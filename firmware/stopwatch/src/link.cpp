#include "link.h"

#include <ArduinoJson.h>
#include "lwip/etharp.h"
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
#if STOPWATCH_DEBUG
  Serial.begin(921600);
  Serial.printf("\n[dsh] boot fw=%s id=%s\n", STOPWATCH_FW_VERSION, STOPWATCH_DEVICE_ID);
#endif
  bootMs_ = millis();
  prefs_.begin(kNamespace, false);
  loadHost();
  if (strlen(STOPWATCH_HOST_IP) > 0 && strlen(STOPWATCH_HOST_MAC) > 0) {
    // routers that proxy-ARP across bands hand out their own MAC; pin the real one
    ip4_addr_t ip;
    struct eth_addr mac;
    if (ip4addr_aton(STOPWATCH_HOST_IP, &ip) && sscanf(STOPWATCH_HOST_MAC, "%2hhx:%2hhx:%2hhx:%2hhx:%2hhx:%2hhx",
                                                        &mac.addr[0], &mac.addr[1], &mac.addr[2], &mac.addr[3],
                                                        &mac.addr[4], &mac.addr[5]) == 6) {
      etharp_add_static_entry(&ip, &mac);
#if STOPWATCH_DEBUG
      Serial.printf("[dsh] static arp %s -> %s\n", STOPWATCH_HOST_IP, STOPWATCH_HOST_MAC);
#endif
    }
  }
  if (strlen(STOPWATCH_HOST_IP) > 0) {  // a pinned host always wins over NVS
    strlcpy(host_, STOPWATCH_HOST_IP, sizeof(host_));
    port_ = STOPWATCH_HOST_PORT;
#if STOPWATCH_DEBUG
    Serial.printf("[dsh] fixed host %s:%u\n", host_, port_);
#endif
  }

  configured_ = strlen(STOPWATCH_WIFI_SSID) > 0;
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] wifi ssid=%s configured=%d\n", STOPWATCH_WIFI_SSID, configured_ ? 1 : 0);
#endif
#if STOPWATCH_DEBUG
  if (!configured_) {
    // no credentials yet: list what the 2.4 GHz radio can actually see
    WiFi.mode(WIFI_STA);
    const int found = WiFi.scanNetworks();
    Serial.printf("[dsh] scan found %d networks\n", found);
    for (int i = 0; i < found; i++) {
      Serial.printf("[dsh]   ssid=%s ch=%d rssi=%d enc=%d\n", WiFi.SSID(i).c_str(), WiFi.channel(i),
                    WiFi.RSSI(i), static_cast<int>(WiFi.encryptionType(i)));
    }
    WiFi.scanDelete();
  }
#endif
  if (!configured_) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.setHostname(STOPWATCH_DEVICE_ID);
  connectWifi();
  readBattery();
#if STOPWATCH_DEVICE_SERVER
  if (wifiUp_) {
    server_.begin(STOPWATCH_HOST_PORT);
    serverStarted_ = true;
    server_.setNoDelay(true);
#if STOPWATCH_DEBUG
    Serial.printf("[dsh] listening on tcp/%u\n", STOPWATCH_HOST_PORT);
#endif
  }
#endif
}

void Link::loop() {
#if STOPWATCH_DEBUG
  {
    static uint32_t lastBeat = 0;
    if (millis() - lastBeat > 4000) {
      lastBeat = millis();
      Serial.printf("[dsh] alive wifi=%d ip=%s srv=%d tcp=%d host=%s\n", wifiUp_ ? 1 : 0,
                    wifiUp_ ? WiFi.localIP().toString().c_str() : "-", serverStarted_ ? 1 : 0, connected_ ? 1 : 0,
                    host_[0] != 0 ? host_ : "-");
    }
  }
#endif
#if STOPWATCH_SERIAL_TRANSPORT
  // USB first: it needs no network, so the watch also works on locked-down LANs
  pumpSerial();
  maintainSerial();
  if (channel_ == kSerialChannel) {
    if (!channelOk()) {
      channel_ = kNoChannel;
      connected_ = false;
      listener_->onLinkDisconnected();
      return;
    }
    if (millis() - lastBeat_ > BEAT_TIMEOUT_MS) {
      channel_ = kNoChannel;  // the host stopped talking; re-offer the serial link
      connected_ = false;
      listener_->onLinkDisconnected();
      return;
    }
    if (millis() - lastStatus_ > STATUS_INTERVAL_MS) {
      lastStatus_ = millis();
      readBattery();
      sendStatus();
    }
    return;
  }
#endif

  if (!configured_) return;

  const bool up = WiFi.status() == WL_CONNECTED;
  if (up != wifiUp_) {
    wifiUp_ = up;
#if STOPWATCH_DEVICE_SERVER
    if (up && !serverStarted_) {
      server_.begin(STOPWATCH_HOST_PORT);  // begin() defaults to port 80
      serverStarted_ = true;
#if STOPWATCH_DEBUG
      Serial.printf("[dsh] listening on tcp/%u\n", STOPWATCH_HOST_PORT);
#endif
    }
#endif
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
    const auto status = WiFi.status();
    // only restart when the stack is idle; begin() during a connect logs an error
    const bool idle = status == WL_DISCONNECTED || status == WL_CONNECT_FAILED ||
                      status == WL_NO_SSID_AVAIL;
    if (idle && millis() - lastTry > WIFI_RETRY_MS) {
      lastTry = millis();
      connectWifi();
    }
    return;
  }

#if STOPWATCH_DEVICE_SERVER
  if (!connected_) {
    if (!client_.connected()) {
      WiFiClient incoming = server_.accept();
      if (incoming) {
        client_ = incoming;
        adoptClient();
      }
      return;
    }
    readSocket();
    if (!connected_ && millis() - lastConnectAttempt_ > 5000) client_.stop();
    return;
  }
#else
  if (!connected_) {
    // once the socket is up, read the welcome before ever reconnecting again
    if (client_.connected()) {
      readSocket();
      if (!connected_ && millis() - lastConnectAttempt_ > 5000) client_.stop();
      return;
    }
    if (millis() - lastConnectAttempt_ < CONNECT_RETRY_MS) return;
    lastConnectAttempt_ = millis();
    if (host_[0] == 0 && !discoverHost(DISCOVERY_TIMEOUT_MS)) return;
    if (!connectHost()) {
      if (!discoverHost(DISCOVERY_TIMEOUT_MS)) return;
      connectHost();
    }
    return;
  }
#endif

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
  // Never block: a 12 s synchronous wait starved pumpSerial() and stalled the
  // USB protocol whenever Wi-Fi was unreachable.
  WiFi.begin(STOPWATCH_WIFI_SSID, STOPWATCH_WIFI_PASS);
#if STOPWATCH_DEBUG
  Serial.println("[dsh] wifi connecting");
#endif
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
  // limited broadcast is dropped by some APs; also try the subnet broadcast
  const IPAddress local = WiFi.localIP();
  const IPAddress mask = WiFi.subnetMask();
  const IPAddress subnet(local[0] | (~mask[0] & 0xFF), local[1] | (~mask[1] & 0xFF), local[2] | (~mask[2] & 0xFF),
                         local[3] | (~mask[3] & 0xFF));
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] discover via %s and 255.255.255.255\n", subnet.toString().c_str());
#endif
  const IPAddress broadcast = subnet;
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
#if STOPWATCH_DEBUG
            Serial.printf("[dsh] discovered host %s:%u\n", host_, port_);
#endif
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

  sendHello(channel_);
  lastBeat_ = millis();
  lastStatus_ = millis();
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] tcp connected %s:%u\n", host_, port_);
#endif
  return true;
}

bool Link::channelOk() {
  if (channel_ == kSerialChannel) return static_cast<bool>(Serial);
  if (channel_ == kTcpChannel) return client_.connected();
  return false;
}

size_t Link::writeRaw(Channel via, const uint8_t *data, size_t len) {
  if (via == kSerialChannel) return Serial.write(data, len);
  if (via == kTcpChannel) return client_.write(data, len);
  return 0;
}

void Link::writeLine(Channel via, const uint8_t *data, size_t len) {
  if (via == kNoChannel) return;
  writeRaw(via, data, len);
  const char newline = '\n';
  writeRaw(via, reinterpret_cast<const uint8_t *>(&newline), 1);
}

void Link::pumpSerial() {
  while (Serial.available()) {
    const int value = Serial.read();
    if (value < 0) break;
    const char c = static_cast<char>(value);
    if (c == '\r') continue;
    if (c == '\n') {
      lineSerial_[serialLen_] = 0;
      if (serialLen_ > 0) handleLine(lineSerial_, kSerialChannel);
      serialLen_ = 0;
      continue;
    }
    if (serialLen_ < sizeof(lineSerial_) - 1) {
      lineSerial_[serialLen_++] = c;
    } else {
      serialLen_ = 0;
    }
  }
}

void Link::maintainSerial() {
  if (channel_ == kSerialChannel) return;
  if (connected_) return;  // already paired over TCP
  // Write even when the host looks absent: HWCDC only reports a connection once
  // the host actually drains our TX FIFO, so writing is what proves it.
  constexpr uint32_t kHelloMs = 2000;
  if (millis() - lastSerialHello_ < kHelloMs) return;
  lastSerialHello_ = millis();
  sendHello(kSerialChannel);
}

void Link::sendHello(Channel via) {
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
  writeLine(via, reinterpret_cast<const uint8_t *>(payload), length);
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] hello via %s: %s\n", via == kSerialChannel ? "usb" : "tcp", payload);
#endif
}

void Link::adoptClient() {
  client_.setNoDelay(true);
  channel_ = kTcpChannel;
  lastBeat_ = millis();
  lastConnectAttempt_ = millis();  // the welcome timeout counts from accept
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] host dialed in from %s\n", client_.remoteIP().toString().c_str());
#endif
  sendHello(kTcpChannel);
}

void Link::readSocket() {
  while (client_.available()) {
    const int value = client_.read();
    if (value < 0) break;
    const char c = static_cast<char>(value);
    if (c == '\n') {
      line_[lineLen_] = 0;
      if (lineLen_ > 0) handleLine(line_, kTcpChannel);
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

void Link::handleLine(char *line, Channel from) {
#if STOPWATCH_DEBUG
  Serial.printf("[dsh] <- %s\n", line);
#endif
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  lastBeat_ = millis();

  const char *type = doc["t"] | "";
  if (!strcmp(type, "welcome")) {
    channel_ = from;
    connected_ = true;
#if STOPWATCH_DEBUG
    Serial.println("[dsh] paired, waiting for prompts");
#endif
    const char *host = doc["host"] | "";
    if (host[0] != 0) strlcpy(hostName_, host, sizeof(hostName_));
    listener_->onLinkConnected();
    sendStatus();
    return;
  }
  if (!strcmp(type, "dump")) {
    listener_->onDumpRequested();
    return;
  }
  if (!strcmp(type, "ping")) {
    JsonDocument reply;
    reply["t"] = "pong";
    reply["ts"] = doc["ts"] | 0;
    char payload[96];
    size_t length = serializeJson(reply, payload, sizeof(payload));
    writeLine(from, reinterpret_cast<const uint8_t *>(payload), length);
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
  if (!connected_ || !channelOk()) return;
  writeLine(channel_, reinterpret_cast<const uint8_t *>(json), strlen(json));
}

void Link::sendDecision(const char *id, const char *value, uint32_t latencyMs) {
  JsonDocument doc;
  doc["t"] = "decision";
  doc["id"] = id;
  doc["value"] = value;
  doc["latencyMs"] = latencyMs;
  char payload[192];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  if (!connected_ || !channelOk()) return;
  writeLine(channel_, reinterpret_cast<const uint8_t *>(payload), length);
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
