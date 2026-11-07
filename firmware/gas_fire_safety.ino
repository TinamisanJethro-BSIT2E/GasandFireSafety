/*
  IoT-Based Gas Leakage and Fire Safety System
  Requires ArduinoJson, ESP32Servo, and LiquidCrystal_I2C libraries.

  SAFETY: Test this educational prototype with safe sensor simulations and
  supervised, isolated loads. Do not connect life-safety equipment until a
  qualified engineer has validated hardware, power, fail-safe states, and code.
*/
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <Wire.h>

// -------------------------- USER CONFIGURATION -----------------------------
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SERVER_BASE_URL = "http://192.168.1.100:3000";
const char *DEVICE_API_KEY = "change-this-device-api-key";
const char *ALERT_PHONE_NUMBER = "+639XXXXXXXXX";

// ESP32 pin map. MQ-6 analog output must be voltage-limited for the ESP32 ADC.
constexpr int PIN_MQ6_ADC = 34;       // ADC1 input-only pin
constexpr int PIN_FLAME_DIGITAL = 27; // Most flame modules assert LOW
constexpr int PIN_RELAY_FAN = 26;     // Relay module default active LOW
constexpr int PIN_RELAY_PUMP = 25;    // Relay module default active LOW
constexpr int PIN_BUZZER = 33;        // Use a driver if required by the buzzer
constexpr int PIN_VALVE_SERVO = 18;   // Servo mechanically closes gas valve at 0 deg
constexpr int PIN_I2C_SDA = 21;       // 16x2 LCD SDA
constexpr int PIN_I2C_SCL = 22;       // 16x2 LCD SCL
constexpr int PIN_GSM_RX = 16;        // ESP32 RX2 <- GSM TX
constexpr int PIN_GSM_TX = 17;        // ESP32 TX2 -> GSM RX (level shift if needed)
constexpr int PIN_RELAY_ON = LOW;
constexpr int PIN_RELAY_OFF = HIGH;
constexpr bool FLAME_ACTIVE_LOW = true;
constexpr int VALVE_OPEN_ANGLE = 90;
constexpr int VALVE_CLOSED_ANGLE = 0;
constexpr uint32_t DEFAULT_GAS_THRESHOLD = 1800; // Raw ADC counts; calibrate on hardware
constexpr uint32_t DEFAULT_DETECTION_DELAY_SECONDS = 5;
constexpr uint32_t CONFIG_POLL_MS = 30000;
constexpr uint32_t DATA_REPORT_MS = 2500;
constexpr uint32_t COMMAND_POLL_MS = 5000;
constexpr uint32_t GAS_CLEAR_HYSTERESIS_PERCENT = 90;
// Wiring: use suitable power supplies for relay loads, servo and GSM modem.
// SIM800L must have a dedicated supply capable of its current bursts; never use
// the ESP32 3.3V pin. Check LCD and sensor logic voltages before connecting.
// ---------------------------------------------------------------------------

struct Telemetry {
  int gasValue;
  bool flameDetected;
  bool fanOn;
  bool pumpOn;
  bool buzzerOn;
  bool regulatorOpen;
  bool gasAlarm;
  bool fireAlarm;
  char status[20];
};

struct DeviceEvent {
  char type[20];
  int gasValue;
  char actions[160];
};

Preferences preferences;
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo valveServo;
HardwareSerial gsm(2);
QueueHandle_t eventQueue;
QueueHandle_t commandQueue;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
Telemetry telemetry = {};
uint32_t gasThreshold = DEFAULT_GAS_THRESHOLD;
uint32_t detectionDelaySeconds = DEFAULT_DETECTION_DELAY_SECONDS;
uint32_t gasCandidateAt = 0;
uint32_t fireCandidateAt = 0;
uint32_t lastLcdUpdate = 0;
uint32_t buzzerTestUntil = 0;
uint8_t displayPage = 0;
bool gasAlarmActive = false;
bool fireAlarmActive = false;
bool valveWasClosed = false;
bool lastGasAlarm = false;
bool lastFireAlarm = false;

void queueEvent(const char *type, const char *actions, int gasValue) {
  DeviceEvent event = {};
  strlcpy(event.type, type, sizeof(event.type));
  event.gasValue = gasValue;
  strlcpy(event.actions, actions, sizeof(event.actions));
  if (!eventQueue || xQueueSend(eventQueue, &event, 0) != pdTRUE) {
    Serial.println("Warning: alarm event queue full; event could not be queued");
  }
}

bool flameIsDetected() {
  const int value = digitalRead(PIN_FLAME_DIGITAL);
  return FLAME_ACTIVE_LOW ? value == LOW : value == HIGH;
}

void setRelay(int pin, bool enabled) {
  digitalWrite(pin, enabled ? PIN_RELAY_ON : PIN_RELAY_OFF);
}

void updateDisplay(const Telemetry &state) {
  lcd.setCursor(0, 0);
  if (state.fireAlarm) lcd.print("FIRE DETECTED   ");
  else if (state.gasAlarm) lcd.print("GAS LEAK        ");
  else lcd.print("System Normal   ");
  lcd.setCursor(0, 1);
  char line[17];
  if (displayPage == 0) {
    snprintf(line, sizeof(line), "G:%4d F:%s", state.gasValue, state.flameDetected ? "YES" : "NO");
  } else if (displayPage == 1) {
    snprintf(line, sizeof(line), "Fan:%s Pump:%s", state.fanOn ? "ON" : "OFF", state.pumpOn ? "ON" : "OFF");
  } else {
    snprintf(line, sizeof(line), "Bz:%s V:%s", state.buzzerOn ? "ON" : "OFF", state.regulatorOpen ? "OPEN" : "CLOSED");
  }
  lcd.print(line);
  for (size_t i = strlen(line); i < 16; i++) lcd.print(' ');
}

void applyLocalSafetyLogic() {
  const uint32_t now = millis();
  uint32_t activeThreshold;
  uint32_t activeDelay;
  portENTER_CRITICAL(&stateMux);
  activeThreshold = gasThreshold;
  activeDelay = detectionDelaySeconds;
  portEXIT_CRITICAL(&stateMux);
  const int gasValue = analogRead(PIN_MQ6_ADC);
  const bool flame = flameIsDetected();
  const bool gasAbove = gasValue >= activeThreshold;
  const bool gasSafe = gasValue < (activeThreshold * GAS_CLEAR_HYSTERESIS_PERCENT / 100);

  if (!gasAlarmActive && gasAbove) {
    if (gasCandidateAt == 0) gasCandidateAt = now;
    if (now - gasCandidateAt >= activeDelay * 1000UL) gasAlarmActive = true;
  } else if (!gasAbove) {
    gasCandidateAt = 0;
  }

  if (!fireAlarmActive && flame) {
    if (fireCandidateAt == 0) fireCandidateAt = now;
    if (now - fireCandidateAt >= activeDelay * 1000UL) fireAlarmActive = true;
  } else if (!flame) {
    fireCandidateAt = 0;
  }

  if (gasAlarmActive && !gasSafe) {
    // Keep the alarm latched through the hysteresis band.
  } else if (gasAlarmActive && gasSafe && !flame) {
    gasAlarmActive = false;
  }
  if (fireAlarmActive && !flame && gasSafe) fireAlarmActive = false;

  const bool fan = gasAlarmActive;
  const bool pump = fireAlarmActive;
  const bool buzzer = gasAlarmActive || fireAlarmActive || now < buzzerTestUntil;
  const bool closeValve = gasAlarmActive || fireAlarmActive;

  setRelay(PIN_RELAY_FAN, fan);
  setRelay(PIN_RELAY_PUMP, pump);
  digitalWrite(PIN_BUZZER, buzzer ? HIGH : LOW);
  if (closeValve != valveWasClosed) {
    valveServo.write(closeValve ? VALVE_CLOSED_ANGLE : VALVE_OPEN_ANGLE);
    valveWasClosed = closeValve;
  }

  Telemetry state = {};
  state.gasValue = gasValue;
  state.flameDetected = flame;
  state.fanOn = fan;
  state.pumpOn = pump;
  state.buzzerOn = buzzer;
  state.regulatorOpen = !closeValve;
  state.gasAlarm = gasAlarmActive;
  state.fireAlarm = fireAlarmActive;
  strlcpy(state.status, fireAlarmActive ? "Fire Detected" : gasAlarmActive ? "Gas Leak" : "Normal", sizeof(state.status));
  portENTER_CRITICAL(&stateMux);
  telemetry = state;
  portEXIT_CRITICAL(&stateMux);

  if (gasAlarmActive && !lastGasAlarm) {
    queueEvent("Gas Leak", "gas regulator closed, exhaust fan on, buzzer on", gasValue);
  }
  if (fireAlarmActive && !lastFireAlarm) {
    queueEvent("Fire Detected", "gas regulator closed, water pump on, buzzer on", gasValue);
  }
  if ((!gasAlarmActive && lastGasAlarm) || (!fireAlarmActive && lastFireAlarm)) {
    queueEvent("Cleared", "readings returned to safe range; automatic controls reset", gasValue);
  }
  lastGasAlarm = gasAlarmActive;
  lastFireAlarm = fireAlarmActive;
  if (now - lastLcdUpdate >= 1500) {
    displayPage = (displayPage + 1) % 3;
    updateDisplay(state);
    lastLcdUpdate = now;
  }

  bool runBuzzerTest = false;
  if (commandQueue && xQueueReceive(commandQueue, &runBuzzerTest, 0) == pdTRUE) {
    if (runBuzzerTest && !gasAlarmActive && !fireAlarmActive) buzzerTestUntil = now + 1500;
  }
}

void sendSms(const char *eventType, int gasValue) {
  if (strlen(ALERT_PHONE_NUMBER) < 8 || strchr(ALERT_PHONE_NUMBER, 'X')) return;
  gsm.println("AT");
  delay(250);
  gsm.println("AT+CMGF=1");
  delay(250);
  gsm.print("AT+CMGS=\"");
  gsm.print(ALERT_PHONE_NUMBER);
  gsm.println("\"");
  delay(500);
  gsm.print("Gas/fire safety alert: ");
  gsm.print(eventType);
  gsm.print(". MQ-6 raw ADC=");
  gsm.print(gasValue);
  gsm.print(". ESP32 safety controls activated.");
  gsm.write(26);
  delay(2500);
}

bool postEvent(const DeviceEvent &event) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  HTTPClient http;
  const String url = String(SERVER_BASE_URL) + "/api/device/event";
  if (!http.begin(client, url)) return false;
  http.setTimeout(800);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-api-key", DEVICE_API_KEY);
  StaticJsonDocument<384> document;
  document["event_type"] = event.type;
  document["gas_value"] = event.gasValue;
  JsonArray actions = document.createNestedArray("actions");
  actions.add(event.actions);
  String body;
  serializeJson(document, body);
  const int result = http.POST(body);
  if (result < 200 || result >= 300) Serial.printf("Event report failed: HTTP %d\n", result);
  http.end();
  return result >= 200 && result < 300;
}

void reportTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;
  Telemetry state;
  portENTER_CRITICAL(&stateMux);
  state = telemetry;
  portEXIT_CRITICAL(&stateMux);

  WiFiClient client;
  HTTPClient http;
  const String url = String(SERVER_BASE_URL) + "/api/device/data";
  if (!http.begin(client, url)) return;
  http.setTimeout(800);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-api-key", DEVICE_API_KEY);
  StaticJsonDocument<384> document;
  document["gas_value"] = state.gasValue;
  document["flame_detected"] = state.flameDetected;
  document["status"] = state.status;
  document["fan_on"] = state.fanOn;
  document["pump_on"] = state.pumpOn;
  document["buzzer_on"] = state.buzzerOn;
  document["regulator_open"] = state.regulatorOpen;
  String body;
  serializeJson(document, body);
  const int result = http.POST(body);
  if (result < 200 || result >= 300) Serial.printf("Telemetry report failed: HTTP %d\n", result);
  http.end();
}

void fetchConfiguration() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, String(SERVER_BASE_URL) + "/api/device/config")) return;
  http.setTimeout(800);
  http.addHeader("x-device-api-key", DEVICE_API_KEY);
  const int result = http.GET();
  if (result == HTTP_CODE_OK) {
    StaticJsonDocument<128> document;
    const DeserializationError error = deserializeJson(document, http.getString());
    const uint32_t threshold = document["gas_threshold"] | 0;
    const uint32_t delaySeconds = document["detection_delay"] | 0;
    if (!error && threshold >= 100 && threshold <= 4095 && delaySeconds >= 1 && delaySeconds <= 60) {
      portENTER_CRITICAL(&stateMux);
      gasThreshold = threshold;
      detectionDelaySeconds = delaySeconds;
      portEXIT_CRITICAL(&stateMux);
      preferences.putUInt("threshold", threshold);
      preferences.putUInt("delay", delaySeconds);
    }
  } else if (result < 0) {
    Serial.printf("Config fetch failed: %s\n", http.errorToString(result).c_str());
  }
  http.end();
}

void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, String(SERVER_BASE_URL) + "/api/device/commands")) return;
  http.setTimeout(800);
  http.addHeader("x-device-api-key", DEVICE_API_KEY);
  const int result = http.GET();
  if (result == HTTP_CODE_OK) {
    StaticJsonDocument<192> document;
    if (deserializeJson(document, http.getString()) == DeserializationError::Ok && !document["command"].isNull()) {
      const long id = document["command"]["id"] | 0;
      const char *command = document["command"]["command"] | "";
      if (id > 0 && strcmp(command, "buzzer_test") == 0) {
        bool requestTest = true;
        const bool queued = commandQueue && xQueueSend(commandQueue, &requestTest, 0) == pdTRUE;
        http.end();
        WiFiClient ackClient;
        HTTPClient ack;
        const String ackUrl = String(SERVER_BASE_URL) + "/api/device/commands/" + id + "/complete";
        if (ack.begin(ackClient, ackUrl)) {
          ack.setTimeout(800);
          ack.addHeader("Content-Type", "application/json");
          ack.addHeader("x-device-api-key", DEVICE_API_KEY);
          const int ackResult = ack.POST(queued ? "{\"success\":true}" : "{\"success\":false}");
          if (ackResult < 200 || ackResult >= 300) Serial.printf("Command acknowledgement failed: HTTP %d\n", ackResult);
          ack.end();
        }
        return;
      }
    }
  } else if (result < 0) {
    Serial.printf("Command poll failed: %s\n", http.errorToString(result).c_str());
  }
  http.end();
}

void networkTask(void *parameter) {
  uint32_t lastData = 0;
  uint32_t lastConfig = 0;
  uint32_t lastCommand = 0;
  uint32_t lastReconnect = 0;
  uint32_t lastEventReport = 0;
  DeviceEvent pendingEvent = {};
  bool hasPendingEvent = false;
  bool smsAttempted = false;
  for (;;) {
    const uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED && now - lastReconnect >= 10000) {
      WiFi.reconnect();
      lastReconnect = now;
    }
    if (!hasPendingEvent && eventQueue && xQueueReceive(eventQueue, &pendingEvent, 0) == pdTRUE) {
      hasPendingEvent = true;
      smsAttempted = false;
      lastEventReport = now - 3000;
    }
    if (hasPendingEvent) {
      if (!smsAttempted) {
        if (strcmp(pendingEvent.type, "Gas Leak") == 0 || strcmp(pendingEvent.type, "Fire Detected") == 0) {
          sendSms(pendingEvent.type, pendingEvent.gasValue);
        }
        smsAttempted = true;
      }
      if (WiFi.status() == WL_CONNECTED && now - lastEventReport >= 3000) {
        if (postEvent(pendingEvent)) {
          hasPendingEvent = false;
          smsAttempted = false;
        } else {
          lastEventReport = now;
        }
      }
    }
    if (WiFi.status() == WL_CONNECTED) {
      if (now - lastData >= DATA_REPORT_MS) { reportTelemetry(); lastData = now; }
      if (now - lastConfig >= CONFIG_POLL_MS) { fetchConfiguration(); lastConfig = now; }
      if (now - lastCommand >= COMMAND_POLL_MS) { pollCommands(); lastCommand = now; }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_MQ6_ADC, INPUT);
  analogReadResolution(12);
  pinMode(PIN_FLAME_DIGITAL, INPUT_PULLUP);
  pinMode(PIN_RELAY_FAN, OUTPUT);
  pinMode(PIN_RELAY_PUMP, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  setRelay(PIN_RELAY_FAN, false);
  setRelay(PIN_RELAY_PUMP, false);
  digitalWrite(PIN_BUZZER, LOW);
  valveServo.attach(PIN_VALVE_SERVO);
  valveServo.write(VALVE_OPEN_ANGLE);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Gas Safety Boot");
  lcd.setCursor(0, 1);
  lcd.print("Local logic ON");

  gsm.begin(9600, SERIAL_8N1, PIN_GSM_RX, PIN_GSM_TX);
  preferences.begin("gas-safety", false);
  gasThreshold = preferences.getUInt("threshold", DEFAULT_GAS_THRESHOLD);
  detectionDelaySeconds = preferences.getUInt("delay", DEFAULT_DETECTION_DELAY_SECONDS);
  if (gasThreshold < 100 || gasThreshold > 4095) gasThreshold = DEFAULT_GAS_THRESHOLD;
  if (detectionDelaySeconds < 1 || detectionDelaySeconds > 60) detectionDelaySeconds = DEFAULT_DETECTION_DELAY_SECONDS;
  eventQueue = xQueueCreate(8, sizeof(DeviceEvent));
  commandQueue = xQueueCreate(2, sizeof(bool));

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  xTaskCreatePinnedToCore(networkTask, "network", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  applyLocalSafetyLogic();
  delay(20);
}
