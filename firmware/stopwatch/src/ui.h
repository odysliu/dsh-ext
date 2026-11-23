/**
 * Watch UI: one state machine that turns link events into the alert, the
 * decision screen, and the short result confirmations.
 */

#pragma once

#include <M5Unified.h>

#include "character.h"
#include "config.h"
#include "link.h"
#include "mic.h"

class UI : public LinkListener {
 public:
  void begin(Link* link);
  void loop();

  /** Print the current character frame for remote inspection. */
  void dumpFrame();

  void onLinkConnected() override;
  void onLinkDisconnected() override;
  void onDumpRequested() override;
  void onDone(const char* title, const char* id) override;
  String describe() override;
  void onLinkPrompt(const PromptView& prompt) override;
  void onLinkClose(const char* id, const char* outcome, const char* text) override;
  void onLinkNotice(const char* kind, const char* text, const char* line) override;
  void onLinkQueue(uint8_t pending) override;
  void onLinkVoiceText(const char* id, const char* text, uint32_t audioMs) override;
  void onLinkVoiceStatus(const char* id, const char* state, const char* message) override;

 private:
  enum State {
    kBoot,
    kIdle,
    kAlert,
    kPrompt,
    kResult,
    kNotice,
    kRecord,
    kTranscribing,
    kReview,
    kDone,
  };

  void render();
  void renderBoot();
  void renderIdle();
  void renderPrompt();
  void renderResult();
  void renderNotice();
  void renderRecord();
  void renderTranscribing();
  void renderReview();
  void renderDone();
  /** The screen to fall back to: approval, then a waiting completion ring, then idle. */
  State restingState() const;
  /** Whether this state owns the screen as an event. */
  bool isEventState(State state) const;
  /** Dump whatever is on screen (used for remote screenshots). */
  void dumpScreen();
  void handleVoiceButtons(uint32_t now);
  void startRecording(uint32_t now);
  void finishRecording();
  void cancelRecording();
  void captureStep();
  void drawStatusLine();
  void drawButton(int x, int y, int w, int h, const char* label, uint16_t fill, uint16_t textColor, bool outline);
  void drawAttentionRing(int radius, int thickness);
  void handleTap(int x, int y);
  void setState(State next);
  void animate();
  void pulseBrightness(uint32_t now);
  /** Mark user activity and wake the panel if it had blanked. */
  void touch();
  /** Buzz for a bounded time; overlapping requests extend, never stack. */
  void vibrate(uint32_t ms, uint8_t level);
  /** Dim or blank the panel after a long idle period. */
  void updateIdleScreen(uint32_t now);
  void alert(uint32_t now);
  void playSound(const uint8_t* data, size_t size);

  Link* link_ = nullptr;
  State state_ = kBoot;
  PromptView prompt_;
  bool hasPrompt_ = false;
  uint8_t pending_ = 0;

  uint32_t stateSince_ = 0;
  uint32_t lastActivity_ = 0;
  char doneTitle_[128] = {0};
  uint8_t donePending_ = 0;
  M5Canvas* doneCanvas_ = nullptr;
  bool screenOff_ = false;
  bool screenDim_ = false;
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
  Character::Mood resultMood_ = Character::kIdle;

  uint8_t brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  Character character_;
  MicCapture mic_;
  char voiceId_[16] = {0};
  uint32_t voiceSeq_ = 0;
  uint32_t recordStartedAt_ = 0;
  int16_t chunk_[512] = {0};
  char transcript_[512] = {0};
  char voiceHint_[64] = {0};
  bool voiceActive_ = false;
};
