"""Built-in content geometry and text rasterisation (Phase 5 M14, ADR-029/032).

Canonical geometry (packages/schema/src/content.ts): centred on the node origin, in the XY plane facing +Z, meters.
The geometry and the text/panel layout mirror the editor (apps/web/src/editor/builtins.ts) so the editor preview, the
GLB and the USDZ agree. Text uses the bundled DejaVu Sans (fonts/, same files as the editor), so output is identical on
every run (no system fonts).
"""

from __future__ import annotations

import io
import math
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = Path(__file__).resolve().parents[2] / "fonts"
FONT_REGULAR = FONT_DIR / "DejaVuSans.ttf"
FONT_BOLD = FONT_DIR / "DejaVuSans-Bold.ttf"
PANEL_WIDTH_METERS = 0.3
MAX_CANVAS = 4096


@dataclass
class Geometry:
    positions: list[float]
    normals: list[float]
    uvs: list[float]
    indices: list[int]


def box() -> Geometry:
    """1 m cube, 24 vertices (flat normals), 12 triangles."""
    faces = [  # normal, u axis, v axis
        ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    ]
    g = Geometry([], [], [], [])
    for n, u, v in faces:
        base = len(g.positions) // 3
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            g.positions += [0.5 * (n[i] + su * u[i] + sv * v[i]) for i in range(3)]
            g.normals += list(map(float, n))
            g.uvs += [(su + 1) / 2, 1 - (sv + 1) / 2]
        g.indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return g


def sphere(w: int = 48, h: int = 24) -> Geometry:
    """Diameter 1 m; the same tessellation as three.js SphereGeometry(0.5, 48, 24) used by the editor."""
    g = Geometry([], [], [], [])
    grid = []
    for iy in range(h + 1):
        v = iy / h
        row = []
        for ix in range(w + 1):
            u = ix / w
            x = -0.5 * math.cos(u * 2 * math.pi) * math.sin(v * math.pi)
            y = 0.5 * math.cos(v * math.pi)
            z = 0.5 * math.sin(u * 2 * math.pi) * math.sin(v * math.pi)
            g.positions += [x, y, z]
            ln = math.sqrt(x * x + y * y + z * z) or 1
            g.normals += [x / ln, y / ln, z / ln]
            g.uvs += [u, v]
            row.append(len(g.positions) // 3 - 1)
        grid.append(row)
    for iy in range(h):
        for ix in range(w):
            a, b, c, d = grid[iy][ix + 1], grid[iy][ix], grid[iy + 1][ix], grid[iy + 1][ix + 1]
            if iy != 0:
                g.indices += [a, b, d]
            if iy != h - 1:
                g.indices += [b, c, d]
    return g


def cylinder(segments: int = 48) -> Geometry:
    """Diameter 1 m, height 1 m along +Y, with caps (three.js CylinderGeometry(0.5, 0.5, 1, 48))."""
    g = Geometry([], [], [], [])
    ring = []
    for y, v in ((0.5, 0.0), (-0.5, 1.0)):
        row = []
        for i in range(segments + 1):
            t = i / segments * 2 * math.pi
            s, c = math.sin(t), math.cos(t)
            g.positions += [0.5 * s, y, 0.5 * c]
            g.normals += [s, 0.0, c]
            g.uvs += [i / segments, v]
            row.append(len(g.positions) // 3 - 1)
        ring.append(row)
    for i in range(segments):
        a, b, c, d = ring[0][i], ring[1][i], ring[1][i + 1], ring[0][i + 1]
        g.indices += [a, b, d, b, c, d]
    for y, ny in ((0.5, 1.0), (-0.5, -1.0)):
        centre = len(g.positions) // 3
        g.positions += [0.0, y, 0.0]
        g.normals += [0.0, ny, 0.0]
        g.uvs += [0.5, 0.5]
        first = centre + 1
        for i in range(segments + 1):
            t = i / segments * 2 * math.pi
            g.positions += [0.5 * math.sin(t), y, 0.5 * math.cos(t)]
            g.normals += [0.0, ny, 0.0]
            g.uvs += [0.5 + 0.5 * math.sin(t), 0.5 + 0.5 * math.cos(t) * ny]
        for i in range(segments):
            if ny > 0:
                g.indices += [first + i, first + i + 1, centre]
            else:
                g.indices += [first + i + 1, first + i, centre]
    return g


def plane(width: float = 1.0, height: float = 1.0) -> Geometry:
    """A quad in XY facing +Z, centred; UV (0,0) at the top-left like glTF images."""
    w, h = width / 2, height / 2
    return Geometry(
        positions=[-w, h, 0, -w, -h, 0, w, -h, 0, w, h, 0],
        normals=[0, 0, 1] * 4,
        uvs=[0, 0, 0, 1, 1, 1, 1, 0],
        indices=[1, 2, 3, 1, 3, 0],
    )


SHAPES = {"box": box, "sphere": sphere, "cylinder": cylinder, "plane": plane}


def srgb_hex_to_linear(hex_color: str) -> list[float]:
    """#rrggbb (sRGB, as the editor shows it) → linear factors (glTF baseColorFactor, USD diffuseColor)."""

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return [round(lin(int(hex_color[i : i + 2], 16) / 255), 6) for i in (1, 3, 5)]


# ---------------------------------------------------------------- text and panels


def wrap_text(text: str, max_width: float, measure) -> list[str]:
    """Same greedy wrap as apps/web/src/editor/budgets.ts wrapText."""
    lines: list[str] = []
    for para in text.split("\n"):
        line = ""
        for word in re.split(r" +", para):  # same as JS para.split(/ +/)
            candidate = f"{line} {word}" if line else word
            if measure(candidate) <= max_width:
                line = candidate
                continue
            if line:
                lines.append(line)
            line = ""
            rest = word
            while measure(rest) > max_width and len(rest) > 1:
                cut = len(rest) - 1
                while cut > 1 and measure(rest[:cut]) > max_width:
                    cut -= 1
                lines.append(rest[:cut])
                rest = rest[cut:]
            line = rest
        lines.append(line)
    return lines


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)  # no metadata: identical bytes for identical input
    return buf.getvalue()


@dataclass
class Raster:
    png: bytes
    width_px: int
    height_px: int
    width_m: float
    height_m: float


def _rgba(hex_color: str) -> tuple[int, int, int, int]:
    return (int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16), 255)


def text_raster(text: str, color: str, line_m: float) -> Raster:
    """Lines centred, each `line_m` tall (font 128 px, line 160 px), like the editor."""
    lines = text.split("\n")
    font_px = 128
    font = ImageFont.truetype(str(FONT_BOLD), font_px)
    widest = max(1.0, *(font.getlength(line) for line in lines))
    line_px = round(font_px * 1.25)
    scale = min(1.0, (MAX_CANVAS - 32) / widest, MAX_CANVAS / (line_px * len(lines)))
    if scale < 1:
        font_px = max(8, math.floor(font_px * scale))
        font = ImageFont.truetype(str(FONT_BOLD), font_px)
        widest = max(1.0, *(font.getlength(line) for line in lines))
        line_px = round(font_px * 1.25)
    w = math.ceil(widest + font_px * 0.25)
    h = line_px * len(lines)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        d.text((w / 2, line_px * (i + 0.5)), line, font=font, fill=_rgba(color), anchor="mm")
    height_m = line_m * len(lines)
    return Raster(_png(img), w, h, height_m * w / h, height_m)


def panel_raster(title: str, body: str) -> Raster:
    """A white card 1024 px wide (PANEL_WIDTH_METERS), like the editor's panel."""
    W, pad, title_px, title_line, body_px, body_line = 1024, 56, 64, 80, 44, 62
    tfont = ImageFont.truetype(str(FONT_BOLD), title_px)
    bfont = ImageFont.truetype(str(FONT_REGULAR), body_px)
    tlines = wrap_text(title, W - pad * 2, tfont.getlength) if title.strip() else []
    blines = wrap_text(body, W - pad * 2, bfont.getlength) if body.strip() else []
    gap = 24 if tlines and blines else 0

    def height_for(b: int) -> int:
        return pad * 2 + len(tlines) * title_line + gap + b * body_line

    while blines and height_for(len(blines)) > MAX_CANVAS:
        blines = blines[:-2] + ["…"]
    H = max(pad * 2 + body_line, height_for(len(blines)))
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((3, 3, W - 4, H - 4), radius=40, fill=(255, 255, 255, 255), outline=(0xDC, 0xE2, 0xE8, 255), width=6)
    y = pad
    for line in tlines:
        d.text((pad, y + title_line / 2), line, font=tfont, fill=(0x17, 0x20, 0x2A, 255), anchor="lm")
        y += title_line
    y += gap
    for line in blines:
        d.text((pad, y + body_line / 2), line, font=bfont, fill=(0x3B, 0x46, 0x52, 255), anchor="lm")
        y += body_line
    return Raster(_png(img), W, H, PANEL_WIDTH_METERS, PANEL_WIDTH_METERS * H / W)
