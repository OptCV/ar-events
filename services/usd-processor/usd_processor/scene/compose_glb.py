"""Compose one GLB from a canonical scene (Phase 5 M14, ADR-032).

Used for Android: the single hosted Scene Viewer file (floor/wall) and the scene the WebXR image viewer draws (image).
The canonical frame is glTF's (+Y up, meters), so node transforms are copied as they are. Each visible scene node becomes
a wrapper node named by its scene id (with `extras.arCreator.nodeId`), so the WebXR viewer can find objects for taps and
show/hide; image objects and models are merged in losslessly under it; built-ins are generated. Hidden nodes (and their
children) are left out. Hotspots are empty wrappers: viewers that support taps draw their own marker.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .builtins import SHAPES, plane, panel_raster, srgb_hex_to_linear, text_raster, Geometry
from .gltf import GltfBuilder, read_glb, triangle_count
from .request import Node, SceneRequest

SCENE_COMPILER_VERSION = "scene-glb@0.1.0"
#: Scene Viewer refuses files over 15 MB (MAX_INPUT_BINARY_SIZE_EXCEEDED, developers.google.com/ar/develop/scene-viewer).
SCENE_VIEWER_MAX_BYTES = 15 * 1024 * 1024


class SceneCompileError(Exception):
    def __init__(self, message: str, code: str = "compile_failed"):
        super().__init__(message)
        self.code = code


@dataclass
class GlbResult:
    sha256: str
    size_bytes: int
    triangles: int
    node_ids: list[str]
    extensions_used: list[str]
    warnings: list[str] = field(default_factory=list)
    compiler_version: str = SCENE_COMPILER_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "sizeBytes": self.size_bytes,
            "triangles": self.triangles,
            "nodeIds": self.node_ids,
            "extensionsUsed": self.extensions_used,
            "warnings": self.warnings,
            "compilerVersion": self.compiler_version,
        }


def _trs(n: Node) -> dict[str, Any]:
    t = n.transform
    out: dict[str, Any] = {}
    if any(t.position):
        out["translation"] = list(t.position)
    if tuple(t.rotation) != (0.0, 0.0, 0.0, 1.0):
        out["rotation"] = list(t.rotation)
    if tuple(t.scale) != (1.0, 1.0, 1.0):
        out["scale"] = list(t.scale)
    return out


def _mesh(b: GltfBuilder, g: Geometry, material: int, name: str) -> int:
    attrs = {
        "POSITION": b.add_floats(g.positions, "VEC3", with_bounds=True),
        "NORMAL": b.add_floats(g.normals, "VEC3"),
        "TEXCOORD_0": b.add_floats(g.uvs, "VEC2"),
    }
    return b.add("meshes", {"name": name, "primitives": [{"attributes": attrs, "indices": b.add_indices(g.indices), "material": material, "mode": 4}]})


def _picture_material(b: GltfBuilder, png: bytes, name: str) -> int:
    """Unlit, see-through picture (text, panels): drawn as authored, like the editor's MeshBasicMaterial."""
    sampler = b.add("samplers", {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071})
    texture = b.add("textures", {"sampler": sampler, "source": b.add_image(png, "image/png")})
    b.used.add("KHR_materials_unlit")
    return b.add(
        "materials",
        {
            "name": name,
            "pbrMetallicRoughness": {"baseColorTexture": {"index": texture}, "metallicFactor": 0.0, "roughnessFactor": 1.0},
            "alphaMode": "BLEND",
            "extensions": {"KHR_materials_unlit": {}},
        },
    )


def compose_glb(req: SceneRequest) -> tuple[bytes, GlbResult]:
    b = GltfBuilder(SCENE_COMPILER_VERSION)
    index: dict[str, int] = {}
    warnings: list[str] = []
    parsed: dict[str, tuple[dict, bytes]] = {}

    for n in req.visible_nodes():
        wrapper: dict[str, Any] = {"name": n.id, **_trs(n), "extras": {"arCreator": {"nodeId": n.id, "kind": n.kind}}}
        children: list[int] = []
        if n.kind in ("image-object", "model"):
            assert n.file is not None
            if n.file not in parsed:
                try:
                    parsed[n.file] = read_glb(req.files[n.file])
                except Exception as e:  # GltfError and malformed structures
                    raise SceneCompileError(f"node {n.id}: the file could not be read ({e})", "bad_file") from e
            doc, binary = parsed[n.file]
            try:
                children = b.merge(doc, binary)
            except (KeyError, IndexError, TypeError) as e:
                raise SceneCompileError(f"node {n.id}: the file is not valid glTF", "bad_file") from e
        elif n.kind == "primitive":
            shape = n.props["shape"]
            mat = b.add(
                "materials",
                {
                    "name": f"{n.id}-material",
                    "pbrMetallicRoughness": {"baseColorFactor": [*srgb_hex_to_linear(n.props["color"]), 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.75},
                    **({"doubleSided": True} if shape == "plane" else {}),
                },
            )
            children = [b.add("nodes", {"name": f"{n.id}-{shape}", "mesh": _mesh(b, SHAPES[shape](), mat, f"{n.id}-{shape}")})]
        elif n.kind in ("text", "panel"):
            r = text_raster(n.props["text"], n.props["color"], n.props["sizeMeters"]) if n.kind == "text" else panel_raster(n.props["title"], n.props["body"])
            mat = _picture_material(b, r.png, f"{n.id}-material")
            children = [b.add("nodes", {"name": f"{n.id}-{n.kind}", "mesh": _mesh(b, plane(r.width_m, r.height_m), mat, f"{n.id}-{n.kind}")})]
        if children:
            wrapper["children"] = children
        i = b.add("nodes", wrapper)
        index[n.id] = i
        parent = index.get(n.parent_id) if n.parent_id else None
        if parent is None:
            b.doc["scenes"][0]["nodes"].append(i)
        else:
            b.doc["nodes"][parent].setdefault("children", []).append(i)

    if not index:
        raise SceneCompileError("the scene has no visible objects", "empty_scene")
    if b.doc["animations"]:
        warnings.append("Scene Viewer plays only the first animation, in a loop.")
    glb = b.finish()
    if req.mode in ("floor", "wall") and len(glb) > SCENE_VIEWER_MAX_BYTES:
        raise SceneCompileError(f"the composed file is {len(glb) / 1048576:.1f} MB; Scene Viewer refuses files over 15 MB", "too_large")
    doc, _ = read_glb(glb)
    result = GlbResult(
        sha256=hashlib.sha256(glb).hexdigest(),
        size_bytes=len(glb),
        triangles=triangle_count(doc),
        node_ids=list(index),
        extensions_used=sorted(doc.get("extensionsUsed", [])),
        warnings=warnings,
    )
    return glb, result
