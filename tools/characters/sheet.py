#!/usr/bin/env python3
"""Render the character picker sheet."""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

from artkit import BG, Canvas
from characters import Palette, render

HERE = pathlib.Path(__file__).resolve().parent
FONT = HERE.parent / ".cache" / "fonts" / "NotoSansSC-Regular.otf"

CELL = 280
COLS = 3
MOODS = ["calm", "happy", "sad"]
MOOD_LABEL = {"calm": "待机", "happy": "同意", "sad": "拒绝"}

CHARS = [
    ("团团", "团子鱼 · 最百搭", "mochi", Palette(body=(77, 107, 254), fin=(58, 82, 214), belly=(200, 216, 255))),
    ("豆豆", "河豚 · 最呆萌", "puffer", Palette(body=(46, 196, 182), fin=(30, 156, 146), belly=(210, 246, 240))),
    ("阿鲸", "侧身鲸 · 最像 DeepSeek", "whale", Palette(body=(77, 107, 254), fin=(52, 74, 205), belly=(196, 212, 255))),
    ("锦鲤", "胖头鱼 · 最跳", "koi", Palette(body=(255, 152, 78), fin=(232, 120, 52), belly=(255, 234, 210),
                                     eye=(104, 46, 24), blush=(255, 118, 118))),
]

NAME_W = 170


def load(size):
    return ImageFont.truetype(str(FONT), size)


def draw_cell(kind, pal, mood):
    card = Canvas(CELL, CELL, BG)
    render(card, kind, CELL // 2, CELL // 2 - 6, 236, mood, 0.0, pal)
    img = card.img.resize((CELL, CELL), Image.LANCZOS)

    tile = Image.new("RGBA", (CELL, CELL + 34), BG + (255,))
    tile.alpha_composite(img, (0, 0))
    d = ImageDraw.Draw(tile)
    d.text((CELL / 2, CELL + 4), MOOD_LABEL[mood], font=load(20), fill=(150, 162, 200), anchor="mt")
    d.rounded_rectangle([2, 2, CELL - 3, CELL + 31], radius=18, outline=(30, 36, 62), width=2)
    return tile


def main(out):
    rows = len(CHARS)
    width = NAME_W + COLS * CELL
    height = rows * (CELL + 34 + 16) + 12
    sheet = Image.new("RGBA", (width, height), (6, 7, 14, 255))
    d = ImageDraw.Draw(sheet)

    for row, (name, subtitle, kind, pal) in enumerate(CHARS):
        top = 12 + row * (CELL + 34 + 16)
        d.text((16, top + 92), name, font=load(32), fill=(235, 240, 255))
        head, _, tail = subtitle.partition(" · ")
        d.text((16, top + 136), head, font=load(20), fill=(140, 152, 190))
        d.text((16, top + 162), tail, font=load(18), fill=(94, 106, 148))
        for col, mood in enumerate(MOODS):
            tile = draw_cell(kind, pal, mood)
            sheet.alpha_composite(tile, (NAME_W + col * CELL, top))

    sheet.convert("RGB").save(out)
    print("saved", out, sheet.size)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE.parent / ".cache" / "chars.png"))
