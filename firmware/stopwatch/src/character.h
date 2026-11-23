/**
 * Character sprites: the Live2D model baked into 8bpp frames by
 * tools/build_sprites.py (DS 鲸鱼娘, CC BY-NC-SA 4.0 — see assets/character/).
 *
 * Every state has 1–3 frames sampled from the model's idle motion; they play
 * ping-pong so the loop never jumps.
 */

#pragma once

#include <M5Unified.h>

class Character {
 public:
  enum Mood {
    kIdle = 0,
    kAlert = 1,
    kHappy = 2,
    kSad = 3,
  };

  /** Allocate the frame canvases; call once from UI::begin(). */
  void begin(uint16_t background);

  /** Switch mood; frames are decoded immediately. */
  void setMood(Mood mood);

  /** Advance the ping-pong playback; call every loop. */
  void tick(uint32_t now);

  /** Push the current frame at (x, y); the canvas has an opaque background. */
  void push(int x, int y);

  static int width();

  /** Dump the current frame as hex over serial (debug screenshots). */
  void dump();

  /** Dump an arbitrary canvas with the same wire format. */
  void dumpCanvas(M5Canvas* canvas);

 private:
  static constexpr int kMaxFrames = 3;
  M5Canvas* frames_[kMaxFrames] = {nullptr, nullptr, nullptr};
  Mood mood_ = kIdle;
  int count_ = 0;
  int index_ = 0;
  int direction_ = 1;
  uint32_t lastFrame_ = 0;
  uint32_t frameMs_ = 280;
  bool ready_ = false;
  uint16_t background_ = 0;
};
