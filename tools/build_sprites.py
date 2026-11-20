#!/usr/bin/env python3
"""Turn dropped-in character art into 4bpp sprite frames for the firmware.

Put PNGs in firmware/stopwatch/assets/character/ (idle / alert / happy / sad),
then run:

    python3 tools/build_sprites.py

It removes leftover backgrounds, crops to the artwork, fits it into a 300x300
box, quantises to 16 colours (index 0 = transparent), and writes
firmware/stopwatch/src/assets/characters.h plus a PNG preview of exactly what
the panel will show.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "firmware" / "stopwatch" / "assets" / "character"
OUT_HEADER = ROOT / "firmware" / "stopwatch" / "src" / "assets" / "characters.h"
PREVIEW = ROOT / "tools" / ".cache" / "sprites-preview.png"

SIZE = 300
MARGIN = 0.06
STATES = ["idle", "alert", "happy", "sad"]
BPP = 8
COLORS = 255  # index 0 stays transparent


def find_sources(state: str) -> list[pathlib.Path]:
    """All frames for one state: `idle.png`, or `idle-0.png`, `idle-1.png`, ..."""
    numbered = sorted(SRC_DIR.glob(f"{state}-*.png")) + sorted(SRC_DIR.glob(f"{state}-*.PNG"))
    if numbered:
        return numbered
    for pattern in (f"{state}.png", f"{state}.PNG"):
        hits = sorted(SRC_DIR.glob(pattern))
        if hits:
            return [hits[0]]
    hits = sorted(SRC_DIR.glob(f"*{state}*.png"))
    return [hits[0]] if hits else []


def drop_background(img: Image.Image) -> Image.Image:
    """Make a uniform background transparent; keep real alpha untouched."""
    img = img.convert("RGBA")
    alpha = img.getchannel("A")
    if alpha.getextrema() != (255, 255):
        return img

    w, h = img.size
    corners = [img.getpixel((0, 0)), img.getpixel((w - 1, 0)), img.getpixel((0, h - 1)), img.getpixel((w - 1, h - 1))]
    corner = corners[0]
    if any(max(abs(a - b) for a, b in zip(corner[:3], c[:3])) > 24 for c in corners[1:]):
        print("  ! background is not uniform; leaving pixels as they are")
        return img

    pixels = img.load()
    tolerance = 32
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if abs(r - corner[0]) <= tolerance and abs(g - corner[1]) <= tolerance and abs(b - corner[2]) <= tolerance:
                pixels[x, y] = (r, g, b, 0)
    return img


def fit_common(images: list[Image.Image], size: int = SIZE) -> list[Image.Image]:
    """Crop every frame of a state with one shared box so they stay registered.

    Per-frame cropping makes the character twitch between frames, because each
    frame's alpha bbox differs by a few pixels.
    """
    boxes = [img.getchannel("A").getbbox() for img in images]
    if any(box is None for box in boxes):
        raise SystemExit("artwork is fully transparent")
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    width, height = right - left, bottom - top

    box = int(size * (1 - 2 * MARGIN))
    scale = min(box / width, box / height)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    offset = ((size - target[0]) // 2, (size - target[1]) // 2)

    out = []
    for img in images:
        art = img.crop((left, top, right, bottom)).resize(target, Image.BOX)  # no ringing halos
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(art, offset)
        out.append(canvas)
    return out


def quantize(img: Image.Image) -> tuple[Image.Image, list[tuple[int, int, int]]]:
    """Indexed palette with index 0 reserved for transparency."""
    rgb = Image.new("RGB", img.size, (9, 11, 22))
    rgb.paste(img, (0, 0), img)
    quant = rgb.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = quant.getpalette()[: COLORS * 3]
    colors = [tuple(palette[i * 3 : i * 3 + 3]) for i in range(COLORS)]

    # Compose at the index level: pasting P-mode images makes PIL round-trip
    # through RGB and scrambles the palette.
    indices = quant.tobytes()
    alpha = img.getchannel("A").tobytes()
    data = bytearray(len(indices))
    for i, value in enumerate(indices):
        data[i] = min(255, value + 1) if alpha[i] >= 128 else 0
    indexed = Image.frombytes("P", img.size, bytes(data))
    indexed.putpalette([0, 0, 0] + palette + [0] * (768 - 3 - len(palette)))
    return indexed, colors


def quantize_palette(img: Image.Image) -> list[int]:
    """The RGB palette the quantiser would pick for this frame."""
    rgb = Image.new("RGB", img.size, (9, 11, 22))
    rgb.paste(img, (0, 0), img)
    return rgb.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()[
        : COLORS * 3
    ]


def remap(img: Image.Image, palette_img: Image.Image) -> Image.Image:
    """Map a frame onto an existing palette and keep alpha as index 0."""
    rgb = Image.new("RGB", img.size, (9, 11, 22))
    rgb.paste(img, (0, 0), img)
    quant = rgb.quantize(palette=palette_img, dither=Image.Dither.NONE)
    indices = quant.tobytes()
    alpha = img.getchannel("A").tobytes()
    data = bytearray(len(indices))
    for i, value in enumerate(indices):
        data[i] = min(255, value + 1) if alpha[i] >= 128 else 0
    indexed = Image.frombytes("P", img.size, bytes(data))
    indexed.putpalette(palette_img.getpalette())
    return indexed


def rgb565(color: tuple[int, int, int]) -> int:
    r, g, b = color
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def despeckle(indexed: Image.Image) -> Image.Image:
    """Replace isolated pixels with the majority of their neighbours.

    Thin anti-aliased lines sometimes quantise into single white dots that look
    like scratches on the panel.
    """
    w, h = indexed.size
    src = indexed.tobytes()
    out = bytearray(src)
    for y in range(1, h - 1):
        row = y * w
        for x in range(1, w - 1):
            i = row + x
            value = src[i]
            if value == 0:
                continue
            counts = {}
            for dy in (-1, 0, 1):
                base = (y + dy) * w
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    n = src[base + x + dx]
                    counts[n] = counts.get(n, 0) + 1
            if counts.get(value, 0) == 0:
                out[i] = max(counts, key=counts.get)
    result = Image.frombytes("P", indexed.size, bytes(out))
    result.putpalette(indexed.getpalette())
    return result


def pack(indexed: Image.Image) -> bytes:
    """One byte per pixel at 8bpp; two nibbles per byte at 4bpp."""
    data = bytearray()
    w, h = indexed.size
    px = indexed.load()
    if BPP == 8:
        for y in range(h):
            for x in range(w):
                data.append(px[x, y])
        return bytes(data)
    for y in range(h):
        for x in range(0, w, 2):
            hi = px[x, y] & 0x0F
            lo = px[x + 1, y] & 0x0F if x + 1 < w else 0
            data.append((hi << 4) | lo)
    return bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", default=str(PREVIEW))
    args = parser.parse_args()

    found = {state: find_sources(state) for state in STATES}
    if not found["idle"]:
        print(f"没有找到角色图。把 PNG 放进 {SRC_DIR.relative_to(ROOT)}/（至少 idle.png）再运行。")
        print(f"当前目录内容：{sorted(p.name for p in SRC_DIR.glob('*'))}")
        sys.exit(0)

    sprites: dict[str, tuple[list[Image.Image], list]] = {}
    for state in STATES:
        paths = found[state] or found["idle"]
        print(f"{state:6s} <- {len(paths)} frame(s): {', '.join(p.name for p in paths)}")
        raw = []
        for path in paths:
            img = Image.open(path)
            img.thumbnail((1200, 1200), Image.BOX)
            raw.append(drop_background(img))
        fitted_frames = fit_common(raw)
        # one palette for the whole state, otherwise colours flicker between frames
        indexed, colors = quantize(fitted_frames[0])
        palette_img = Image.new("P", (1, 1))
        palette_img.putpalette([0, 0, 0] + quantize_palette(fitted_frames[0]))
        frames = [indexed]
        for fitted in fitted_frames[1:]:
            frames.append(remap(fitted, palette_img))
        sprites[state] = (frames, colors)

    OUT_HEADER.parent.mkdir(parents=True, exist_ok=True)
    with OUT_HEADER.open("w", encoding="utf-8") as handle:
        handle.write("// Generated by tools/build_sprites.py from assets/character/*.png.\n")
        handle.write("// 4bpp indexed sprites, palette entry 0 = transparent.\n")
        handle.write("#pragma once\n\n#include <stdint.h>\n\n")
        handle.write(f"#define CHAR_W {SIZE}\n#define CHAR_H {SIZE}\n")
        handle.write(f"#define CHAR_BPP {BPP}\n")
        handle.write(f"#define CHAR_PALETTE_SIZE {COLORS + 1}\n")
        handle.write(f"#define CHAR_BYTES (CHAR_W * CHAR_H * {BPP} / 8)\n\n")
        for state in STATES:
            frames, colors = sprites[state]
            name = state.upper()
            handle.write(f"#define CHAR_{name}_COUNT {len(frames)}\n")
            handle.write(f"static const uint16_t CHAR_{name}_PAL[CHAR_PALETTE_SIZE] = {{\n  0x0000,\n")
            handle.write("".join(f"  0x{rgb565(c):04X},\n" for c in colors))
            handle.write("};\n\n")
            for index, frame in enumerate(frames):
                handle.write(f"static const uint8_t CHAR_{name}_{index}[CHAR_BYTES] = {{\n")
                packed = pack(frame)
                for offset in range(0, len(packed), 24):
                    handle.write("  " + ",".join(str(b) for b in packed[offset : offset + 24]) + ",\n")
                handle.write("};\n\n")
            pointers = ", ".join(f"CHAR_{name}_{i}" for i in range(len(frames)))
            handle.write(f"static const uint8_t* const CHAR_{name}_FRAMES[CHAR_{name}_COUNT] = {{{pointers}}};\n\n")

    per_state = max(len(sprites[state][0]) for state in STATES)
    preview = Image.new("RGB", (SIZE * per_state, SIZE * len(STATES)), (9, 11, 22))
    for row, state in enumerate(STATES):
        frames, colors = sprites[state]
        for column, indexed in enumerate(frames):
            rgba = Image.new("RGBA", indexed.size, (0, 0, 0, 0))
            src = indexed.load()
            dst = rgba.load()
            for y in range(SIZE):
                for x in range(SIZE):
                    value = src[x, y]
                    if value == 0:
                        continue
                    r, g, b = colors[value - 1] if value - 1 < len(colors) else (255, 0, 255)
                    dst[x, y] = (r, g, b, 255)
            preview.paste(rgba, (column * SIZE, row * SIZE), rgba)
    pathlib.Path(args.preview).parent.mkdir(parents=True, exist_ok=True)
    preview.save(args.preview)

    print(f"\n✓ {OUT_HEADER.relative_to(ROOT)}  ({OUT_HEADER.stat().st_size / 1024:.0f} KiB)")
    print(f"✓ preview {args.preview}")


if __name__ == "__main__":
    main()
