#!/usr/bin/env python3
"""Render the whale off-device so the art can be iterated without hardware.

Mirrors firmware/stopwatch/src/fish.cpp closely enough to judge proportions and
facial expressions; it is a design tool, not a test.
"""
import math
import sys

from PIL import Image, ImageDraw

BG = (9, 11, 22)
BODY = (77, 107, 254)
FIN = (52, 74, 205)
BELLY = (168, 188, 255)
WHITE = (255, 255, 255)
PUPIL = (18, 26, 64)
BLUSH = (255, 150, 175)
MOUTH = (24, 34, 80)


def draw_whale(d, x0, y0, size, mood, now):
    """Draw one whale into a 300x300 box at (x0, y0)."""
    u = size / 300.0

    def X(v):
        return x0 + v * u

    def Y(v):
        return y0 + v * u

    def S(v):
        return v * u

    bob = math.sin(now / 780.0) * 4.0
    wag = math.sin(now / 320.0) * 5.0

    def Yb(v):
        return Y(v + bob)

    # tail fluke
    for tri in (
        ((64, 142), (16, 108 - wag), (36, 150)),
        ((64, 158), (16, 192 + wag), (36, 150)),
        ((36, 150), (16, 108 - wag), (64, 158)),
        ((36, 150), (16, 192 + wag), (64, 142)),
    ):
        d.polygon([(X(a), Yb(b)) for a, b in tri], fill=FIN)

    # body + head volume
    d.ellipse([X(150 - 104), Yb(152 - 80), X(150 + 104), Yb(152 + 80)], fill=BODY)
    d.ellipse([X(191 - 71), Yb(171 - 39), X(191 + 71), Yb(171 + 39)], fill=BODY)

    # dorsal fin
    d.polygon([(X(108), Yb(86)), (X(136), Yb(104)), (X(100), Yb(108))], fill=FIN)

    # underside
    d.ellipse([X(157 - 53), Yb(208 - 22), X(157 + 53), Yb(208 + 22)], fill=BELLY)

    # flipper
    d.polygon([(X(92), Yb(190)), (X(118), Yb(214)), (X(90), Yb(218))], fill=FIN)

    eye_x, eye_y, eye_r = 196, 134, 15
    if mood == "happy":
        d.line([(X(eye_x - eye_r), Yb(eye_y + 6)), (X(eye_x), Yb(eye_y - 7)), (X(eye_x + eye_r), Yb(eye_y + 6))],
               fill=PUPIL, width=max(2, int(S(5))))
    elif mood == "sad":
        w = max(2, int(S(5)))
        d.line([(X(eye_x - eye_r), Yb(eye_y - 6)), (X(eye_x + eye_r), Yb(eye_y + 6))], fill=PUPIL, width=w)
        d.line([(X(eye_x - eye_r), Yb(eye_y + 6)), (X(eye_x + eye_r), Yb(eye_y - 6))], fill=PUPIL, width=w)
    else:
        d.ellipse([X(eye_x - eye_r), Yb(eye_y - eye_r), X(eye_x + eye_r), Yb(eye_y + eye_r)], fill=WHITE)
        d.ellipse([X(eye_x + 2 - 9), Yb(eye_y + 2 - 9), X(eye_x + 2 + 9), Yb(eye_y + 2 + 9)], fill=PUPIL)
        d.ellipse([X(eye_x - 7), Yb(eye_y - 7), X(eye_x - 1), Yb(eye_y - 1)], fill=WHITE)

    d.ellipse([X(228 - 12), Yb(162 - 6), X(228 + 12), Yb(162 + 6)], fill=BLUSH)

    mouth_x, mouth_y = 164, 158
    if mood == "happy":
        d.ellipse([X(mouth_x), Yb(mouth_y), X(mouth_x + 22), Yb(mouth_y + 13)], fill=MOUTH)
        d.ellipse([X(mouth_x + 5), Yb(mouth_y + 7), X(mouth_x + 17), Yb(mouth_y + 13)], fill=BLUSH)
    else:
        width = max(2, int(S(3)))
        if mood == "sad":
            d.line([(X(mouth_x), Yb(mouth_y + 7)), (X(mouth_x + 10), Yb(mouth_y + 2)),
                    (X(mouth_x + 20), Yb(mouth_y + 7))], fill=MOUTH, width=width)
        else:
            d.line([(X(mouth_x), Yb(mouth_y)), (X(mouth_x + 10), Yb(mouth_y + 5)),
                    (X(mouth_x + 20), Yb(mouth_y))], fill=MOUTH, width=width)

    for index in range(3):
        phase = (now / 1600.0 + index * 0.33) % 1.0
        bubble_x = 188 + 10 * math.sin(phase * 6.283 + index)
        bubble_y = 64 - 46 * phase
        radius = max(1, int(S(8 - 4 * phase)))
        color = tuple(int(BG[k] + (BODY[k] - BG[k]) * (1 - phase)) for k in range(3))
        d.ellipse([X(bubble_x) - radius, Y(bubble_y) - radius, X(bubble_x) + radius, Y(bubble_y) + radius],
                  fill=color)


def main(out):
    width = 466
    canvas = Image.new("RGB", (width * 3 + 40, width), BG)
    for index, mood in enumerate(["calm", "happy", "sad"]):
        draw_whale(ImageDraw.Draw(canvas), index * (width + 20) + 83, 83, 300, mood, 0)
    canvas.save(out)
    print("saved", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tools/.cache/fish.png")
