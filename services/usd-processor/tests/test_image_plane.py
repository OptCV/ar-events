"""USDZ image-plane converter tests. Run in the container: npm run usd:test (fixtures mounted at /fixtures)."""

from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path

import pytest
from pxr import Usd, UsdGeom, UsdShade

from usd_processor.image_plane import (
    ConversionError,
    ImagePlaneRequest,
    build_image_plane_usdz,
    physical_size,
    quad_points,
)
from usd_processor.validate import authored_api_schemas, validate_usdz

FIX = Path(os.environ.get("FIXTURES_DIR", "/fixtures"))
MANIFEST = json.loads((FIX / "manifest.json").read_text())
DISPLAY = [f for f in MANIFEST["fixtures"] if f["role"] == "display-image"]
TARGET = FIX / "images" / "tracking_target_20cm.png"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def build(tmp_path: Path, fixture: dict, anchor: str = "none", **kw) -> tuple[ImagePlaneRequest, object]:
    extra = {}
    if anchor == "image":
        extra = {"tracking_image": TARGET, "tracking_width_m": 0.2}
    req = ImagePlaneRequest(
        image=FIX / fixture["path"],
        out_usdz=tmp_path / f"{Path(fixture['file']).stem}_{anchor}.usdz",
        width_m=kw.pop("width_m", 0.5),
        alpha_mode=kw.pop("alpha_mode", fixture["expectedAutoAlpha"]),
        anchor=anchor,
        **extra,
        **kw,
    )
    return req, build_image_plane_usdz(req)


def surface(stage: Usd.Stage) -> UsdShade.Shader:
    return UsdShade.Shader(stage.GetPrimAtPath("/Root/Materials/ImageMaterial/PreviewSurface"))


@pytest.mark.parametrize("fixture", DISPLAY, ids=[f["file"] for f in DISPLAY])
@pytest.mark.parametrize("anchor", ["none", "floor", "wall", "image"])
def test_valid_package_and_texture_preserved(tmp_path, fixture, anchor):
    req, res = build(tmp_path, fixture, anchor)
    assert res.validation_errors == [], res.validation_errors
    assert res.validation_warnings == [], res.validation_warnings
    assert res.openusd_validators_run > 0
    with zipfile.ZipFile(req.out_usdz) as z:
        names = z.namelist()
        assert names[0] == "scene.usdc"
        tex = [n for n in names if "display" in n]
        assert len(tex) == 1
        # alpha preserved: texture bytes identical to the source (no re-encode / flatten / premultiply)
        assert sha(z.read(tex[0])) == fixture["sha256"]
        if anchor == "image":
            tgt = [n for n in names if "tracking_target" in n]
            assert len(tgt) == 1 and sha(z.read(tgt[0])) == sha(TARGET.read_bytes())
        else:
            assert not any("tracking_target" in n for n in names)


@pytest.mark.parametrize("fixture", DISPLAY, ids=[f["file"] for f in DISPLAY])
def test_material_alpha_wiring(tmp_path, fixture):
    req, res = build(tmp_path, fixture)
    stage = Usd.Stage.Open(str(req.out_usdz))
    s = surface(stage)
    opacity = s.GetInput("opacity")
    mode = fixture["expectedAutoAlpha"]
    if mode == "OPAQUE":
        assert not opacity or not opacity.HasConnectedSource()
    else:
        assert opacity.HasConnectedSource()
        (src, out_name, _), = [opacity.GetConnectedSource()]
        assert src.GetPrim().GetName() == "DisplayTexture" and out_name == "a"
        thr = s.GetInput("opacityThreshold").Get()
        assert thr == pytest.approx(0.5 if mode == "MASK" else 0.0)
    tex = UsdShade.Shader(stage.GetPrimAtPath("/Root/Materials/ImageMaterial/DisplayTexture"))
    assert tex.GetInput("sourceColorSpace").Get() == "sRGB"


def test_geometry_matches_shared_golden(tmp_path):
    golden = json.loads((FIX / "geometry_golden.json").read_text())["cases"]
    assert golden
    for c in golden:
        w, h = physical_size(c["pixelWidth"], c["pixelHeight"], c["widthMeters"])
        assert h == c["heightMeters"], c
        pts = [v for p in quad_points(w, h, c["pivot"], c["orientation"]) for v in p]
        assert pts == pytest.approx(c["positions"], abs=1e-7), c


def test_usd_mesh_matches_glb_contract(tmp_path):
    fixture = next(f for f in DISPLAY if f["file"] == "orientation_probe.png")
    req, res = build(tmp_path, fixture, width_m=0.3, pivot="bottom-center", orientation="flat")
    stage = Usd.Stage.Open(str(req.out_usdz))
    mesh = UsdGeom.Mesh(stage.GetPrimAtPath("/Root/ImageObject"))
    golden = next(
        c for c in json.loads((FIX / "geometry_golden.json").read_text())["cases"]
        if c["pixelWidth"] == 600 and c["pivot"] == "bottom-center" and c["orientation"] == "flat"
    )
    pts = [v for p in mesh.GetPointsAttr().Get() for v in p]
    assert pts == pytest.approx(golden["positions"], abs=1e-7)
    assert list(mesh.GetFaceVertexIndicesAttr().Get()) == golden["indices"]
    st = UsdGeom.PrimvarsAPI(mesh).GetPrimvar("st").Get()
    uv = golden["uvs"]
    # USD st is v-up: st = (u, 1 - v)
    assert [(p[0], p[1]) for p in st] == [(uv[i], 1 - uv[i + 1]) for i in range(0, 8, 2)]
    assert mesh.GetSubdivisionSchemeAttr().Get() == "none"
    assert UsdGeom.GetStageMetersPerUnit(stage) == 1.0


def test_anchoring_metadata(tmp_path):
    f = DISPLAY[0]
    for anchor, expected in [("floor", "horizontal"), ("wall", "vertical")]:
        req, _ = build(tmp_path, f, anchor)
        st = Usd.Stage.Open(str(req.out_usdz))
        root = st.GetDefaultPrim()
        assert "Preliminary_AnchoringAPI" in authored_api_schemas(root)
        assert root.GetAttribute("preliminary:anchoring:type").Get() == "plane"
        assert root.GetAttribute("preliminary:planeAnchoring:alignment").Get() == expected

    req, _ = build(tmp_path, f, "image")
    stage = Usd.Stage.Open(str(req.out_usdz))
    root = stage.GetDefaultPrim()
    assert root.GetAttribute("preliminary:anchoring:type").Get() == "image"
    (target,) = root.GetRelationship("preliminary:imageAnchoring:referenceImage").GetTargets()
    ref = stage.GetPrimAtPath(target)
    assert ref.GetTypeName() == "Preliminary_ReferenceImage"
    # DB meters -> Apple centimeters
    assert ref.GetAttribute("physicalWidth").Get() == pytest.approx(20.0)

    req, _ = build(tmp_path, f, "none")
    st = Usd.Stage.Open(str(req.out_usdz))
    assert "Preliminary_AnchoringAPI" not in authored_api_schemas(st.GetDefaultPrim())


def test_double_sided_flag(tmp_path):
    req, _ = build(tmp_path, DISPLAY[1], double_sided=True)
    stage = Usd.Stage.Open(str(req.out_usdz))
    mesh = UsdGeom.Mesh(stage.GetPrimAtPath("/Root/ImageObject"))
    assert mesh.GetDoubleSidedAttr().Get() is True


def test_deterministic_output(tmp_path):
    f = next(x for x in DISPLAY if x["file"] == "aa_disc_dark_fringe.png")
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    _, r1 = build(tmp_path / "a", f, "wall")
    _, r2 = build(tmp_path / "b", f, "wall")
    assert r1.sha256 == r2.sha256


@pytest.mark.parametrize(
    "kw, msg",
    [
        ({"alpha_mode": "BLEND"}, "JPEG"),
        ({"alpha_mode": "OPAQUE", "anchor": "image"}, "tracking_image"),
        ({"alpha_mode": "OPAQUE", "anchor": "image", "tracking_image": TARGET, "tracking_width_m": 20.0}, "tracking_width_m"),
        ({"alpha_mode": "OPAQUE", "anchor": "floor", "tracking_image": TARGET}, "only valid"),
        ({"alpha_mode": "OPAQUE", "width_m": 0}, "width_m"),
    ],
)
def test_rejects_bad_requests(tmp_path, kw, msg):
    jpg = next(f for f in DISPLAY if f["file"] == "opaque_photo.jpg")
    req = ImagePlaneRequest(image=FIX / jpg["path"], out_usdz=tmp_path / "x.usdz", width_m=kw.pop("width_m", 0.5), **kw)
    with pytest.raises(ConversionError, match=msg):
        build_image_plane_usdz(req)


def test_rejects_non_image_bytes(tmp_path):
    bad = tmp_path / "evil.png"
    bad.write_bytes(b"<svg onload=alert(1)></svg>")
    with pytest.raises(ConversionError, match="signature"):
        build_image_plane_usdz(ImagePlaneRequest(image=bad, out_usdz=tmp_path / "x.usdz", width_m=0.5, alpha_mode="OPAQUE"))


def test_validator_rejects_zip_renamed_to_usdz(tmp_path):
    """AGENTS.md: never handcraft/rename a ZIP to USDZ. The validator must catch it."""
    req, _ = build(tmp_path, DISPLAY[1])
    fake = tmp_path / "fake.usdz"
    with zipfile.ZipFile(req.out_usdz) as src, zipfile.ZipFile(fake, "w", zipfile.ZIP_DEFLATED) as dst:
        for n in src.namelist():
            dst.writestr(n, src.read(n))
    rep = validate_usdz(str(fake))
    assert not rep.ok
    assert any("compressed" in e for e in rep.errors)


def test_validator_rejects_missing_texture(tmp_path):
    req, _ = build(tmp_path, DISPLAY[1])
    broken = tmp_path / "broken.usdz"
    # Rebuild a stored package without the texture, keeping 64-byte alignment irrelevant: expect asset error.
    with zipfile.ZipFile(req.out_usdz) as src, zipfile.ZipFile(broken, "w", zipfile.ZIP_STORED) as dst:
        for n in src.namelist():
            if "display" not in n:
                dst.writestr(n, src.read(n))
    rep = validate_usdz(str(broken))
    assert any("not inside package" in e for e in rep.errors), rep.errors


def test_validator_detects_broken_anchoring(tmp_path):
    """Regression: the anchoring checks must actually run (unregistered schema visibility)."""
    from pxr import Sdf, UsdUtils

    req, _ = build(tmp_path, DISPLAY[1], "image")
    work = tmp_path / "x"
    with zipfile.ZipFile(req.out_usdz) as z:
        z.extractall(work)
    layer = Sdf.Layer.FindOrOpen(str(work / "scene.usdc"))
    stage = Usd.Stage.Open(layer)
    ref = stage.GetPrimAtPath("/Root/ReferenceImage")
    ref.GetAttribute("physicalWidth").Set(0.0)
    layer.Save()
    out = tmp_path / "broken_anchor.usdz"
    assert UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(str(work / "scene.usdc")), str(out))
    rep = validate_usdz(str(out))
    assert any("physicalWidth" in e for e in rep.errors), rep.errors


def test_reproducible_across_time(tmp_path):
    """Regression: ZIP entry timestamps were wall-clock, so hashes changed between runs."""
    import time

    f = next(x for x in DISPLAY if x["file"] == "alpha_steps.png")
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    req, r1 = build(tmp_path / "a", f, "floor")
    time.sleep(2.1)  # DOS timestamps have 2 s resolution
    _, r2 = build(tmp_path / "b", f, "floor")
    assert r1.sha256 == r2.sha256
    with zipfile.ZipFile(req.out_usdz) as z:
        assert {i.date_time for i in z.infolist()} == {(1980, 1, 1, 0, 0, 0)}
    assert validate_usdz(str(req.out_usdz)).ok  # alignment intact after patching
