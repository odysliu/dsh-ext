#!/usr/bin/env python3
"""Render each candidate at real device size (466x466, round mask, ALERT state)."""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

from artkit import Canvas
from characters import Palette, render
from sheet import CHARS

HERE = pathlib.Path(__file__).resolve().parent
FONT = HERE.parent / ".cache" / "fonts" / "NotoSansSC-Regular.otf"
W = 466


def font(size):
    return ImageFont.truetype(str(FONT), size)


def centered(d, width, y, text, color, size):
    f = font(size)
    d.text(((width - d.textlength(text, font=f)) / 2, y), text, font=f, fill=color)


def card(kind, pal):
    c = Canvas(W, W)
    render(c, kind, W // 2, 158, 300, "calm", 0.0, pal)
    img = c.img.resize((W, W), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    centered(d, W, 330, "有确认请求", (235, 240, 255), 28)
    centered(d, W, 366, "点一下屏幕", (77, 107, 254), 28)
    centered(d, W, 404, "88%  -52dBm", (128, 140, 178), 18)

    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, W - 1, W - 1], fill=255)
    out = Image.new("RGB", (W, W), (2, 2, 6))
    out.paste(img.convert("RGB"), (0, 0), mask)
    return out


def main(out):
    cols = 2
    rows = (len(CHARS) + cols - 1) // cols
    pad, label_h = 24, 54
    sheet = Image.new("RGB", (cols * W + (cols + 1) * pad, rows * (W + label_h) + (rows + 1) * pad), (6, 7, 14))
    d = ImageDraw.Draw(sheet)
    for index, (name, subtitle, kind, pal) in enumerate(CHARS):
        col, row = index % cols, index // cols
        x = pad + col * (W + pad)
        y = pad + row * (W + label_h + pad)
        sheet.paste(card(kind, pal), (x, y))
        head = subtitle.partition(" · ")[0]
        d.text((x + 10, y + W + 10), f"{name} · {head}", font=font(26), fill=(220, 228, 250))
        d.text((x + 10, y + W + 40), "300px 显示尺寸 · 深色 AMOLED", font=font(16), fill=(110, 122, 160))
    sheet.save(out)
    print("saved", out, sheet.size)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE.parent / ".cache" / "onscreen.png"))
