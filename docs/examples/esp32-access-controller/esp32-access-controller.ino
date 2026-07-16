/*
 * TrasterOS — Controlador de acceso de ejemplo para ESP32 (Patrón A)
 * -----------------------------------------------------------------------------
 * El inquilino teclea su PIN en un teclado 4x4 y pulsa '#'. El ESP32 valida el
 * PIN contra TrasterOS (POST /v1/access/verify) y, si la respuesta es
 * "allowed": true, da un pulso al relé que abre el cerradero/cancela.
 *
 * Comentarios en español; identificadores en inglés (convención del proyecto).
 *
 * Librerías necesarias (Arduino IDE → Gestor de librerías):
 *   - ArduinoJson  (Benoit Blanchon)
 *   - Keypad       (Mark Stanley, Alexander Brevig)
 * WiFi.h, WiFiClientSecure.h y HTTPClient.h vienen con el core de ESP32.
 *
 * Placa: "ESP32 Dev Module".
 */

#include <Arduino.h>
#include <Keypad.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ============================ CONFIG (EDITAR) ================================

// --- WiFi ---
static const char* WIFI_SSID = "TU_WIFI";
static const char* WIFI_PASS = "TU_PASSWORD";

// --- TrasterOS ---
// Host de tu API (sin https:// ni barra final), p. ej. "api.tudominio.com".
static const char* API_HOST = "api.tudominio.com";
static const int   API_PORT = 443;
// El "Hardware ID" que pusiste al crear el dispositivo en el panel.
static const char* DEVICE_ID = "gate-entrada-01";
// La API key revelada UNA sola vez al crear el dispositivo (X-Device-Key).
static const char* DEVICE_KEY = "PEGA_AQUI_LA_DEVICE_KEY";

// --- Hardware ---
static const int RELAY_PIN = 13;       // GPIO al relé que abre la cerradura
static const int STATUS_LED = 2;       // LED integrado (estado/feedback)
static const int RELAY_OPEN_MS = 2000; // duración del pulso de apertura (ms)
static const bool RELAY_ACTIVE_HIGH = true; // true: HIGH abre; algunos relés son al revés

// --- Teclado 4x4 ---
const byte ROWS = 4;
const byte COLS = 4;
char KEYS[ROWS][COLS] = {
  { '1', '2', '3', 'A' },
  { '4', '5', '6', 'B' },
  { '7', '8', '9', 'C' },
  { '*', '0', '#', 'D' },
};
byte ROW_PINS[ROWS] = { 19, 18, 5, 17 };  // filas → GPIO
byte COL_PINS[COLS] = { 16, 4, 14, 12 };  // columnas → GPIO

// ============================================================================

Keypad keypad = Keypad(makeKeymap(KEYS), ROW_PINS, COL_PINS, ROWS, COLS);

String pinBuffer = "";
unsigned long lastVerifyMs = 0;
static const unsigned long MIN_GAP_MS = 800; // antirebote entre intentos

void setRelay(bool open) {
  digitalWrite(RELAY_PIN, (open == RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

void connectWifi() {
  Serial.printf("[wifi] Conectando a %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n[wifi] OK, IP: %s\n", WiFi.localIP().toString().c_str());
}

void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED, HIGH);
    delay(ms);
    digitalWrite(STATUS_LED, LOW);
    delay(ms);
  }
}

void openDoor() {
  Serial.println("[door] ABRIR (pulso relé)");
  setRelay(true);
  digitalWrite(STATUS_LED, HIGH);
  delay(RELAY_OPEN_MS);
  setRelay(false);
  digitalWrite(STATUS_LED, LOW);
}

/**
 * Llama a POST /v1/access/verify con el PIN tecleado. Devuelve true si la API
 * responde { "allowed": true }.
 */
bool verifyPin(const String& pin) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }

  WiFiClientSecure client;
  // Arranque rápido: sin validar el certificado del servidor.
  // PRODUCCIÓN: sustituye por client.setCACert(ROOT_CA_PEM) con la CA de tu
  // dominio (Let's Encrypt ISRG Root X1) para evitar ataques MITM.
  client.setInsecure();

  HTTPClient http;
  String url = String("https://") + API_HOST + "/v1/access/verify";
  if (!http.begin(client, API_HOST, API_PORT, "/v1/access/verify", true)) {
    Serial.println("[verify] http.begin falló");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  http.setTimeout(8000);

  // Cuerpo: { "method":"pin", "credential":"<pin>", "deviceId":"<hwid>" }
  StaticJsonDocument<256> reqDoc;
  reqDoc["method"] = "pin";
  reqDoc["credential"] = pin;
  reqDoc["deviceId"] = DEVICE_ID;
  String reqBody;
  serializeJson(reqDoc, reqBody);

  int status = http.POST(reqBody);
  if (status <= 0) {
    Serial.printf("[verify] error de red: %s\n", http.errorToString(status).c_str());
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();
  Serial.printf("[verify] HTTP %d → %s\n", status, payload.c_str());

  if (status == 401) {
    Serial.println("[verify] 401: revisa DEVICE_KEY / DEVICE_ID");
    return false;
  }
  if (status != 200) return false;

  StaticJsonDocument<256> resDoc;
  if (deserializeJson(resDoc, payload)) {
    Serial.println("[verify] respuesta no es JSON válido");
    return false;
  }
  bool allowed = resDoc["allowed"] | false;
  const char* result = resDoc["result"] | "";
  if (!allowed) {
    Serial.printf("[verify] denegado: %s\n", result);
  }
  return allowed;
}

void handleSubmit() {
  if (pinBuffer.length() == 0) return;
  unsigned long now = millis();
  if (now - lastVerifyMs < MIN_GAP_MS) {
    pinBuffer = "";
    return;
  }
  lastVerifyMs = now;

  String pin = pinBuffer;
  pinBuffer = "";
  Serial.printf("[keypad] PIN enviado (%d díg)\n", pin.length());

  if (verifyPin(pin)) {
    openDoor();
  } else {
    blink(3, 120); // feedback de rechazo
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(RELAY_PIN, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);
  setRelay(false); // arrancar cerrado
  digitalWrite(STATUS_LED, LOW);

  keypad.setDebounceTime(40);
  connectWifi();
  Serial.println("[ready] Teclea tu PIN y pulsa '#'  (· '*' borra)");
  blink(2, 80);
}

void loop() {
  char key = keypad.getKey();
  if (!key) return;

  if (key == '#') {
    handleSubmit();
  } else if (key == '*') {
    pinBuffer = ""; // borrar
    Serial.println("[keypad] borrado");
  } else {
    if (pinBuffer.length() < 16) pinBuffer += key;
  }
}
