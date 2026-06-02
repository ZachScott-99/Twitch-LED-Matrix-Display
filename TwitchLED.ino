/**
 * TwitchLED.ino
 *
 * ESP32 firmware for 9x MAX7219 8x8 LED matrix display.
 * Connects to your home Wi-Fi, opens a WebSocket connection to your
 * backend server, and scrolls Twitch stats + alerts across the display.
 *
 * ── Libraries required (install via Arduino Library Manager) ──────────────────
 *   - MD_Parola      by MajicDesigns  (search "MD_Parola")
 *   - MD_MAX72XX     by MajicDesigns  (search "MD_MAX72XX")
 *   - ArduinoJson    by Benoit Blanchon (search "ArduinoJson")
 *   - ArduinoWebsockets by Gil Maimon  (search "ArduinoWebsockets")
 *   - WiFi           (built-in with ESP32 board package)
 *
 * ── Wiring ────────────────────────────────────────────────────────────────────
 *   MAX7219 VCC  → 5V  (use external PSU for 9 modules, share GND)
 *   MAX7219 GND  → GND (common with ESP32 GND)
 *   MAX7219 DIN  → GPIO 23  (ESP32 MOSI / SPI)
 *   MAX7219 CLK  → GPIO 18  (ESP32 SCK  / SPI)
 *   MAX7219 CS   → GPIO 5   (ESP32 chip select)
 *   Chain: DOUT of module 1 → DIN of module 2, etc.
 *
 * ── Board setup in Arduino IDE ────────────────────────────────────────────────
 *   Board: "ESP32 Dev Module"
 *   Upload Speed: 921600
 *   Flash Size: 4MB
 *   Partition Scheme: "Default 4MB with spiffs"
 */

#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>
#include <MD_Parola.h>
#include <MD_MAX72xx.h>
#include <SPI.h>

// ─── USER CONFIGURATION ──────────────────────────────────────────────────────
// Change these to match your setup

#define WIFI_SSID       "YourWiFiNetworkName"
#define WIFI_PASSWORD   "YourWiFiPassword"

// IP address of your PC running server.js
// Find it on Windows: open CMD and type "ipconfig"
// Find it on Mac/Linux: open terminal and type "ifconfig"
#define WS_HOST         "192.168.1.100"
#define WS_PORT         3001

// Display brightness 0–15 (15 = max brightness)
#define DISPLAY_BRIGHTNESS  7

// Scroll speed — lower = faster (recommended 30–80)
#define SCROLL_SPEED    40

// ─── HARDWARE CONFIG ─────────────────────────────────────────────────────────
#define HARDWARE_TYPE   MD_MAX72XX::FC16_HW  // Most HiLetgo modules use FC16
#define NUM_DEVICES     9                     // Number of MAX7219 modules
#define CLK_PIN         18
#define DATA_PIN        23
#define CS_PIN          5

// ─── Message queue ────────────────────────────────────────────────────────────
#define QUEUE_SIZE      10

struct DisplayMessage {
  char text[256];
  bool isAlert;        // Alerts jump the queue and display immediately
  unsigned long displayMs;
};

DisplayMessage messageQueue[QUEUE_SIZE];
int queueHead = 0;
int queueTail = 0;
int queueCount = 0;

// Current message state
char currentText[256] = "Connecting...";
bool displayReady = true;   // True when Parola has finished scrolling
bool alertPending = false;
DisplayMessage pendingAlert;

// ─── Timing ───────────────────────────────────────────────────────────────────
unsigned long lastReconnectAttempt = 0;
unsigned long messageStartTime = 0;
unsigned long currentDisplayMs = 8000;
#define RECONNECT_INTERVAL 5000  // Try to reconnect every 5 seconds

// ─── Object instances ─────────────────────────────────────────────────────────
MD_Parola display = MD_Parola(HARDWARE_TYPE, DATA_PIN, CLK_PIN, CS_PIN, NUM_DEVICES);
using namespace websockets;
WebsocketsClient wsClient;
bool wsConnected = false;

// ─────────────────────────────────────────────────────────────────────────────
// Message queue functions
// ─────────────────────────────────────────────────────────────────────────────

bool enqueue(const char* text, bool isAlert, unsigned long displayMs) {
  if (queueCount >= QUEUE_SIZE) {
    Serial.println("[Queue] Full — dropping oldest message");
    // Drop oldest non-alert message to make room
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
  }
  DisplayMessage& msg = messageQueue[queueTail];
  strncpy(msg.text, text, sizeof(msg.text) - 1);
  msg.text[sizeof(msg.text) - 1] = '\0';
  msg.isAlert = isAlert;
  msg.displayMs = displayMs;
  queueTail = (queueTail + 1) % QUEUE_SIZE;
  queueCount++;
  return true;
}

bool dequeue(DisplayMessage& out) {
  if (queueCount == 0) return false;
  out = messageQueue[queueHead];
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  queueCount--;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

void showText(const char* text, unsigned long displayMs) {
  strncpy(currentText, text, sizeof(currentText) - 1);
  currentText[sizeof(currentText) - 1] = '\0';
  currentDisplayMs = displayMs;
  messageStartTime = millis();
  displayReady = false;

  display.displayClear();
  display.displayScroll(currentText, PA_LEFT, PA_SCROLL_LEFT, SCROLL_SPEED);

  Serial.print("[Display] Showing: ");
  Serial.println(currentText);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket callbacks
// ─────────────────────────────────────────────────────────────────────────────

void onWebSocketMessage(WebsocketsMessage msg) {
  Serial.print("[WS] Received: ");
  Serial.println(msg.data());

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg.data());
  if (err) {
    Serial.print("[WS] JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  const char* type      = doc["type"]      | "unknown";
  const char* text      = doc["text"]      | "";
  unsigned long dispMs  = doc["displayMs"] | 8000UL;

  // Ignore pings
  if (strcmp(type, "ping") == 0) return;

  // Alerts get priority — stored separately and shown immediately
  if (strcmp(type, "alert") == 0) {
    alertPending = true;
    strncpy(pendingAlert.text, text, sizeof(pendingAlert.text) - 1);
    pendingAlert.text[sizeof(pendingAlert.text) - 1] = '\0';
    pendingAlert.isAlert = true;
    pendingAlert.displayMs = dispMs;
    Serial.print("[Queue] Alert queued: ");
    Serial.println(text);
    return;
  }

  // Stats and commands go into the rotation queue
  enqueue(text, false, dispMs);
  Serial.print("[Queue] Enqueued: ");
  Serial.println(text);
}

void onWebSocketEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("[WS] Connected to backend server!");
    wsConnected = true;
    display.displayClear();
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    Serial.println("[WS] Disconnected from backend server.");
    wsConnected = false;
    // Show reconnecting message
    display.displayClear();
    display.displayScroll("Reconnecting...", PA_LEFT, PA_SCROLL_LEFT, SCROLL_SPEED);
  } else if (event == WebsocketsEvent::GotPing) {
    wsClient.pong();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wi-Fi connection
// ─────────────────────────────────────────────────────────────────────────────

void connectWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.print(WIFI_SSID);
  Serial.print(" ");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Show dots on display while connecting
  int dotPos = 0;
  char dotBuf[32];
  unsigned long start = millis();

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");

    // Animate display
    snprintf(dotBuf, sizeof(dotBuf), "WiFi");
    for (int i = 0; i <= dotPos; i++) strncat(dotBuf, ".", sizeof(dotBuf) - strlen(dotBuf) - 1);
    display.displayClear();
    display.print(dotBuf);
    dotPos = (dotPos + 1) % 4;

    if (millis() - start > 30000) {
      Serial.println("\n[WiFi] Timeout. Restarting...");
      ESP.restart();
    }
  }

  Serial.println();
  Serial.print("[WiFi] Connected! IP: ");
  Serial.println(WiFi.localIP());
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket connection
// ─────────────────────────────────────────────────────────────────────────────

void connectWebSocket() {
  Serial.print("[WS] Connecting to ws://");
  Serial.print(WS_HOST);
  Serial.print(":");
  Serial.println(WS_PORT);

  wsClient.onMessage(onWebSocketMessage);
  wsClient.onEvent(onWebSocketEvent);

  char wsUrl[64];
  snprintf(wsUrl, sizeof(wsUrl), "ws://%s:%d", WS_HOST, WS_PORT);
  bool ok = wsClient.connect(wsUrl);

  if (!ok) {
    Serial.println("[WS] Connection failed. Will retry...");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arduino setup()
// ─────────────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n========================================");
  Serial.println("  Twitch LED Matrix Display");
  Serial.println("========================================\n");

  // ── Initialize display ──
  display.begin();
  display.setIntensity(DISPLAY_BRIGHTNESS);
  display.setTextAlignment(PA_LEFT);
  display.displayClear();
  display.print("Starting...");
  Serial.println("[Display] MAX7219 initialized");

  // ── Connect to Wi-Fi ──
  connectWiFi();

  // ── Connect WebSocket to backend ──
  connectWebSocket();
}

// ─────────────────────────────────────────────────────────────────────────────
// Arduino loop()
// ─────────────────────────────────────────────────────────────────────────────

void loop() {
  // ── Maintain WebSocket connection ──
  if (wsConnected) {
    wsClient.poll();
  } else {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > RECONNECT_INTERVAL) {
      lastReconnectAttempt = now;
      Serial.println("[WS] Attempting reconnect...");
      if (WiFi.status() != WL_CONNECTED) {
        connectWiFi();
      }
      connectWebSocket();
    }
  }

  // ── Drive the Parola display state machine ──
  if (display.displayAnimate()) {
    // Parola signals true when the current scroll animation finishes

    bool hasTimedOut = (millis() - messageStartTime) >= currentDisplayMs;

    // Priority: show a pending alert immediately
    if (alertPending) {
      alertPending = false;
      showText(pendingAlert.text, pendingAlert.displayMs);
      return;
    }

    // If the message's display time has elapsed, move to next in queue
    if (hasTimedOut) {
      DisplayMessage next;
      if (dequeue(next)) {
        showText(next.text, next.displayMs);
      } else {
        // Queue empty — re-scroll the current text
        messageStartTime = millis();
        display.displayReset();
      }
    } else {
      // Re-scroll the same message (it finished one pass but time isn't up)
      display.displayReset();
    }
  }
}
