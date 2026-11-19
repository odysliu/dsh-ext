"""Small supersampled vector-ish canvas for character design.

Everything is drawn in device units (466 wide) at SS× resolution and
downsampled with LANCZOS, so edges stay smooth and the result looks like the
sprite atlas the firmware will blit.
"""
from __future__ import annotations

import math
from PIL import Image, ImageDraw, ImageFilter

SS = 4
BG = (9, 11, 22)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(a, b, t))) for a, b in zip(c1, c2))


def lighten(c, t):
    return mix(c, (255, 255, 255), t)


def darken(c, t):
    return mix(c, (0, 0, 0), t)


class Canvas:
    def __init__(self, width=466, height=466, bg=BG):
        self.w, self.h = width, height
        self.img = Image.new("RGBA", (width * SS, height * SS), bg + (255,))
        self.d = ImageDraw.Draw(self.img)

    # -- primitives -------------------------------------------------------
    def ellipse(self, cx, cy, rx, ry, fill=None, outline=None, width=0):
        box = [self._s(cx - rx), self._s(cy - ry), self._s(cx + rx), self._s(cy + ry)]
        self.d.ellipse(box, fill=fill, outline=outline, width=max(1, int(width * SS)))

    def circle(self, cx, cy, r, fill=None, outline=None, width=0):
        self.ellipse(cx, cy, r, r, fill, outline, width)

    def rect(self, x0, y0, x1, y1, fill=None, radius=0):
        self.d.rounded_rectangle(
            [self._s(x0), self._s(y0), self._s(x1), self._s(y1)],
            radius=self._s(radius),
            fill=fill,
        )

    def poly(self, points, fill=None, outline=None, width=0):
        pts = [(self._s(x), self._s(y)) for x, y in points]
        self.d.polygon(pts, fill=fill, outline=outline, width=max(1, int(width * SS)))

    def line(self, points, fill, width=2):
        pts = [(self._s(x), self._s(y)) for x, y in points]
        self.d.line(pts, fill=fill, width=max(1, int(width * SS)), joint="curve")

    def arc(self, cx, cy, rx, ry, start, end, fill, width=3):
        box = [self._s(cx - rx), self._s(cy - ry), self._s(cx + rx), self._s(cy + ry)]
        self.d.arc(box, start, end, fill=fill, width=max(1, int(width * SS)))

    # -- helpers ----------------------------------------------------------
    def _s(self, v):
        return v * SS

    def rounded_blob(self, points, radius, fill, outline=None, width=0):
        """Polygon with rounded corners: hull + a circle at every vertex."""
        self.poly(points, fill=fill, outline=None)
        for x, y in points:
            self.circle(x, y, radius, fill=fill)
        if outline is not None:
            self._outline_round(points, radius, outline, width)

    def _outline_round(self, points, radius, color, width):
        for i in range(len(points)):
            x0, y0 = points[i]
            x1, y1 = points[(i + 1) % len(points)]
            self.line([(x0, y0), (x1, y1)], color, width)
        for x, y in points:
            self.circle(x, y, radius + width / 2, outline=color, width=width)

    def rotated_ellipse(self, cx, cy, rx, ry, angle, fill, alpha=255):
        """Ellipse rotated about its centre — fins and tails read as real shapes."""
        w, h = int((2 * rx + 2) * SS), int((2 * ry + 2) * SS)
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse([0, 0, w - 1, h - 1], fill=fill + (alpha,))
        layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
        px = int(self._s(cx) - layer.width / 2)
        py = int(self._s(cy) - layer.height / 2)
        self.img.alpha_composite(layer, (px, py))
        self.d = ImageDraw.Draw(self.img)

    def soft_ellipse(self, cx, cy, rx, ry, color, alpha=120, blur=10):
        """Feathered patch (belly, blush) composited over the canvas."""
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.ellipse(
            [self._s(cx - rx), self._s(cy - ry), self._s(cx + rx), self._s(cy + ry)],
            fill=color + (alpha,),
        )
        layer = layer.filter(ImageFilter.GaussianBlur(self._s(blur) / SS * 1))
        self.img = Image.alpha_composite(self.img, layer)
        self.d = ImageDraw.Draw(self.img)

    def vertical_gradient(self, mask_fn, top, bottom, alpha=255):
        grad = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(grad)
        for y in range(0, self.h * SS, 4):
            t = y / (self.h * SS)
            gd.rectangle([0, y, self.w * SS, y + 4], fill=mix(top, bottom, t) + (alpha,))
        mask = Image.new("L", self.img.size, 0)
        md = ImageDraw.Draw(mask)
        mask_fn(md)
        self.img = Image.composite(Image.alpha_composite(self.img, grad), self.img, mask)
        self.img = Image.alpha_composite(self.img, Image.new("RGBA", self.img.size, (0, 0, 0, 0)))
        self.d = ImageDraw.Draw(self.img)

    def save(self, path):
        self.img.resize((self.w, self.h), Image.LANCZOS).convert("RGB").save(path)


def eyes_round(c, x, y, r, color=(20, 28, 60), white=(255, 255, 255), look=0.0, big=True):
    c.circle(x, y, r, fill=white)
    iris = r * (0.68 if big else 0.55)
    c.circle(x + look, y + r * 0.08, iris, fill=color)
    c.circle(x + look - iris * 0.35, y - iris * 0.35, max(2, iris * 0.32), fill=(255, 255, 255))
    c.circle(x + look + iris * 0.38, y + iris * 0.42, max(1.5, iris * 0.16), fill=(210, 220, 255))


def eyes_happy(c, x, y, r, color, width=4):
    c.arc(x, y + r * 0.2, r * 0.95, r * 0.85, 200, 340, fill=color, width=width)


def eyes_sad(c, x, y, r, color, width=3.5):
    c.line([(x - r * 0.8, y - r * 0.5), (x + r * 0.55, y + r * 0.45)], color, width)
    c.line([(x - r * 0.55, y + r * 0.45), (x + r * 0.8, y - r * 0.5)], color, width)


def eyes_dot(c, x, y, r, color=(24, 30, 56)):
    c.circle(x, y, r, fill=color)
    c.circle(x - r * 0.3, y - r * 0.3, r * 0.25, fill=(255, 255, 255))


def smile(c, x, y, w, color, depth=0.55, width=3.5):
    c.arc(x, y, w, w * depth, 20, 160, fill=color, width=width)


def blush(c, x, y, rx, ry, color=(255, 140, 165), alpha=110):
    c.soft_ellipse(x, y, rx, ry, color, alpha=alpha, blur=7)
