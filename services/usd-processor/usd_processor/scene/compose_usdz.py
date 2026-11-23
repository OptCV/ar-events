"""Compose one anchored USDZ from a canonical scene for AR Quick Look (Phase 5 M15, ADR-033).

Same input and node handling as compose_glb (ADR-032): visible nodes only, hierarchy and transforms as authored (the
stage is +Y up, meters, like the canonical frame), built-ins from the same geometry and pictures. Anchoring per
placement on the root prim (Apple preliminary schemas, as image_plane.py): image → reference image with physicalWidth
in centimetres; floor → horizontal plane; wall → vertical plane. The package is made by OpenUSD's ARKit packager and
checked by validate.py. Structural validity does NOT prove Quick Look behaviour; device tests decide.
"""

from __future__ import annotations

import hashlib
import tempfile
import zipfile
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils, Vt

from ..reproducible import normalize_zip_timestamps
from ..validate import validate_usdz
from .builtins import SHAPES, Geometry, panel_raster, plane, srgb_hex_to_linear, text_raster
from .gltf import GltfError, read_glb
from .gltf_to_usd import UsdConvertError, convert_gltf, usd_name
from .request import Node, SceneRequest

SCENE_USDZ_VERSION = "scene-usdz@0.1.0"


class SceneUsdzError(Exception):
    def __init__(self, message: str, code: str = "compile_failed", report: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.report = report


@dataclass
class UsdzResult:
    sha256: str
    size_bytes: int
    anchor: str
    node_ids: list[str]
    package_files: list[str]
    warnings: list[str] = field(default_factory=list)
    validation_warnings: list[str] = field(default_factory=list)
    openusd_validators_run: int = 0
    compiler_version: str = SCENE_USDZ_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "sizeBytes": self.size_bytes,
            "anchor": self.anchor,
            "nodeIds": self.node_ids,
            "packageFiles": self.package_files,
            "warnings": self.warnings,
            "validationWarnings": self.validation_warnings,
            "openusdValidatorsRun": self.openusd_validators_run,
            "compilerVersion": self.compiler_version,
        }


def _image_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpg"
    raise SceneUsdzError("the tracking image must be PNG or JPEG", "bad_file")


def _anchor(stage: Usd.Stage, root: Usd.Prim, req: SceneRequest, files: dict[str, bytes]) -> None:
    root.AddAppliedSchema("Preliminary_AnchoringAPI")
    uniform = Sdf.VariabilityUniform
    if req.mode == "image":
        if req.tracking_file is None:
            raise SceneUsdzError("image placement needs the tracking image", "tracking_image_missing")
        data = req.files[req.tracking_file]
        name = f"textures/tracking_target.{_image_ext(data)}"
        files[name] = data
        root.CreateAttribute("preliminary:anchoring:type", Sdf.ValueTypeNames.Token, variability=uniform).Set("image")
        ref = stage.DefinePrim("/Root/ReferenceImage", "Preliminary_ReferenceImage")
        ref.CreateAttribute("image", Sdf.ValueTypeNames.Asset, variability=uniform).Set(Sdf.AssetPath(name))
        # The scene stores meters; Apple's physicalWidth is centimetres.
        ref.CreateAttribute("physicalWidth", Sdf.ValueTypeNames.Double, variability=uniform).Set(round(float(req.tracking_width_m) * 100.0, 4))
        root.CreateRelationship("preliminary:imageAnchoring:referenceImage", custom=False).SetTargets([ref.GetPath()])
    else:
        root.CreateAttribute("preliminary:anchoring:type", Sdf.ValueTypeNames.Token, variability=uniform).Set("plane")
        root.CreateAttribute("preliminary:planeAnchoring:alignment", Sdf.ValueTypeNames.Token, variability=uniform).Set("horizontal" if req.mode == "floor" else "vertical")


def _xform(x: UsdGeom.Xformable, n: Node) -> None:
    t = n.transform
    if any(t.position):
        x.AddTranslateOp().Set(Gf.Vec3d(*t.position))
    if tuple(t.rotation) != (0.0, 0.0, 0.0, 1.0):
        x.AddOrientOp().Set(Gf.Quatf(t.rotation[3], Gf.Vec3f(*t.rotation[:3])))
    if tuple(t.scale) != (1.0, 1.0, 1.0):
        x.AddScaleOp().Set(Gf.Vec3f(*t.scale))


def _geometry_mesh(stage: Usd.Stage, path: Sdf.Path, g: Geometry, material: UsdShade.Material, double_sided: bool) -> None:
    mesh = UsdGeom.Mesh.Define(stage, path)
    pos = array("f", g.positions)
    mesh.CreatePointsAttr(Vt.Vec3fArray.FromBuffer(memoryview(pos).cast("B").cast("f", (len(pos) // 3, 3))))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray.FromBuffer(memoryview(array("i", [3]) * (len(g.indices) // 3))))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromBuffer(memoryview(array("i", g.indices))))
    nrm = array("f", g.normals)
    mesh.CreateNormalsAttr(Vt.Vec3fArray.FromBuffer(memoryview(nrm).cast("B").cast("f", (len(nrm) // 3, 3))))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    uv = array("f", g.uvs)
    for i in range(1, len(uv), 2):
        uv[i] = 1.0 - uv[i]
    st = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
    st.Set(Vt.Vec2fArray.FromBuffer(memoryview(uv).cast("B").cast("f", (len(uv) // 2, 2))))
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateOrientationAttr(UsdGeom.Tokens.rightHanded)
    mesh.CreateDoubleSidedAttr(double_sided)
    mesh.CreateExtentAttr(UsdGeom.PointBased.ComputeExtent(mesh.GetPointsAttr().Get()))
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)


def _colour_material(stage: Usd.Stage, path: Sdf.Path, hex_color: str) -> UsdShade.Material:
    mat = UsdShade.Material.Define(stage, path)
    surf = UsdShade.Shader.Define(stage, path.AppendChild("PreviewSurface"))
    surf.CreateIdAttr("UsdPreviewSurface")
    surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*srgb_hex_to_linear(hex_color)))
    surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
    surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.75)
    mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")
    return mat


def _picture_material(stage: Usd.Stage, path: Sdf.Path, file: str) -> UsdShade.Material:
    """Text and panels: shown as authored (no lighting) — black diffuse + emissive picture, opacity from its alpha."""
    mat = UsdShade.Material.Define(stage, path)
    surf = UsdShade.Shader.Define(stage, path.AppendChild("PreviewSurface"))
    surf.CreateIdAttr("UsdPreviewSurface")
    st = UsdShade.Shader.Define(stage, path.AppendChild("StReader"))
    st.CreateIdAttr("UsdPrimvarReader_float2")
    st.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
    tex = UsdShade.Shader.Define(stage, path.AppendChild("Picture"))
    tex.CreateIdAttr("UsdUVTexture")
    tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file))
    tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
    tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("clamp")
    tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("clamp")
    tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st.ConnectableAPI(), "result")
    surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0, 0, 0))
    surf.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3))
    surf.CreateInput("opacity", Sdf.ValueTypeNames.Float).ConnectToSource(tex.CreateOutput("a", Sdf.ValueTypeNames.Float))
    surf.CreateInput("opacityThreshold", Sdf.ValueTypeNames.Float).Set(0.0)
    surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
    surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(1.0)
    mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")
    return mat


def compose_usdz(req: SceneRequest) -> tuple[bytes, UsdzResult]:
    visible = req.visible_nodes()
    if not visible:
        raise SceneUsdzError("the scene has no visible objects", "empty_scene")
    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="scene-") as tmp_s:
        tmp = Path(tmp_s)
        files: dict[str, bytes] = {}
        layer = tmp / "scene.usdc"
        stage = Usd.Stage.CreateNew(str(layer))
        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        stage.SetMetadata("customLayerData", {"arCreator": {"compilerVersion": SCENE_USDZ_VERSION}})
        root = UsdGeom.Xform.Define(stage, "/Root").GetPrim()
        stage.SetDefaultPrim(root)
        Usd.ModelAPI(root).SetKind("component")
        _anchor(stage, root, req, files)

        paths: dict[str, Sdf.Path] = {}
        taken: dict[str, set[str]] = {"/Root": {"ReferenceImage"}}
        for n in visible:
            parent = paths.get(n.parent_id) if n.parent_id else None
            parent_path = parent or Sdf.Path("/Root")
            names = taken.setdefault(str(parent_path), set())
            path = parent_path.AppendChild(usd_name(n.id, names))
            paths[n.id] = path
            x = UsdGeom.Xform.Define(stage, path)
            _xform(x, n)
            x.GetPrim().SetCustomDataByKey("arCreator:nodeId", n.id)
            x.GetPrim().SetCustomDataByKey("arCreator:kind", n.kind)
            taken.setdefault(str(path), {"content"})  # child wrappers never take the name of the content prim
            content = path.AppendChild("content")
            if n.kind in ("image-object", "model"):
                assert n.file is not None
                UsdGeom.Xform.Define(stage, content)
                try:
                    doc, binary = read_glb(req.files[n.file])
                    src = convert_gltf(stage, content, doc, binary, usd_name(f"{n.file}", set()))
                except GltfError as e:
                    raise SceneUsdzError(f"node {n.id}: the file could not be read ({e})", "bad_file") from e
                except UsdConvertError as e:
                    raise SceneUsdzError(f"node {n.id}: {e}", e.code) from e
                except (KeyError, IndexError, TypeError, ValueError) as e:
                    raise SceneUsdzError(f"node {n.id}: the file is not valid glTF", "bad_file") from e
                files.update(src.textures)
                warnings += sorted(w for w in src.warnings if w not in warnings)
            elif n.kind == "primitive":
                shape = n.props["shape"]
                UsdGeom.Xform.Define(stage, content)
                mat = _colour_material(stage, content.AppendChild("Material"), n.props["color"])
                _geometry_mesh(stage, content.AppendChild(shape), SHAPES[shape](), mat, shape == "plane")
            elif n.kind in ("text", "panel"):
                r = text_raster(n.props["text"], n.props["color"], n.props["sizeMeters"]) if n.kind == "text" else panel_raster(n.props["title"], n.props["body"])
                file = f"textures/{n.kind}_{hashlib.sha256(r.png).hexdigest()[:16]}.png"
                files[file] = r.png
                UsdGeom.Xform.Define(stage, content)
                mat = _picture_material(stage, content.AppendChild("Material"), file)
                _geometry_mesh(stage, content.AppendChild("card"), plane(r.width_m, r.height_m), mat, False)
            # group, hotspot: the transform only (Quick Look has no taps; ADR-031 lists the action on the page)

        for name, data in sorted(files.items()):
            p = tmp / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        stage.GetRootLayer().Save()
        out = tmp / "scene.usdz"
        if not UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(str(layer)), str(out)):
            raise SceneUsdzError("the USDZ package could not be created")
        normalize_zip_timestamps(out)
        report = validate_usdz(str(out))
        usdz = out.read_bytes()
        with zipfile.ZipFile(out) as z:
            names_in = z.namelist()
    if report.errors:
        raise SceneUsdzError("the USDZ failed structural validation", "validation_failed", {"errors": report.errors, "warnings": report.warnings})
    return usdz, UsdzResult(
        sha256=hashlib.sha256(usdz).hexdigest(),
        size_bytes=len(usdz),
        anchor=req.mode,
        node_ids=[n.id for n in visible],
        package_files=names_in,
        warnings=warnings,
        validation_warnings=report.warnings,
        openusd_validators_run=report.openusd_validators_run,
    )
