"""Scene compiler: composed GLB (Phase 5 M14, ADR-032)."""

import hashlib
import json
import struct
import threading
import urllib.request
from http.server import HTTPServer

import pytest

from usd_processor.scene.builtins import box, cylinder, panel_raster, sphere, srgb_hex_to_linear, text_raster, wrap_text
from usd_processor.scene.compose_glb import SceneCompileError, compose_glb
from usd_processor.scene.gltf import GltfBuilder, GltfError, read_glb, triangle_count, write_glb
from usd_processor.scene.request import SceneRequestError, build_scene_body, parse_scene_request
from usd_processor.server import Handler

IDENTITY = {"position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}
PNG_1x1 = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360f8cf000000020101e221bc330000000049454e44ae426082")


def model_glb(*, animated=False, textured=False, skinned=False, padding=0) -> bytes:
    """A small but feature-rich source model: a triangle mesh, optional texture (base colour + normal map),
    a joint hierarchy with a skin, an animation, a camera (dropped), and optional dead weight."""
    b = GltfBuilder("test")
    pos = b.add_floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", with_bounds=True)
    idx = b.add_indices([0, 1, 2])
    mat: dict = {"pbrMetallicRoughness": {"baseColorFactor": [1, 0, 0, 1]}}
    if textured:
        tex = b.add("textures", {"source": b.add_image(PNG_1x1, "image/png"), "sampler": b.add("samplers", {})})
        tex2 = b.add("textures", {"source": b.add_image(PNG_1x1, "image/png")})
        mat = {"pbrMetallicRoughness": {"baseColorTexture": {"index": tex}}, "normalTexture": {"index": tex2, "scale": 1}}
    m = b.add("materials", mat)
    mesh = b.add("meshes", {"primitives": [{"attributes": {"POSITION": pos}, "indices": idx, "material": m}]})
    child = b.add("nodes", {"name": "joint"})
    root = b.add("nodes", {"name": "model-root", "mesh": mesh, "children": [child], "camera": 0})
    b.doc["cameras"] = [{"type": "perspective", "perspective": {"yfov": 1, "znear": 0.1}}]
    if skinned:
        ibm = b.add_floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], "MAT4" if False else "VEC4")
        b.doc["accessors"][ibm]["type"] = "MAT4"
        b.doc["accessors"][ibm]["count"] = 1
        b.doc["skins"].append({"inverseBindMatrices": ibm, "joints": [child], "skeleton": child})
    if animated:
        t = b.add_floats([0, 1], "SCALAR", with_bounds=True)
        r = b.add_floats([0, 0, 0, 1, 0, 0.7071068, 0, 0.7071068], "VEC4")
        b.doc["animations"].append({"name": "Spin", "samplers": [{"input": t, "output": r}], "channels": [{"sampler": 0, "target": {"node": child, "path": "rotation"}}]})
    if padding:
        b.add_view(b"\x00" * padding)
    b.doc["scenes"][0]["nodes"] = [root]
    return b.finish()


def body(nodes, files, placement=None):
    return build_scene_body({"version": 1, "placement": placement or {"mode": "floor"}, "nodes": nodes}, files)


def node(id_, kind, **extra):
    return {"id": id_, "kind": kind, "transform": extra.pop("transform", IDENTITY), "visible": extra.pop("visible", True), **extra}


def compiled(nodes, files=None, placement=None):
    glb, res = compose_glb(parse_scene_request(body(nodes, files or {}, placement)))
    doc, binary = read_glb(glb)
    return doc, binary, res, glb


def check_references(doc, binary):
    """Every index in the composed document points at something that exists (what the validator checks first)."""
    n = {k: len(doc.get(k, [])) for k in ("nodes", "meshes", "materials", "textures", "images", "samplers", "accessors", "bufferViews", "skins")}
    for v in doc.get("bufferViews", []):
        assert v["byteOffset"] + v["byteLength"] <= len(binary)
    for a in doc.get("accessors", []):
        assert a["bufferView"] < n["bufferViews"]
    for im in doc.get("images", []):
        assert im["bufferView"] < n["bufferViews"]
    for t in doc.get("textures", []):
        assert t.get("source", 0) < n["images"] and t.get("sampler", 0) < max(1, n["samplers"])
    for mesh in doc.get("meshes", []):
        for p in mesh["primitives"]:
            assert all(v < n["accessors"] for v in p["attributes"].values())
            assert p.get("indices", 0) < n["accessors"] and p.get("material", 0) < n["materials"]
    for nd in doc["nodes"]:
        assert all(c < n["nodes"] for c in nd.get("children", []))
        assert nd.get("mesh", 0) < max(1, n["meshes"]) and "camera" not in nd
    for s in doc.get("skins", []):
        assert all(j < n["nodes"] for j in s["joints"]) and s["inverseBindMatrices"] < n["accessors"]
    for an in doc.get("animations", []):
        for c in an["channels"]:
            assert c["target"]["node"] < n["nodes"]
        for s in an["samplers"]:
            assert s["input"] < n["accessors"] and s["output"] < n["accessors"]
    # Every node has exactly one parent at most (a tree).
    seen = [c for nd in doc["nodes"] for c in nd.get("children", [])] + doc["scenes"][0]["nodes"]
    assert len(seen) == len(set(seen))


def test_glb_roundtrip_and_refusals():
    doc, binary = read_glb(model_glb())
    assert doc["asset"]["version"] == "2.0" and binary
    assert read_glb(write_glb(doc, binary))[0] == doc
    with pytest.raises(GltfError):
        read_glb(b"glTF" + b"\x00" * 20)
    good = model_glb()
    with pytest.raises(GltfError, match="length"):
        read_glb(good + b"\x00\x00\x00\x00")
    ext = GltfBuilder("t")
    ext.doc["images"].append({"uri": "texture.png"})
    with pytest.raises(GltfError, match="external"):
        GltfBuilder("x").merge(*read_glb(ext.finish()))


def test_models_are_merged_losslessly_twice_with_all_references_remapped():
    f = model_glb(animated=True, textured=True, skinned=True)
    doc, binary, res, _ = compiled(
        [node("a", "model", file="m", transform={"position": [0.5, 0, 0], "rotation": [0, 0.7071068, 0, 0.7071068], "scale": [2, 2, 2]}), node("b", "model", file="m")],
        {"m": f},
    )
    check_references(doc, binary)
    roots = [doc["nodes"][i] for i in doc["scenes"][0]["nodes"]]
    assert [r["name"] for r in roots] == ["a", "b"]
    assert roots[0] == {**roots[0], "translation": [0.5, 0, 0], "rotation": [0, 0.7071068, 0, 0.7071068], "scale": [2, 2, 2], "extras": {"arCreator": {"nodeId": "a", "kind": "model"}}}
    assert "translation" not in roots[1] and "rotation" not in roots[1]
    # Each copy brings its own mesh, material, two textures, a skin and an animation targeting ITS joint.
    assert len(doc["meshes"]) == 2 and len(doc["materials"]) == 2 and len(doc["textures"]) == 4 and len(doc["images"]) == 4
    assert len(doc["skins"]) == 2 and len(doc["animations"]) == 2
    for copy_i, r in enumerate(roots):
        model_root = doc["nodes"][r["children"][0]]
        joint = model_root["children"][0]
        assert doc["nodes"][joint]["name"] == "joint"
        assert doc["animations"][copy_i]["channels"][0]["target"]["node"] == joint
        assert doc["skins"][copy_i]["joints"] == [joint]
        mat = doc["materials"][doc["meshes"][model_root["mesh"]]["primitives"][0]["material"]]
        assert mat["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 2 * copy_i
        assert mat["normalTexture"]["index"] == 2 * copy_i + 1
    assert "cameras" not in doc
    assert res.triangles == 2 and res.node_ids == ["a", "b"]
    assert res.warnings == ["Scene Viewer plays only the first animation, in a loop."]


def test_hierarchy_visibility_and_hotspots():
    nodes = [
        node("g", "group", transform={"position": [0, 1, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}),
        node("child", "primitive", shape="box", parentId="g"),
        node("hidden", "group", visible=False),
        node("under-hidden", "primitive", shape="sphere", parentId="hidden"),
        node("pin", "hotspot", actionId="x"),
    ]
    doc, binary, res, _ = compiled(nodes)
    check_references(doc, binary)
    assert res.node_ids == ["g", "child", "pin"]  # the hidden group and its child are left out
    g = doc["nodes"][doc["scenes"][0]["nodes"][0]]
    assert g["name"] == "g" and doc["nodes"][g["children"][0]]["name"] == "child"
    pin = doc["nodes"][doc["scenes"][0]["nodes"][1]]
    assert pin == {"name": "pin", "extras": {"arCreator": {"nodeId": "pin", "kind": "hotspot"}}}  # empty: viewers draw their marker


def test_builtins_geometry_colours_and_pictures():
    assert len(box().indices) // 3 == 12
    assert len(sphere().indices) // 3 == 48 * 24 * 2 - 48 * 2  # three.js SphereGeometry(0.5, 48, 24)
    assert len(cylinder().indices) // 3 == 48 * 2 + 48 * 2
    for g in (box(), sphere(), cylinder()):
        xs, ys, zs = g.positions[0::3], g.positions[1::3], g.positions[2::3]
        assert max(xs) - min(xs) == pytest.approx(1) and max(ys) - min(ys) == pytest.approx(1) and max(zs) - min(zs) == pytest.approx(1)
    assert srgb_hex_to_linear("#ffffff") == [1, 1, 1] and srgb_hex_to_linear("#000000") == [0, 0, 0]
    assert srgb_hex_to_linear("#808080")[0] == pytest.approx(0.215861, abs=1e-6)

    doc, binary, res, _ = compiled(
        [
            node("s", "primitive", shape="plane", color="#ff8800"),
            node("t", "text", text="Hello\nAR", style={"color": "#c0392b", "sizeMeters": 0.1}),
            node("p", "panel", title="Opening hours", body="Monday to Friday, 9:00 to 17:00."),
        ]
    )
    check_references(doc, binary)
    shape_mat = doc["materials"][0]
    assert shape_mat["pbrMetallicRoughness"]["baseColorFactor"][:3] == srgb_hex_to_linear("#ff8800") and shape_mat["doubleSided"] is True
    text_mat, panel_mat = doc["materials"][1], doc["materials"][2]
    for m in (text_mat, panel_mat):
        assert m["alphaMode"] == "BLEND" and "KHR_materials_unlit" in m["extensions"]
    assert "KHR_materials_unlit" in doc["extensionsUsed"] and "extensionsRequired" not in doc
    pos = {a: doc["accessors"][doc["meshes"][i]["primitives"][0]["attributes"]["POSITION"]] for a, i in (("text", 1), ("panel", 2))}
    assert pos["text"]["max"][1] - pos["text"]["min"][1] == pytest.approx(0.2)  # 2 lines × 10 cm
    assert pos["panel"]["max"][0] - pos["panel"]["min"][0] == pytest.approx(0.3)  # 30 cm card


def test_text_and_panels_are_identical_on_every_run_and_wrap_like_the_editor():
    a, b = text_raster("Héllo AR ✓", "#17202a", 0.05), text_raster("Héllo AR ✓", "#17202a", 0.05)
    assert a.png == b.png and a.height_px == 160
    p1, p2 = panel_raster("Title", "word " * 200), panel_raster("Title", "word " * 200)
    assert p1.png == p2.png and p1.width_px == 1024
    m = len
    assert wrap_text("the quick brown fox", 10, m) == ["the quick", "brown fox"]
    assert wrap_text("a\n\nb", 10, m) == ["a", "", "b"]
    assert wrap_text("abcdefghijklmnop", 6, m) == ["abcdef", "ghijkl", "mnop"]
    assert wrap_text("", 6, m) == [""]
    # Very long text stays within the texture limit.
    long = text_raster("x" * 500, "#000000", 0.05)
    assert long.width_px <= 4096


def test_output_is_byte_identical_for_identical_input():
    nodes = [node("m", "model", file="f"), node("t", "text", text="Same", style={"color": "#000000", "sizeMeters": 0.05})]
    one = compiled(nodes, {"f": model_glb(textured=True)})[3]
    two = compiled(nodes, {"f": model_glb(textured=True)})[3]
    assert one == two


def test_refusals():
    with pytest.raises(SceneCompileError, match="no visible objects"):
        compiled([node("h", "primitive", shape="box", visible=False)])
    with pytest.raises(SceneRequestError, match="checksum"):
        raw = bytearray(body([node("m", "model", file="f")], {"f": model_glb()}))
        raw[-1] ^= 0xFF
        parse_scene_request(bytes(raw))
    for bad in (
        [node("a", "primitive", shape="cone")],
        [node("a", "primitive", shape="box", parentId="nope")],
        [node("a", "model")],
        [node("a", "text", text="", style={"color": "#000000", "sizeMeters": 0.05})],
        [node("a", "primitive", shape="box", transform={"position": [0, 0, 0], "rotation": [0, 0, 0, 2], "scale": [1, 1, 1]})],
        [node("a", "group", parentId="b"), node("b", "group", parentId="a")],
    ):
        with pytest.raises(SceneRequestError):
            parse_scene_request(body(bad, {}))
    with pytest.raises(SceneRequestError, match="trackingWidthMeters"):
        parse_scene_request(body([], {}, {"mode": "image", "trackingWidthMeters": 9}))
    # Scene Viewer's 15 MB limit is enforced for floor/wall, not for the WebXR image scene.
    big = model_glb(padding=16 * 1024 * 1024)
    with pytest.raises(SceneCompileError, match="15 MB"):
        compiled([node("m", "model", file="f")], {"f": big})
    _, _, res, _ = compiled([node("m", "model", file="f")], {"f": big}, {"mode": "image", "trackingWidthMeters": 0.2})
    assert res.size_bytes > 16 * 1024 * 1024


def test_endpoint_returns_a_frame():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        url = f"http://127.0.0.1:{httpd.server_address[1]}/v1/scene/glb"
        data = body([node("s", "primitive", shape="box")], {})
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST")) as r:
            raw = r.read()
        (n,) = struct.unpack(">I", raw[:4])
        meta = json.loads(raw[4 : 4 + n])
        glb = raw[4 + n :]
        assert meta["ok"] and meta["sha256"] == hashlib.sha256(glb).hexdigest() and meta["triangles"] == 12 and meta["compilerVersion"] == "scene-glb@0.1.0"
        bad = urllib.request.Request(url, data=body([node("s", "primitive", shape="cone")], {}), method="POST")
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(bad)
        assert e.value.code == 400 and json.loads(e.value.read())["code"] == "bad_scene"
    finally:
        httpd.shutdown()


def test_triangle_count_counts_indexed_and_plain_triangles():
    doc, _ = read_glb(model_glb())
    assert triangle_count(doc) == 1
