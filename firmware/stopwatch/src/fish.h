/**
 * The chubby DeepSeek whale, drawn procedurally so it stays crisp at any size
 * and costs no flash. All geometry is relative to a `size` box, so the same
 * routine draws the big idle fish and the small header icon.
 */

#pragma once

#include <M5GFX.h>

namespace fish {

enum Mood {
  kCalm = 0,
  kHappy = 1,
  kSad = 2,
};

/**
 * Draw one frame.
 * @param g canvas to draw into
 * @param cx centre x
 * @param cy centre y
 * @param size overall width in pixels (300 reads well on the 466 panel)
 * @param mood facial expression
 * @param now millis(), drives bobbing, tail wag, and bubbles
 * @param bg background colour the fish sits on
 */
void draw(M5Canvas& g, int cx, int cy, int size, int mood, uint32_t now, uint16_t bg);

}  // namespace fish
