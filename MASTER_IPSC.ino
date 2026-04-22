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

struct TargetEntry {
  bool registered = false;
  uint8_t mac[6];
};

TargetEntry targets[MAX_TARGETS];
uint8_t broadcastMAC[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

// ================= SCORE ===================
uint16_t scoreA = 0, scoreC = 0, scoreD = 0;
char lastZone = '-';

// ================= STRUCT EVENTO ===========
struct PendingShot {
  uint32_t seqId;
  char zone;
  uint16_t splitMs;
  uint32_t timeMs;
  int targetId;
  unsigned long lastSent;
};

std::vector<PendingShot> shotQueue;
uint32_t nextSeqId = 1;
bool isRunning = false;

// ================= CHAVES DE SEGURANÇA (MUTEX) ===========
SemaphoreHandle_t queueMutex;  
SemaphoreHandle_t wsMutex;     


std::vector<String> wsOutQueue;


void sendWS(String msg) {
  if (webSocket.connectedClients() > 0 && wsOutQueue.size() < 10) {
   
    if (xSemaphoreTake(wsMutex, 0)) {
      wsOutQueue.push_back(msg);
      xSemaphoreGive(wsMutex);
    }
  } else if (wsOutQueue.size() >= 10) {
 
    if (xSemaphoreTake(wsMutex, 0)) {
      wsOutQueue.erase(wsOutQueue.begin());
      wsOutQueue.push_back(msg);
      xSemaphoreGive(wsMutex);
    }
  }
}
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
// --- FUNÇÕES DE APOIO ---
float lerTensaoBateria() {
  int leitura = analogRead(34); 
  
  float tensaoNoPino = (leitura / 4095.0) * 3.3;
  
 float fatorDivisor = 2.0; 
  
  float tensaoReal = tensaoNoPino * fatorDivisor;
  
  return tensaoReal;
}
// --- HANDLERS (LITTLEFS + CACHE) ---
void handleRoot() {
  File file = LittleFS.open("/index.html", "r");
  if (!file) { server.send(404, "text/plain", "Falta index.html"); return; }
  server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  server.streamFile(file, "text/html");
  file.close(); //
}

void handleJS() {
  File file = LittleFS.open("/script.js", "r");
  if (!file) { server.send(404, "text/plain", "Falta script.js"); return; }
  server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  server.streamFile(file, "application/javascript");
  file.close(); //
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
    if (!isRunning) {
      if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
        shotQueue.clear();
        xSemaphoreGive(queueMutex);
      }
    } else {
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
    sendCommand(target, CMD_CALIB, 1);
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

  // 2. DISPARA O ACK IMEDIATAMENTE (FURA-FILA)
  if (slot >= 0) {
    TargetCommand ack;
    ack.targetId = slot + 1; 
    ack.command = CMD_REGISTER_OK; 
    ack.value = (ev.zone == 'H') ? (slot + 1) : ev.eventId; 
    esp_now_send(info->src_addr, (uint8_t *)&ack, sizeof(ack)); 
  }
  if (ev.zone == 'H') {
    if (slot < 0) {
      for (int i = 0; i < MAX_TARGETS; i++) {
        if (!targets[i].registered) {
          memcpy(targets[i].mac, info->src_addr, 6);
          targets[i].registered = true;
          slot = i;

          esp_now_peer_info_t peer = {};
          memcpy(peer.peer_addr, info->src_addr, 6);
          peer.channel = WIFI_CHANNEL;
          peer.encrypt = false;

          if (!esp_now_is_peer_exist(info->src_addr)) {
            esp_now_add_peer(&peer);
          }

          char syncBuf[64];
          sprintf(syncBuf, "{\"type\":\"new_target\",\"id\":%d}", slot + 1);
          sendWS(String(syncBuf));  // <-- ENVIO SEGURO
          break;
        }
      }
    }
    return;
  }


  if (slot < 0) {
    for (int i = 0; i < MAX_TARGETS; i++) {
      if (!targets[i].registered) {
        memcpy(targets[i].mac, info->src_addr, 6);
        targets[i].registered = true;
        slot = i;

        esp_now_peer_info_t peer = {};
        memcpy(peer.peer_addr, info->src_addr, 6);
        peer.channel = WIFI_CHANNEL;
        peer.encrypt = false;
        if (!esp_now_is_peer_exist(info->src_addr)) {
          esp_now_add_peer(&peer);
        }
        break;
      }
    }
  }

  if (slot < 0) return;

  if (ev.zone == 'A') scoreA++;
  if (ev.zone == 'C') scoreC++;
  if (ev.zone == 'D') scoreD++;
  lastZone = ev.zone;

  char buf[128];
  sprintf(buf, "{\"type\":\"score\",\"A\":%u,\"C\":%u,\"D\":%u,\"last\":\"%c\"}", scoreA, scoreC, scoreD, lastZone);
  sendWS(String(buf));  // <-- ENVIO SEGURO

  int finalID = (ev.targetId > 0) ? ev.targetId : (slot + 1);
  TargetCommand ack;
  ack.targetId = slot + 1;
  ack.command = CMD_REGISTER_OK;
  ack.value = ev.eventId;  // Devolve o ID do evento como confirmação
  esp_now_send(info->src_addr, (uint8_t *)&ack, sizeof(ack));
  if (isRunning) {
    PendingShot ps;
    ps.seqId = nextSeqId++;
    ps.zone = ev.zone;
    ps.splitMs = ev.splitMs;
    ps.timeMs = ev.timeMs;  // Vem da estrutura ShotEvent recebida
    ps.targetId = finalID;
    ps.lastSent = 0;

    if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
      // Procura a posição correta para manter a ordem cronológica
      auto it = shotQueue.begin();
      while (it != shotQueue.end() && it->timeMs < ps.timeMs) {
        it++;
      }
      shotQueue.insert(it, ps);  // Insere na ordem correta, não apenas no fim
      if (shotQueue.size() > 10) {
        shotQueue.erase(shotQueue.begin());  // Apaga o tiro mais velho (fantasma)
        Serial.println("Aviso: Fila de tiros lotada! Descartando mais antigos.");
      }
      xSemaphoreGive(queueMutex);
    }
  } else {
    // Caso o cronômetro não esteja rodando, envia direto (tempo real/treino livre)
    char buf2[128];
    sprintf(buf2, "{\"type\":\"shot\",\"zone\":\"%c\",\"split\":%u,\"target\":%d,\"time\":%u}",
            ev.zone, ev.splitMs, finalID, ev.timeMs);
    sendWS(String(buf2));
  }
}

// ================= WEBSOCKET (Recebe comandos do site) =================
void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_TEXT) {
    String msg = (char *)payload;
    if (msg.startsWith("ACK:")) {
      uint32_t ackSeq = msg.substring(4).toInt();

      if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
        for (int i = 0; i < shotQueue.size(); i++) {
          if (shotQueue[i].seqId == ackSeq) {
            shotQueue.erase(shotQueue.begin() + i);
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
    for (int i = 0; i < shotQueue.size() && enviosNesteCiclo < 2; i++) {  // Limita a 2 por vez
      // Aumentado o intervalo de reenvio para 400ms para não inundar o celular
      if (currentMillis - shotQueue[i].lastSent > 400) {
        char buf[128];
        sprintf(buf, "{\"type\":\"shot\",\"seq\":%u,\"zone\":\"%c\",\"split\":%u,\"target\":%d,\"time\":%u}",
                shotQueue[i].seqId, shotQueue[i].zone, shotQueue[i].splitMs, shotQueue[i].targetId, shotQueue[i].timeMs);
        sendWS(String(buf));
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

    String msgToSend = "";

    if (xSemaphoreTake(wsMutex, portMAX_DELAY)) {
      if (wsOutQueue.size() > 0) {
        msgToSend = wsOutQueue[0];
        wsOutQueue.erase(wsOutQueue.begin());
      }
      xSemaphoreGive(wsMutex);  // <-- Chave liberada! O Rádio Wi-Fi está livre.
    }


    if (msgToSend != "") {
      webSocket.broadcastTXT(msgToSend.c_str());
    } else {
      vTaskDelay(pdMS_TO_TICKS(30));  
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



  server.serveStatic("/style.css", LittleFS, "/style.css");
  server.on("/script.js", []() {
  File file = LittleFS.open("/script.js", "r");
  if (!file) {
    server.send(404, "text/plain", "Arquivo não encontrado");
    return;
  }

  server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("Expires", "-1");
  
  server.streamFile(file, "application/javascript");
  file.close();
});
  server.serveStatic("/chart.js", LittleFS, "/chart.js");
  server.on("/", HTTP_GET, []() {
    server.client().setNoDelay(true);  // <-- ACELERAÇÃO TCP
    server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    server.sendHeader("Pragma", "no-cache");
    server.sendHeader("Expires", "-1");

    File file = LittleFS.open("/index.html", "r");
    server.streamFile(file, "text/html");
    file.close();
  });
  server.on("/tf.min.js", HTTP_GET, []() {
    // Manda o celular fazer um cache eterno desse arquivo pesado
    server.sendHeader("Cache-Control", "max-age=31536000");
    File file = LittleFS.open("/tf.min.js", "r");
    server.streamFile(file, "application/javascript");
    file.close();
  });
  server.on("/cmd", handleCmd);

  server.begin();
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);

  xTaskCreatePinnedToCore(webTask, "webTask", 10000, NULL, 1, NULL, 0);
  server.on("/jspdf.js", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "max-age=31536000");  // Cache de 1 ano (offline total)
    File file = LittleFS.open("/jspdf.js", "r");
    server.streamFile(file, "application/javascript");
    file.close();
  });

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  auto redirectCaptive = []() {
    server.sendHeader("Location", "http://192.168.4.1/", true);
    server.send(302, "text/html", "<html><head><meta http-equiv=\"refresh\" content=\"0;url=http://192.168.4.1/\"></head><body>Redirecionando para o IPS Metrix...</body></html>");
  };

  
  server.on("/generate_204", redirectCaptive);
  server.on("/gen_204", redirectCaptive);
  server.on("/hotspot-detect.html", redirectCaptive);
  
  server.onNotFound(redirectCaptive);

  server.on("/", []() {
    server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    server.sendHeader("Pragma", "no-cache");
    server.sendHeader("Expires", "-1");
   
    handleRoot(); 
  });

  server.begin();

  Serial.println("IPS Metrix PRONTO (Dual-Core + WebSocket Seguro Ativados)");
}

// ================= NÚCLEO 1 (Cronômetro e Lógica) =================
void loop() {
  dnsServer.processNextRequest();
  processQueue();
  esp_task_wdt_reset();

  static unsigned long lastBatSend = 0;

  if (millis() - lastBatSend > 1000) { 
    
    float voltagemBateria = lerTensaoBateria(); 
    
    // Imprime no Plotter


    // Alerta de 3.2V
    if (voltagemBateria <= 3.20) {
        Serial.println("ALERTA_BATERIA: Critica! Coloque para carregar!");
    }

    // Envia pro celular via WebSocket
    char batBuf[64];
    sprintf(batBuf, "{\"type\":\"master_status\",\"bat_v\":%.2f}", voltagemBateria);
    sendWS(String(batBuf));
    
    lastBatSend = millis();
  }
  
  vTaskDelay(pdMS_TO_TICKS(30));
}