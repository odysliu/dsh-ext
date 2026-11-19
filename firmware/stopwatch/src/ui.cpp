#include "ui.h"

#include <math.h>

#include "assets/sounds.h"
#include "config.h"
#include "fish.h"
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
constexpr int kFishY = 12;
constexpr int kFishSize = 300;

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
  fishSprite_.setPsram(true);
  fishSprite_.createSprite(kFishSize, kFishSize);
  M5.Display.setBrightness(brightness_);
  setState(kBoot);
}

void UI::setState(State next) {
  state_ = next;
  stateSince_ = millis();
  denyArmed_ = false;
  render();
}

void UI::loop() {
  const uint32_t now = millis();

  if (state_ == kResult && now - stateSince_ > kResultMs) {
    setState(hasPrompt_ ? kAlert : kIdle);
  } else if (state_ == kNotice && now > noticeUntil_) {
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

  if (state_ == kAlert || state_ == kIdle) pulseBrightness(now);
  if (state_ == kAlert && now - lastAlertAt_ > kAlertRepeatMs && alertCount_ < 4) {
    lastAlertAt_ = now;
    alertCount_++;
    alert(now);
  }

  animate();

  auto detail = M5.Touch.getDetail();
  if (detail.wasClicked()) {
    if (state_ == kAlert) {
      setState(kPrompt);
    } else if (state_ == kPrompt) {
      handleTap(detail.x, detail.y);
    }
  }
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
  M5.Speaker.playWav(data, size, 0, 1);
}

void UI::animate() {
  if (state_ != kIdle && state_ != kAlert) return;
  const uint32_t now = millis();
  if (now - lastFrame_ < STOPWATCH_FRAME_MS) return;
  lastFrame_ = now;

  fishSprite_.fillScreen(kBg);
  const int mood = (state_ == kAlert) ? fish::kCalm : fish::kCalm;
  fish::draw(fishSprite_, kFishSize / 2, kFishSize / 2 - 8, 280, mood, now, kBg);
  fishSprite_.pushSprite(kFishX, kFishY);
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
  drawStatusLine();
}

void UI::drawStatusLine() {
  const bool connected = link_ != nullptr && link_->connected();
  const int y = 330;
  if (state_ == kAlert) {
    const char* label = "有确认请求";
    text::drawCentered(M5.Display, kCx, y, label, kText, kBg);
    text::drawCentered(M5.Display, kCx, y + 36, "点一下屏幕", kAccent, kBg);
  } else if (connected) {
    text::drawCentered(M5.Display, kCx, y, "已连接", kMuted, kBg);
  } else {
    text::drawCentered(M5.Display, kCx, y, "未连接", kMuted, kBg);
  }

  char footer[40];
  const int battery = link_ != nullptr ? link_->battery() : -1;
  if (battery >= 0) {
    snprintf(footer, sizeof(footer), "%d%%  %ddBm", battery, link_ != nullptr ? link_->rssi() : 0);
  } else {
    snprintf(footer, sizeof(footer), "%ddBm", link_ != nullptr ? link_->rssi() : 0);
  }
  text::drawCentered(M5.Display, kCx, 404, footer, kMuted, kBg);
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

  drawButton(kDenyX, kButtonY, kButtonW, kButtonH, denyArmed_ ? "再点一次" : "拒绝",
             denyArmed_ ? kDanger : kPanel, denyArmed_ ? kBg : kDanger, !denyArmed_);
  drawButton(kAllowX, kButtonY, kButtonW, kButtonH, "同意", kAccent, kBg, false);
  text::drawCentered(M5.Display, kCx, 410, "电脑处理", kMuted, kBg);
}

void UI::renderResult() {
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  brightness_ = STOPWATCH_BRIGHTNESS_IDLE;
  const uint16_t color = resultMood_ == fish::kHappy ? kAccent : kMuted;
  text::drawCentered(M5.Display, kCx, 196, resultText_, color, kBg);
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
      resultMood_ = fish::kSad;
      playSound(SOUND_DENY, sizeof(SOUND_DENY));
      setState(kResult);
      return;
    }
    if (x >= kAllowX && x <= kAllowX + kButtonW) {
      if (link_ != nullptr) link_->sendDecision(prompt_.id, "allow", millis() - stateSince_);
      strlcpy(resultText_, "已同意", sizeof(resultText_));
      resultMood_ = fish::kHappy;
      playSound(SOUND_ALLOW, sizeof(SOUND_ALLOW));
      setState(kResult);
      return;
    }
  }
  if (y >= 392) {
    if (link_ != nullptr) link_->sendDecision(prompt_.id, "delegate", millis() - stateSince_);
    strlcpy(resultText_, "请在电脑处理", sizeof(resultText_));
    resultMood_ = fish::kCalm;
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
  prompt_ = prompt;
  hasPrompt_ = true;
  alertCount_ = 0;
  if (state_ == kResult) return;  // let the confirmation finish, then alert
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
  resultMood_ = strcmp(outcome, "allowed-once") == 0 ? fish::kHappy : fish::kCalm;
  setState(kResult);
}

void UI::onLinkNotice(const char* kind, const char* text, const char* line) {
  (void)kind;
  strlcpy(noticeText_, text != nullptr ? text : "", sizeof(noticeText_));
  strlcpy(noticeLine_, line != nullptr ? line : "", sizeof(noticeLine_));
  noticeUntil_ = millis() + 4000;
  setState(kNotice);
}

void UI::onLinkQueue(uint8_t pending) {
  pending_ = pending;
  if (state_ == kIdle || state_ == kAlert) drawStatusLine();
}
