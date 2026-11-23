"""Minimal, dependency-free glTF 2.0 binary (GLB) reader, writer and lossless merger (Phase 5 M14, ADR-032).

The merger copies a source GLB into the document being built: every buffer view, accessor, image, sampler, texture,
material, mesh, skin, node and animation, re-indexing all references. Cameras and punctual lights are dropped (AR
viewers supply their own). Only self-contained files are accepted: the GLB binary chunk or data: URIs.
"""

from __future__ import annotations

import base64
import copy
import json
import struct
from typing import Any

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
DROPPED_EXTENSIONS = {"KHR_lights_punctual"}


class GltfError(Exception):
    pass


def read_glb(data: bytes) -> tuple[dict[str, Any], bytes]:
    if len(data) < 20:
        raise GltfError("file too short for GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2:
        raise GltfError("not a glTF 2.0 binary file")
    if length != len(data):
        raise GltfError("GLB length does not match the file size")
    off = 12
    doc: dict[str, Any] | None = None
    bin_chunk = b""
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        if off + clen > len(data):
            raise GltfError("GLB chunk exceeds the file")
        chunk = data[off : off + clen]
        off += clen
        if ctype == CHUNK_JSON and doc is None:
            try:
                doc = json.loads(chunk.decode("utf-8").rstrip(" \x00"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise GltfError("GLB JSON chunk is not valid JSON") from e
        elif ctype == CHUNK_BIN and not bin_chunk:
            bin_chunk = bytes(chunk)
    if not isinstance(doc, dict) or doc.get("asset", {}).get("version") != "2.0":
        raise GltfError("missing glTF 2.0 JSON")
    return doc, bin_chunk


def write_glb(doc: dict[str, Any], binary: bytes) -> bytes:
    j = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bytes(binary) + b"\x00" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    out = struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(j), CHUNK_JSON) + j
    if b:
        out += struct.pack("<II", len(b), CHUNK_BIN) + b
    return out


def _data_uri(uri: str) -> bytes:
    if not uri.startswith("data:") or ";base64," not in uri:
        raise GltfError("only self-contained files are supported (external file references found)")
    return base64.b64decode(uri.split(";base64,", 1)[1], validate=True)


def triangle_count(doc: dict[str, Any]) -> int:
    n = 0
    acc = doc.get("accessors", [])
    for mesh in doc.get("meshes", []):
        for p in mesh.get("primitives", []):
            if p.get("mode", 4) != 4:
                continue
            if "indices" in p:
                n += acc[p["indices"]]["count"] // 3
            elif "POSITION" in p.get("attributes", {}):
                n += acc[p["attributes"]["POSITION"]]["count"] // 3
    return n


class GltfBuilder:
    """Builds one glTF document with a single binary buffer."""

    def __init__(self, generator: str):
        self.doc: dict[str, Any] = {"asset": {"version": "2.0", "generator": generator}, "scene": 0, "scenes": [{"nodes": []}]}
        for k in ("nodes", "meshes", "materials", "textures", "images", "samplers", "accessors", "bufferViews", "skins", "animations"):
            self.doc[k] = []
        self.bin = bytearray()
        self.used: set[str] = set()
        self.required: set[str] = set()

    # ---- low level
    def add_view(self, data: bytes, target: int | None = None, stride: int | None = None) -> int:
        self.bin += b"\x00" * ((4 - len(self.bin) % 4) % 4)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        if stride is not None:
            view["byteStride"] = stride
        self.bin += data
        self.doc["bufferViews"].append(view)
        return len(self.doc["bufferViews"]) - 1

    def add(self, kind: str, item: dict[str, Any]) -> int:
        self.doc[kind].append(item)
        return len(self.doc[kind]) - 1

    def add_floats(self, values: list[float], type_: str, target: int = ARRAY_BUFFER, with_bounds: bool = False) -> int:
        comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[type_]
        view = self.add_view(struct.pack(f"<{len(values)}f", *values), target)
        acc: dict[str, Any] = {"bufferView": view, "componentType": 5126, "count": len(values) // comps, "type": type_}
        if with_bounds:
            cols = [values[i::comps] for i in range(comps)]
            acc["min"] = [min(c) for c in cols]
            acc["max"] = [max(c) for c in cols]
        return self.add("accessors", acc)

    def add_indices(self, indices: list[int]) -> int:
        big = max(indices, default=0) > 65535
        data = struct.pack(f"<{len(indices)}{'I' if big else 'H'}", *indices)
        view = self.add_view(data, ELEMENT_ARRAY_BUFFER)
        return self.add("accessors", {"bufferView": view, "componentType": 5125 if big else 5123, "count": len(indices), "type": "SCALAR"})

    def add_image(self, data: bytes, mime: str) -> int:
        return self.add("images", {"bufferView": self.add_view(data), "mimeType": mime})

    # ---- merge
    def merge(self, src: dict[str, Any], src_bin: bytes) -> list[int]:
        """Copies `src` in; returns the indices of its (default) scene's root nodes in this document."""
        buffers: list[bytes] = []
        for i, b in enumerate(src.get("buffers", [])):
            if "uri" in b:
                buffers.append(_data_uri(b["uri"]))
            elif i == 0:
                buffers.append(src_bin)
            else:
                raise GltfError("buffer without data")
        off = {k: len(self.doc[k]) for k in ("nodes", "meshes", "materials", "textures", "images", "samplers", "accessors", "skins", "animations")}

        view_map: list[int] = []
        for v in src.get("bufferViews", []):
            raw = buffers[v["buffer"]]
            start = v.get("byteOffset", 0)
            end = start + v["byteLength"]
            if end > len(raw):
                raise GltfError("buffer view exceeds its buffer")
            view_map.append(self.add_view(raw[start:end], v.get("target"), v.get("byteStride")))

        def view(i: int) -> int:
            return view_map[i]

        for a in src.get("accessors", []):
            a = copy.deepcopy(a)
            if "bufferView" in a:
                a["bufferView"] = view(a["bufferView"])
            if "sparse" in a:
                a["sparse"]["indices"]["bufferView"] = view(a["sparse"]["indices"]["bufferView"])
                a["sparse"]["values"]["bufferView"] = view(a["sparse"]["values"]["bufferView"])
            self.doc["accessors"].append(a)
        for im in src.get("images", []):
            im = copy.deepcopy(im)
            if "uri" in im:
                data = _data_uri(im.pop("uri"))
                im["bufferView"] = self.add_view(data)
                if "mimeType" not in im:
                    im["mimeType"] = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
            else:
                im["bufferView"] = view(im["bufferView"])
            self.doc["images"].append(im)
        self.doc["samplers"].extend(copy.deepcopy(src.get("samplers", [])))
        for t in src.get("textures", []):
            t = copy.deepcopy(t)
            if "sampler" in t:
                t["sampler"] += off["samplers"]
            if "source" in t:
                t["source"] += off["images"]
            for ext in t.get("extensions", {}).values():
                if isinstance(ext, dict) and "source" in ext:
                    ext["source"] += off["images"]
            self.doc["textures"].append(t)
        for m in src.get("materials", []):
            m = copy.deepcopy(m)
            _shift_texture_refs(m, off["textures"])
            self.doc["materials"].append(m)
        for mesh in src.get("meshes", []):
            mesh = copy.deepcopy(mesh)
            for p in mesh.get("primitives", []):
                p["attributes"] = {k: v + off["accessors"] for k, v in p["attributes"].items()}
                if "indices" in p:
                    p["indices"] += off["accessors"]
                if "material" in p:
                    p["material"] += off["materials"]
                if "targets" in p:
                    p["targets"] = [{k: v + off["accessors"] for k, v in t.items()} for t in p["targets"]]
                draco = p.get("extensions", {}).get("KHR_draco_mesh_compression")
                if draco and "bufferView" in draco:
                    draco["bufferView"] = view(draco["bufferView"])
            self.doc["meshes"].append(mesh)
        for s in src.get("skins", []):
            s = copy.deepcopy(s)
            if "inverseBindMatrices" in s:
                s["inverseBindMatrices"] += off["accessors"]
            s["joints"] = [j + off["nodes"] for j in s["joints"]]
            if "skeleton" in s:
                s["skeleton"] += off["nodes"]
            self.doc["skins"].append(s)
        for n in src.get("nodes", []):
            n = copy.deepcopy(n)
            n.pop("camera", None)
            if "extensions" in n:
                for e in DROPPED_EXTENSIONS:
                    n["extensions"].pop(e, None)
                if not n["extensions"]:
                    del n["extensions"]
            if "children" in n:
                n["children"] = [c + off["nodes"] for c in n["children"]]
            if "mesh" in n:
                n["mesh"] += off["meshes"]
            if "skin" in n:
                n["skin"] += off["skins"]
            self.doc["nodes"].append(n)
        for an in src.get("animations", []):
            an = copy.deepcopy(an)
            for s in an.get("samplers", []):
                s["input"] += off["accessors"]
                s["output"] += off["accessors"]
            for c in an.get("channels", []):
                if "node" in c.get("target", {}):
                    c["target"]["node"] += off["nodes"]
            self.doc["animations"].append(an)
        self.used.update(e for e in src.get("extensionsUsed", []) if e not in DROPPED_EXTENSIONS)
        self.required.update(e for e in src.get("extensionsRequired", []) if e not in DROPPED_EXTENSIONS)

        scenes = src.get("scenes", [])
        if scenes:
            roots = scenes[src.get("scene", 0)].get("nodes", [])
        else:
            children = {c for n in src.get("nodes", []) for c in n.get("children", [])}
            roots = [i for i in range(len(src.get("nodes", []))) if i not in children]
        return [r + off["nodes"] for r in roots]

    def finish(self) -> bytes:
        doc = {k: v for k, v in self.doc.items() if not (isinstance(v, list) and not v)}
        if self.used:
            doc["extensionsUsed"] = sorted(self.used)
        if self.required:
            doc["extensionsRequired"] = sorted(self.required)
        if self.bin:
            doc["buffers"] = [{"byteLength": len(self.bin) + (4 - len(self.bin) % 4) % 4}]
        return write_glb(doc, bytes(self.bin))


def _shift_texture_refs(obj: Any, offset: int) -> None:
    """Texture references are textureInfo objects ({"index": n, ...}) under keys ending in "Texture"."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, dict) and k.lower().endswith("texture") and isinstance(v.get("index"), int):
                v["index"] += offset
            _shift_texture_refs(v, offset)
    elif isinstance(obj, list):
        for v in obj:
            _shift_texture_refs(v, offset)
