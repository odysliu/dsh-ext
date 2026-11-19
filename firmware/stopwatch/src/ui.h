/**
 * Watch UI: one state machine that turns link events into the alert, the
 * decision screen, and the short result confirmations.
 */

#pragma once

#include <M5GFX.h>

#include "config.h"
#include "link.h"

class UI : public LinkListener {
 public:
  void begin(Link* link);
  void loop();

  void onLinkConnected() override;
  void onLinkDisconnected() override;
  void onLinkPrompt(const PromptView& prompt) override;
  void onLinkClose(const char* id, const char* outcome, const char* text) override;
  void onLinkNotice(const char* kind, const char* text, const char* line) override;
  void onLinkQueue(uint8_t pending) override;

 private:
  enum State {
    kBoot,
    kIdle,
    kAlert,
    kPrompt,
    kResult,
    kNotice,
  };

  void render();
  void renderBoot();
  void renderIdle();
  void renderPrompt();
  void renderResult();
  void renderNotice();
  void drawStatusLine();
  void drawButton(int x, int y, int w, int h, const char* label, uint16_t fill, uint16_t textColor, bool outline);
  void handleTap(int x, int y);
  void setState(State next);
  void animate();
  void pulseBrightness(uint32_t now);
  void alert(uint32_t now);
  void playSound(const uint8_t* data, size_t size);

  Link* link_ = nullptr;
  State state_ = kBoot;
  PromptView prompt_;
  bool hasPrompt_ = false;
  uint8_t pending_ = 0;

  uint32_t stateSince_ = 0;
  uint32_t lastFrame_ = 0;
  uint32_t lastPulse_ = 0;
  uint32_t lastAlertAt_ = 0;
  uint32_t alertCount_ = 0;
  uint32_t denyArmedAt_ = 0;
  uint32_t vibrateUntil_ = 0;
  bool alertPending_ = false;
  bool denyArmed_ = false;

  char resultText_[48] = {0};
  char noticeText_[80] = {0};
  char noticeLine_[80] = {0};
  uint32_t noticeUntil_ = 0;
  uint8_t resultMood_ = 0;

  uint8_t brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  M5Canvas fishSprite_{&M5.Display};
};
