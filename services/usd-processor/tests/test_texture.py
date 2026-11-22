"""Texture preparation (texture.py, ADR-025). Images are generated with Pillow inside the sandbox."""

from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image

from usd_processor.texture import MAX_PIXELS, TextureError, prepare_texture


def encode(im: Image.Image, fmt: str, **kw) -> bytes:
    b = io.BytesIO()
    im.save(b, format=fmt, **kw)
    return b.getvalue()


def disc(size: int, bg=(0, 0, 0, 0), fg=(255, 255, 255, 255)) -> Image.Image:
    """White opaque disc with an antialiased edge on fully transparent BLACK (the classic fringe trap)."""
    from PIL import ImageDraw

    big = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(big).ellipse((size * 0.5, size * 0.5, size * 3.5, size * 3.5), fill=255)
    alpha = big.resize((size, size), Image.Resampling.LANCZOS)
    # Straight alpha: colour is pure white wherever alpha > 0 and black where fully transparent.
    im = Image.new("RGB", (size, size), bg[:3])
    im.paste(fg[:3], (0, 0, size, size), alpha.point(lambda a: 255 if a > 0 else 0))
    im.putalpha(alpha)
    return im


def decode(data: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def test_webp_with_alpha_becomes_png_and_keeps_alpha():
    src = disc(300)
    data, r = prepare_texture(encode(src, "WEBP", lossless=True), 2048)
    assert r.mime == "image/png" and r.source_mime == "image/webp"
    assert r.changes == ["converted"] and r.has_alpha
    out = decode(data)
    assert out.format == "PNG" and out.mode == "RGBA" and out.size == (300, 300)
    # Lossless WebP -> PNG is pixel-exact.
    assert out.tobytes() == src.tobytes()


def test_opaque_lossy_webp_becomes_jpeg():
    src = Image.new("RGB", (400, 200), (30, 120, 200))
    data, r = prepare_texture(encode(src, "WEBP", quality=80), 2048)
    assert r.mime == "image/jpeg" and not r.has_alpha and r.changes == ["converted"]
    assert decode(data).size == (400, 200)


def test_exif_rotated_jpeg_is_turned_upright():
    src = Image.new("RGB", (600, 300), (200, 30, 30))
    src.paste((30, 200, 30), (0, 0, 100, 100))  # marker in the top-left corner of the stored pixels
    exif = Image.Exif()
    exif[0x0112] = 6  # stored rotated: display needs 90° clockwise
    data, r = prepare_texture(encode(src, "JPEG", quality=95, exif=exif.tobytes()), 2048)
    assert r.mime == "image/jpeg" and r.changes == ["rotated"]
    out = decode(data)
    assert out.size == (300, 600)  # width/height swapped
    assert 0x0112 not in out.getexif()  # orientation no longer needed
    # After a 90° clockwise turn the marker sits in the top-RIGHT corner.
    r_, g_, _ = out.getpixel((280, 20))
    assert g_ > 150 and r_ < 100


def test_large_png_is_downscaled_without_dark_fringe():
    src = disc(3000)  # 3000 px > 2048
    data, r = prepare_texture(encode(src, "PNG"), 2048)
    assert r.mime == "image/png" and r.changes == ["resized"] and (r.width, r.height) == (2048, 2048)
    assert (r.source_width, r.source_height) == (3000, 3000)
    out = decode(data).convert("RGBA")
    # Every partly transparent edge pixel must stay white: premultiplied filtering never pulls in the black of
    # fully transparent neighbours (straight-alpha filtering would darken them).
    darkest = 255
    for x, y in [(i, 1024) for i in range(2048)] + [(1024, i) for i in range(2048)]:
        rr, gg, bb, aa = out.getpixel((x, y))
        if 0 < aa < 255:
            darkest = min(darkest, rr, gg, bb)
    assert darkest >= 250, darkest


def test_large_opaque_jpeg_stays_jpeg_and_is_downscaled():
    src = Image.new("RGB", (4000, 1000), (90, 90, 90))
    data, r = prepare_texture(encode(src, "JPEG", quality=90), 2048)
    assert r.mime == "image/jpeg" and r.changes == ["resized"] and (r.width, r.height) == (2048, 512)


def test_fully_opaque_alpha_channel_is_dropped():
    src = Image.new("RGBA", (3000, 100), (10, 20, 30, 255))
    data, r = prepare_texture(encode(src, "PNG"), 2048)
    assert not r.has_alpha and r.mime == "image/png"  # PNG source stays PNG (lossless)
    assert decode(data).mode == "RGB"


def test_deterministic():
    src = encode(disc(2500), "WEBP", lossless=True)
    a, _ = prepare_texture(src, 2048)
    b, _ = prepare_texture(src, 2048)
    assert hashlib.sha256(a).digest() == hashlib.sha256(b).digest()


@pytest.mark.parametrize(
    "data,msg",
    [
        (b"<html>no</html>", "could not be decoded"),
        (encode(Image.new("RGB", (10, 10)), "GIF"), "unsupported image type"),
    ],
)
def test_refuses_bad_inputs(data, msg):
    with pytest.raises(TextureError, match=msg):
        prepare_texture(data, 2048)


def test_refuses_animated_webp():
    frames = [Image.new("RGB", (20, 20), c) for c in [(255, 0, 0), (0, 255, 0)]]
    b = io.BytesIO()
    frames[0].save(b, format="WEBP", save_all=True, append_images=frames[1:], duration=100)
    with pytest.raises(TextureError, match="animated"):
        prepare_texture(b.getvalue(), 2048)


def test_refuses_decompression_bombs_from_the_header():
    # A tiny PNG whose header claims more pixels than allowed.
    side = int(MAX_PIXELS**0.5) + 1
    im = Image.new("1", (side, side))
    with pytest.raises(TextureError, match="exceeds limits"):
        prepare_texture(encode(im, "PNG"), 2048)


def test_max_edge_bounds():
    with pytest.raises(TextureError, match="max_edge"):
        prepare_texture(encode(Image.new("RGB", (10, 10)), "PNG"), 10)
