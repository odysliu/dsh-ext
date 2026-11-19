"""Original chubby-fish characters, authored in a 300x300 box.

Two clear body plans keep the silhouettes readable on a 466px round screen:

* front view  — a dumpling-shaped body with the face centred (fish/blob mascot)
* side view   — a heavy-headed whale with the eye near the head (DeepSeek-ish)

Everything is flat colour with soft patches, because the firmware will bake
these into a 16-colour sprite atlas.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from artkit import Canvas, darken, lighten, mix


@dataclass
class Palette:
    body: tuple
    fin: tuple
    belly: tuple
    eye: tuple = (20, 28, 60)
    blush: tuple = (255, 138, 162)
    mouth: tuple = (28, 34, 68)


class Box:
    """Local 300x300 coordinate space placed on a card."""

    def __init__(self, card: Canvas, cx: float, cy: float, size: float):
        self.card = card
        self.k = size / 300.0
        self.ox = cx - 150 * self.k
        self.oy = cy - 150 * self.k

    def x(self, v):
        return self.ox + v * self.k

    def y(self, v):
        return self.oy + v * self.k

    def s(self, v):
        return v * self.k

    def ellipse(self, cx, cy, rx, ry, **kw):
        self.card.ellipse(self.x(cx), self.y(cy), self.s(rx), self.s(ry), **kw)

    def circle(self, cx, cy, r, **kw):
        self.ellipse(cx, cy, r, r, **kw)

    def poly(self, pts, **kw):
        self.card.poly([(self.x(a), self.y(b)) for a, b in pts], **kw)

    def fan(self, hx, hy, r, a0, a1, fill, notch=0.0, steps=12):
        """Rounded fan from a hinge — proper fins and flukes."""
        pts = [(hx, hy)]
        for i in range(steps + 1):
            a = math.radians(a0 + (a1 - a0) * i / steps)
            rr = r * (1 - notch * math.sin(math.pi * i / steps))
            pts.append((hx + rr * math.cos(a), hy + rr * math.sin(a)))
        self.poly(pts, fill=fill)

    def line(self, pts, color, width):
        self.card.line([(self.x(a), self.y(b)) for a, b in pts], color, self.s(width))

    def arc(self, cx, cy, rx, ry, start, end, color, width):
        self.card.arc(self.x(cx), self.y(cy), self.s(rx), self.s(ry), start, end, color, self.s(width))

    def rotated(self, cx, cy, rx, ry, angle, fill, alpha=255):
        self.card.rotated_ellipse(self.x(cx), self.y(cy), self.s(rx), self.s(ry), angle, fill, alpha)

    def soft(self, cx, cy, rx, ry, color, alpha, blur):
        self.card.soft_ellipse(self.x(cx), self.y(cy), self.s(rx), self.s(ry), color, alpha=alpha, blur=blur)


# ---------------------------------------------------------------------------
# shared face parts
# ---------------------------------------------------------------------------
def eye_round(b: Box, x, y, r, pal: Palette, look=0.0):
    b.circle(x, y, r, fill=(255, 255, 255))
    iris = r * 0.78
    b.circle(x + look, y + r * 0.04, iris, fill=pal.eye)
    b.circle(x + look - iris * 0.34, y - iris * 0.38, max(2.2, iris * 0.36), fill=(255, 255, 255))
    b.circle(x + look + iris * 0.36, y + iris * 0.48, max(1.6, iris * 0.18), fill=(222, 232, 255))


def eye_happy(b: Box, x, y, r, pal: Palette):
    b.arc(x, y + r * 0.34, r * 0.92, r * 0.82, 200, 340, pal.eye, r * 0.34)


def eye_sad(b: Box, x, y, r, pal: Palette):
    """Round eye with a heavy lid: reads as sad at watch distance."""
    b.circle(x, y, r, fill=(255, 255, 255))
    iris = r * 0.6
    b.circle(x, y + r * 0.22, iris, fill=pal.eye)
    b.circle(x - iris * 0.34, y + r * 0.22 - iris * 0.36, max(2, iris * 0.3), fill=(255, 255, 255))
    # lid
    b.card.poly([
        (b.x(x - r * 1.02), b.y(y - r * 1.05)),
        (b.x(x + r * 1.02), b.y(y - r * 1.05)),
        (b.x(x + r * 0.95), b.y(y - r * 0.15)),
        (b.x(x - r * 0.95), b.y(y - r * 0.05)),
    ], fill=pal.body)
    b.line([(x - r * 0.95, y - r * 0.12), (x + r * 0.95, y - r * 0.2)], pal.eye, r * 0.22)


def eye_blink(b: Box, x, y, r, pal: Palette):
    b.line([(x - r * 0.8, y + r * 0.1), (x + r * 0.8, y + r * 0.1)], pal.eye, r * 0.3)


def mouth_w(b: Box, x, y, w, pal: Palette, width=3.2):
    b.arc(x - w * 0.45, y, w * 0.45, w * 0.38, 10, 170, pal.mouth, width)
    b.arc(x + w * 0.45, y, w * 0.45, w * 0.38, 10, 170, pal.mouth, width)


def mouth_open(b: Box, x, y, w, h, pal: Palette):
    b.ellipse(x, y, w, h, fill=pal.mouth)
    b.soft(x, y + h * 0.45, w * 0.55, h * 0.45, pal.blush, alpha=230, blur=3)


def mouth_frown(b: Box, x, y, w, pal: Palette):
    b.arc(x, y + w * 0.5, w * 0.5, w * 0.4, 190, 350, pal.mouth, 3.2)


def face_front(b: Box, pal: Palette, mood: str, eye_y=134, dy=0.0, spread=40, r=19):
    lx, rx = 150 - spread, 150 + spread
    if mood == "happy":
        eye_happy(b, lx, eye_y + dy, r, pal)
        eye_happy(b, rx, eye_y + dy, r, pal)
    elif mood == "sad":
        eye_sad(b, lx, eye_y + dy, r, pal)
        eye_sad(b, rx, eye_y + dy, r, pal)
    else:
        eye_round(b, lx, eye_y + dy, r, pal)
        eye_round(b, rx, eye_y + dy, r, pal)

    if mood == "happy":
        mouth_open(b, 150, 178 + dy, 12, 9, pal)
    elif mood == "sad":
        mouth_frown(b, 150, 182 + dy, 11, pal)
        b.ellipse(176, 152 + dy, 3.2, 5.0, fill=(150, 200, 255))
    else:
        mouth_w(b, 150, 176 + dy, 20, pal)

    b.soft(150 - 58, 158 + dy, 13, 8, pal.blush, alpha=120, blur=6)
    b.soft(150 + 58, 158 + dy, 13, 8, pal.blush, alpha=120, blur=6)


# ---------------------------------------------------------------------------
# A. 团子鱼 — front-facing dumpling with fins
# ---------------------------------------------------------------------------
def mochi_fish(b: Box, mood: str, phase: float, pal: Palette):
    bob = math.sin(phase * math.tau) * 3
    body = pal.body

    # body
    b.ellipse(150, 158 + bob, 92, 92, fill=body)
    b.soft(150, 220 + bob, 66, 26, darken(body, 0.35), alpha=70, blur=9)
    b.soft(150, 216 + bob, 50, 21, pal.belly, alpha=115, blur=9)
    b.soft(118, 108 + bob, 40, 24, (255, 255, 255), alpha=26, blur=10)

    face_front(b, pal, mood, dy=bob)

    # spout drifting up from the left of the head
    for i in range(3):
        p = (phase + i * 0.33) % 1.0
        rad = b.s(7.5 - 4.5 * p)
        if rad > 0:
            b.card.circle(b.x(104 + 10 * math.sin(p * 6.28 + i)), b.y(52 - 30 * p + bob), rad,
                          fill=mix((9, 11, 22), lighten(body, 0.4), 1 - p))


# ---------------------------------------------------------------------------
# B. 河豚 — front-facing ball with soft spikes and dot eyes
# ---------------------------------------------------------------------------
def puffer(b: Box, mood: str, phase: float, pal: Palette):
    bob = math.sin(phase * math.tau) * 4
    cx, cy = 150, 164 + bob

    for i in range(16):
        a = i / 16 * math.tau + 0.18
        r0, r1 = 84, 101
        b.poly([
            (cx + r0 * math.cos(a - 0.13), cy + r0 * math.sin(a - 0.13)),
            (cx + r1 * math.cos(a), cy + r1 * math.sin(a)),
            (cx + r0 * math.cos(a + 0.13), cy + r0 * math.sin(a + 0.13)),
        ], fill=pal.fin)

    b.ellipse(cx, cy, 88, 86, fill=pal.body)
    b.soft(cx, cy + 44, 60, 26, pal.belly, alpha=235, blur=9)
    b.soft(cx - 30, cy - 40, 34, 20, (255, 255, 255), alpha=40, blur=9)

    if mood == "happy":
        eye_happy(b, 118, 146 + bob, 15, pal)
        eye_happy(b, 182, 146 + bob, 15, pal)
        mouth_open(b, 150, 180 + bob, 10, 8, pal)
    elif mood == "sad":
        eye_sad(b, 118, 146 + bob, 15, pal)
        eye_sad(b, 182, 146 + bob, 15, pal)
        mouth_frown(b, 150, 184 + bob, 10, pal)
        b.ellipse(178, 162 + bob, 3, 4.6, fill=(150, 200, 255))
    else:
        for x in (118, 182):
            b.circle(x, 146 + bob, 9.5, fill=pal.eye)
            b.circle(x - 3, 143 + bob, 3, fill=(255, 255, 255))
        b.arc(150, 178 + bob, 8, 5.5, 20, 160, pal.mouth, 3)

    b.soft(150 - 64, 172 + bob, 12, 7, pal.blush, alpha=140, blur=6)
    b.soft(150 + 64, 172 + bob, 12, 7, pal.blush, alpha=140, blur=6)


# ---------------------------------------------------------------------------
# C. 侧身鲸 — heavy head at the right, tail at the left (DeepSeek silhouette)
# ---------------------------------------------------------------------------
def side_whale(b: Box, mood: str, phase: float, pal: Palette):
    bob = math.sin(phase * math.tau) * 3
    body, fin = pal.body, pal.fin

    # tail: two rounded fans hinged at the peduncle
    b.fan(78, 152 + bob, 62, 146, 200, fin, notch=0.28)
    b.fan(78, 160 + bob, 58, 205, 258, fin, notch=0.26)

    # body + head
    b.ellipse(144, 162 + bob, 98, 76, fill=body)
    b.ellipse(194, 140 + bob, 58, 54, fill=body)
    b.soft(150, 214 + bob, 62, 22, darken(body, 0.35), alpha=60, blur=9)
    b.soft(162, 202 + bob, 54, 22, pal.belly, alpha=170, blur=9)

    # top fin and side fin
    b.poly([(124, 106 + bob), (150, 112 + bob), (126, 122 + bob)], fill=fin)
    b.poly([(118, 206 + bob), (140, 226 + bob), (114, 228 + bob)], fill=fin)

    eye_x, eye_y = 198, 132 + bob
    if mood == "happy":
        eye_happy(b, eye_x, eye_y, 17, pal)
        mouth_open(b, 182, 164 + bob, 11, 8, pal)
    elif mood == "sad":
        eye_sad(b, eye_x, eye_y, 17, pal)
        mouth_frown(b, 182, 168 + bob, 11, pal)
        b.ellipse(212, 152 + bob, 3, 4.6, fill=(150, 200, 255))
    else:
        eye_round(b, eye_x, eye_y, 18, pal)
        b.arc(182, 166 + bob, 11, 7, 20, 160, pal.mouth, 3)

    b.soft(216, 154 + bob, 13, 8, pal.blush, alpha=130, blur=6)

    for i in range(2):
        p = (phase + i * 0.45) % 1.0
        rad = b.s(8 - 5 * p)
        if rad > 0:
            b.card.circle(b.x(196 + 10 * math.sin(p * 6.28)), b.y(84 - 34 * p + bob), rad,
                          fill=mix((9, 11, 22), lighten(body, 0.35), 1 - p))


# ---------------------------------------------------------------------------
# D. 胖锦鲤 — warm side-view koi with a flowing tail
# ---------------------------------------------------------------------------
def koi(b: Box, mood: str, phase: float, pal: Palette):
    bob = math.sin(phase * math.tau) * 4
    sway = math.sin(phase * math.tau) * 7

    b.fan(86, 146 + bob, 78, 140 + sway, 198, pal.fin, notch=0.30)
    b.fan(86, 164 + bob, 74, 208, 262 - sway, pal.fin, notch=0.28)

    b.ellipse(162, 166 + bob, 88, 70, fill=pal.body)
    b.soft(150, 210 + bob, 54, 20, darken(pal.body, 0.3), alpha=55, blur=8)
    b.soft(172, 198 + bob, 48, 20, pal.belly, alpha=170, blur=8)
    b.poly([(150, 104 + bob), (178, 120 + bob), (144, 128 + bob)], fill=pal.fin)
    b.poly([(128, 212 + bob), (150, 232 + bob), (124, 234 + bob)], fill=pal.fin)

    # scales / spots
    b.soft(136, 146 + bob, 20, 13, (255, 236, 216), alpha=160, blur=5)
    b.soft(172, 128 + bob, 14, 9, (255, 236, 216), alpha=140, blur=5)

    eye_x, eye_y = 200, 146 + bob
    if mood == "happy":
        eye_happy(b, eye_x, eye_y, 16, pal)
        mouth_open(b, 186, 174 + bob, 10, 8, pal)
    elif mood == "sad":
        eye_sad(b, eye_x, eye_y, 16, pal)
        mouth_frown(b, 186, 178 + bob, 10, pal)
        b.ellipse(214, 164 + bob, 3, 4.6, fill=(150, 200, 255))
    else:
        eye_round(b, eye_x, eye_y, 17, pal)
        b.arc(184, 170 + bob, 10, 7, 20, 160, pal.mouth, 3)

    b.soft(218, 166 + bob, 12, 7, pal.blush, alpha=110, blur=6)


# ---------------------------------------------------------------------------
# E. 贴纸团子 — the round fish in sticker style: white border, ink outline
# ---------------------------------------------------------------------------
def sticker_mochi(b: Box, mood: str, phase: float, pal: Palette):
    bob = math.sin(phase * math.tau) * 3
    ink = darken(pal.body, 0.74)
    body = pal.body

    # white sticker border, then ink line, then fill
    b.ellipse(150, 158 + bob, 104, 104, fill=(250, 251, 255))
    b.ellipse(150, 158 + bob, 96, 96, fill=ink)
    b.ellipse(150, 158 + bob, 90, 90, fill=body)
    b.soft(150, 214 + bob, 48, 20, lighten(pal.belly, 0.1), alpha=170, blur=8)

    if mood == "happy":
        b.arc(116, 140 + bob, 15, 13, 200, 340, ink, 6)
        b.arc(184, 140 + bob, 15, 13, 200, 340, ink, 6)
        b.ellipse(150, 178 + bob, 18, 14, fill=ink)
        b.soft(150, 186 + bob, 9, 5, (255, 150, 170), alpha=235, blur=3)
    elif mood == "sad":
        b.arc(116, 150 + bob, 15, 12, 20, 160, ink, 6)
        b.arc(184, 150 + bob, 15, 12, 20, 160, ink, 6)
        b.arc(150, 188 + bob, 14, 9, 200, 340, ink, 5)
    else:
        b.arc(116, 146 + bob, 14, 11, 200, 340, ink, 6)
        b.arc(184, 146 + bob, 14, 11, 200, 340, ink, 6)
        b.arc(150, 172 + bob, 16, 11, 20, 160, ink, 5)

    b.soft(92, 172 + bob, 12, 8, (255, 140, 165), alpha=190, blur=5)
    b.soft(208, 172 + bob, 12, 8, (255, 140, 165), alpha=190, blur=5)


DRAWERS = {
    "sticker": sticker_mochi,
    "mochi": mochi_fish,
    "puffer": puffer,
    "whale": side_whale,
    "koi": koi,
}


def render(card: Canvas, kind: str, cx: float, cy: float, size: float, mood: str, phase: float, pal: Palette):
    DRAWERS[kind](Box(card, cx, cy, size), mood, phase, pal)
