"""Generate the WebP fixtures in tests/fixtures/normalize/ (ADR-025). Run: node --experimental-strip-types scripts/usd.ts fixtures-webp

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

with open(OUT / "SHA256SUMS", "w") as f:
    for p in sorted(OUT.glob("*.webp")):
        f.write(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n")
print("\n".join(sorted(p.name for p in OUT.glob("*.webp"))))
