#!/usr/bin/env python3
"""Render the whale geometry off-device so the art can be iterated without hardware.

This mirrors firmware/stopwatch/src/fish.cpp closely enough to judge
proportions and face expressions; it is a design tool, not a test.
"""
import math
import sys
from PIL import Image, ImageDraw

BG = (10, 12, 24)
BODY = (77, 107, 254)
BODY_DARK = (58, 82, 214)
BELLY = (199, 212, 255)
WHITE = (255, 255, 255)
PUPIL = (22, 32, 74)
BLUSH = (255, 158, 181)
MOUTH = (26, 38, 88)


def draw_whale(d, cx, cy, size, mood, now):
    s = float(size)
    bob = math.sin(now / 780.0) * s * 0.018
    wag = math.sin(now / 320.0)
    x, y = cx, int(cy + bob)
    hinge = x - int(s * 0.26)
    tipx = x - int(s * (0.50 + 0.02 * wag))
    tip_top = y - int(s * 0.24) + int(s * 0.05 * wag)
    tip_bot = y + int(s * 0.22) + int(s * 0.05 * wag)
    waist = x - int(s * 0.36)
    d.polygon([(hinge, y - int(s*0.03)), (tipx, tip_top), (waist, y + int(s*0.02))], fill=BODY_DARK)
    d.polygon([(hinge, y + int(s*0.03)), (tipx, tip_bot), (waist, y - int(s*0.02))], fill=BODY_DARK)
    d.polygon([(x-int(s*0.06), y-int(s*0.20)), (x+int(s*0.07), y-int(s*0.22)), (x-int(s*0.01), y-int(s*0.37))], fill=BODY_DARK)
    d.ellipse([x-int(s*0.33), y-int(s*0.25), x+int(s*0.33), y+int(s*0.25)], fill=BODY)
    d.ellipse([x+int(s*0.02)-int(s*0.26), y+int(s*0.08)-int(s*0.14), x+int(s*0.02)+int(s*0.26), y+int(s*0.08)+int(s*0.14)], fill=BELLY)
    d.polygon([(x-int(s*0.05), y+int(s*0.13)), (x+int(s*0.05), y+int(s*0.29)), (x+int(s*0.11), y+int(s*0.10))], fill=BODY_DARK)

    ex, ey = x + int(s*0.13), y - int(s*0.06)
    er = int(s*0.045)
    if mood == 'happy':
        d.line([(ex-er, ey+er//2), (ex, ey-er//2), (ex+er, ey+er//2)], fill=PUPIL, width=3)
    elif mood == 'sad':
        d.line([(ex-er, ey-er//2), (ex+er, ey+er//2)], fill=PUPIL, width=3)
        d.line([(ex-er, ey+er//2), (ex+er, ey-er//2)], fill=PUPIL, width=3)
    else:
        d.ellipse([ex-er, ey-er, ex+er, ey+er], fill=WHITE)
        pr = int(er*0.55)
        d.ellipse([ex+er//4-pr, ey+er//8-pr, ex+er//4+pr, ey+er//8+pr], fill=PUPIL)

    d.ellipse([x+int(s*0.23)-int(s*0.045), y+int(s*0.06)-int(s*0.028), x+int(s*0.23)+int(s*0.045), y+int(s*0.06)+int(s*0.028)], fill=BLUSH)

    mx, my = x + int(s*0.06), y + int(s*0.07)
    if mood == 'happy':
        d.ellipse([mx+int(s*0.04)-int(s*0.055), my+int(s*0.02)-int(s*0.045), mx+int(s*0.04)+int(s*0.055), my+int(s*0.02)+int(s*0.045)], fill=MOUTH)
    elif mood == 'sad':
        d.line([(mx, my+int(s*0.02)), (mx+int(s*0.03), my), (mx+int(s*0.06), my+int(s*0.015))], fill=MOUTH, width=3)
    else:
        d.line([(mx, my), (mx+int(s*0.03), my+int(s*0.015)), (mx+int(s*0.06), my)], fill=MOUTH, width=3)


def main(out):
    W = 466
    img = Image.new('RGB', (W * 3 + 40, 420), BG)
    for i, mood in enumerate(['calm', 'happy', 'sad']):
        d = ImageDraw.Draw(img)
        draw_whale(d, 120 + i * (W + 20) + 0, 210, 300, mood, 0)
    img.save(out)
    print('saved', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'tools/.cache/fish.png')
