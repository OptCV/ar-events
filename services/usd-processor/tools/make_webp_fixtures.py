"""Generate the WebP fixtures (ADR-025) and the Phase 2 device-test inputs in tests/fixtures/normalize/. Run: node --experimental-strip-types scripts/usd.ts fixtures-webp

Sources are the committed PNG/JPEG fixtures, so the WebP files are reproducible with the pinned Pillow/libwebp.
"""

import hashlib
import sys
from pathlib import Path

from PIL import Image

SRC = Path("/fixtures/images")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/out")
OUT.mkdir(parents=True, exist_ok=True)


def save(name: str, im: Image.Image, **kw) -> None:
    im.save(OUT / name, format="WEBP", **kw)


# Lossless WebP with transparency (binary alpha + transparent border): must convert to PNG pixel-exactly.
save("logo_alpha_lossless.webp", Image.open(SRC / "logo_transparent_border.png").convert("RGBA"), lossless=True, exact=True)
# Antialiased alpha (soft edges): lossless keeps fractional alpha → BLEND.
save("disc_soft_alpha.webp", Image.open(SRC / "aa_disc_dark_fringe.png").convert("RGBA"), lossless=True, exact=True)
# Opaque lossy WebP (a photo): must become JPEG.
save("photo_lossy.webp", Image.open(SRC / "opaque_photo.jpg").convert("RGB"), quality=80, method=4)
# Animated WebP: refused at upload.
frames = [Image.new("RGB", (64, 64), c) for c in [(255, 0, 0), (0, 0, 255)]]
frames[0].save(OUT / "animated.webp", format="WEBP", save_all=True, append_images=frames[1:], duration=200, loop=0)

# Device-test inputs for the Phase 2 checklist (made here for the same reproducibility):
# orientation_probe stored sideways with EXIF orientation 6 -> the product must show it upright (red corner top-left).
exif = Image.Exif()
exif[0x0112] = 6
Image.open(SRC / "orientation_probe.png").convert("RGB").transpose(Image.Transpose.ROTATE_90).save(
    OUT / "orientation_probe_exif6.jpg", format="JPEG", quality=92, subsampling=0, exif=exif.tobytes())
# 4096 x 4096 ring (nearest-neighbour x8 of ring_inner_hole) -> scaled to the 2048 px budget; the hole must stay clear.
ring = Image.open(SRC / "ring_inner_hole.png").convert("RGBA")
ring.resize((ring.width * 8, ring.height * 8), Image.Resampling.NEAREST).save(OUT / "ring_4096.png", format="PNG", optimize=True)

FIXTURES = ("*.webp", "*.jpg", "*.png")
with open(OUT / "SHA256SUMS", "w") as f:
    for p in sorted(q for g in FIXTURES for q in OUT.glob(g)):
        f.write(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n")
print("\n".join(sorted(p.name for g in FIXTURES for p in OUT.glob(g))))
