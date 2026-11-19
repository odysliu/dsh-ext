#include "character.h"

#include "assets/characters.h"

namespace {

/** Palette + pixels for one mood. */
struct Frame {
  const uint16_t* palette;
  const uint8_t* pixels;
};

Frame frameFor(Character::Mood mood) {
  switch (mood) {
    case Character::kAlert:
      return {CHAR_ALERT_PAL, CHAR_ALERT};
    case Character::kHappy:
      return {CHAR_HAPPY_PAL, CHAR_HAPPY};
    case Character::kSad:
      return {CHAR_SAD_PAL, CHAR_SAD};
    default:
      return {CHAR_IDLE_PAL, CHAR_IDLE};
  }
}

}  // namespace

void Character::begin(uint16_t background) {
  background_ = background;
  canvas_.setPsram(true);
  canvas_.createSprite(CHAR_W, CHAR_H);
  ready_ = true;
  setMood(kIdle);
}

int Character::width() { return CHAR_W; }

void Character::setMood(Mood mood) {
  if (!ready_ || mood == mood_) return;
  mood_ = mood;
  const Frame frame = frameFor(mood);
  uint16_t row[CHAR_W];
  canvas_.fillScreen(background_);
  for (int y = 0; y < CHAR_H; y++) {
    const uint8_t* line = frame.pixels + static_cast<size_t>(y) * CHAR_W;
    for (int x = 0; x < CHAR_W; x++) {
      const uint8_t index = line[x];
      row[x] = index == 0 ? background_ : frame.palette[index];
    }
    canvas_.pushImage(0, y, CHAR_W, 1, row);
  }
}

void Character::push(int x, int y) {
  if (!ready_) return;
  canvas_.pushSprite(x, y);
}
