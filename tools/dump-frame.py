#!/usr/bin/env python3
"""Reconstruct a frame dumped by the firmware's `d` serial command.

  stty -f /dev/cu.usbmodem101 921600 raw -echo
  (cat /dev/cu.usbmodem101 > /tmp/dump.txt &) ; printf 'd' > /dev/cu.usbmodem101
  python3 tools/dump-frame.py /tmp/dump.txt out.png
"""

import sys

from PIL import Image


def main(argv: list[str]) -> int:
    source, target = (argv[1] if len(argv) > 1 else "/tmp/dump.txt", argv[2] if len(argv) > 2 else "frame.png")
    lines = open(source, encoding="utf-8", errors="ignore").read().replace("\r", "").split("\n")
    start = next(i for i, line in enumerate(lines) if line.startswith("DUMP"))
    width, height = map(int, lines[start].split()[1:3])
    rows = [line for line in lines[start + 1 :] if line and line != "END"][:height]
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y, row in enumerate(rows):
        for x in range(min(width, len(row) // 4)):
            raw = int(row[x * 4 : x * 4 + 4], 16)
            raw = ((raw >> 8) | ((raw & 0xFF) << 8)) & 0xFFFF  # the canvas holds panel order
            r, g, b = (raw >> 11) & 0x1F, (raw >> 5) & 0x3F, raw & 0x1F
            pixels[x, y] = (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)
    image.save(target)
    print(f"wrote {target} ({width}x{height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
