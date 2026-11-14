"""Structural USDZ validation.

usd-core 26.x removed the Python `ComplianceChecker` (`usdchecker --arkit`). We therefore run:
  1. every registered OpenUSD `UsdValidation` validator (core, geom, shade, usdz package checks), and
  2. explicit ARKit/Quick Look profile checks re-implemented here from Apple's published constraints
     (https://developer.apple.com/documentation/usd/creating-usd-files-for-apple-devices), plus
     anchoring-metadata consistency checks for the Apple preliminary schemas.
Passing these checks is "structurally validated" only (TESTING.md) — NOT device verified. Apple's own
`usdchecker` (macOS/Xcode) remains a recommended extra gate and is not available in this container.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from pxr import Sdf, Tf, Usd, UsdGeom, UsdShade, UsdValidation

ALLOWED_EXTS = {".usdc", ".usda", ".usd", ".png", ".jpg", ".jpeg"}
ALLOWED_SHADER_IDS = {"UsdPreviewSurface", "UsdUVTexture", "UsdPrimvarReader_float2", "UsdTransform2d"}
ANCHORING_API = "Preliminary_AnchoringAPI"


@dataclass
class ValidationReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    openusd_validators_run: int = 0

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_usdz(path: str) -> ValidationReport:
    rep = ValidationReport()
    _check_zip(path, rep)
    try:
        stage = Usd.Stage.Open(path)
    except Tf.ErrorException as e:
        rep.errors.append(f"stage failed to open: {str(e).strip().splitlines()[0]}")
        return rep
    if stage is None:
        rep.errors.append("stage failed to open")
        return rep
    _run_openusd_validators(stage, rep)
    _check_stage(stage, rep)
    _check_shading_and_assets(stage, path, rep)
    _check_anchoring(stage, path, rep)
    return rep


def _check_zip(path: str, rep: ValidationReport) -> None:
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if not infos:
            rep.errors.append("usdz: empty package")
            return
        if PurePosixPath(infos[0].filename).suffix != ".usdc":
            rep.errors.append(f"usdz: first entry must be the root .usdc layer, got {infos[0].filename}")
        with open(path, "rb") as f:
            raw = f.read()
        for info in infos:
            ext = PurePosixPath(info.filename).suffix.lower()
            if ext not in ALLOWED_EXTS:
                rep.errors.append(f"usdz: disallowed file type {info.filename}")
            if info.compress_type != zipfile.ZIP_STORED:
                rep.errors.append(f"usdz: {info.filename} is compressed (must be stored)")
            if info.filename.startswith("/") or ".." in PurePosixPath(info.filename).parts:
                rep.errors.append(f"usdz: unsafe entry path {info.filename}")
            # local header: 30 bytes + name + extra; data must start on a 64-byte boundary
            o = info.header_offset
            name_len = int.from_bytes(raw[o + 26 : o + 28], "little")
            extra_len = int.from_bytes(raw[o + 28 : o + 30], "little")
            data_offset = o + 30 + name_len + extra_len
            if data_offset % 64 != 0:
                rep.errors.append(f"usdz: {info.filename} data not 64-byte aligned ({data_offset})")


def _run_openusd_validators(stage: Usd.Stage, rep: ValidationReport) -> None:
    validators = UsdValidation.ValidationRegistry().GetOrLoadAllValidators()
    rep.openusd_validators_run = len(validators)
    ctx = UsdValidation.ValidationContext(validators)
    for err in ctx.Validate(stage):
        if err.HasNoError():
            continue
        msg = f"openusd:{err.GetName()}: {err.GetMessage()}"
        if err.GetType() == UsdValidation.ValidationErrorType.Error:
            rep.errors.append(msg)
        else:
            rep.warnings.append(msg)


def _check_stage(stage: Usd.Stage, rep: ValidationReport) -> None:
    if not stage.HasDefaultPrim():
        rep.errors.append("stage: no defaultPrim")
    if UsdGeom.GetStageMetersPerUnit(stage) != 1.0:
        rep.errors.append("stage: metersPerUnit must be 1.0 (canonical meters)")
    if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.y:
        rep.errors.append("stage: upAxis must be Y")
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.Mesh):
            mesh = UsdGeom.Mesh(prim)
            if mesh.GetSubdivisionSchemeAttr().Get() != UsdGeom.Tokens.none:
                rep.warnings.append(f"mesh {prim.GetPath()}: subdivisionScheme is not 'none'")
            if not UsdGeom.PrimvarsAPI(prim).HasPrimvar("st"):
                rep.warnings.append(f"mesh {prim.GetPath()}: no st primvar")
            if not UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]:
                rep.errors.append(f"mesh {prim.GetPath()}: no bound material")


def _package_names(path: str) -> set[str]:
    with zipfile.ZipFile(path) as z:
        return set(z.namelist())


def _asset_in_package(value: Sdf.AssetPath, names: set[str]) -> bool:
    p = value.path.lstrip("./")
    return p in names


def _check_shading_and_assets(stage: Usd.Stage, path: str, rep: ValidationReport) -> None:
    names = _package_names(path)
    for prim in stage.Traverse():
        if prim.IsA(UsdShade.Shader):
            sid = UsdShade.Shader(prim).GetShaderId()
            if sid not in ALLOWED_SHADER_IDS:
                rep.errors.append(f"shader {prim.GetPath()}: id {sid} not supported by Quick Look")
        for attr in prim.GetAttributes():
            if attr.GetTypeName() == Sdf.ValueTypeNames.Asset:
                v = attr.Get()
                if v and v.path and not _asset_in_package(v, names):
                    rep.errors.append(f"asset {attr.GetPath()} -> {v.path} not inside package")


def authored_api_schemas(prim: Usd.Prim) -> list[str]:
    """Authored apiSchemas, including UNREGISTERED ones. Apple's preliminary schemas are not registered in
    OpenUSD, so prim.GetAppliedSchemas() silently omits them."""
    op = prim.GetMetadata("apiSchemas")
    return list(op.ApplyOperations([])) if op else []


def _check_anchoring(stage: Usd.Stage, path: str, rep: ValidationReport) -> None:
    names = _package_names(path)
    anchored = [p for p in stage.Traverse() if ANCHORING_API in authored_api_schemas(p)]
    for p in stage.Traverse():
        if p.HasAttribute("preliminary:anchoring:type") and p not in anchored:
            rep.errors.append(f"anchoring: {p.GetPath()} has anchoring attributes without {ANCHORING_API}")
    if len(anchored) > 1:
        rep.errors.append(f"anchoring: {len(anchored)} anchored prims; nested/independent anchors not allowed")
    for prim in anchored:
        if prim != stage.GetDefaultPrim():
            rep.warnings.append(f"anchoring: {prim.GetPath()} is not the defaultPrim")
        typ = prim.GetAttribute("preliminary:anchoring:type").Get()
        if typ == "plane":
            align = prim.GetAttribute("preliminary:planeAnchoring:alignment").Get()
            if align not in ("horizontal", "vertical"):
                rep.errors.append(f"anchoring: bad plane alignment {align!r}")
        elif typ == "image":
            targets = prim.GetRelationship("preliminary:imageAnchoring:referenceImage").GetTargets()
            if len(targets) != 1:
                rep.errors.append("anchoring: image anchor needs exactly one referenceImage target")
                continue
            ref = stage.GetPrimAtPath(targets[0])
            if not ref or ref.GetTypeName() != "Preliminary_ReferenceImage":
                rep.errors.append("anchoring: referenceImage target is not a Preliminary_ReferenceImage")
                continue
            img = ref.GetAttribute("image").Get()
            if not img or not _asset_in_package(img, names):
                rep.errors.append("anchoring: reference image asset missing from package")
            width_cm = ref.GetAttribute("physicalWidth").Get()
            if not width_cm or width_cm <= 0:
                rep.errors.append("anchoring: physicalWidth (cm) must be > 0")
        else:
            rep.errors.append(f"anchoring: unknown type {typ!r}")
