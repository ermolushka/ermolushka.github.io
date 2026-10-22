#!/usr/bin/env python3
"""Generate light-theme copies of the post banner SVGs.

Reads public/art/*.svg (drawn for a dark page) and writes public/art/light/*.svg:
dark panels become pale, neon strokes and text are darkened, and dim opacities
are lifted so every stage of the animation stays readable on a light page.
Re-run after editing or adding a banner:  python3 scripts/make-light-art.py
"""
import colorsys
import re
from pathlib import Path

ART = Path(__file__).resolve().parent.parent / "public" / "art"
OUT = ART / "light"
OUT.mkdir(exist_ok=True)


def lighten_hex(match):
    raw = match.group(1)
    if len(raw) == 3:
        raw = "".join(c * 2 for c in raw)
    r, g, b = (int(raw[i : i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l > 0.9 and s < 0.3:  # near white (text on filled shapes) -> near black
        l, s = 0.12, s
    elif l < 0.22:  # dark panel / background -> pale
        l, s = min(0.97, 0.9 + (0.22 - l) * 0.3), s * 0.5
    else:  # neon stroke / text -> darker, same hue
        l, s = 0.14 + (l - 0.22) * 0.3, min(1.0, s * 1.1)
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def lift(v):
    # leave near-invisible grids/glows alone, lift the dim-but-meant-to-be-read range
    return v if v < 0.15 or v >= 0.7 else 0.62 + v * 0.2


def lift_attr(m):
    return f'{m.group(1)}="{lift(float(m.group(2))):.2f}"'


def lift_css(m):
    return f"opacity:{lift(float(m.group(1))):.2f}"


for src in sorted(ART.glob("*.svg")):
    s = src.read_text()
    s = re.sub(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", lighten_hex, s)
    s = re.sub(r"(?<![\w-])((?:stroke-|fill-)?opacity)=\"(\.?\d*\.?\d+)\"", lift_attr, s)
    s = re.sub(r"(?<![\w-])opacity:\s*(\.?\d*\.?\d+)", lift_css, s)
    (OUT / src.name).write_text(s)
    print("wrote", OUT.relative_to(ART.parent.parent), src.name)
