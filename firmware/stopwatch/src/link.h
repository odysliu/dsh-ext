#pragma once

/**
 * Link layer: WiFi, LAN discovery, the TCP connection to the DSH plugin, and
 * the NDJSON protocol from docs/protocol.md.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiServer.h>
#include <Preferences.h>

#include "config.h"

struct PromptView {
  char id[24] = {0};
  char tool[24] = {0};
  char title[48] = {0};
  char lines[8][96] = {{0}};
  uint8_t lineCount = 0;
  uint8_t seq = 1;
  uint8_t total = 1;
  uint32_t timeoutMs = 45000;
  bool sound = true;
  bool vibration = true;
};

class LinkListener {
 public:
  virtual ~LinkListener() {}
  virtual void onLinkConnected() {}
  virtual void onLinkDisconnected() {}
  virtual void onLinkPrompt(const PromptView &prompt) = 0;
  virtual void onLinkClose(const char *id, const char *outcome, const char *text) = 0;
  virtual void onLinkNotice(const char *kind, const char *text, const char *line) = 0;
  virtual void onLinkQueue(uint8_t pending) {}
  virtual void onLinkVoiceText(const char* id, const char* text, uint32_t audioMs) = 0;
  virtual void onLinkVoiceStatus(const char* id, const char* state, const char* message) = 0;
};

class Link {
 public:
  void begin(LinkListener *listener);
  void loop();

  bool connected() const { return connected_; }
  bool configured() const { return configured_; }
  const char *hostName() const { return hostName_; }
  int8_t battery() const { return battery_; }
  int8_t rssi() const { return rssi_; }
  uint8_t pending() const { return pending_; }

  void sendDecision(const char *id, const char *value, uint32_t latencyMs);

  /** Voice input: start a recording, stream PCM, finish, then send or clear. */
  void sendVoiceStart(const char *id);
  void sendVoiceChunk(const char *id, uint32_t seq, const int16_t *samples, size_t count);
  void sendVoiceEnd(const char *id);
  void sendVoiceSend(const char *id);
  void sendVoiceClear(const char *id);

 private:
  void connectWifi();
  void sendHello();
  void adoptClient();
  bool discoverHost(uint32_t timeoutMs);
  bool connectHost();
  void readSocket();
  void handleLine(char *line);
  void send(const char *json);
  void sendStatus();
  void readBattery();
  void loadHost();
  void saveHost();

  LinkListener *listener_ = nullptr;
  WiFiClient client_;
  WiFiServer server_{STOPWATCH_HOST_PORT};
  WiFiUDP udp_;
  Preferences prefs_;

  bool configured_ = false;
  bool wifiUp_ = false;
  bool connected_ = false;
  bool serverStarted_ = false;

  char host_[40] = {0};
  uint16_t port_ = 0;
  char token_[64] = {0};
  char hostName_[40] = {0};

  char line_[8192] = {0};
  size_t lineLen_ = 0;

  uint32_t lastBeat_ = 0;
  uint32_t lastConnectAttempt_ = 0;
  uint32_t lastStatus_ = 0;
  uint32_t bootMs_ = 0;

  int8_t battery_ = -1;
  int8_t rssi_ = -127;
  uint8_t pending_ = 0;
};
