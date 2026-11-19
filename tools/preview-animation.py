#!/usr/bin/env python3
"""Filmstrip of the animation: idle 3 frames, then alert 2 frames with the ring."""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
ART = ROOT / "firmware" / "stopwatch" / "assets" / "character"
FONT = HERE / ".cache" / "fonts" / "NotoSansSC-Regular.otf"

W, BG = 466, (9, 11, 22)
FISH_X, FISH_Y = 83, 36


def font(size):
    return ImageFont.truetype(str(FONT), size)


def centered(d, y, text, color, size):
    f = font(size)
    d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=color)


def frame(state, index, alert):
    img = Image.new("RGB", (W, W), BG)
    art = Image.open(ART / f"{state}-{index}.png").convert("RGBA").resize((300, 300), Image.LANCZOS)
    img.paste(art, (FISH_X, FISH_Y), art)
    d = ImageDraw.Draw(img)
    if alert:
        d.ellipse([11, 11, W - 11, W - 11], outline=(255, 64, 72), width=9)
        centered(d, 346, "有确认请求", (235, 240, 255), 28)
        centered(d, 382, "点一下屏幕", (77, 107, 254), 28)
    else:
        centered(d, 346, "已连接", (128, 140, 178), 28)
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, W - 1, W - 1], fill=255)
    out = Image.new("RGB", (W, W), (2, 2, 6))
    out.paste(img, (0, 0), mask)
    return out


def main(out):
    shots = [frame("idle", 0, False), frame("idle", 1, False), frame("idle", 2, False),
             frame("alert", 0, True), frame("alert", 1, True)]
    pad = 18
    sheet = Image.new("RGB", (len(shots) * W + (len(shots) + 1) * pad, W + 2 * pad), (6, 7, 14))
    for i, shot in enumerate(shots):
        sheet.paste(shot, (pad + i * (W + pad), pad))
    sheet.save(out)
    print("saved", out, sheet.size)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / ".cache" / "animation.png"))
