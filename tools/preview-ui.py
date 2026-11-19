#!/usr/bin/env python3
"""Compose the three device screens off-device, to check layout and safe area.

Uses the same font sizes, coordinates, and palette as firmware/stopwatch/src/ui.cpp.
Design tool only; the firmware remains the source of truth.
"""
import importlib.util
import pathlib
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
FONT_PATH = HERE / '.cache' / 'fonts' / 'NotoSansSC-Regular.otf'

BG = (9, 11, 22)
PANEL = (20, 25, 45)
TEXT = (232, 236, 255)
MUTED = (128, 140, 178)
ACCENT = (77, 107, 254)
DANGER = (255, 96, 120)

spec = importlib.util.spec_from_file_location('fish', HERE / 'preview-fish.py')
fish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fish)


def load(size):
    return ImageFont.truetype(str(FONT_PATH), size)


def centered(d, y, text, color, font):
    w = d.textlength(text, font=font)
    d.text(((466 - w) / 2, y), text, font=font, fill=color)


def screen_alert(now=0):
    img = Image.new('RGB', (466, 466), BG)
    d = ImageDraw.Draw(img)
    fish.draw_whale(d, 233 - 140, 150 - 140, 280, 'calm', now)
    centered(d, 330, '有确认请求', TEXT, load(28))
    centered(d, 366, '点一下屏幕', ACCENT, load(28))
    centered(d, 404, '88%  -52dBm', MUTED, load(18))
    return img


def screen_prompt(lines):
    img = Image.new('RGB', (466, 466), BG)
    d = ImageDraw.Draw(img)
    centered(d, 40, '需要确认', TEXT, load(28))
    centered(d, 78, 'bash', ACCENT, load(28))
    y = 112
    for line in lines:
        centered(d, y, line, TEXT, load(28))
        y += 34
    d.rounded_rectangle([60, 332, 60 + 146, 332 + 56], 16, outline=DANGER, width=2)
    d.text((133 - d.textlength('拒绝', font=load(28)) / 2, 346), '拒绝', font=load(28), fill=DANGER)
    d.rounded_rectangle([260, 332, 260 + 146, 332 + 56], 16, fill=ACCENT)
    d.text((333 - d.textlength('同意', font=load(28)) / 2, 346), '同意', font=load(28), fill=BG)
    centered(d, 410, '电脑处理', MUTED, load(28))
    return img


def screen_result(text, color):
    img = Image.new('RGB', (466, 466), BG)
    d = ImageDraw.Draw(img)
    centered(d, 196, text, color, load(28))
    return img


def mask(img):
    m = Image.new('L', (466, 466), 0)
    ImageDraw.Draw(m).ellipse([0, 0, 465, 465], fill=255)
    out = Image.new('RGB', (466, 466), (2, 2, 6))
    out.paste(img, (0, 0), m)
    return out


def main(out):
    prompt = screen_prompt(['命令 npm run build', '需要完全权限：写工作区', '以外的临时文件'])
    shots = [screen_alert(), prompt, screen_result('已同意', ACCENT), screen_result('已拒绝', MUTED)]
    canvas = Image.new('RGB', (466 * 4 + 60, 466), (2, 2, 6))
    for index, shot in enumerate(shots):
        canvas.paste(mask(shot), (index * (466 + 20), 0))
    canvas.save(out)
    print('saved', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / '.cache' / 'ui.png'))
