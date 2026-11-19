#include "fish.h"

#include <math.h>

namespace fish {
namespace {

constexpr uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return static_cast<uint16_t>(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

// DeepSeek blues, tuned for the AMOLED panel.
constexpr uint16_t kBody = rgb(77, 107, 254);
constexpr uint16_t kFin = rgb(52, 74, 205);
constexpr uint16_t kBelly = rgb(168, 188, 255);
constexpr uint16_t kEyeWhite = rgb(255, 255, 255);
constexpr uint16_t kPupil = rgb(18, 26, 64);
constexpr uint16_t kBlush = rgb(255, 150, 175);
constexpr uint16_t kMouth = rgb(24, 34, 80);

uint16_t fade(uint16_t from, uint16_t to, int num, int den) {
  const int fr = (from >> 11) & 0x1F, fg = (from >> 5) & 0x3F, fb = from & 0x1F;
  const int tr = (to >> 11) & 0x1F, tg = (to >> 5) & 0x3F, tb = to & 0x1F;
  const int r = fr + (tr - fr) * num / den;
  const int g = fg + (tg - fg) * num / den;
  const int b = fb + (tb - fb) * num / den;
  return static_cast<uint16_t>((r << 11) | (g << 5) | b);
}

}  // namespace

void draw(M5Canvas& g, int x0, int y0, int size, int mood, uint32_t now, uint16_t bg) {
  const float u = size / 300.0f;
  const float bob = sinf(now / 780.0f) * 4.0f;
  const float wag = sinf(now / 320.0f) * 5.0f;

  auto X = [x0, u](float v) { return x0 + static_cast<int>(lroundf(v * u)); };
  auto Y = [y0, u, bob](float v) { return y0 + static_cast<int>(lroundf((v + bob) * u)); };
  auto S = [u](float v) { return static_cast<int>(lroundf(v * u)); };

  // tail fluke, hinged behind the body
  g.fillTriangle(X(64), Y(142), X(16), Y(108 - wag), X(36), Y(150), kFin);
  g.fillTriangle(X(64), Y(158), X(16), Y(192 + wag), X(36), Y(150), kFin);
  g.fillTriangle(X(36), Y(150), X(16), Y(108 - wag), X(64), Y(158), kFin);
  g.fillTriangle(X(36), Y(150), X(16), Y(192 + wag), X(64), Y(142), kFin);

  // body: main ellipse plus a head volume, so the front reads heavier
  g.fillEllipse(X(150), Y(152), S(104), S(80), kBody);
  g.fillEllipse(X(191), Y(171), S(71), S(39), kBody);

  // dorsal fin on the back
  g.fillTriangle(X(108), Y(86), X(136), Y(104), X(100), Y(108), kFin);

  // lighter underside
  g.fillEllipse(X(157), Y(208), S(53), S(22), kBelly);

  // flipper
  g.fillTriangle(X(92), Y(190), X(118), Y(214), X(90), Y(218), kFin);

  // face
  const int eyeX = X(196);
  const int eyeY = Y(134);
  const int eyeR = S(15);
  if (mood == kHappy) {
    const int w = S(5);
    g.drawLine(eyeX - eyeR, eyeY + S(6), eyeX, eyeY - S(7), kPupil);
    g.drawLine(eyeX, eyeY - S(7), eyeX + eyeR, eyeY + S(6), kPupil);
    g.drawLine(eyeX - eyeR, eyeY + S(6) + w, eyeX, eyeY - S(7) + w, kPupil);
    g.drawLine(eyeX, eyeY - S(7) + w, eyeX + eyeR, eyeY + S(6) + w, kPupil);
  } else if (mood == kSad) {
    const int w = S(5);
    for (int i = 0; i < w; i++) {
      g.drawLine(eyeX - eyeR, eyeY - S(6) + i, eyeX + eyeR, eyeY + S(6) + i, kPupil);
      g.drawLine(eyeX - eyeR, eyeY + S(6) + i, eyeX + eyeR, eyeY - S(6) + i, kPupil);
    }
  } else {
    g.fillCircle(eyeX, eyeY, eyeR, kEyeWhite);
    g.fillCircle(eyeX + S(2), eyeY + S(2), S(9), kPupil);
    g.fillCircle(eyeX - S(4), eyeY - S(4), S(3), kEyeWhite);
  }

  g.fillEllipse(X(228), Y(162), S(12), S(6), kBlush);

  const int mouthX = X(164);
  const int mouthY = Y(158);
  if (mood == kHappy) {
    g.fillEllipse(mouthX + S(11), mouthY + S(6), S(11), S(7), kMouth);
    g.fillEllipse(mouthX + S(11), mouthY + S(10), S(6), S(3), kBlush);
  } else if (mood == kSad) {
    for (int i = 0; i < S(3); i++) {
      g.drawLine(mouthX, mouthY + S(7) + i, mouthX + S(10), mouthY + S(2) + i, kMouth);
      g.drawLine(mouthX + S(10), mouthY + S(2) + i, mouthX + S(20), mouthY + S(7) + i, kMouth);
    }
  } else {
    for (int i = 0; i < S(3); i++) {
      g.drawLine(mouthX, mouthY + i, mouthX + S(10), mouthY + S(5) + i, kMouth);
      g.drawLine(mouthX + S(10), mouthY + S(5) + i, mouthX + S(20), mouthY + i, kMouth);
    }
  }

  // spout bubbles rising from the blowhole
  for (int i = 0; i < 3; i++) {
    const float phase = fmodf(now / 1600.0f + i * 0.33f, 1.0f);
    const int bubbleX = X(188.0f + 10.0f * sinf(phase * 6.283f + i));
    const int bubbleY = Y(64.0f - 46.0f * phase);
    const int radius = S(8.0f - 4.0f * phase);
    if (radius <= 0) continue;
    g.fillCircle(bubbleX, bubbleY, radius, fade(bg, kBody, static_cast<int>((1.0f - phase) * 3.0f), 3));
  }
}

}  // namespace fish
