#!/usr/bin/env python3
"""Tests for the asset generators: sprite packing, font coverage, sound headers.

Run with:  python3 -m unittest discover -s tools -p 'test_assets.py'
"""
from __future__ import annotations

import importlib.util
import pathlib
import struct
import sys
import unittest

from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sprites = load("build_sprites")
font = load("genfont")
sounds = load("gensounds")


def disc(size: int, centre: tuple[int, int], radius: int, colour=(200, 40, 40, 255)) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse(
        [centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius], fill=colour
    )
    return img


class SpriteTests(unittest.TestCase):
    def test_frames_share_one_crop_box(self):
        """Registration matters: per-frame cropping made the character twitch."""
        a = disc(400, (200, 200), 80)
        b = disc(400, (200, 200), 60)
        fitted = sprites.fit_common([a, b])
        self.assertEqual(fitted[0].size, fitted[1].size)
        # both circles stay centred on the same pixel
        for frame in fitted:
            bbox = frame.getchannel("A").getbbox()
            self.assertAlmostEqual((bbox[0] + bbox[2]) / 2, sprites.SIZE / 2, delta=2)

    def test_quantize_keeps_index_zero_transparent(self):
        img = sprites.fit_common([disc(400, (200, 200), 80)])[0]
        indexed, colours = sprites.quantize(img)
        self.assertEqual(len(colours), sprites.COLORS)
        alpha = img.getchannel("A")
        data = indexed.tobytes()
        for i, value in enumerate(data[:5000]):
            if alpha.tobytes()[i] < 128:
                self.assertEqual(value, 0, "transparent pixels must be index 0")
        self.assertTrue(any(value > 0 for value in data))

    def test_pack_is_one_byte_per_pixel(self):
        img = sprites.fit_common([disc(400, (200, 200), 80)])[0]
        indexed, _ = sprites.quantize(img)
        packed = sprites.pack(indexed)
        self.assertEqual(len(packed), sprites.SIZE * sprites.SIZE)
        rebuilt = Image.frombytes("P", indexed.size, packed)
        self.assertEqual(rebuilt.tobytes(), indexed.tobytes())

    def test_palette_is_rgb565_safe(self):
        img = sprites.fit_common([disc(400, (200, 200), 80)])[0]
        _, colours = sprites.quantize(img)
        for colour in colours:
            value = sprites.rgb565(colour)
            self.assertGreaterEqual(value, 0)
            self.assertLessEqual(value, 0xFFFF)


class FontTests(unittest.TestCase):
    def test_gb2312_level_one_coverage(self):
        chars = font.gb2312_chars()
        self.assertEqual(len(chars), 3755)
        self.assertEqual(len(set(chars)), 3755)
        for char in "需要确认同意拒绝发送清空录音":
            self.assertIn(char, chars)

    def test_glyph_is_196_bytes(self):
        self.assertEqual(font.GLYPH_BYTES, 196)
        self.assertEqual(font.BYTES_PER_ROW, 7)

    def test_pack_shape(self):
        image = Image.new("L", (font.CELL_W, font.CELL_H), 0)
        ImageDraw.Draw(image).rectangle([0, 0, 27, 27], fill=255)
        packed = font.pack(image)
        self.assertEqual(len(packed), font.GLYPH_BYTES)
        # solid white = 2-bit level 3 everywhere
        self.assertEqual(packed[0], 0xFF)


class SoundTests(unittest.TestCase):
    def test_wav_headers(self):
        data = sounds.build()
        self.assertEqual(set(data), {"ALERT", "ALLOW", "DENY"})
        for name, wav in data.items():
            self.assertEqual(wav[:4], b"RIFF", name)
            self.assertEqual(wav[8:12], b"WAVE", name)
            channels, rate = struct.unpack("<HI", wav[22:28])
            bits = struct.unpack("<H", wav[34:36])[0]
            self.assertEqual((channels, rate, bits), (1, 44100, 16), name)
            self.assertGreater(len(wav), 44)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class WireContractTests(unittest.TestCase):
    """The firmware, the host and the protocol document must agree on names."""

    @classmethod
    def setUpClass(cls):
        cls.root = HERE.parent
        cls.protocol = (cls.root / "docs" / "protocol.md").read_text(encoding="utf-8")
        cls.link = (cls.root / "firmware" / "stopwatch" / "src" / "link.cpp").read_text(encoding="utf-8")
        cls.voice = (cls.root / "packages" / "stopwatch-bridge" / "src" / "voice.js").read_text(encoding="utf-8")
        cls.bridge = (cls.root / "packages" / "stopwatch-bridge" / "src" / "bridge.js").read_text(encoding="utf-8")
        cls.queue = (cls.root / "packages" / "stopwatch-bridge" / "src" / "queue.js").read_text(encoding="utf-8")

    def documented(self) -> set[str]:
        import re

        return set(re.findall(r'"t"\s*:\s*"([a-z_]+)"', self.protocol))

    def firmware_sends(self) -> set[str]:
        import re

        names = set(re.findall(r'doc\["t"\]\s*=\s*"([a-z_]+)"', self.link))
        names |= set(re.findall(r'\\"t\\":\\"([a-z_]+)\\"', self.link))
        return names

    def firmware_handles(self) -> set[str]:
        import re

        return set(re.findall(r'strcmp\(type,\s*"([a-z_]+)"\)', self.link))

    def test_every_firmware_message_is_documented(self):
        missing = self.firmware_sends() - self.documented()
        self.assertEqual(missing, set(), f"firmware sends undocumented types: {missing}")

    def test_every_firmware_handler_is_documented(self):
        missing = self.firmware_handles() - self.documented()
        self.assertEqual(missing, set(), f"firmware handles undocumented types: {missing}")

    def test_voice_messages_are_handled_by_the_host(self):
        import re

        handled = set(re.findall(r"case '([a-z_]+)':", self.voice))
        documented_voice = {name for name in self.documented() if name.startswith("voice_")}
        sent_by_device = {"voice_start", "voice_chunk", "voice_end", "voice_send", "voice_clear"}
        self.assertEqual(sent_by_device - handled, set(), "host does not handle a device voice message")

    def test_permission_messages_are_handled_by_the_host(self):
        self.assertIn("'prompt'", self.queue)
        self.assertIn("'close'", self.queue)
        self.assertIn("'decision'", self.bridge)


class LayoutContractTests(unittest.TestCase):
    """Host wrapping and firmware drawing must use the same pixel budget."""

    def test_prompt_width_matches(self):
        import re

        root = HERE.parent
        config = (root / "packages" / "stopwatch-bridge" / "src" / "config.js").read_text(encoding="utf-8")
        ui = (root / "firmware" / "stopwatch" / "src" / "ui.cpp").read_text(encoding="utf-8")
        host_default = int(re.search(r"maxWidthPx:\s*(\d+)", config).group(1))
        firmware_width = int(re.search(r"text::wrap\(transcript_,\s*(\d+)", ui).group(1))
        self.assertEqual(host_default, firmware_width, "host wrap width and firmware wrap width drifted")

    def test_line_height_matches_font(self):
        import re

        text_header = (HERE.parent / "firmware" / "stopwatch" / "src" / "text.h").read_text(encoding="utf-8")
        self.assertIn("kLineHeight = 34", text_header)
        self.assertIn("kWide = 28", text_header)
        self.assertIn("kAscii = 18", text_header)
