#include "link.h"

#include <ArduinoJson.h>
#include <M5Unified.h>

#include "config.h"

namespace {
constexpr uint32_t WIFI_RETRY_MS = 5000;
constexpr uint32_t CONNECT_RETRY_MS = 4000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 1500;
constexpr uint32_t DISCOVERY_TIMEOUT_MS = 2200;
constexpr uint32_t BEAT_TIMEOUT_MS = 26000;
constexpr uint32_t STATUS_INTERVAL_MS = 60000;

const char *kNamespace = "dsh-stopwatch";
}  // namespace

void Link::begin(LinkListener *listener) {
  listener_ = listener;
  bootMs_ = millis();
  prefs_.begin(kNamespace, false);
  loadHost();

  configured_ = strlen(STOPWATCH_WIFI_SSID) > 0;
  if (!configured_) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.setHostname(STOPWATCH_DEVICE_ID);
  connectWifi();
  readBattery();
}

void Link::loop() {
  if (!configured_) return;

  const bool up = WiFi.status() == WL_CONNECTED;
  if (up != wifiUp_) {
    wifiUp_ = up;
    if (!up) {
      connected_ = false;
      client_.stop();
      listener_->onLinkDisconnected();
    } else {
      rssi_ = static_cast<int8_t>(WiFi.RSSI());
    }
  }

  if (!wifiUp_) {
    static uint32_t lastTry = 0;
    if (millis() - lastTry > WIFI_RETRY_MS) {
      lastTry = millis();
      connectWifi();
    }
    return;
  }

  if (!connected_) {
    if (millis() - lastConnectAttempt_ < CONNECT_RETRY_MS) return;
    lastConnectAttempt_ = millis();
    if (host_[0] == 0 && !discoverHost(DISCOVERY_TIMEOUT_MS)) return;
    if (!connectHost()) {
      if (!discoverHost(DISCOVERY_TIMEOUT_MS)) return;
      connectHost();
    }
    return;
  }

  if (!client_.connected()) {
    connected_ = false;
    listener_->onLinkDisconnected();
    return;
  }

  readSocket();

  if (millis() - lastBeat_ > BEAT_TIMEOUT_MS) {
    client_.stop();
    connected_ = false;
    listener_->onLinkDisconnected();
    return;
  }

  if (millis() - lastStatus_ > STATUS_INTERVAL_MS) {
    lastStatus_ = millis();
    readBattery();
    sendStatus();
  }
}

void Link::connectWifi() {
  WiFi.begin(STOPWATCH_WIFI_SSID, STOPWATCH_WIFI_PASS);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
    delay(120);
  }
  wifiUp_ = WiFi.status() == WL_CONNECTED;
  if (wifiUp_) rssi_ = static_cast<int8_t>(WiFi.RSSI());
}

void Link::loadHost() {
  prefs_.getString("host", host_, sizeof(host_));
  port_ = prefs_.getUShort("port", 0);
  prefs_.getString("token", token_, sizeof(token_));
}

void Link::saveHost() {
  prefs_.putString("host", host_);
  prefs_.putUShort("port", port_);
  prefs_.putString("token", token_);
}

bool Link::discoverHost(uint32_t timeoutMs) {
  udp_.begin(0);
  const IPAddress broadcast(255, 255, 255, 255);
  udp_.beginPacket(broadcast, STOPWATCH_DISCOVERY_PORT);
  static const char kDiscover[] = "{\"t\":\"discover\",\"proto\":1}";
  udp_.write(reinterpret_cast<const uint8_t*>(kDiscover), strlen(kDiscover));
  if (udp_.endPacket() == 0) {
    udp_.stop();
    return false;
  }

  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    const int size = udp_.parsePacket();
    if (size > 0) {
      char buffer[256];
      const int read = udp_.read(buffer, sizeof(buffer) - 1);
      if (read > 0) {
        buffer[read] = 0;
        JsonDocument doc;
        if (!deserializeJson(doc, buffer)) {
          const char *type = doc["t"] | "";
          const uint16_t port = doc["port"] | 0;
          if (!strcmp(type, "host") && port != 0) {
            const IPAddress remote = udp_.remoteIP();
            snprintf(host_, sizeof(host_), "%u.%u.%u.%u", remote[0], remote[1], remote[2], remote[3]);
            port_ = port;
            const char *token = doc["token"] | "";
            strlcpy(token_, token, sizeof(token_));
            const char *name = doc["name"] | "";
            strlcpy(hostName_, name, sizeof(hostName_));
            saveHost();
            udp_.stop();
            return true;
          }
        }
      }
    }
    delay(20);
  }
  udp_.stop();
  return false;
}

bool Link::connectHost() {
  if (host_[0] == 0) return false;
  client_.setNoDelay(true);
  if (!client_.connect(host_, port_, CONNECT_TIMEOUT_MS)) return false;

  JsonDocument doc;
  doc["t"] = "hello";
  doc["proto"] = 1;
  doc["id"] = STOPWATCH_DEVICE_ID;
  doc["name"] = STOPWATCH_DEVICE_NAME;
  doc["fw"] = STOPWATCH_FW_VERSION;
  doc["token"] = token_;
  doc["battery"] = battery_;
  char payload[320];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  client_.write(reinterpret_cast<const uint8_t *>(payload), length);
  client_.write('\n');

  lastBeat_ = millis();
  lastStatus_ = millis();
  return true;
}

void Link::readSocket() {
  while (client_.available()) {
    const int value = client_.read();
    if (value < 0) break;
    const char c = static_cast<char>(value);
    if (c == '\n') {
      line_[lineLen_] = 0;
      if (lineLen_ > 0) handleLine(line_);
      lineLen_ = 0;
      continue;
    }
    if (lineLen_ < sizeof(line_) - 1) {
      line_[lineLen_++] = c;
    } else {
      lineLen_ = 0;  // oversized frame: drop and resynchronise on the next newline
    }
  }
}

void Link::handleLine(char *line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  lastBeat_ = millis();

  const char *type = doc["t"] | "";
  if (!strcmp(type, "welcome")) {
    connected_ = true;
    const char *host = doc["host"] | "";
    if (host[0] != 0) strlcpy(hostName_, host, sizeof(hostName_));
    listener_->onLinkConnected();
    sendStatus();
    return;
  }
  if (!strcmp(type, "ping")) {
    JsonDocument reply;
    reply["t"] = "pong";
    reply["ts"] = doc["ts"] | 0;
    char payload[96];
    size_t length = serializeJson(reply, payload, sizeof(payload));
    client_.write(reinterpret_cast<const uint8_t *>(payload), length);
    client_.write('\n');
    return;
  }
  if (!strcmp(type, "prompt")) {
    PromptView prompt;
    strlcpy(prompt.id, doc["id"] | "", sizeof(prompt.id));
    strlcpy(prompt.tool, doc["tool"] | "", sizeof(prompt.tool));
    strlcpy(prompt.title, doc["title"] | "", sizeof(prompt.title));
    for (JsonVariant value : doc["lines"].as<JsonArray>()) {
      if (prompt.lineCount >= 8) break;
      const char *line = value.as<const char *>();
      strlcpy(prompt.lines[prompt.lineCount], line != nullptr ? line : "", sizeof(prompt.lines[0]));
      prompt.lineCount++;
    }
    prompt.seq = doc["seq"] | 1;
    prompt.total = doc["total"] | 1;
    prompt.timeoutMs = doc["timeoutMs"] | 45000;
    prompt.sound = doc["sound"] | true;
    prompt.vibration = doc["vibration"] | true;
    pending_ = prompt.total > 0 ? prompt.total - 1 : 0;
    listener_->onLinkPrompt(prompt);
    return;
  }
  if (!strcmp(type, "close")) {
    listener_->onLinkClose(doc["id"] | "", doc["outcome"] | "", doc["text"] | "");
    if (pending_ > 0) pending_--;
    return;
  }
  if (!strcmp(type, "notice")) {
    const char *line0 = "";
    JsonArray lines = doc["lines"].as<JsonArray>();
    if (!lines.isNull() && lines.size() > 0) {
      const char *text = lines[0].as<const char *>();
      if (text != nullptr) line0 = text;
    }
    listener_->onLinkNotice(doc["kind"] | "info", doc["text"] | "", line0);
    return;
  }
  if (!strcmp(type, "voice_text")) {
    listener_->onLinkVoiceText(doc["id"] | "", doc["text"] | "", doc["audioMs"] | 0);
    return;
  }
  if (!strcmp(type, "voice_status")) {
    listener_->onLinkVoiceStatus(doc["id"] | "", doc["state"] | "", doc["message"] | "");
    return;
  }
  if (!strcmp(type, "queue")) {
    pending_ = doc["pending"] | 0;
    listener_->onLinkQueue(pending_);
    return;
  }
  if (!strcmp(type, "bye")) {
    client_.stop();
    connected_ = false;
    listener_->onLinkDisconnected();
    return;
  }
  if (!strcmp(type, "error")) {
    client_.stop();
    connected_ = false;
    listener_->onLinkDisconnected();
  }
}

void Link::send(const char *json) {
  if (!connected_ || !client_.connected()) return;
  client_.write(reinterpret_cast<const uint8_t *>(json), strlen(json));
  client_.write('\n');
}

void Link::sendDecision(const char *id, const char *value, uint32_t latencyMs) {
  JsonDocument doc;
  doc["t"] = "decision";
  doc["id"] = id;
  doc["value"] = value;
  doc["latencyMs"] = latencyMs;
  char payload[192];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  if (!connected_ || !client_.connected()) return;
  client_.write(reinterpret_cast<const uint8_t *>(payload), length);
  client_.write('\n');
}

namespace {
const char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode little-endian PCM as base64 for the JSON line. */
size_t base64Encode(const uint8_t* data, size_t length, char* out, size_t outSize) {
  size_t written = 0;
  for (size_t i = 0; i < length; i += 3) {
    const uint32_t b0 = data[i];
    const uint32_t b1 = i + 1 < length ? data[i + 1] : 0;
    const uint32_t b2 = i + 2 < length ? data[i + 2] : 0;
    const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
    if (written + 4 >= outSize) break;
    out[written++] = kBase64[(triple >> 18) & 0x3F];
    out[written++] = kBase64[(triple >> 12) & 0x3F];
    out[written++] = i + 1 < length ? kBase64[(triple >> 6) & 0x3F] : '=';
    out[written++] = i + 2 < length ? kBase64[triple & 0x3F] : '=';
  }
  out[written] = 0;
  return written;
}
}  // namespace

void Link::sendVoiceStart(const char* id) {
  JsonDocument doc;
  doc["t"] = "voice_start";
  doc["id"] = id;
  doc["rate"] = 16000;
  doc["format"] = "s16le";
  char payload[128];
  serializeJson(doc, payload, sizeof(payload));
  send(payload);
}

void Link::sendVoiceChunk(const char* id, uint32_t seq, const int16_t* samples, size_t count) {
  if (count == 0) return;
  // 512 samples -> 1024 B -> 1368 base64 chars, well under the 8 KB line cap
  static char encoded[2048];
  base64Encode(reinterpret_cast<const uint8_t*>(samples), count * sizeof(int16_t), encoded, sizeof(encoded));
  static char payload[2304];
  const int written = snprintf(payload, sizeof(payload), "{\"t\":\"voice_chunk\",\"id\":\"%s\",\"seq\":%u,\"data\":\"%s\"}",
                               id, static_cast<unsigned>(seq), encoded);
  if (written > 0 && static_cast<size_t>(written) < sizeof(payload)) send(payload);
}

void Link::sendVoiceEnd(const char* id) {
  JsonDocument doc;
  doc["t"] = "voice_end";
  doc["id"] = id;
  char payload[96];
  serializeJson(doc, payload, sizeof(payload));
  send(payload);
}

void Link::sendVoiceSend(const char* id) {
  JsonDocument doc;
  doc["t"] = "voice_send";
  doc["id"] = id;
  char payload[96];
  serializeJson(doc, payload, sizeof(payload));
  send(payload);
}

void Link::sendVoiceClear(const char* id) {
  JsonDocument doc;
  doc["t"] = "voice_clear";
  doc["id"] = id;
  char payload[96];
  serializeJson(doc, payload, sizeof(payload));
  send(payload);
}

void Link::sendStatus() {
  JsonDocument doc;
  doc["t"] = "status";
  doc["battery"] = battery_;
  doc["rssi"] = rssi_;
  doc["uptime"] = (millis() - bootMs_) / 1000;
  char payload[160];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  send(payload);
  (void)length;
}

void Link::readBattery() {
  int level = M5.Power.getBatteryLevel();
  if (level >= 0 && level <= 100) battery_ = static_cast<int8_t>(level);
  rssi_ = wifiUp_ ? static_cast<int8_t>(WiFi.RSSI()) : -127;
}
