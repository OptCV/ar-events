"""Scene compiler: anchored USDZ for Quick Look (Phase 5 M15, ADR-033)."""

import io
import json
import struct
import threading
import urllib.request
import zipfile
from http.server import HTTPServer

import pytest
from pxr import Gf, Usd, UsdGeom, UsdShade

from usd_processor.image_plane import GLTF_UVS, INDICES, quad_points
from usd_processor.scene.compose_usdz import SceneUsdzError, compose_usdz
from usd_processor.scene.gltf import GltfBuilder
from usd_processor.scene.request import build_scene_body, parse_scene_request
from usd_processor.server import Handler
from usd_processor.validate import authored_api_schemas, validate_usdz
from tests.test_scene_glb import IDENTITY, PNG_1x1, model_glb, node

TRACKING_PNG = open("/fixtures/images/tracking_target_20cm.png", "rb").read()


def image_object_glb(alpha_mode="MASK", cutoff=0.5, double_sided=False) -> bytes:
    """The same quad the image-to-ar GLB builder makes (40 × 40 cm, bottom-centre pivot, standing)."""
    b = GltfBuilder("image-object")
    pts = quad_points(0.4, 0.4, "bottom-center", "upright")
    pos = b.add_floats([c for p in pts for c in p], "VEC3", with_bounds=True)
    nrm = b.add_floats([0, 0, 1] * 4, "VEC3")
    uv = b.add_floats([c for p in GLTF_UVS for c in p], "VEC2")
    idx = b.add_indices(INDICES)
    tex = b.add("textures", {"source": b.add_image(PNG_1x1, "image/png"), "sampler": b.add("samplers", {"wrapS": 33071, "wrapT": 33071})})
    mat = {"pbrMetallicRoughness": {"baseColorTexture": {"index": tex}, "metallicFactor": 0, "roughnessFactor": 1}, "alphaMode": alpha_mode, "doubleSided": double_sided}
    if alpha_mode == "MASK":
        mat["alphaCutoff"] = cutoff
    m = b.add("materials", mat)
    mesh = b.add("meshes", {"primitives": [{"attributes": {"POSITION": pos, "NORMAL": nrm, "TEXCOORD_0": uv}, "indices": idx, "material": m}]})
    b.doc["scenes"][0]["nodes"] = [b.add("nodes", {"mesh": mesh})]
    return b.finish()


def compile_usdz(nodes, files=None, placement=None):
    data, res = compose_usdz(parse_scene_request(build_scene_body({"version": 1, "placement": placement or {"mode": "floor"}, "nodes": nodes}, files or {})))
    return data, res


_opened = iter(range(10**6))


def open_stage(data, tmp_path):
    # A fresh name per file: USD caches layers by path, so reusing one would return the first file again.
    p = tmp_path / f"scene-{next(_opened)}.usdz"
    p.write_bytes(data)
    return Usd.Stage.Open(str(p)), p


def wrapper(stage, node_id):
    return next(p for p in stage.Traverse() if p.GetCustomDataByKey("arCreator:nodeId") == node_id)


def surface_inputs(mesh_prim):
    mat = UsdShade.MaterialBindingAPI(mesh_prim).ComputeBoundMaterial()[0]
    surf = mat.ComputeSurfaceSource()[0]
    out = {}
    for i in surf.GetInputs():
        src = i.GetConnectedSources()[0]
        out[i.GetBaseName()] = ("<-", src[0].source.GetPath().name, src[0].sourceName) if src else i.Get()
    return out


def test_floor_scene_every_kind_validates_with_anchoring_ids_and_hierarchy(tmp_path):
    nodes = [
        node("ring", "image-object", file="io", transform={"position": [-0.4, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}),
        node("cube", "model", file="m", transform={"position": [0.4, 0.15, 0], "rotation": [0, 0.7071068, 0, 0.7071068], "scale": [2, 2, 2]}),
        node("cube-2", "model", file="m"),
        node("group", "group", transform={"position": [0, 0.5, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}),
        node("title", "text", parentId="group", text="Hello AR", style={"color": "#c0392b", "sizeMeters": 0.08}),
        node("card", "panel", title="Opening hours", body="Monday to Friday."),
        *[node(f"s-{s}", "primitive", shape=s, color="#2a8a3e") for s in ("box", "sphere", "cylinder", "plane")],
        node("pin", "hotspot", actionId="x"),
        node("off", "group", visible=False),
        node("off-child", "primitive", shape="box", parentId="off"),
    ]
    data, res = compile_usdz(nodes, {"io": image_object_glb(), "m": model_glb(animated=True, textured=True, skinned=True)})
    stage, path = open_stage(data, tmp_path)
    report = validate_usdz(str(path))
    assert report.errors == [] and report.openusd_validators_run > 0
    root = stage.GetDefaultPrim()
    assert root.GetPath() == "/Root" and "Preliminary_AnchoringAPI" in authored_api_schemas(root)
    assert root.GetAttribute("preliminary:anchoring:type").Get() == "plane"
    assert root.GetAttribute("preliminary:planeAnchoring:alignment").Get() == "horizontal"
    assert UsdGeom.GetStageUpAxis(stage) == "Y" and UsdGeom.GetStageMetersPerUnit(stage) == 1.0
    assert res.node_ids == ["ring", "cube", "cube-2", "group", "title", "card", "s-box", "s-sphere", "s-cylinder", "s-plane", "pin"]
    # Hierarchy and transforms as authored; ids kept in customData, names made USD-safe and unique.
    title = wrapper(stage, "title")
    assert title.GetParent() == wrapper(stage, "group")
    assert wrapper(stage, "cube-2").GetName() == "cube_2"
    cube = UsdGeom.Xformable(wrapper(stage, "cube"))
    m = cube.GetLocalTransformation()
    assert Gf.IsClose(m.ExtractTranslation(), Gf.Vec3d(0.4, 0.15, 0), 1e-6)
    assert Gf.IsClose(Gf.Vec3d(*[m.GetRow3(i).GetLength() for i in range(3)]), Gf.Vec3d(2, 2, 2), 1e-5)
    assert not any(p.GetCustomDataByKey("arCreator:nodeId") in ("off", "off-child") for p in stage.Traverse())
    # Warnings explain what is not carried over to iPhone.
    assert "Animations are not carried over to iPhone yet." in res.warnings
    assert "Skinned models are shown in their rest pose on iPhone." in res.warnings
    # Every texture the materials use is inside the package.
    # (The ARKit packager relocates dependencies into the package and rewrites the references; validation checks them.)
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    base = [n.rsplit("/", 1)[-1] for n in names]
    assert names[0] == "scene.usdc" and any(b.startswith("text_") for b in base) and any(b.startswith("panel_") for b in base)


def test_image_object_matches_the_reference_image_plane_exactly(tmp_path):
    data, _ = compile_usdz([node("ring", "image-object", file="io")], {"io": image_object_glb("MASK", 0.3, True)})
    stage, _ = open_stage(data, tmp_path)
    mesh = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh))
    g = UsdGeom.Mesh(mesh)
    # Same corners as image_plane.quad_points and the same st (u, 1 - v) as the M1 image-plane USDZ.
    assert [c for p in g.GetPointsAttr().Get() for c in p] == pytest.approx([float(c) for p in quad_points(0.4, 0.4, "bottom-center", "upright") for c in p])
    st = UsdGeom.PrimvarsAPI(mesh).GetPrimvar("st").Get()
    assert [tuple(v) for v in st] == [(u, 1.0 - v) for (u, v) in GLTF_UVS]
    assert list(g.GetFaceVertexIndicesAttr().Get()) == INDICES and g.GetDoubleSidedAttr().Get() is True
    inputs = surface_inputs(mesh)
    assert inputs["diffuseColor"][0] == "<-" and inputs["opacity"] == ("<-", "BaseColor", "a")
    assert inputs["opacityThreshold"] == pytest.approx(0.3) and inputs["metallic"] == 0 and inputs["roughness"] == 1
    # BLEND keeps fractional opacity (threshold 0); OPAQUE has no opacity input at all.
    blend_stage, _ = open_stage(compile_usdz([node("r", "image-object", file="io")], {"io": image_object_glb("BLEND")})[0], tmp_path)  # keep the stage alive
    blend = surface_inputs(next(p for p in blend_stage.Traverse() if p.IsA(UsdGeom.Mesh)))
    assert blend["opacityThreshold"] == 0
    opaque_stage, _ = open_stage(compile_usdz([node("r", "image-object", file="io")], {"io": image_object_glb("OPAQUE")})[0], tmp_path)
    opaque = surface_inputs(next(p for p in opaque_stage.Traverse() if p.IsA(UsdGeom.Mesh)))
    assert "opacity" not in opaque


def test_model_materials_textures_and_builtins(tmp_path):
    data, _ = compile_usdz(
        [node("m", "model", file="m"), node("b", "primitive", shape="box", color="#ff8800"), node("t", "text", text="Hi", style={"color": "#000000", "sizeMeters": 0.05})],
        {"m": model_glb(textured=True)},
    )
    stage, _ = open_stage(data, tmp_path)
    meshes = {p.GetParent().GetParent().GetCustomDataByKey("arCreator:nodeId") or p.GetPath(): p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh)}
    model_mesh = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh) and "/m/" in str(p.GetPath()))
    inputs = surface_inputs(model_mesh)
    assert inputs["diffuseColor"] == ("<-", "BaseColor", "rgb") and inputs["normal"] == ("<-", "Normal", "rgb")
    normal = UsdShade.Shader(stage.GetPrimAtPath(model_mesh.GetPath()).GetStage().GetPrimAtPath(str(UsdShade.MaterialBindingAPI(model_mesh).ComputeBoundMaterial()[0].GetPath()) + "/Normal"))
    assert normal.GetInput("sourceColorSpace").Get() == "raw" and tuple(normal.GetInput("bias").Get()) == (-1, -1, -1, 0)
    box = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh) and p.GetName() == "box")
    assert len(UsdGeom.Mesh(box).GetFaceVertexCountsAttr().Get()) == 12
    assert surface_inputs(box)["diffuseColor"] == pytest.approx(Gf.Vec3f(1.0, 0.246201, 0.0), abs=1e-5)
    card = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh) and p.GetName() == "card")
    ci = surface_inputs(card)
    assert ci["emissiveColor"] == ("<-", "Picture", "rgb") and ci["opacity"] == ("<-", "Picture", "a") and tuple(ci["diffuseColor"]) == (0, 0, 0)
    assert meshes  # every mesh has a bound material (validate_usdz checks it too)


def test_image_and_wall_anchoring(tmp_path):
    data, res = compile_usdz([node("s", "primitive", shape="box")], {"t": TRACKING_PNG}, {"mode": "image", "trackingWidthMeters": 0.2, "trackingFile": "t"})
    stage, path = open_stage(data, tmp_path)
    assert validate_usdz(str(path)).errors == []
    root = stage.GetDefaultPrim()
    assert root.GetAttribute("preliminary:anchoring:type").Get() == "image"
    ref = stage.GetPrimAtPath(root.GetRelationship("preliminary:imageAnchoring:referenceImage").GetTargets()[0])
    assert ref.GetTypeName() == "Preliminary_ReferenceImage" and ref.GetAttribute("physicalWidth").Get() == 20.0  # centimetres
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.read(next(n for n in z.namelist() if n.endswith("tracking_target.png"))) == TRACKING_PNG and res.anchor == "image"
    with pytest.raises(SceneUsdzError, match="tracking image"):
        compile_usdz([node("s", "primitive", shape="box")], {}, {"mode": "image", "trackingWidthMeters": 0.2})
    wall, _ = compile_usdz([node("s", "primitive", shape="box")], {}, {"mode": "wall"})
    assert open_stage(wall, tmp_path)[0].GetDefaultPrim().GetAttribute("preliminary:planeAnchoring:alignment").Get() == "vertical"


def test_deterministic_and_refusals():
    nodes = [node("m", "model", file="m"), node("t", "text", text="Same", style={"color": "#000000", "sizeMeters": 0.05})]
    a, _ = compile_usdz(nodes, {"m": model_glb(textured=True)})
    b, _ = compile_usdz(nodes, {"m": model_glb(textured=True)})
    assert a == b
    with pytest.raises(SceneUsdzError, match="no visible objects"):
        compile_usdz([node("s", "primitive", shape="box", visible=False)])
    draco = GltfBuilder("d")
    draco.doc["scenes"][0]["nodes"] = [draco.add("nodes", {})]
    draco.required.add("KHR_draco_mesh_compression")
    draco.used.add("KHR_draco_mesh_compression")
    with pytest.raises(SceneUsdzError) as e:
        compile_usdz([node("m", "model", file="d")], {"d": draco.finish()})
    assert e.value.code == "unsupported_model" and "cannot be converted for iPhone yet" in str(e.value)


def test_matrix_nodes_and_strips(tmp_path):
    b = GltfBuilder("m")
    pos = b.add_floats([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], "VEC3", with_bounds=True)
    mat = b.add("materials", {})
    mesh = b.add("meshes", {"primitives": [{"attributes": {"POSITION": pos}, "mode": 5, "material": mat}]})
    b.doc["scenes"][0]["nodes"] = [b.add("nodes", {"mesh": mesh, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.25, 0.5, 0.75, 1]})]
    data, _ = compile_usdz([node("m", "model", file="m")], {"m": b.finish()})
    stage, _ = open_stage(data, tmp_path)
    mesh_prim = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh))
    assert list(UsdGeom.Mesh(mesh_prim).GetFaceVertexIndicesAttr().Get()) == [0, 1, 2, 2, 1, 3]  # strip → two triangles
    world = UsdGeom.Xformable(mesh_prim.GetParent()).GetLocalTransformation()
    assert Gf.IsClose(world.ExtractTranslation(), Gf.Vec3d(0.25, 0.5, 0.75), 1e-9)


def test_endpoint(tmp_path):
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{httpd.server_address[1]}/v1/scene/usdz"
        data = build_scene_body({"version": 1, "placement": {"mode": "wall"}, "nodes": [node("s", "primitive", shape="sphere")]}, {})
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST")) as r:
            raw = r.read()
        (n,) = struct.unpack(">I", raw[:4])
        meta = json.loads(raw[4 : 4 + n])
        assert meta["ok"] and meta["anchor"] == "wall" and meta["compilerVersion"] == "scene-usdz@0.1.0" and raw[4 + n : 4 + n + 2] == b"PK"
    finally:
        httpd.shutdown()
