#include "text.h"

#include "assets/font_cn.h"

namespace text {
namespace {

constexpr int kGlyphBytes = FONT_GLYPH_BYTES;
constexpr int kMaxGlyphPixels = 28 * 28;
uint16_t s_pixels[kMaxGlyphPixels];

/** Decode one UTF-8 code point and advance the cursor. */
uint32_t decode(const char*& cursor) {
  const uint8_t first = static_cast<uint8_t>(*cursor);
  if (first == 0) return 0;
  cursor++;
  if (first < 0x80) return first;
  int extra = 0;
  uint32_t value = 0;
  if ((first & 0xE0) == 0xC0) {
    value = first & 0x1F;
    extra = 1;
  } else if ((first & 0xF0) == 0xE0) {
    value = first & 0x0F;
    extra = 2;
  } else if ((first & 0xF8) == 0xF0) {
    value = first & 0x07;
    extra = 3;
  } else {
    return 0xFFFD;
  }
  for (int i = 0; i < extra; i++) {
    const uint8_t next = static_cast<uint8_t>(*cursor);
    if ((next & 0xC0) != 0x80) return 0xFFFD;
    value = (value << 6) | (next & 0x3F);
    cursor++;
  }
  return value;
}

/** Binary-search the atlas. */
const uint8_t* find(uint32_t codepoint) {
  int low = 0;
  int high = FONT_GLYPH_COUNT - 1;
  while (low <= high) {
    const int mid = (low + high) / 2;
    const uint16_t value = FONT_CODEPOINTS[mid];
    if (value == codepoint) return FONT_GLYPHS[mid];
    if (value < codepoint) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return nullptr;
}

uint8_t level_at(const uint8_t* glyph, int x, int y) {
  const int index = y * (FONT_CELL_W * 2 / 8) + (x * 2) / 8;
  const int shift = 6 - ((x * 2) % 8);
  return (glyph[index] >> shift) & 0x03;
}

uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return static_cast<uint16_t>(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

uint16_t mix(uint16_t from, uint16_t to, int num, int den) {
  const int fr = (from >> 11) & 0x1F, fg = (from >> 5) & 0x3F, fb = from & 0x1F;
  const int tr = (to >> 11) & 0x1F, tg = (to >> 5) & 0x3F, tb = to & 0x1F;
  const int r = fr + (tr - fr) * num / den;
  const int g = fg + (tg - fg) * num / den;
  const int b = fb + (tb - fb) * num / den;
  return static_cast<uint16_t>((r << 11) | (g << 5) | b);
}

}  // namespace

int width(const char* utf8) {
  int total = 0;
  const char* cursor = utf8;
  while (*cursor != 0) {
    const uint32_t codepoint = decode(cursor);
    if (codepoint == 0) break;
    total += codepoint < 0x80 ? kAscii : kWide;
  }
  return total;
}

void draw(M5Canvas& g, int x, int y, const char* utf8, uint16_t fg, uint16_t bg) {
  uint16_t palette[4];
  palette[0] = bg;
  palette[3] = fg;
  palette[1] = mix(bg, fg, 1, 3);
  palette[2] = mix(bg, fg, 2, 3);

  const char* cursor = utf8;
  while (*cursor != 0) {
    const uint32_t codepoint = decode(cursor);
    if (codepoint == 0) break;
    const int advance = codepoint < 0x80 ? kAscii : kWide;
    const uint8_t* glyph = find(codepoint);
    if (glyph == nullptr) glyph = find(0xFFFD);

    if (glyph != nullptr) {
      int index = 0;
      for (int gy = 0; gy < FONT_CELL_H; gy++) {
        for (int gx = 0; gx < advance; gx++) {
          s_pixels[index++] = palette[level_at(glyph, gx, gy)];
        }
      }
      g.pushImage(x, y, advance, FONT_CELL_H, s_pixels);
    }
    x += advance;
  }
}

void drawCentered(M5Canvas& g, int cx, int y, const char* utf8, uint16_t fg, uint16_t bg) {
  draw(g, cx - width(utf8) / 2, y, utf8, fg, bg);
}

}  // namespace text
