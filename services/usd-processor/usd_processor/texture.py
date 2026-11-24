"""Texture preparation for Image-to-AR (Phase 2 Milestone 8, ADR-025).

Turns an uploaded display image into the texture that BOTH the GLB and the USDZ embed, when the original cannot be
embedded as-is (ADR-009):

  * WebP (not core glTF, not allowed in USDZ)          -> PNG (alpha kept) or JPEG (opaque, lossy source)
  * JPEG with EXIF orientation != 1                     -> pixels rotated upright, orientation removed
  * longest edge above ``max_edge`` (viewer budget)     -> downscaled with Lanczos in PREMULTIPLIED alpha
  * an embedded ICC profile other than sRGB (Display P3, Adobe RGB, ...) -> converted to sRGB with LittleCMS
    (relative colorimetric + black point compensation); glTF/USDZ viewers assume sRGB and ignore profiles (ADR-039)

Rules: anything with transparency is written as PNG (lossless). Opaque images from a lossy source (JPEG, lossy
WebP) are written as JPEG quality 92 with 4:4:4 chroma; other opaque images as PNG. Metadata is not copied. The
caller decides whether preparation is needed; images that need none keep their original bytes (ADR-009).
Output is deterministic for the same input and Pillow version.
"""

from __future__ import annotations

import io
from dataclasses import asdict, dataclass, field

from PIL import Image, ImageCms, ImageOps

TEXTURE_CONVERTER_VERSION = "texture@0.2.0"
MAX_PIXELS = 8192 * 8192  # same bomb limit as the upload checks
MAX_EDGE = 8192
JPEG_QUALITY = 92

# Pillow refuses (DecompressionBombError) anything above twice this; we refuse anything above it ourselves.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class TextureError(Exception):
    pass


@dataclass
class TextureResult:
    mime: str
    width: int
    height: int
    source_mime: str
    source_width: int
    source_height: int
    changes: list[str] = field(default_factory=list)  # "converted", "rotated", "resized", "color-converted"
    has_alpha: bool = False
    converter_version: str = TEXTURE_CONVERTER_VERSION

    def to_dict(self) -> dict:
        return asdict(self)


_FORMAT_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def _has_alpha(im: Image.Image) -> bool:
    if im.mode in ("RGBA", "LA", "PA", "RGBa", "La"):
        return True
    return "transparency" in im.info


_SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))


def _to_srgb(im: Image.Image) -> Image.Image | None:
    """The image converted to sRGB when it carries a non-sRGB ICC profile; None when nothing needs to change."""
    icc = im.info.get("icc_profile")
    if not icc:
        return None
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
    except (ImageCms.PyCMSError, OSError):
        return None  # unreadable profile: viewers ignore it too, so keep the pixels as they are
    if src.profile.xcolor_space.strip() == "RGB" and "srgb" in (ImageCms.getProfileDescription(src) or "").lower():
        return None
    alpha = None
    if im.mode in ("LA", "La", "PA", "RGBA", "RGBa") or "transparency" in im.info:
        rgba = im.convert("LA" if im.mode in ("LA", "La") else "RGBA")
        alpha = rgba.getchannel("A")
        base = rgba.convert("L" if rgba.mode == "LA" else "RGB")
    else:
        base = im if im.mode in ("L", "RGB", "CMYK") else im.convert("RGB")
    try:
        out = ImageCms.profileToProfile(
            base,
            src,
            _SRGB,
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            outputMode="RGB",
            flags=ImageCms.Flags.BLACKPOINTCOMPENSATION,
        )
    except ImageCms.PyCMSError:
        return None  # profile does not match the pixel format: keep the pixels as they are
    if alpha is not None:
        out.putalpha(alpha)
    return out


def needs_color_conversion(data: bytes) -> bool:
    im = Image.open(io.BytesIO(data))
    return _to_srgb(im) is not None if im.info.get("icc_profile") else False


def prepare_texture(data: bytes, max_edge: int) -> tuple[bytes, TextureResult]:
    if not 64 <= max_edge <= MAX_EDGE:
        raise TextureError(f"max_edge must be between 64 and {MAX_EDGE}")
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
        if fmt not in _FORMAT_MIME:
            raise TextureError("unsupported image type (PNG, JPEG or WebP only)")
        if getattr(im, "n_frames", 1) > 1:
            raise TextureError("animated images are not supported")
        sw, sh = im.size
        if sw * sh > MAX_PIXELS or sw > MAX_EDGE or sh > MAX_EDGE:
            raise TextureError(f"image {sw}x{sh} exceeds limits")
        im.load()
    except Image.DecompressionBombError:
        raise TextureError("image exceeds limits") from None
    except TextureError:
        raise
    except Exception as e:  # noqa: BLE001 - any decoder failure is a bad input
        raise TextureError(f"the image could not be decoded ({type(e).__name__})") from None

    src_mime = _FORMAT_MIME[fmt]
    lossy = fmt == "JPEG" or (fmt == "WEBP" and not im.info.get("lossless", False))
    changes: list[str] = []
    if fmt == "WEBP":
        changes.append("converted")

    orientation = im.getexif().get(0x0112, 1) if fmt in ("JPEG", "WEBP") else 1
    if orientation not in (1, None):
        im = ImageOps.exif_transpose(im)
        changes.append("rotated")

    srgb = _to_srgb(im)
    if srgb is not None:
        im = srgb
        changes.append("color-converted")

    alpha = _has_alpha(im)
    im = im.convert("RGBA" if alpha else "RGB")
    if alpha and im.getextrema()[3][0] == 255:
        # An alpha channel that is fully opaque everywhere carries no transparency.
        alpha = False
        im = im.convert("RGB")

    w, h = im.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        if alpha:
            # Premultiply before filtering so transparent pixels' (often black) colour never bleeds into edges. Pillow
            # already premultiplies RGBA internally when resizing (checked 2026-11-22: a straight resize also passes the
            # fringe test); the explicit RGBa step keeps this correct even if that internal behaviour changes.
            im = im.convert("RGBa").resize((nw, nh), Image.Resampling.LANCZOS).convert("RGBA")
        else:
            im = im.resize((nw, nh), Image.Resampling.LANCZOS)
        changes.append("resized")

    # Untagged output = sRGB for every viewer. LittleCMS attaches a fresh sRGB profile (with today's date) to converted
    # images, and re-encoded sources may carry theirs: neither is written, which also keeps the output deterministic.
    im.info.pop("icc_profile", None)
    out = io.BytesIO()
    if not alpha and lossy:
        im.save(out, format="JPEG", quality=JPEG_QUALITY, subsampling=0, optimize=False, progressive=False)
        mime = "image/jpeg"
    else:
        im.save(out, format="PNG", compress_level=6)
        mime = "image/png"
    if mime != src_mime and "converted" not in changes:
        changes.append("converted")
    return out.getvalue(), TextureResult(
        mime=mime,
        width=im.size[0],
        height=im.size[1],
        source_mime=src_mime,
        source_width=sw,
        source_height=sh,
        changes=changes,
        has_alpha=alpha,
    )
