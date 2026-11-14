"""Image to AR Object (flat) -> USDZ, with optional Quick Look anchoring.

Mirrors packages/image-to-ar (GLB) geometry exactly: same quad corners, pivot, orientation,
physical size rounding, and UVs (USD st = (u, 1 - v) of the glTF UV). See IMAGE_TO_AR.md.

Anchoring (Apple preliminary schemas, https://developer.apple.com/documentation/usd/preliminary-anchoringapi):
  image -> preliminary:anchoring:type = "image" + Preliminary_ReferenceImage (physicalWidth in CENTIMETERS)
  floor -> preliminary:anchoring:type = "plane", preliminary:planeAnchoring:alignment = "horizontal"
  wall  -> preliminary:anchoring:type = "plane", preliminary:planeAnchoring:alignment = "vertical"
Structural validity does NOT prove Quick Look detection or rendering; device tests are required.
"""

from __future__ import annotations

import hashlib
import shutil
import struct
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal, Optional

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils, Vt

from .validate import validate_usdz

CONVERTER_VERSION = "usd-image-plane@0.1.0"
AlphaMode = Literal["OPAQUE", "MASK", "BLEND"]
Anchor = Literal["none", "image", "floor", "wall"]
MAX_EDGE = 8192
TRACKING_WIDTH_RANGE_M = (0.03, 5.0)


class ConversionError(Exception):
    pass


@dataclass(frozen=True)
class ImageInfo:
    mime: str
    width: int
    height: int


def read_image_info(data: bytes) -> ImageInfo:
    """Header-only inspection by magic bytes (never trust extension or MIME)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        if data[12:16] != b"IHDR":
            raise ConversionError("PNG missing IHDR")
        w, h = struct.unpack(">II", data[16:24])
        info = ImageInfo("image/png", w, h)
    elif data[:2] == b"\xff\xd8":
        info = _jpeg_info(data)
    else:
        raise ConversionError("unsupported image signature (PNG/JPEG only)")
    if not (0 < info.width <= MAX_EDGE and 0 < info.height <= MAX_EDGE):
        raise ConversionError(f"image {info.width}x{info.height} exceeds limits")
    return info


def _jpeg_info(b: bytes) -> ImageInfo:
    o = 2
    while o + 9 < len(b):
        if b[o] != 0xFF:
            raise ConversionError("corrupt JPEG marker stream")
        m = b[o + 1]
        if m == 0xD8 or 0xD0 <= m <= 0xD7 or m == 0x01:
            o += 2
            continue
        seg_len = (b[o + 2] << 8) | b[o + 3]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h = (b[o + 5] << 8) | b[o + 6]
            w = (b[o + 7] << 8) | b[o + 8]
            return ImageInfo("image/jpeg", w, h)
        o += 2 + seg_len
    raise ConversionError("JPEG has no SOF marker")


def physical_size(px_w: int, px_h: int, width_m: float) -> tuple[float, float]:
    """Same rounding as packages/image-to-ar physicalSize (0.1 mm). JS Math.round == floor(x + 0.5)."""
    import math

    height_m = math.floor((width_m * px_h * 10000) / px_w + 0.5) / 10000
    return width_m, height_m


def quad_points(w: float, h: float, pivot: str, orientation: str) -> list[tuple[float, float, float]]:
    """TL, BL, BR, TR in the canonical frame (ADR-005)."""
    x0, x1 = -w / 2, w / 2
    bottom = 0.0 if pivot == "bottom-center" else -h / 2
    top = bottom + h
    if orientation == "upright":
        return [(x0, top, 0.0), (x0, bottom, 0.0), (x1, bottom, 0.0), (x1, top, 0.0)]
    return [(x0, 0.0, -top), (x0, 0.0, -bottom), (x1, 0.0, -bottom), (x1, 0.0, -top)]


GLTF_UVS = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0)]
INDICES = [1, 2, 3, 1, 3, 0]


@dataclass
class ImagePlaneRequest:
    image: Path
    out_usdz: Path
    width_m: float
    alpha_mode: AlphaMode
    alpha_cutoff: float = 0.5
    double_sided: bool = False
    pivot: Literal["center", "bottom-center"] = "center"
    orientation: Literal["upright", "flat"] = "upright"
    anchor: Anchor = "none"
    tracking_image: Optional[Path] = None
    tracking_width_m: Optional[float] = None


@dataclass
class ImagePlaneResult:
    usdz: str
    sha256: str
    width_m: float
    height_m: float
    alpha_mode: str
    anchor: str
    package_files: list[str]
    validation_errors: list[str] = field(default_factory=list)
    validation_warnings: list[str] = field(default_factory=list)
    openusd_validators_run: int = 0
    converter_version: str = CONVERTER_VERSION

    def to_dict(self) -> dict:
        return asdict(self)


def _validate(req: ImagePlaneRequest, info: ImageInfo) -> None:
    if not (0.01 <= req.width_m <= 20):
        raise ConversionError("width_m out of range [0.01, 20]")
    if req.alpha_mode not in ("OPAQUE", "MASK", "BLEND"):
        raise ConversionError(f"bad alpha_mode {req.alpha_mode}")
    if info.mime == "image/jpeg" and req.alpha_mode != "OPAQUE":
        raise ConversionError("JPEG has no alpha channel; alpha_mode must be OPAQUE")
    if not (0.0 <= req.alpha_cutoff <= 1.0):
        raise ConversionError("alpha_cutoff out of range")
    if req.anchor == "image":
        if req.tracking_image is None or req.tracking_width_m is None:
            raise ConversionError("image anchor requires tracking_image and tracking_width_m")
        lo, hi = TRACKING_WIDTH_RANGE_M
        if not (lo <= req.tracking_width_m <= hi):
            raise ConversionError("tracking_width_m out of range")
    elif req.tracking_image is not None:
        raise ConversionError("tracking_image is only valid with anchor=image")


def build_image_plane_usdz(req: ImagePlaneRequest) -> ImagePlaneResult:
    data = req.image.read_bytes()
    info = read_image_info(data)
    _validate(req, info)
    w, h = physical_size(info.width, info.height, req.width_m)

    with tempfile.TemporaryDirectory(prefix="usdjob-") as tmp_s:
        tmp = Path(tmp_s)
        # Generated, sanitized names only; never reuse uploaded filenames.
        tex_name = "textures/display" + (".png" if info.mime == "image/png" else ".jpg")
        (tmp / "textures").mkdir()
        shutil.copyfile(req.image, tmp / tex_name)  # byte-identical, alpha untouched
        target_name = None
        if req.anchor == "image":
            tdata = req.tracking_image.read_bytes()  # type: ignore[union-attr]
            tinfo = read_image_info(tdata)
            target_name = "textures/tracking_target" + (".png" if tinfo.mime == "image/png" else ".jpg")
            (tmp / target_name).write_bytes(tdata)

        layer_path = tmp / "scene.usdc"
        _author_stage(layer_path, req, w, h, tex_name, target_name)

        req.out_usdz.parent.mkdir(parents=True, exist_ok=True)
        if req.out_usdz.exists():
            req.out_usdz.unlink()
        # Proper packager (never zip-and-rename): aligned, uncompressed, ARKit-flattened.
        if not UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(str(layer_path)), str(req.out_usdz)):
            raise ConversionError("UsdUtils.CreateNewARKitUsdzPackage failed")

    report = validate_usdz(str(req.out_usdz))
    with zipfile.ZipFile(req.out_usdz) as z:
        names = z.namelist()
    return ImagePlaneResult(
        usdz=str(req.out_usdz),
        sha256=hashlib.sha256(req.out_usdz.read_bytes()).hexdigest(),
        width_m=w,
        height_m=h,
        alpha_mode=req.alpha_mode,
        anchor=req.anchor,
        package_files=names,
        validation_errors=report.errors,
        validation_warnings=report.warnings,
        openusd_validators_run=report.openusd_validators_run,
    )


def _author_stage(path: Path, req: ImagePlaneRequest, w: float, h: float, tex: str, target: Optional[str]) -> None:
    stage = Usd.Stage.CreateNew(str(path))
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    stage.SetMetadata("customLayerData", {"arCreator": {"converterVersion": CONVERTER_VERSION}})

    root = UsdGeom.Xform.Define(stage, "/Root").GetPrim()
    stage.SetDefaultPrim(root)
    Usd.ModelAPI(root).SetKind("component")

    if req.anchor != "none":
        root.AddAppliedSchema("Preliminary_AnchoringAPI")
        if req.anchor == "image":
            root.CreateAttribute("preliminary:anchoring:type", Sdf.ValueTypeNames.Token, variability=Sdf.VariabilityUniform).Set("image")
            ref = stage.DefinePrim("/Root/ReferenceImage", "Preliminary_ReferenceImage")
            ref.CreateAttribute("image", Sdf.ValueTypeNames.Asset, variability=Sdf.VariabilityUniform).Set(Sdf.AssetPath(target))
            # DB stores meters; Apple physicalWidth is centimeters.
            ref.CreateAttribute("physicalWidth", Sdf.ValueTypeNames.Double, variability=Sdf.VariabilityUniform).Set(
                round(req.tracking_width_m * 100.0, 4)  # type: ignore[operator]
            )
            root.CreateRelationship("preliminary:imageAnchoring:referenceImage", custom=False).SetTargets([ref.GetPath()])
        else:
            root.CreateAttribute("preliminary:anchoring:type", Sdf.ValueTypeNames.Token, variability=Sdf.VariabilityUniform).Set("plane")
            root.CreateAttribute("preliminary:planeAnchoring:alignment", Sdf.ValueTypeNames.Token, variability=Sdf.VariabilityUniform).Set(
                "horizontal" if req.anchor == "floor" else "vertical"
            )

    # --- material
    mat = UsdShade.Material.Define(stage, "/Root/Materials/ImageMaterial")
    surf = UsdShade.Shader.Define(stage, "/Root/Materials/ImageMaterial/PreviewSurface")
    surf.CreateIdAttr("UsdPreviewSurface")
    surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
    surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(1.0)
    st_reader = UsdShade.Shader.Define(stage, "/Root/Materials/ImageMaterial/StReader")
    st_reader.CreateIdAttr("UsdPrimvarReader_float2")
    st_reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
    texture = UsdShade.Shader.Define(stage, "/Root/Materials/ImageMaterial/DisplayTexture")
    texture.CreateIdAttr("UsdUVTexture")
    texture.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(tex))
    texture.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
    texture.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("clamp")
    texture.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("clamp")
    texture.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st_reader.ConnectableAPI(), "result")
    rgb = texture.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
    surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(rgb)
    if req.alpha_mode != "OPAQUE":
        a = texture.CreateOutput("a", Sdf.ValueTypeNames.Float)
        surf.CreateInput("opacity", Sdf.ValueTypeNames.Float).ConnectToSource(a)
        # MASK -> binary cutout at threshold; BLEND -> 0 keeps fractional opacity.
        surf.CreateInput("opacityThreshold", Sdf.ValueTypeNames.Float).Set(float(req.alpha_cutoff) if req.alpha_mode == "MASK" else 0.0)
    mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")

    # --- mesh
    mesh = UsdGeom.Mesh.Define(stage, "/Root/ImageObject")
    pts = quad_points(w, h, req.pivot, req.orientation)
    mesh.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*p) for p in pts]))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray([3, 3]))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(INDICES))
    normal = (0.0, 0.0, 1.0) if req.orientation == "upright" else (0.0, 1.0, 0.0)
    mesh.CreateNormalsAttr(Vt.Vec3fArray([Gf.Vec3f(*normal)] * 4))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)  # avoid Catmull-Clark smoothing in viewers
    mesh.CreateOrientationAttr(UsdGeom.Tokens.rightHanded)
    mesh.CreateDoubleSidedAttr(bool(req.double_sided))
    st = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
    st.Set(Vt.Vec2fArray([Gf.Vec2f(u, 1.0 - v) for (u, v) in GLTF_UVS]))
    mesh.CreateExtentAttr(UsdGeom.PointBased.ComputeExtent(mesh.GetPointsAttr().Get()))
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mat)

    stage.GetRootLayer().Save()
