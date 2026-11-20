#include "character.h"

#include "assets/characters.h"

namespace {

/** One mood's palette, frames and playback speed. */
struct FrameSet {
  const uint16_t* palette;
  const uint8_t* const* frames;
  int count;
  uint32_t frameMs;
};

FrameSet setFor(Character::Mood mood) {
  switch (mood) {
    case Character::kAlert:
      return {CHAR_ALERT_PAL, CHAR_ALERT_FRAMES, CHAR_ALERT_COUNT, 180};
    case Character::kHappy:
      return {CHAR_HAPPY_PAL, CHAR_HAPPY_FRAMES, CHAR_HAPPY_COUNT, 150};
    case Character::kSad:
      return {CHAR_SAD_PAL, CHAR_SAD_FRAMES, CHAR_SAD_COUNT, 0};
    default:
      return {CHAR_IDLE_PAL, CHAR_IDLE_FRAMES, CHAR_IDLE_COUNT, 320};
  }
}

}  // namespace

void Character::begin(uint16_t background) {
  background_ = background;
  for (int i = 0; i < kMaxFrames; i++) {
    // the array constructor has no display parent; without it pushSprite dereferences null
    frames_[i] = new M5Canvas(&M5.Display);
    frames_[i]->createSprite(CHAR_W, CHAR_H);
  }
  ready_ = true;
  count_ = 0;
  setMood(kIdle);
}

int Character::width() { return CHAR_W; }

void Character::setMood(Mood mood) {
  if (!ready_) return;
  if (mood == mood_ && count_ > 0) return;
  mood_ = mood;
  const FrameSet set = setFor(mood);
  count_ = set.count > kMaxFrames ? kMaxFrames : set.count;
  frameMs_ = set.frameMs;
  index_ = 0;
  direction_ = 1;
  lastFrame_ = millis();

  // Decode with fillRect runs rather than pushImage(uint16_t*): the latter takes
  // a byte-swap path on sprites and produced wrong colours on the panel.
  for (int frame = 0; frame < count_; frame++) {
    M5Canvas& canvas = *frames_[frame];
    canvas.fillScreen(background_);
    const uint8_t* pixels = set.frames[frame];
    for (int y = 0; y < CHAR_H; y++) {
      const uint8_t* line = pixels + static_cast<size_t>(y) * CHAR_W;
      int x = 0;
      while (x < CHAR_W) {
        const uint8_t index = line[x];
        const int start = x;
        while (x < CHAR_W && line[x] == index) x++;
        if (index != 0) canvas.fillRect(start, y, x - start, 1, set.palette[index]);
      }
    }
  }
}

void Character::tick(uint32_t now) {
  if (!ready_ || count_ < 2 || frameMs_ == 0) return;
  if (now - lastFrame_ < frameMs_) return;
  lastFrame_ = now;
  index_ += direction_;
  if (index_ >= count_) {
    index_ = count_ - 2;
    direction_ = -1;
  } else if (index_ < 0) {
    index_ = 1;
    direction_ = 1;
  }
}

void Character::push(int x, int y) {
  if (!ready_ || count_ == 0) return;
  if (frames_[index_] != nullptr) frames_[index_]->pushSprite(x, y);
}
