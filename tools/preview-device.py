#!/usr/bin/env python3
"""Compose the watch screens from the baked character frames.

Mirrors the layout constants in firmware/stopwatch/src/ui.cpp so the preview
matches what the panel will show.
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
ART = ROOT / "firmware" / "stopwatch" / "assets" / "character"
FONT = HERE / ".cache" / "fonts" / "NotoSansSC-Regular.otf"

W = 466
BG = (9, 11, 22)
TEXT = (235, 240, 255)
MUTED = (128, 140, 178)
ACCENT = (77, 107, 254)
DANGER = (255, 96, 120)
FISH_X, FISH_Y = 83, 36


def font(size):
    return ImageFont.truetype(str(FONT), size)


def centered(d, y, text, color, size):
    f = font(size)
    d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=color)


def sprite(state, frame=0, size=300):
    path = ART / f"{state}-{frame}.png"
    if not path.exists():
        path = ART / f"{state}.png"
    img = Image.open(path).convert("RGBA")
    return img.resize((size, size), Image.LANCZOS)


def ring(d, radius=222, thickness=6, color=(255, 64, 72)):
    d.ellipse([233 - radius, 233 - radius, 233 + radius, 233 + radius], outline=color, width=thickness)


def card(state):
    img = Image.new("RGB", (W, W), BG)
    if state != "prompt":
        art = sprite(state)
        img.paste(art, (FISH_X, FISH_Y), art)
    d = ImageDraw.Draw(img)
    if state == "idle":
        centered(d, 346, "已连接", MUTED, 28)
        centered(d, 412, "88%  -52dBm", MUTED, 18)
    elif state == "alert":
        ring(d, 222, 9)
        centered(d, 346, "有确认请求", TEXT, 28)
        centered(d, 382, "点一下屏幕", ACCENT, 28)
    elif state == "prompt":
        ring(d, 222, 6)
        centered(d, 40, "需要确认", TEXT, 28)
        centered(d, 78, "bash", ACCENT, 28)
        y = 112
        for line in ["命令 npm run build", "需要完全权限：写工作区", "以外的临时文件"]:
            centered(d, y, line, TEXT, 28)
            y += 34
        d.rounded_rectangle([60, 332, 60 + 146, 332 + 56], 16, outline=DANGER, width=2)
        d.text((133 - d.textlength("拒绝", font=font(28)) / 2, 346), "拒绝", font=font(28), fill=DANGER)
        d.rounded_rectangle([260, 332, 260 + 146, 332 + 56], 16, fill=ACCENT)
        d.text((333 - d.textlength("同意", font=font(28)) / 2, 346), "同意", font=font(28), fill=BG)
        centered(d, 410, "电脑处理", MUTED, 28)
    elif state == "happy":
        centered(d, 356, "已同意", ACCENT, 28)
    elif state == "sad":
        centered(d, 356, "已拒绝", MUTED, 28)

    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, W - 1, W - 1], fill=255)
    out = Image.new("RGB", (W, W), (2, 2, 6))
    out.paste(img, (0, 0), mask)
    return out


def main(out):
    states = ["idle", "alert", "prompt", "happy", "sad"]
    pad = 20
    sheet = Image.new("RGB", (len(states) * W + (len(states) + 1) * pad, W + 2 * pad), (6, 7, 14))
    for i, name in enumerate(states):
        sheet.paste(card(name), (pad + i * (W + pad), pad))
    sheet.save(out)
    print("saved", out, sheet.size)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / ".cache" / "device.png"))
