/**
 * Character sprites: the Live2D model baked into 8bpp frames by
 * tools/build_sprites.py (DS 鲸鱼娘, CC BY-NC-SA 4.0 — see assets/character/).
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

  /** Allocate the sprite canvas; call once from UI::begin(). */
  void begin(uint16_t background);

  /** Switch mood; the frame is decoded into the canvas immediately. */
  void setMood(Mood mood);

  /** Push the frame at (x, y); the canvas has an opaque background. */
  void push(int x, int y);

  /** Width/height of the sprite in pixels. */
  static int width();

 private:
  M5Canvas canvas_{&M5.Display};
  Mood mood_ = kIdle;
  bool ready_ = false;
  uint16_t background_ = 0;
};
