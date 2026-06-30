#include <Wire.h>
#include "Adafruit_TCS34725.h"
#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <Preferences.h> 

Preferences preferences; 


int myTargetId = 0; 
bool isRegistered = false;

uint8_t masterAddr[6] = {0};
bool hasMasterAddr = false;

// ---- PINS ----
#define LED_R11_PIN 2  
#define LED_G_PIN   4
#define LED_A_PIN   5
#define LED_C_PIN   3

#define BASE_ALPHA 0.01f 
#define CONTINUO_MAX_MS 50
#define LED_DURATION 80 

// ---- COMANDOS ESP-NOW ----
#define CMD_LIGHT   1 
#define CMD_SOUND   2 
#define CMD_CALIB   3 
#define CMD_DETECT  4 
#define CMD_RESET   5 
#define CMD_SET_IR  6 
#define CMD_SET_RED 7 
#define CMD_SOU_EU  10
#define CMD_STOP_ID 11  
#define CMD_MODE_METAL 12 
#define CMD_MODE_IPSC  13 
#define CMD_REGISTER_OK 20 


#define MIN_INTERVALO_DISPARO_MS 100

// --- PARÂMETROS DE DETECÇÃO ---
#define N_MEDIA 20
uint16_t bufferR[N_MEDIA];
uint16_t bufferG[N_MEDIA];
uint8_t  idxMedia = 0;
float baselineR = 0;

const int   MIN_DELTA_ABS = 5;
const float PROPORTIONAL_TOL = 0.3f;
const float LASER_DOMINANCE = 1.035f;
const int   WINDOW_PICO_MS = 20;

// Variáveis de estado
unsigned long ultimoDisparoMs = 0;
unsigned long drHighStart = 0;
bool laserContinuo = false;
bool capturandoPico = false;
bool laserPresente = false;
uint16_t picoEvento = 0;
uint16_t picoLaser = 0;
uint16_t picoLaser2 = 0;
int limiteCalib = 5; 
unsigned long picoStartTime = 0;
unsigned long lastShotMillis = 0;
unsigned long startMillis = 0;
unsigned long baselineFreezeUntil = 0;
uint32_t eventId = 0;
uint8_t modoFaixa = CMD_SET_RED;
bool ledEnabled = true;
bool soundEnabled = true;
bool calibrating = false;
bool detecting = true;
bool isMetallic = false;
unsigned long lastMetalBlink = 0;
bool metalBlinkState = false;
bool identificarAlvo = false;
int disparosCalib = 0;
long somaPicosCalib = 0;

// Timer para envio de Handshake
unsigned long lastHandshakeMs = 0;

// Timers para desligar LEDs
unsigned long ledC_until = 0;
unsigned long ledG_until = 0;
unsigned long ledA_until = 0;
unsigned long ledR11_until = 0;

// Estruturas de Dados
// Estrutura para fila de reenvio
struct PendingShotTarget {
  uint32_t eventId;
  char zone;
  uint16_t splitMs;
  uint32_t timeMs;
  unsigned long lastAttempt;
};
#define TARGET_QUEUE_SIZE 10
PendingShotTarget targetQueue[TARGET_QUEUE_SIZE];
volatile int targetQueueCount = 0;
SemaphoreHandle_t queueMutex;

typedef struct __attribute__((packed)) {
  uint8_t targetId;
  uint32_t eventId;
  char zone;
  // Se zone == 'H', é Handshake (Hello)
  uint16_t splitMs;
  uint32_t timeMs;
} ShotEvent;

typedef struct __attribute__((packed)) {
  uint8_t targetId;
  uint8_t command;
  uint8_t value;
} TargetCommand;

uint8_t broadcastAddr[] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
Adafruit_TCS34725 tcs(TCS34725_INTEGRATIONTIME_24MS, TCS34725_GAIN_60X); 

// --- FERRAMENTA PROPORCIONAL ---
static bool proporcional(float a, float b, float tol) {
  if (a <= 0.0f && b <= 0.0f) return true;
  float ma = fabs(a), mb = fabs(b); 
  float mx = (ma > mb) ? ma : mb;
  float mn = (ma > mb) ? mb : ma; 
  if (mx == 0.0f) return true;
  return ((mn / mx) >= (1.0f - tol)); 
}

// RECEBIMENTO ESP-NOW
void onESPNowRecv(const esp_now_recv_info *info, const uint8_t *data, int len) {
  
  // 1. O SONAR: Imprime no painel tudo o que bate na antena do Alvo
  Serial.printf("\n[RÁDIO] Pacote recebido! Tamanho: %d bytes\n", len);

  // Trava de segurança contra lixo na rede
  if (len != sizeof(TargetCommand)) {
      Serial.println("[ERRO] Pacote ignorado. Tamanho incompatível.");
      return;
  }

  // Salva o MAC do Master para responder com Unicast
  if (!hasMasterAddr) {
      memcpy(masterAddr, info->src_addr, 6);
      hasMasterAddr = true;
      esp_now_peer_info_t peer = {};
      memcpy(peer.peer_addr, masterAddr, 6);
      peer.channel = 0;
      peer.encrypt = false;
      if (!esp_now_is_peer_exist(masterAddr)) {
          esp_now_add_peer(&peer);
      }
      Serial.println("Endereço MAC do Master salvo para Unicast!");
  }

  TargetCommand cmd;
  memcpy(&cmd, data, sizeof(cmd));

  // 2. RAIO-X DO COMANDO: Mostra exatamente o que o Master pediu
  Serial.printf("[COMANDO] Para o Alvo: %d | Ação (Cmd): %d | Valor: %d\n", cmd.targetId, cmd.command, cmd.value);

  // 3. Lógica de ACK e Registro (Intacta)
  if (cmd.command == CMD_REGISTER_OK) {
      if (!isRegistered) {
          isRegistered = true;
          myTargetId = cmd.value;
          Serial.printf("REGISTRADO! ID Atribuido: %d\n", myTargetId);
      }
      if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
          for (int i = 0; i < targetQueueCount; i++) {
              if (targetQueue[i].eventId == cmd.value) {
                  for (int j = i; j < targetQueueCount - 1; j++) {
                      targetQueue[j] = targetQueue[j + 1];
                  }
                  targetQueueCount--;
                  Serial.printf("ACK Recebido: Evento %d removido da fila.\n", cmd.value);
                  break;
              }
          }
          xSemaphoreGive(queueMutex);
      }
      return;
  }

  // 4. A PORTA DE SEGURANÇA ESCANCARADA
  // A Mágica aqui: Ele sempre obedece o 255 (Todos os Alvos), mesmo se o ID dele ainda estiver confuso!
  if (cmd.targetId == 255 || (myTargetId > 0 && cmd.targetId == myTargetId)) {
      
      switch (cmd.command) {
          // ... (Aqui continua o seu código normal com case CMD_LIGHT, CMD_MODE_METAL, etc.)
        case CMD_LIGHT: 
            ledEnabled = cmd.value;
            if (!ledEnabled) { digitalWrite(LED_G_PIN, LOW); digitalWrite(LED_A_PIN, LOW); digitalWrite(LED_C_PIN, LOW); } 
            break; 
        
        case CMD_SOUND: 
            soundEnabled = cmd.value;
            if (!soundEnabled) { digitalWrite(LED_R11_PIN, LOW); } 
            break; 
        
        case CMD_CALIB: 
          calibrating = true;
          disparosCalib = 0; 
          somaPicosCalib = 0;
          lastShotMillis = millis(); // Timeout timer init
          if(cmd.value == 2) {
            limiteCalib = 10;
            Serial.println("modo calibração 10 disparos");
          } else {
            limiteCalib = 5;
            Serial.println("modo calibração 5 disparos");
          }
          // Feedback não bloqueante para o callback
          digitalWrite(LED_C_PIN, HIGH);
          digitalWrite(LED_A_PIN, HIGH);
          ledC_until = millis() + 100;
          ledA_until = millis() + 100;
          Serial.println("Modo Calibração Ativado");
          break;

        case CMD_DETECT: 
          detecting = cmd.value; 
          if(detecting) digitalWrite(LED_C_PIN, LOW);
          break;

        case CMD_RESET: 
          lastShotMillis = 0;
          startMillis = millis();
          break;

        case CMD_SET_IR: 
          modoFaixa = CMD_SET_IR; 
          Serial.println("Modo Laser: Infravermelho (IR)");
          break;

        case CMD_SET_RED: 
          modoFaixa = CMD_SET_RED; 
          Serial.println("Modo Laser: Vermelho");
          break;

        case CMD_SOU_EU:
          identificarAlvo = true;
          digitalWrite(LED_A_PIN, HIGH);
          break;

        case CMD_STOP_ID: 
          digitalWrite(LED_A_PIN, LOW);
          Serial.println("Identificação Desligada");
          break;

        case CMD_MODE_METAL:
            isMetallic = true;
            preferences.putBool("isMetallic", true);
            Serial.println("Modo Metálico Salvo");
            break;

        case CMD_MODE_IPSC:
            isMetallic = false;
            preferences.putBool("isMetallic", false); 
            Serial.println("Modo IPSC Salvo");
            break;
      }
  } // <-- Fim da porta de segurança

  // O ACK CMD_REGISTER_OK foi removido daqui pois já é retornado e tratado com 'return;' na linha 148, e era um código morto que usava std::vector.
}



 


void sendShot(char zone, uint16_t split, uint32_t time) {
  PendingShotTarget ps = {eventId, zone, split, time, 0};
  
  if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
      if (targetQueueCount < TARGET_QUEUE_SIZE) {
          targetQueue[targetQueueCount++] = ps;
      } else {
          for (int i = 1; i < TARGET_QUEUE_SIZE; i++) {
              targetQueue[i - 1] = targetQueue[i];
          }
          targetQueue[TARGET_QUEUE_SIZE - 1] = ps;
      }
      xSemaphoreGive(queueMutex);
  }

  ShotEvent ev; // Usa a struct global limpa
  ev.targetId = (uint8_t)myTargetId;
  ev.eventId = eventId;
  ev.zone = zone;
  ev.splitMs = split;
  ev.timeMs = time;

  uint8_t* destAddr = hasMasterAddr ? masterAddr : broadcastAddr;
  esp_now_send(destAddr, (uint8_t*)&ev, sizeof(ev));
}

// Função de Handshake (Registro)
void sendHandshake() {
  ShotEvent ev; 
  ev.targetId = 0;      
  ev.eventId  = 0;
  ev.zone     = 'H';     
  ev.splitMs  = 0;
  ev.timeMs   = millis();

  esp_now_send(broadcastAddr, (uint8_t*)&ev, sizeof(ev));
  //Serial.println("Enviando Pedido de Registro (Handshake)...");
}

uint16_t media_movel(uint16_t *buffer, uint16_t novoValor) {
  buffer[idxMedia] = novoValor; 
  uint32_t soma = 0;
  for (int i = 0; i < N_MEDIA; i++) soma += buffer[i]; 
  return soma / N_MEDIA;
}

void setup() {
  Serial.begin(115200); 
  queueMutex = xSemaphoreCreateMutex();
  Wire.begin(); 
  tcs.begin(); 
  
  // Inicializa Preferências (Memória Flash)
  // Namespace: "target_cfg", false = read/write
  preferences.begin("target_cfg", false); 
// Dentro do setup(), após preferences.begin
isMetallic = preferences.getBool("isMetallic", false); 
Serial.printf("Modo Operação: %s\n", isMetallic ? "METÁLICO" : "IPSC");
  picoLaser = preferences.getUInt("picoLaser", 0); 
  
  if (picoLaser > 0) {
    Serial.printf("Calibração Carregada da Memória: %d\n", picoLaser);
    // Se já temos calibração, não ativamos 'calibrating = true' automaticamente
    calibrating = false; 
  } else {
    Serial.println("Sem calibração salva. Modo Calibração Ativado.");
    calibrating = true;
  }

  pinMode(LED_R11_PIN, OUTPUT); pinMode(LED_G_PIN, OUTPUT); 
  pinMode(LED_A_PIN, OUTPUT);   pinMode(LED_C_PIN, OUTPUT); 

  WiFi.mode(WIFI_STA);
  // NÃO fixamos mais o canal aqui. O esp_now_init usa o atual.
  if (esp_now_init() != ESP_OK) {
      Serial.println("Erro ao iniciar ESP-NOW");
      ESP.restart();
  }
  esp_now_register_recv_cb(onESPNowRecv);
  
  // Registra o peer de Broadcast
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddr, 6); 
  peer.channel = 0;
  peer.encrypt = false; 
  esp_now_add_peer(&peer);
  
  // --- CALIBRAÇÃO INICIAL DA COR (BASELINE) ---
  uint16_t r, g, b, c;
  for (int i = 0; i < N_MEDIA; i++) {
    tcs.getRawData(&r, &g, &b, &c);
    bufferR[i] = r;
    bufferG[i] = g; delay(5); 
  }
  
  startMillis = millis(); 
  // Removido: calibrating = true; (já tratado acima com preferences)

  // --- HUNTING (CAÇA AO CANAL) ---
  Serial.println("Procurando canal do Master...");
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
}

void loop() {
  unsigned long now = millis();

  // --- LÓGICA DE HANDSHAKE ---
  if (!isRegistered) {
    if (now - lastHandshakeMs > 150) {
      sendHandshake();
      lastHandshakeMs = now;
    }
  }
  // ---------------------------
  
  // Timeout de calibração (120s inatividade)
  if (calibrating && (now - lastShotMillis > 120000)) {
      calibrating = false;
      Serial.println("Calibração cancelada por inatividade (Timeout 120s)");
      digitalWrite(LED_C_PIN, LOW);
      digitalWrite(LED_A_PIN, LOW);
  }

  if (!detecting) { 
    digitalWrite(LED_G_PIN, LOW);
    digitalWrite(LED_A_PIN, LOW);
    digitalWrite(LED_C_PIN, LOW); digitalWrite(LED_R11_PIN, LOW);
    return;
  }

  uint16_t r, g, b, c;
  tcs.getRawData(&r, &g, &b, &c); 
  
  // ==========================================
  // INCREMENTO EDGE IMPULSE (DATA LOGGER)
  
  //Serial.printf("%d,%d,%d,%d\n", r, g, b, c); 
  // ==========================================

  idxMedia = (idxMedia + 1) % N_MEDIA;

  uint16_t mediaR_val = (!laserPresente && !capturandoPico) ?
    media_movel(bufferR, r) : bufferR[(idxMedia - 1 + N_MEDIA) % N_MEDIA]; 
  uint16_t mediaG_val = media_movel(bufferG, g);
  float dR = r - mediaR_val; 
  float dG = g - mediaG_val;

  // Lógica do comando SOU_EU (ID 10)
  if (identificarAlvo){

    identificarAlvo = false; 

  }

  if (dR > MIN_DELTA_ABS) {
    if (drHighStart == 0) drHighStart = now;
    else if (now - drHighStart > CONTINUO_MAX_MS) laserContinuo = true; 
  } else {
    drHighStart = 0;
    laserContinuo = false; 
  }

  if (!laserPresente && !capturandoPico && now > baselineFreezeUntil) {
    baselineR = BASE_ALPHA * mediaR_val + (1.0f - BASE_ALPHA) * baselineR;
  }

  bool detectouAgora = (dR > MIN_DELTA_ABS) && (dR > dG * LASER_DOMINANCE) && (!laserContinuo) && 
                       (!proporcional(dR, dG, PROPORTIONAL_TOL)) && (now - ultimoDisparoMs >= MIN_INTERVALO_DISPARO_MS);
  
  if (detectouAgora) {
    if (!laserPresente && !capturandoPico) {
      capturandoPico = true;
      laserPresente = true; picoEvento = r; picoStartTime = now; 
      ultimoDisparoMs = now; baselineFreezeUntil = now + 10;
    }
  } else if (dR < (MIN_DELTA_ABS / 2)) {
    laserPresente = false;
  }

  if (capturandoPico) {
    if (r > picoEvento) picoEvento = r;
    
    if (now - picoStartTime > WINDOW_PICO_MS) {
      capturandoPico = false;
      
      if (calibrating) {
            digitalWrite(LED_A_PIN, LOW); digitalWrite(LED_C_PIN, LOW);
            disparosCalib++;
            somaPicosCalib += picoEvento;
            lastShotMillis = now;
            
            Serial.printf("Disparo Calib %d/%d - Pico: %d\n", disparosCalib, limiteCalib, picoEvento);
            
            digitalWrite(LED_A_PIN, HIGH);
            delay(50); digitalWrite(LED_A_PIN, LOW);
            
            // --- LÓGICA MODO 5 DISPAROS (APENAS ALFA) ---
            if (limiteCalib == 5) {
                if (disparosCalib >= 5) {
                    picoLaser = somaPicosCalib / 5;
                    calibrating = false;
                    
                    preferences.putUInt("picoLaser", picoLaser);
                    Serial.println("Calibração Rápida Salva na Memória!");
                    
                    digitalWrite(LED_C_PIN, LOW);
                    Serial.printf("Calibração Finalizada. Pico Referência (Alfa): %d\n", picoLaser);
                }
            } 
            // --- LÓGICA MODO 10 DISPAROS (ALFA E CHARLIE) ---
            else if (limiteCalib == 10) {
                // Chegou na metade (5 tiros) - Salva Alfa e avisa para mudar
                if (disparosCalib == 5) {
                    picoLaser = somaPicosCalib / 5;
                    somaPicosCalib = 0; // Zera a soma para medir o Charlie agora
                    
                    Serial.printf("Faixa 1 (Alfa) calibrada: %d. Atire mais 5x para o Charlie.\n", picoLaser);
                    
                    // Pisca o LED C sem bloquear para avisar que mudou de fase
                    digitalWrite(LED_C_PIN, HIGH);
                    ledC_until = now + 600;
                } 
                // Chegou no final (10 tiros) - Salva Charlie e encerra
                else if (disparosCalib >= 10) {
                    picoLaser2 = somaPicosCalib / 5;
                    calibrating = false;
                    
                    preferences.putUInt("picoLaser", picoLaser);
                    preferences.putUInt("picoLaser2", picoLaser2);
                    
                    Serial.println("Calibração Avançada Salva na Memória!");
                    digitalWrite(LED_C_PIN, LOW);
                    Serial.printf("Calibração Finalizada. Alfa: %d | Charlie: %d\n", picoLaser, picoLaser2);
                }
            }
       } else {
          float f2, f3;

          // --- LÓGICA DE FAIXAS DINÂMICAS ---
          // Verifica se a calibração atual foi a Avançada (10 tiros) ou a Rápida (5 tiros)
          if (limiteCalib == 10) {
              // Regra para 10 disparos: Usa os dois picos medidos (Alfa e Charlie)
              float deltaAlfa = picoLaser - baselineR;
              float deltaCharlie = picoLaser2 - baselineR;

              // f3 (Alfa) = 20% do valor calibrado no centro (Margem de segurança para o A)
              f3 = baselineR + (deltaAlfa * 0.20f);
              // f2 (Charlie) = 60% do valor calibrado na borda (Margem para o C)
              f2 = baselineR + (deltaCharlie * 0.60f);
              
          } else {
              // Regra para 5 disparos: Usa apenas o pico principal (Alfa) e o tipo de Laser
              if (modoFaixa == CMD_SET_IR) {
                  f2 = baselineR + (picoLaser - baselineR) * 0.15f;
                  f3 = baselineR + (picoLaser - baselineR) * 0.38f;
              } else {
                  f2 = baselineR + (picoLaser - baselineR) * 0.04f;
                  f3 = baselineR + (picoLaser - baselineR) * 0.20f;
              }
          }

          // Classificação Final da Zona do Disparo
          char zona;
          if (picoEvento >= f3) zona = 'A';
          else if (picoEvento >= f2) zona = 'C';
          else zona = 'D';
          eventId++;
          uint32_t split = (lastShotMillis > 0) ? (now - lastShotMillis) : 0; lastShotMillis = now;
          
            if (ledEnabled) {
            if (isMetallic) {
                // Se for metálico, acende sempre o Azul (LED_A) no impacto
                digitalWrite(LED_A_PIN, HIGH);
                digitalWrite(LED_G_PIN, HIGH);
                digitalWrite(LED_C_PIN, HIGH);
                ledA_until = now + LED_DURATION;
                ledG_until = now + LED_DURATION;
                ledC_until = now + LED_DURATION;
            } else {
                // Lógica normal de pontuação IPSC
                if (zona == 'A') { digitalWrite(LED_G_PIN, HIGH); ledG_until = now + LED_DURATION; } 
                else if (zona == 'C') { digitalWrite(LED_A_PIN, HIGH); ledA_until = now + LED_DURATION; } 
                else { digitalWrite(LED_G_PIN, HIGH); digitalWrite(LED_C_PIN, HIGH); ledG_until = now + LED_DURATION; ledC_until = now + LED_DURATION; }  
            }
          }
          if (soundEnabled) { digitalWrite(LED_R11_PIN, HIGH);
            ledR11_until = now + LED_DURATION; } 
  sendShot(zona, (uint16_t)split, now - startMillis);
      }
    }
  } 
  static unsigned long lastRetry = 0;
  if (now - lastRetry > 200) {
    if (xSemaphoreTake(queueMutex, portMAX_DELAY)) {
        for (int i = 0; i < targetQueueCount; i++) {
            ShotEvent ev;
            ev.targetId = (uint8_t)myTargetId;
            ev.eventId  = targetQueue[i].eventId;
            ev.zone     = targetQueue[i].zone;
            ev.splitMs  = targetQueue[i].splitMs;
            ev.timeMs   = targetQueue[i].timeMs;
            
            uint8_t* destAddr = hasMasterAddr ? masterAddr : broadcastAddr;
            esp_now_send(destAddr, (uint8_t*)&ev, sizeof(ev));
        }
        xSemaphoreGive(queueMutex);
    }
    lastRetry = now;
  }

  if (ledC_until && now >= ledC_until) { digitalWrite(LED_C_PIN, LOW); ledC_until = 0; }
  if (ledG_until && now >= ledG_until) { digitalWrite(LED_G_PIN, LOW); ledG_until = 0; }
  if (ledA_until && now >= ledA_until) { digitalWrite(LED_A_PIN, LOW); ledA_until = 0; }
  if (ledR11_until && now >= ledR11_until) { digitalWrite(LED_R11_PIN, LOW); ledR11_until = 0; }
}