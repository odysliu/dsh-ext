#include "ui.h"

#include <math.h>

#include "assets/sounds.h"
#include "config.h"
#include "character.h"
#include "mic.h"
#include "text.h"

namespace {

constexpr int kW = 466;
constexpr int kH = 466;
constexpr int kCx = kW / 2;

constexpr uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return static_cast<uint16_t>(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

constexpr uint16_t kBg = rgb(9, 11, 22);
constexpr uint16_t kPanel = rgb(20, 25, 45);
constexpr uint16_t kText = rgb(232, 236, 255);
constexpr uint16_t kMuted = rgb(128, 140, 178);
constexpr uint16_t kAccent = rgb(77, 107, 254);
constexpr uint16_t kDanger = rgb(255, 96, 120);

constexpr int kFishX = 83;
constexpr int kFishY = 48;
constexpr uint16_t kRing = rgb(255, 64, 72);
constexpr uint16_t kDoneRing = rgb(52, 211, 138);
constexpr uint16_t kDoneRingDim = rgb(12, 46, 36);
constexpr uint16_t kDoneText = rgb(126, 240, 190);

constexpr int kButtonY = 332;
constexpr int kButtonH = 56;
constexpr int kButtonW = 146;
constexpr int kDenyX = 60;
constexpr int kAllowX = 260;

constexpr uint32_t kResultMs = 1600;
constexpr uint32_t kDenyArmMs = 2500;
constexpr uint32_t kAlertRepeatMs = 4200;

}  // namespace

void UI::begin(Link* link) {
  link_ = link;
  character_.begin(kBg);
  M5.Display.setBrightness(brightness_);
  setState(kBoot);
}

void UI::setState(State next) {
  state_ = next;
  stateSince_ = millis();
  lastActivity_ = stateSince_;
  screenOff_ = false;
  screenDim_ = false;
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  M5.Display.setBrightness(brightness_);
  denyArmed_ = false;
  render();
}

void UI::touch() {
  lastActivity_ = millis();
  if (screenOff_ || screenDim_) {
    screenOff_ = false;
    screenDim_ = false;
    brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
    render();
  }
}

void UI::updateIdleScreen(uint32_t now) {
  // only the resting screens sleep; alerts, prompts and recording stay lit
  if (state_ != kIdle && state_ != kBoot) {
    screenOff_ = false;
    screenDim_ = false;
    return;
  }
  const uint32_t idle = now - lastActivity_;
  if (idle > STOPWATCH_SCREEN_OFF_MS) {
    if (!screenOff_) {
      screenOff_ = true;
      screenDim_ = false;
      brightness_ = 0;
      M5.Display.setBrightness(0);
#if STOPWATCH_DEBUG
      Serial.println("[dsh] screen off");
#endif
    }
    return;
  }
  if (idle > STOPWATCH_SCREEN_DIM_MS) {
    if (!screenDim_) {
      screenDim_ = true;
      screenOff_ = false;
      brightness_ = STOPWATCH_BRIGHTNESS_DIM;
      M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_DIM);
#if STOPWATCH_DEBUG
      Serial.println("[dsh] screen dim");
#endif
    }
    return;
  }
  screenOff_ = false;
  screenDim_ = false;
}

void UI::loop() {
  const uint32_t now = millis();

  if (state_ == kResult && now - stateSince_ > kResultMs) {
    const State next = hasPrompt_ ? kAlert : kIdle;
    setState(next);
    if (hasPrompt_ && alertPending_) {
      alertPending_ = false;
      alertCount_ = 1;
      alert(now);
    }
  } else if (state_ == kNotice && now > noticeUntil_) {
    setState(hasPrompt_ ? kAlert : kIdle);
  } else if (state_ == kDone && now > doneUntil_) {
    donePending_ = 0;
    setState(hasPrompt_ ? kAlert : kIdle);
  }

  if (denyArmed_ && now - denyArmedAt_ > kDenyArmMs) {
    denyArmed_ = false;
    if (state_ == kPrompt) renderPrompt();
  }

  if (vibrateUntil_ != 0 && now > vibrateUntil_) {
    M5.Power.setVibration(0);
    vibrateUntil_ = 0;
  }

  handleVoiceButtons(now);
  if (state_ == kRecord) captureStep();

  updateIdleScreen(now);
  if (!screenOff_ && !screenDim_ && (state_ == kAlert || state_ == kIdle)) pulseBrightness(now);
  if (state_ == kAlert && now - lastAlertAt_ > kAlertRepeatMs && alertCount_ < 4) {
    lastAlertAt_ = now;
    alertCount_++;
    alert(now);
  }

  animate();

  auto detail = M5.Touch.getDetail();
  if (detail.wasClicked()) {
    const bool wasSleeping = screenOff_ || screenDim_;
    touch();
    if (wasSleeping) return;  // the first tap only wakes the screen
    if (state_ == kDone) {
      donePending_ = 0;
      setState(hasPrompt_ ? kAlert : kIdle);
      return;
    }
    if (state_ == kAlert) {
      setState(kPrompt);
    } else if (state_ == kPrompt) {
      handleTap(detail.x, detail.y);
    }
  }
}

void UI::onDumpRequested() { dumpScreen(); }

void UI::onDone(const char* title, const char* id) {
  (void)id;
  strlcpy(doneTitle_, title != nullptr && title[0] != 0 ? title : "任务完成", sizeof(doneTitle_));
  donePending_++;
  // never steal an approval or a recording; show it once they are finished
  if (state_ == kAlert || state_ == kPrompt || state_ == kRecord || state_ == kTranscribing) {
    doneDeferred_ = true;
    return;
  }
  doneUntil_ = millis() + STOPWATCH_DONE_MS;
  M5.Power.setVibration(70);
  vibrateUntil_ = millis() + 220;
  setState(kDone);
}

void UI::pulseBrightness(uint32_t now) {
  const bool alerting = state_ == kAlert;
  const uint8_t target =
      alerting ? static_cast<uint8_t>(STOPWATCH_BRIGHTNESS_LOW +
                                      (STOPWATCH_BRIGHTNESS_HIGH - STOPWATCH_BRIGHTNESS_LOW) *
                                          (0.5f + 0.5f * sinf(now / 190.0f)))
               : STOPWATCH_BRIGHTNESS_IDLE;
  if (abs(static_cast<int>(target) - static_cast<int>(brightness_)) > 8) {
    brightness_ = target;
    M5.Display.setBrightness(brightness_);
  }
}

void UI::alert(uint32_t now) {
  if (prompt_.sound) playSound(SOUND_ALERT, sizeof(SOUND_ALERT));
  if (prompt_.vibration) {
    M5.Power.setVibration(150);
    vibrateUntil_ = now + 180;
  }
  lastAlertAt_ = now;
}

void UI::playSound(const uint8_t* data, size_t size) {
  // M5Unified: playWav(data, length, repeat, channel, stop_current)
  M5.Speaker.playWav(data, size, 1, 0);
}

void UI::animate() {
  if (state_ != kIdle && state_ != kAlert) return;
  const uint32_t now = millis();
  if (now - lastFrame_ < STOPWATCH_FRAME_MS) return;
  lastFrame_ = now;
  character_.tick(now);
  character_.push(kFishX, kFishY);
  if (state_ == kAlert) {
    // breathing red ring: the whole point is being impossible to miss
    const int offset = static_cast<int>((sinf(now / 210.0f) + 1.0f) * 3.0f);
    drawAttentionRing(216 + offset, 9);
  }
}

void UI::drawAttentionRing(int radius, int thickness) {
  M5.Display.fillArc(kCx, kCx, radius, radius + thickness, 0, 360, kRing);
}

void UI::render() {
  M5.Display.fillScreen(kBg);
  switch (state_) {
    case kBoot:
      renderBoot();
      break;
    case kIdle:
    case kAlert:
      renderIdle();
      break;
    case kPrompt:
      renderPrompt();
      break;
    case kResult:
      renderResult();
      break;
    case kNotice:
      renderNotice();
      break;
    case kRecord:
      renderRecord();
      break;
    case kTranscribing:
      renderTranscribing();
      break;
    case kReview:
      renderReview();
      break;
    case kDone:
      renderDone();
      break;
  }
}

void UI::renderBoot() {
  const bool configured = link_ != nullptr && link_->configured();
  if (!configured) {
    text::drawCentered(M5.Display, kCx, 176, "WiFi 未配置", kText, kBg);
    text::drawCentered(M5.Display, kCx, 222, "请先在电脑上运行", kMuted, kBg);
    text::drawCentered(M5.Display, kCx, 256, "tools/configure.mjs", kAccent, kBg);
    return;
  }
  if (link_ != nullptr && link_->connected()) {
    text::drawCentered(M5.Display, kCx, 200, "已连接", kText, kBg);
    text::drawCentered(M5.Display, kCx, 246, link_->hostName(), kMuted, kBg);
    return;
  }
  text::drawCentered(M5.Display, kCx, 200, "正在连接", kText, kBg);
  text::drawCentered(M5.Display, kCx, 246, "DSH", kAccent, kBg);
}

void UI::renderIdle() {
  M5.Display.fillScreen(kBg);
  character_.setMood(state_ == kAlert ? Character::kAlert : Character::kIdle);
  character_.push(kFishX, kFishY);
  drawStatusLine();
}

void UI::renderDone() {
  // drawn into a canvas so it can also be dumped over USB for inspection
  if (doneCanvas_ == nullptr) {
    doneCanvas_ = new M5Canvas(&M5.Display);
    doneCanvas_->createSprite(M5.Display.width(), M5.Display.height());
  }
  M5Canvas& g = *doneCanvas_;
  g.fillScreen(kBg);
  g.fillCircle(kCx, kCx, 206, kDoneRing);
  g.fillCircle(kCx, kCx, 196, kDoneRingDim);

  char lines[3][64];
  const int count = text::wrap(doneTitle_, 260, lines, 3);
  const int lineHeight = 34;
  const int top = kCx - (count * lineHeight) / 2 + 4;
  for (int i = 0; i < count; i++) {
    text::drawCentered(g, kCx, top + i * lineHeight, lines[i], kDoneText, kDoneRingDim);
  }
  if (donePending_ > 1) {
    char extra[32];
    snprintf(extra, sizeof(extra), "还有 %u 个", static_cast<unsigned>(donePending_ - 1));
    text::drawCentered(g, kCx, kCx + 104, extra, kDoneText, kDoneRingDim);
  }
  g.pushSprite(0, 0);
}

void UI::dumpScreen() {
  if (state_ == kDone && doneCanvas_ != nullptr) {
    character_.dumpCanvas(doneCanvas_);
    return;
  }
  character_.dump();
}

void UI::drawStatusLine() {
  if (state_ == kAlert) {
    text::drawCentered(M5.Display, kCx, 356, "有确认请求", kText, kBg);
    text::drawCentered(M5.Display, kCx, 390, "点一下屏幕", kAccent, kBg);
    return;
  }

  const bool connected = link_ != nullptr && link_->connected();
  const int battery = link_ != nullptr ? link_->battery() : -1;
  char footer[48];
  if (!connected) {
    strlcpy(footer, "未连接", sizeof(footer));
  } else if (battery >= 0) {
    snprintf(footer, sizeof(footer), "已连接 %d%%", battery);
  } else {
    strlcpy(footer, "已连接", sizeof(footer));
  }
  text::drawCentered(M5.Display, kCx, 408, footer, kMuted, kBg);
}


void UI::drawButton(int x, int y, int w, int h, const char* label, uint16_t fill, uint16_t textColor,
                    bool outline) {
  if (outline) {
    M5.Display.drawRoundRect(x, y, w, h, 16, fill);
    M5.Display.drawRoundRect(x + 1, y + 1, w - 2, h - 2, 15, fill);
  } else {
    M5.Display.fillRoundRect(x, y, w, h, 16, fill);
  }
  text::drawCentered(M5.Display, x + w / 2, y + (h - 28) / 2, label, textColor, outline ? kBg : fill);
}

void UI::renderPrompt() {
  M5.Display.fillScreen(kBg);
  M5.Display.setBrightness(200);
  brightness_ = 200;

  const char* title = prompt_.title[0] != 0 ? prompt_.title : "需要确认";
  text::drawCentered(M5.Display, kCx, 40, title, kText, kBg);

  char meta[40];
  if (prompt_.total > 1) {
    snprintf(meta, sizeof(meta), "%s  %d/%d", prompt_.tool, prompt_.seq, prompt_.total);
  } else {
    snprintf(meta, sizeof(meta), "%s", prompt_.tool);
  }
  text::drawCentered(M5.Display, kCx, 78, meta, kAccent, kBg);

  int y = 112;
  for (int i = 0; i < prompt_.lineCount && i < 6; i++) {
    text::drawCentered(M5.Display, kCx, y, prompt_.lines[i], kText, kBg);
    y += text::kLineHeight;
  }

  drawAttentionRing(222, 6);

  drawButton(kDenyX, kButtonY, kButtonW, kButtonH, denyArmed_ ? "再点一次" : "拒绝",
             denyArmed_ ? kDanger : kPanel, denyArmed_ ? kBg : kDanger, !denyArmed_);
  drawButton(kAllowX, kButtonY, kButtonW, kButtonH, "同意", kAccent, kBg, false);
  text::drawCentered(M5.Display, kCx, 410, "电脑处理", kMuted, kBg);
}

void UI::renderResult() {
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  character_.setMood(resultMood_);
  character_.push(kFishX, kFishY);
  const uint16_t color = resultMood_ == Character::kHappy ? kAccent : kMuted;
  text::drawCentered(M5.Display, kCx, 362, resultText_, color, kBg);
}

void UI::renderNotice() {
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  text::drawCentered(M5.Display, kCx, 178, noticeText_, kText, kBg);
  if (noticeLine_[0] != 0) text::drawCentered(M5.Display, kCx, 222, noticeLine_, kMuted, kBg);
}

void UI::handleTap(int x, int y) {
  if (state_ != kPrompt) return;
  if (y >= kButtonY && y <= kButtonY + kButtonH) {
    if (x >= kDenyX && x <= kDenyX + kButtonW) {
      if (!denyArmed_) {
        denyArmed_ = true;
        denyArmedAt_ = millis();
        renderPrompt();
        return;
      }
      if (link_ != nullptr) link_->sendDecision(prompt_.id, "deny", millis() - stateSince_);
      strlcpy(resultText_, "已拒绝", sizeof(resultText_));
      resultMood_ = Character::kSad;
      playSound(SOUND_DENY, sizeof(SOUND_DENY));
      setState(kResult);
      return;
    }
    if (x >= kAllowX && x <= kAllowX + kButtonW) {
      if (link_ != nullptr) link_->sendDecision(prompt_.id, "allow", millis() - stateSince_);
      strlcpy(resultText_, "已同意", sizeof(resultText_));
      resultMood_ = Character::kHappy;
      playSound(SOUND_ALLOW, sizeof(SOUND_ALLOW));
      setState(kResult);
      return;
    }
  }
  if (y >= 392) {
    if (link_ != nullptr) link_->sendDecision(prompt_.id, "delegate", millis() - stateSince_);
    strlcpy(resultText_, "请在电脑处理", sizeof(resultText_));
    resultMood_ = Character::kIdle;
    setState(kResult);
  }
}

void UI::onLinkConnected() {
  if (state_ == kBoot || state_ == kIdle) setState(hasPrompt_ ? kAlert : kIdle);
}

void UI::onLinkDisconnected() {
  hasPrompt_ = false;
  setState(kIdle);
}

void UI::onLinkPrompt(const PromptView& prompt) {
  if (state_ == kPrompt) return;  // one prompt on screen at a time; the host queues the rest
  prompt_ = prompt;
  hasPrompt_ = true;
  alertCount_ = 0;
  if (state_ == kResult) {
    alertPending_ = true;  // let the confirmation finish, then alert
    return;
  }
  setState(kAlert);
  M5.Power.setVibration(prompt.vibration ? 180 : 0);
  alert(millis());
  alertCount_ = 1;
}

void UI::onLinkClose(const char* id, const char* outcome, const char* text) {
  (void)id;
  hasPrompt_ = false;
  if (text != nullptr && text[0] != 0) {
    strlcpy(resultText_, text, sizeof(resultText_));
  } else {
    strlcpy(resultText_, outcome, sizeof(resultText_));
  }
  resultMood_ = strcmp(outcome, "allowed-once") == 0 ? Character::kHappy : Character::kIdle;
  setState(kResult);
}

void UI::onLinkNotice(const char* kind, const char* text, const char* line) {
  (void)kind;
  strlcpy(noticeText_, text != nullptr ? text : "", sizeof(noticeText_));
  strlcpy(noticeLine_, line != nullptr ? line : "", sizeof(noticeLine_));
  noticeUntil_ = millis() + 4000;
  setState(kNotice);
}

void UI::handleVoiceButtons(uint32_t now) {
#if STOPWATCH_SWAP_BUTTONS
  auto& right = M5.BtnA;
  auto& left = M5.BtnB;
#else
  auto& right = M5.BtnB;
  auto& left = M5.BtnA;
#endif
  const bool rightPressed = right.wasPressed();
  const bool rightReleased = right.wasReleased();
  const bool leftPressed = left.wasPressed();

  if (state_ == kIdle || state_ == kAlert) {
    if (rightPressed) startRecording(now);
    return;
  }
  if (state_ == kRecord) {
    if (leftPressed) {
      cancelRecording();
      return;
    }
    if (rightReleased) finishRecording();
    return;
  }
  if (state_ == kReview) {
    if (rightPressed) {
      link_->sendVoiceSend(voiceId_);
      strlcpy(resultText_, "已发送", sizeof(resultText_));
      resultMood_ = Character::kHappy;
      transcript_[0] = 0;
      setState(kResult);
      return;
    }
    if (leftPressed) {
      link_->sendVoiceClear(voiceId_);
      transcript_[0] = 0;
      setState(kIdle);
    }
  }
}

void UI::startRecording(uint32_t now) {
  if (!voiceActive_) voiceActive_ = mic_.begin();
  if (!voiceActive_) {
    strlcpy(noticeText_, "麦克风不可用", sizeof(noticeText_));
    noticeLine_[0] = 0;
    noticeUntil_ = millis() + 2500;
    setState(kNotice);
    return;
  }
  snprintf(voiceId_, sizeof(voiceId_), "v_%lu", static_cast<unsigned long>(now % 1000000UL));
  voiceSeq_ = 0;
  recordStartedAt_ = now;
  transcript_[0] = 0;
  link_->sendVoiceStart(voiceId_);
  setState(kRecord);
}

void UI::captureStep() {
  const int samples = mic_.read(chunk_, 512);
  if (samples > 0) link_->sendVoiceChunk(voiceId_, voiceSeq_++, chunk_, static_cast<size_t>(samples));
  if (millis() - recordStartedAt_ > 60000) finishRecording();
}

void UI::finishRecording() {
  link_->sendVoiceEnd(voiceId_);
  setState(kTranscribing);
}

void UI::cancelRecording() {
  link_->sendVoiceClear(voiceId_);
  transcript_[0] = 0;
  setState(kIdle);
}

void UI::onLinkVoiceText(const char* id, const char* text, uint32_t audioMs) {
  (void)id;
  (void)audioMs;
  strlcpy(transcript_, text != nullptr ? text : "", sizeof(transcript_));
  setState(kReview);
}

void UI::onLinkVoiceStatus(const char* id, const char* state, const char* message) {
  (void)id;
  if (!strcmp(state, "sent")) {
    strlcpy(resultText_, "已发送", sizeof(resultText_));
    resultMood_ = Character::kHappy;
    setState(kResult);
    return;
  }
  if (!strcmp(state, "cleared")) {
    if (state_ == kRecord || state_ == kReview) setState(kIdle);
    return;
  }
  if (!strcmp(state, "error")) {
    strlcpy(noticeText_, message != nullptr ? message : "语音不可用", sizeof(noticeText_));
    noticeLine_[0] = 0;
    noticeUntil_ = millis() + 3000;
    setState(kNotice);
  }
}

void UI::renderRecord() {
  M5.Display.setBrightness(200);
  brightness_ = 200;
  character_.setMood(Character::kAlert);
  character_.push(kFishX, kFishY);
  drawAttentionRing(222, 7);
  const uint32_t seconds = (millis() - recordStartedAt_) / 1000;
  char line[48];
  snprintf(line, sizeof(line), "录音中 %lus", static_cast<unsigned long>(seconds));
  text::drawCentered(M5.Display, kCx, 346, line, kText, kBg);
  text::drawCentered(M5.Display, kCx, 382, "松手结束 · 左键取消", kMuted, kBg);
}

void UI::renderTranscribing() {
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  character_.setMood(Character::kIdle);
  character_.push(kFishX, kFishY);
  text::drawCentered(M5.Display, kCx, 346, "识别中…", kText, kBg);
}

void UI::renderReview() {
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  static char lines[6][64];
  const int count = text::wrap(transcript_, 420, lines, 6);
  int y = 96;
  for (int i = 0; i < count; i++) {
    text::drawCentered(M5.Display, kCx, y, lines[i], kText, kBg);
    y += text::kLineHeight;
  }
  text::drawCentered(M5.Display, kCx, 388, "右键发送", kAccent, kBg);
  text::drawCentered(M5.Display, kCx, 420, "左键清空", kMuted, kBg);
}

void UI::onLinkQueue(uint8_t pending) {
  pending_ = pending;
  if (state_ == kIdle || state_ == kAlert) drawStatusLine();
}
