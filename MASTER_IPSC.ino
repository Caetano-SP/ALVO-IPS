#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <vector>
#include <WiFiManager.h>
#include <LittleFS.h>
#include <esp_task_wdt.h>
#include <DNSServer.h>

const byte DNS_PORT = 53;
DNSServer dnsServer;
#define WDT_TIMEOUT 3

// ================= MACROS DE CONFIGURAÇÃO =================
#define MAX_TARGETS 10
#define SHOT_QUEUE_SIZE 10
#define WS_QUEUE_SIZE 20
#define WS_MSG_LEN 128
#define WS_BIN_QUEUE_SIZE 64

// ================= STRUCTS E TIPOS =================
struct TargetEntry {
  bool registered = false;
  uint8_t mac[6];
  uint32_t lastEventId = 0;
};

struct PendingShot {
  uint32_t seqId;
  char zone;
  uint16_t splitMs;
  uint32_t timeMs;
  int targetId;
  unsigned long lastSent;
};

struct WSMessage {
  char data[WS_MSG_LEN];
};

#pragma pack(push, 1)
struct WSBinaryShot {
    uint8_t type;    // 0x01 para Shot
    uint32_t seqId;
    char zone;
    uint16_t splitMs;
    uint32_t timeMs;
    uint8_t targetId;
};

typedef struct __attribute__((packed)) {
  uint8_t targetId;
  uint32_t eventId;
  char zone;
  uint16_t splitMs;
  uint32_t timeMs;
} ShotEvent;

typedef struct __attribute__((packed)) {
  uint8_t targetId;
  uint8_t command;
  uint8_t value;
} TargetCommand;
#pragma pack(pop)

// ================= COMANDOS =================
#define CMD_LIGHT 1
#define CMD_SOUND 2
#define CMD_CALIB 3
#define CMD_DETECT 4
#define CMD_RESET 5
#define CMD_SET_IR 6
#define CMD_SET_RED 7
#define CMD_STOP_ID 11
#define CMD_REGISTER_OK 20

// ================= WIFI ====================
#define WIFI_CHANNEL 1

WebServer server(80);
WebSocketsServer webSocket(81);

#define MAX_TARGETS 10

bool soundEnabled = true;
bool lightEnabled = true;

TargetEntry targets[MAX_TARGETS];
uint8_t broadcastMAC[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

// ================= SCORE ===================
uint16_t scoreA = 0, scoreC = 0, scoreD = 0;
char lastZone = '-';

// ================= STRUCT EVENTO ===========
PendingShot shotQueue[SHOT_QUEUE_SIZE];
volatile int shotQueueCount = 0;
uint32_t nextSeqId = 1;
bool isRunning = false;

// ================= CHAVES DE SEGURANÇA (MUTEX) ===========
SemaphoreHandle_t queueMutex;  
SemaphoreHandle_t wsMutex;

WSMessage wsOutQueue[WS_QUEUE_SIZE];
volatile int wsQueueHead = 0;
volatile int wsQueueTail = 0;

void sendWS(const char* msg) {
  if (webSocket.connectedClients() > 0) {
    if (xSemaphoreTake(wsMutex, pdMS_TO_TICKS(10))) {
      int nextHead = (wsQueueHead + 1) % WS_QUEUE_SIZE;
      if (nextHead == wsQueueTail) {
         wsQueueTail = (wsQueueTail + 1) % WS_QUEUE_SIZE;
      }
      strlcpy(wsOutQueue[wsQueueHead].data, msg, WS_MSG_LEN);
      wsQueueHead = nextHead;
      xSemaphoreGive(wsMutex);
    } else {
      Serial.println("ERRO: Mutex WS travado! Mensagem descartada.");
    }
  }
}

WSBinaryShot wsBinQueue[WS_BIN_QUEUE_SIZE];
volatile int wsBinHead = 0;
volatile int wsBinTail = 0;

void sendWSBin(const WSBinaryShot& payload) {
    if (webSocket.connectedClients() > 0) {
        if (xSemaphoreTake(wsMutex, pdMS_TO_TICKS(10))) {
            wsBinQueue[wsBinHead] = payload;
            wsBinHead = (wsBinHead + 1) % WS_BIN_QUEUE_SIZE;
            if (wsBinHead == wsBinTail) wsBinTail = (wsBinTail + 1) % WS_BIN_QUEUE_SIZE;
            xSemaphoreGive(wsMutex);
        }
    }
}
// --- FUNÇÕES DE APOIO ---

// ===================== SERVIDOR DE ARQUIVOS ESTÁTICOS COM GZIP E CACHE =====================
const char* getContentType(const String& filename) {
  if (server.hasArg("download")) return "application/octet-stream";
  if (filename.endsWith(".html")) return "text/html";
  if (filename.endsWith(".css")) return "text/css";
  if (filename.endsWith(".js")) return "application/javascript";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".gif")) return "image/gif";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".ico")) return "image/x-icon";
  if (filename.endsWith(".xml")) return "text/xml";
  if (filename.endsWith(".pdf")) return "application/x-pdf";
  if (filename.endsWith(".zip")) return "application/x-zip";
  if (filename.endsWith(".json")) return "application/json";
  return "text/plain";
}

bool handleFileRead(const String& pathOriginal) {
  String path = pathOriginal;
  if (path.endsWith("/")) path += "index.html";

  const char* contentType = getContentType(path);
  String pathWithGz = path + ".gz";

  bool clientAcceptsGzip = false;
  if (server.hasHeader("Accept-Encoding") && server.header("Accept-Encoding").indexOf("gzip") != -1) {
    clientAcceptsGzip = true;
  }

  if (clientAcceptsGzip && LittleFS.exists(pathWithGz)) {
    File file = LittleFS.open(pathWithGz, "r");
    if (path.indexOf("index.html") != -1) {
      server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      server.sendHeader("Pragma", "no-cache");
      server.sendHeader("Expires", "0");
    } else {
      server.sendHeader("Cache-Control", "public, max-age=31536000");
    }
    server.client().setNoDelay(true);
    server.streamFile(file, contentType);
    file.close();
    return true;
  } 
  else if (LittleFS.exists(path)) {
    File file = LittleFS.open(path, "r");
    if (path.indexOf("index.html") != -1) {
      server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      server.sendHeader("Pragma", "no-cache");
      server.sendHeader("Expires", "0");
    } else {
      server.sendHeader("Cache-Control", "public, max-age=31536000");
    }
    server.client().setNoDelay(true);
    server.streamFile(file, contentType);
    file.close();
    return true;
  }
  return false;
}
// ================= ENVIO COMANDO =================
void sendCommand(uint8_t targetId, uint8_t cmd, uint8_t val) {
  TargetCommand p;
  p.targetId = targetId;
  p.command = cmd;
  p.value = val;

  const uint8_t *destMac = NULL;

  if (targetId == 255) {
    destMac = broadcastMAC;
  } else {
    int index = targetId - 1;
    if (index >= 0 && index < MAX_TARGETS && targets[index].registered) {
      destMac = targets[index].mac;
    } else {
      Serial.printf("ERRO: Alvo %d não encontrado ou não registrado!\n", targetId);
      return;
    }
  }

  if (destMac != NULL) {
    esp_err_t result = esp_now_send(destMac, (uint8_t *)&p, sizeof(p));
    if (result == ESP_OK) {
      Serial.printf("Comando %d enviado para Alvo %d\n", cmd, targetId);
    } else {
      Serial.printf("Erro ESP-NOW: %s\n", esp_err_to_name(result));
    }
  }
}

// ================= HTTP ====================
void handleCmd() {
  uint8_t target = 255;
  if (server.hasArg("target")) target = server.arg("target").toInt();

  if (server.hasArg("detect")) {
    uint8_t detectVal = server.arg("detect").toInt();
    isRunning = (detectVal == 1);
    if (isRunning) {
      // Limpa a fila somente ao iniciar uma nova rodada para evitar perda de disparos pendentes no stop
      if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
        shotQueueCount = 0;
        xSemaphoreGive(queueMutex);
      }
      sendCommand(target, CMD_DETECT, 1);
    }
  }

  if (server.hasArg("cmd")) {
    uint8_t cmdValue = server.arg("cmd").toInt();
    if (cmdValue == 10) {
      if (target == 255) {
        sendCommand(255, 10, 1);
      } else {
        sendCommand(target, 10, 1);
        for (int i = 0; i < MAX_TARGETS; i++) {
          int idAlvo = i + 1;
          if (targets[i].registered && idAlvo != target) {
            sendCommand(idAlvo, CMD_STOP_ID, 1);
          }
        }
      }
    } else {
      sendCommand(target, cmdValue, 1);
    }
  }

  if (server.hasArg("sound")) {
    soundEnabled = server.arg("sound").toInt();
    sendCommand(target, CMD_SOUND, soundEnabled);
  }

  if (server.hasArg("light")) {
    lightEnabled = server.arg("light").toInt();
    sendCommand(target, CMD_LIGHT, lightEnabled);
  }

  if (server.hasArg("calib")) {
    uint8_t calibVal = server.arg("calib").toInt();
    sendCommand(target, CMD_CALIB, calibVal);
    if (server.hasArg("laserMode")) {
      uint8_t mode = server.arg("laserMode").toInt();
      sendCommand(target, mode, 1);
    }
  }

  server.send(200, "text/plain", "OK");
}

// ================= RECEBE EVENTO (Roda no Rádio) ===========
void onRecv(const esp_now_recv_info *info, const uint8_t *data, int len) {
  if (len != sizeof(ShotEvent)) return;
  ShotEvent ev;
  memcpy(&ev, data, sizeof(ev)); 

  // =======================================================
  // 🛡️ INTERTRAVAMENTO: ESCUDO ANTI STORM X
  // =======================================================
  // Só aceita o pacote se a "zona" for uma assinatura oficial IPSC
  if (ev.zone != 'A' && ev.zone != 'C' && ev.zone != 'D' && 
      ev.zone != 'M' && ev.zone != '-' && ev.zone != 'H') {
      return; // Aborta! Pacote alienígena detetado.
  }
  // =======================================================

  // 1. IDENTIFICA O ALVO RÁPIDO
  int slot = -1;
  for (int i = 0; i < MAX_TARGETS; i++) {
    if (targets[i].registered && memcmp(targets[i].mac, info->src_addr, 6) == 0) {
      slot = i;
      break;
    }
  }

  // 2. CADASTRO DINÂMICO SE NÃO REGISTRADO (Com interface WIFI_IF_AP explícita)
  if (slot < 0) {
    for (int i = 0; i < MAX_TARGETS; i++) {
      if (!targets[i].registered) {
        memcpy(targets[i].mac, info->src_addr, 6);
        targets[i].registered = true;
        targets[i].lastEventId = 0; // Inicializa ID de evento
        slot = i;

        esp_now_peer_info_t peer = {};
        memcpy(peer.peer_addr, info->src_addr, 6);
        peer.channel = WIFI_CHANNEL;
        peer.encrypt = false;
        peer.ifidx = WIFI_IF_AP; // 🔥 CORREÇÃO CRÍTICA: Força o uso da interface AP!

        if (!esp_now_is_peer_exist(info->src_addr)) {
          esp_now_add_peer(&peer);
        }

        // Se for pacote de pareamento ("H"), notifica o frontend imediatamente
        if (ev.zone == 'H') {
          char syncBuf[64];
          sprintf(syncBuf, "{\"type\":\"new_target\",\"id\":%d}", slot + 1);
          sendWS(syncBuf); 
        }
        break;
      }
    }
  }

  if (slot < 0) return; // Limite máximo de alvos excedido

  // 3. ENVIO IMEDIATO DO ACK (Apenas uma vez)
  TargetCommand ack;
  ack.targetId = slot + 1; 
  ack.command = CMD_REGISTER_OK; 
  ack.value = (ev.zone == 'H') ? (slot + 1) : ev.eventId; 
  esp_now_send(info->src_addr, (uint8_t *)&ack, sizeof(ack)); 

  // Se for apenas pacote de pareamento/batimento cardíaco, encerra por aqui
  if (ev.zone == 'H') {
    return;
  }

  // 4. FILTRO DE DUPLICADOS (Evita processar a mesma rajada/jitter)
  if (ev.eventId == targets[slot].lastEventId) {
    Serial.printf("Aviso: Disparo duplicado detectado no Alvo %d (ID Evento: %u). Ignorando, mas ACK reenviado.\n", slot + 1, ev.eventId);
    return; 
  }
  targets[slot].lastEventId = ev.eventId; // Atualiza o último evento processado

  // 5. ATUALIZAÇÃO DE SCORES E TELEMETRIA
  if (ev.zone == 'A') scoreA++;
  if (ev.zone == 'C') scoreC++;
  if (ev.zone == 'D') scoreD++;
  lastZone = ev.zone;

  char buf[128];
  sprintf(buf, "{\"type\":\"score\",\"A\":%u,\"C\":%u,\"D\":%u,\"last\":\"%c\"}", scoreA, scoreC, scoreD, lastZone);
  sendWS(buf);  

  int finalID = (ev.targetId > 0) ? ev.targetId : (slot + 1);

  if (isRunning) {
    PendingShot ps;
    ps.seqId = nextSeqId++;
    ps.zone = ev.zone;
    ps.splitMs = ev.splitMs;
    ps.timeMs = ev.timeMs;  
    ps.targetId = finalID;
    ps.lastSent = 0;

    if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
      if (shotQueueCount < SHOT_QUEUE_SIZE) {
         shotQueue[shotQueueCount++] = ps;
         for(int k = shotQueueCount - 1; k > 0; k--) {
            if(shotQueue[k].timeMs < shotQueue[k-1].timeMs) {
               PendingShot temp = shotQueue[k];
               shotQueue[k] = shotQueue[k-1];
               shotQueue[k-1] = temp;
            } else break;
         }
      } else {
         for(int k=1; k<SHOT_QUEUE_SIZE; k++) {
            shotQueue[k-1] = shotQueue[k];
         }
         shotQueue[SHOT_QUEUE_SIZE-1] = ps;
         Serial.println("Aviso: Fila de tiros lotada! Descartando mais antigos.");
      }
      xSemaphoreGive(queueMutex);
    }
  } else {
    WSBinaryShot binMsg;
    binMsg.type = 1;
    binMsg.seqId = 0;
    binMsg.zone = ev.zone;
    binMsg.splitMs = ev.splitMs;
    binMsg.timeMs = ev.timeMs;
    binMsg.targetId = finalID;
    sendWSBin(binMsg);
  }
}

// ================= WEBSOCKET (Recebe comandos do site) =================
void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_TEXT) {
    if (strncmp((char *)payload, "ACK:", 4) == 0) {
      uint32_t ackSeq = atoi((char *)payload + 4);

      if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
        for (int i = 0; i < shotQueueCount; i++) {
          if (shotQueue[i].seqId == ackSeq) {
            for(int j = i; j < shotQueueCount - 1; j++) {
               shotQueue[j] = shotQueue[j+1];
            }
            shotQueueCount--;
            break;
          }
        }
        xSemaphoreGive(queueMutex);
      }
    }
  }
}

// ================= PROCESSAMENTO (Roda no Núcleo 1) =================
void processQueue() {
  unsigned long currentMillis = millis();
  int enviosNesteCiclo = 0;  

  if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
    for (int i = 0; i < shotQueueCount && enviosNesteCiclo < 2; i++) {  // Limita a 2 por vez
      // Aumentado o intervalo de reenvio para 400ms para não inundar o celular
      if (currentMillis - shotQueue[i].lastSent > 400) {
        WSBinaryShot binMsg;
        binMsg.type = 1;
        binMsg.seqId = shotQueue[i].seqId;
        binMsg.zone = shotQueue[i].zone;
        binMsg.splitMs = shotQueue[i].splitMs;
        binMsg.timeMs = shotQueue[i].timeMs;
        binMsg.targetId = shotQueue[i].targetId;
        sendWSBin(binMsg);
        shotQueue[i].lastSent = currentMillis;
        enviosNesteCiclo++;
      }
    }
    xSemaphoreGive(queueMutex);
  }
}
// ================= TAREFA DO NÚCLEO 0 (Servidor Web) =================
void webTask(void *pvParameters) {
  for (;;) {
    server.handleClient();
    webSocket.loop();
    dnsServer.processNextRequest();

    bool hasData = false;
    WSMessage txtMsg;
    bool hasBin = false;
    WSBinaryShot binMsg;

    if (xSemaphoreTake(wsMutex, pdMS_TO_TICKS(5))) {
      if (wsQueueHead != wsQueueTail) {
        memcpy(&txtMsg, (void*)&wsOutQueue[wsQueueTail], sizeof(WSMessage));
        wsQueueTail = (wsQueueTail + 1) % WS_QUEUE_SIZE;
        hasData = true;
      }
      if (wsBinHead != wsBinTail) {
        memcpy(&binMsg, (void*)&wsBinQueue[wsBinTail], sizeof(WSBinaryShot));
        wsBinTail = (wsBinTail + 1) % WS_BIN_QUEUE_SIZE;
        hasBin = true;
      }
      xSemaphoreGive(wsMutex); 
    }

    if (hasData) {
      webSocket.broadcastTXT(txtMsg.data);
      vTaskDelay(pdMS_TO_TICKS(1));
    }
    if (hasBin) {
      webSocket.broadcastBIN((uint8_t*)&binMsg, sizeof(WSBinaryShot));
      vTaskDelay(pdMS_TO_TICKS(1));
    }
    if (!hasData && !hasBin) {
      vTaskDelay(pdMS_TO_TICKS(10));  
    }
  }
}


// ================= SETUP ===================
void setup() {
  Serial.begin(115200);
esp_task_wdt_config_t twdt_config = {
      .timeout_ms = WDT_TIMEOUT * 1000, // Converte segundos para milissegundos
      .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,    // Monitora ambos os núcleos
      .trigger_panic = true             // Reinicia se travar
  };
  
  esp_task_wdt_init(&twdt_config);      // Inicializa com a configuração acima
  esp_task_wdt_add(NULL);             // Adiciona o Loop principal na vigilância

  // Inicializa as fechaduras de segurança dos dois núcleos
  queueMutex = xSemaphoreCreateMutex();
  wsMutex = xSemaphoreCreateMutex();

  if (!LittleFS.begin(true)) {
    Serial.println("Erro ao montar o LittleFS!");
    return;
  }

  WiFi.mode(WIFI_AP_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);

  WiFi.softAP("360 IPS Metrix", "360virtu", WIFI_CHANNEL, 0, 4);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("Erro ao inicializar ESP-NOW");
    ESP.restart();
  }

  esp_now_register_recv_cb(onRecv);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, broadcastMAC, 6);
  peerInfo.channel = WIFI_CHANNEL;
  peerInfo.encrypt = false;
  peerInfo.ifidx = WIFI_IF_AP;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Falha ao adicionar peer");
  }



  const char* headerkeys[] = {"Accept-Encoding"};
  size_t headerkeyssize = sizeof(headerkeys) / sizeof(char*);
  server.collectHeaders(headerkeys, headerkeyssize);

  server.on("/", []() {
    if (!handleFileRead("/index.html")) {
      server.send(404, "text/plain", "index.html não encontrado");
    }
  });

  server.on("/cmd", handleCmd);

  server.begin();
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);

  xTaskCreatePinnedToCore(webTask, "webTask", 10000, NULL, 1, NULL, 0);

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  auto redirectCaptive = []() {
    server.sendHeader("Location", "http://192.168.4.1/", true);
    server.send(302, "text/html", "<html><head><meta http-equiv=\"refresh\" content=\"0;url=http://192.168.4.1/\"></head><body>Redirecionando para o IPS Metrix...</body></html>");
  };

  server.on("/generate_204", redirectCaptive);
  server.on("/gen_204", redirectCaptive);
  server.on("/hotspot-detect.html", redirectCaptive);
  
  server.onNotFound([]() {
    if (!handleFileRead(server.uri())) {
      server.sendHeader("Location", "http://192.168.4.1/", true);
      server.send(302, "text/html", "<html><head><meta http-equiv=\"refresh\" content=\"0;url=http://192.168.4.1/\"></head><body>Redirecionando para o IPS Metrix...</body></html>");
    }
  });

  Serial.println("IPS Metrix PRONTO (Dual-Core + WebSocket Seguro Ativados)");
}

// ================= NÚCLEO 1 (Cronômetro e Lógica) =================
void loop() {
  processQueue();
  esp_task_wdt_reset();

  
  vTaskDelay(pdMS_TO_TICKS(30));
}