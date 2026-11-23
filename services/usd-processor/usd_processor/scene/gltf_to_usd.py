"""glTF 2.0 → USD for Quick Look (Phase 5 M15, ADR-033): static meshes with PBR materials.

Carried over: the node hierarchy (TRS or matrix), triangle meshes (also strips and fans), normals, the first UV set,
materials as UsdPreviewSurface (base colour factor/texture with alpha, metallic-roughness factor/texture, normal map,
occlusion, emissive), alpha modes (OPAQUE / MASK with cutoff / BLEND), double-sidedness and KHR_materials_unlit (as
emissive). Reported, not carried over: animations, skins (rest pose), morph targets, vertex colours, extra UV sets,
texture transforms, non-PNG/JPEG textures. Compressed meshes (Draco, meshopt) cannot be read and are refused.
Both formats are right-handed, +Y up, meters (the stage is authored so), so coordinates are copied as they are.
"""

from __future__ import annotations

import base64
import re
import sys
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, Vt

assert sys.byteorder == "little"  # glTF buffers are little-endian; array() uses the host order

COMP = {5120: ("b", 1, 127.0), 5121: ("B", 1, 255.0), 5122: ("h", 2, 32767.0), 5123: ("H", 2, 65535.0), 5125: ("I", 4, None), 5126: ("f", 4, None)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
WRAP = {10497: "repeat", 33071: "clamp", 33648: "mirror"}
UNREADABLE = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization"}


class UsdConvertError(Exception):
    def __init__(self, message: str, code: str = "unsupported_model"):
        super().__init__(message)
        self.code = code


def usd_name(raw: str, taken: set[str]) -> str:
    """A valid, unique USD prim name ([A-Za-z_][A-Za-z0-9_]*) derived from `raw`."""
    base = re.sub(r"[^A-Za-z0-9_]", "_", raw or "node")[:48] or "node"
    if not re.match(r"[A-Za-z_]", base[0]):
        base = "n_" + base
    name, i = base, 1
    while name in taken:
        i += 1
        name = f"{base}_{i}"
    taken.add(name)
    return name


@dataclass
class Source:
    """One parsed glTF file plus the texture files it contributes to the package."""

    doc: dict[str, Any]
    bin: bytes
    prefix: str
    textures: dict[str, bytes] = field(default_factory=dict)  # package path -> bytes
    warnings: set[str] = field(default_factory=set)

    def view_bytes(self, index: int) -> bytes:
        v = self.doc["bufferViews"][index]
        b = self.doc["buffers"][v["buffer"]]
        raw = base64.b64decode(b["uri"].split(";base64,", 1)[1]) if "uri" in b else self.bin
        start = v.get("byteOffset", 0)
        return raw[start : start + v["byteLength"]]

    def accessor(self, index: int, as_float: bool = False) -> tuple[array, int]:
        a = self.doc["accessors"][index]
        fmt, size, norm = COMP[a["componentType"]]
        n = NCOMP[a["type"]]
        count = a["count"]
        if "bufferView" in a:
            data = self.view_bytes(a["bufferView"])
            stride = self.doc["bufferViews"][a["bufferView"]].get("byteStride") or size * n
            off = a.get("byteOffset", 0)
            if stride == size * n:
                out = array(fmt, data[off : off + count * stride])
            else:
                out = array(fmt)
                for i in range(count):
                    s = off + i * stride
                    out.frombytes(data[s : s + size * n])
        else:
            out = array(fmt, [0]) * (count * n)
        sp = a.get("sparse")
        if sp:
            ia = sp["indices"]
            ifmt, isz, _ = COMP[ia["componentType"]]
            idx = array(ifmt, self.view_bytes(ia["bufferView"])[ia.get("byteOffset", 0) : ia.get("byteOffset", 0) + sp["count"] * isz])
            vals = array(fmt, self.view_bytes(sp["values"]["bufferView"])[sp["values"].get("byteOffset", 0) : sp["values"].get("byteOffset", 0) + sp["count"] * size * n])
            for k, i in enumerate(idx):
                out[i * n : (i + 1) * n] = vals[k * n : (k + 1) * n]
        if as_float and fmt != "f":
            div = norm if a.get("normalized") and norm else 1.0
            out = array("f", (v / div for v in out))
        return out, n

    def image_file(self, image_index: int) -> Optional[str]:
        im = self.doc["images"][image_index]
        if "bufferView" in im:
            data = self.view_bytes(im["bufferView"])
        elif str(im.get("uri", "")).startswith("data:"):
            data = base64.b64decode(im["uri"].split(";base64,", 1)[1])
        else:
            self.warnings.add("A texture refers to an external file and was left out.")
            return None
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ext = "png"
        elif data[:2] == b"\xff\xd8":
            ext = "jpg"
        else:
            self.warnings.add("A texture is not PNG or JPEG (Quick Look cannot show it) and was left out.")
            return None
        path = f"textures/{self.prefix}_{image_index}.{ext}"
        self.textures[path] = data
        return path


def _vec(arr: array, n: int, kind: Callable):
    mv = memoryview(arr).cast("B").cast("f", (len(arr) // n, n)) if n > 1 else memoryview(arr)
    return kind.FromBuffer(mv)


class MaterialBuilder:
    def __init__(self, stage: Usd.Stage, scope: Sdf.Path, src: Source):
        self.stage, self.scope, self.src = stage, scope, src
        self.cache: dict[int, UsdShade.Material] = {}
        self.default: Optional[UsdShade.Material] = None

    def get(self, index: Optional[int]) -> UsdShade.Material:
        if index is None:
            if self.default is None:  # glTF default material: white, metallic 1, roughness 1
                self.default = self._build("default_material", {})
            return self.default
        if index not in self.cache:
            self.cache[index] = self._build(f"material_{index}", self.src.doc["materials"][index])
        return self.cache[index]

    def _texture(self, path: Sdf.Path, info: dict, linear: bool, scale: Optional[tuple] = None, bias: Optional[tuple] = None) -> Optional[UsdShade.Shader]:
        t = self.src.doc["textures"][info["index"]]
        src_index = t.get("source")
        if src_index is None:
            self.src.warnings.add("A texture in a format Quick Look cannot show was left out.")
            return None
        file = self.src.image_file(src_index)
        if file is None:
            return None
        if info.get("texCoord", 0) != 0:
            self.src.warnings.add("Textures using a second UV set are shown with the first one.")
        if "KHR_texture_transform" in info.get("extensions", {}):
            self.src.warnings.add("Texture transforms (KHR_texture_transform) are not carried over to iPhone.")
        sh = UsdShade.Shader.Define(self.stage, path)
        sh.CreateIdAttr("UsdUVTexture")
        sh.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file))
        sh.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("raw" if linear else "sRGB")
        sampler = self.src.doc.get("samplers", [])[t["sampler"]] if "sampler" in t else {}
        sh.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set(WRAP.get(sampler.get("wrapS", 10497), "repeat"))
        sh.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set(WRAP.get(sampler.get("wrapT", 10497), "repeat"))
        if scale is not None:
            sh.CreateInput("scale", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*scale))
        if bias is not None:
            sh.CreateInput("bias", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*bias))
        sh.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(self.st.ConnectableAPI(), "result")
        return sh

    def _build(self, name: str, m: dict) -> UsdShade.Material:
        path = self.scope.AppendChild(name)
        mat = UsdShade.Material.Define(self.stage, path)
        surf = UsdShade.Shader.Define(self.stage, path.AppendChild("PreviewSurface"))
        surf.CreateIdAttr("UsdPreviewSurface")
        self.st = UsdShade.Shader.Define(self.stage, path.AppendChild("StReader"))
        self.st.CreateIdAttr("UsdPrimvarReader_float2")
        self.st.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
        pbr = m.get("pbrMetallicRoughness", {})
        base = pbr.get("baseColorFactor", [1.0, 1.0, 1.0, 1.0])
        mode = m.get("alphaMode", "OPAQUE")
        unlit = "KHR_materials_unlit" in m.get("extensions", {})
        base_tex = self._texture(path.AppendChild("BaseColor"), pbr["baseColorTexture"], False, tuple(base)) if "baseColorTexture" in pbr else None

        colour_input = "emissiveColor" if unlit else "diffuseColor"
        if base_tex:
            surf.CreateInput(colour_input, Sdf.ValueTypeNames.Color3f).ConnectToSource(base_tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3))
        else:
            surf.CreateInput(colour_input, Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*base[:3]))
        if unlit:  # Quick Look has no unlit model: black diffuse + emissive picture shows it as authored
            surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0, 0, 0))
            surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
            surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(1.0)
        if mode != "OPAQUE":
            if base_tex:
                surf.CreateInput("opacity", Sdf.ValueTypeNames.Float).ConnectToSource(base_tex.CreateOutput("a", Sdf.ValueTypeNames.Float))
            else:
                surf.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(float(base[3]))
            surf.CreateInput("opacityThreshold", Sdf.ValueTypeNames.Float).Set(float(m.get("alphaCutoff", 0.5)) if mode == "MASK" else 0.0)

        if not unlit:
            metallic, roughness = float(pbr.get("metallicFactor", 1.0)), float(pbr.get("roughnessFactor", 1.0))
            mr = self._texture(path.AppendChild("MetallicRoughness"), pbr["metallicRoughnessTexture"], True, (1.0, roughness, metallic, 1.0)) if "metallicRoughnessTexture" in pbr else None
            if mr:
                surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).ConnectToSource(mr.CreateOutput("g", Sdf.ValueTypeNames.Float))
                surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).ConnectToSource(mr.CreateOutput("b", Sdf.ValueTypeNames.Float))
            else:
                surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(roughness)
                surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(metallic)
            if "normalTexture" in m:
                s = float(m["normalTexture"].get("scale", 1.0))
                nt = self._texture(path.AppendChild("Normal"), m["normalTexture"], True, (2.0 * s, 2.0 * s, 2.0, 1.0), (-s, -s, -1.0, 0.0))
                if nt:
                    surf.CreateInput("normal", Sdf.ValueTypeNames.Normal3f).ConnectToSource(nt.CreateOutput("rgb", Sdf.ValueTypeNames.Float3))
            if "occlusionTexture" in m:
                ot = self._texture(path.AppendChild("Occlusion"), m["occlusionTexture"], True)
                if ot:
                    surf.CreateInput("occlusion", Sdf.ValueTypeNames.Float).ConnectToSource(ot.CreateOutput("r", Sdf.ValueTypeNames.Float))
            emissive = m.get("emissiveFactor", [0.0, 0.0, 0.0])
            if "emissiveTexture" in m:
                et = self._texture(path.AppendChild("Emissive"), m["emissiveTexture"], False, (*emissive, 1.0))
                if et:
                    surf.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(et.CreateOutput("rgb", Sdf.ValueTypeNames.Float3))
            elif any(emissive):
                surf.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emissive))
        for ext in m.get("extensions", {}):
            if ext != "KHR_materials_unlit":
                self.src.warnings.add(f"Material extension {ext} is not carried over to iPhone.")
        mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")
        return mat


def _triangles(mode: int, idx: list[int]) -> Optional[list[int]]:
    if mode == 4:
        return idx[: len(idx) - len(idx) % 3]
    if mode == 5:  # strip
        out = []
        for i in range(len(idx) - 2):
            a, b, c = idx[i], idx[i + 1], idx[i + 2]
            out += [a, b, c] if i % 2 == 0 else [b, a, c]
        return out
    if mode == 6:  # fan
        return [v for i in range(1, len(idx) - 1) for v in (idx[0], idx[i], idx[i + 1])]
    return None


def _mesh(stage: Usd.Stage, path: Sdf.Path, src: Source, prim: dict, mats: MaterialBuilder) -> Optional[UsdGeom.Mesh]:
    attrs = prim.get("attributes", {})
    if "POSITION" not in attrs:
        return None
    pos, _ = src.accessor(attrs["POSITION"], as_float=True)
    count = len(pos) // 3
    if "indices" in prim:
        ia, _ = src.accessor(prim["indices"])
        idx = list(ia)
    else:
        idx = list(range(count))
    tris = _triangles(prim.get("mode", 4), idx)
    if tris is None:
        src.warnings.add("Points and lines are not shown on iPhone.")
        return None
    if not tris:
        return None
    if any(i >= count for i in tris):
        raise UsdConvertError("a mesh refers to a vertex that does not exist", "bad_file")
    mesh = UsdGeom.Mesh.Define(stage, path)
    mesh.CreatePointsAttr(_vec(pos, 3, Vt.Vec3fArray))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray.FromBuffer(memoryview(array("i", [3]) * (len(tris) // 3))))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromBuffer(memoryview(array("i", tris))))
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateOrientationAttr(UsdGeom.Tokens.rightHanded)
    if "NORMAL" in attrs:
        nrm, _ = src.accessor(attrs["NORMAL"], as_float=True)
        mesh.CreateNormalsAttr(_vec(nrm, 3, Vt.Vec3fArray))
        mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    if "TEXCOORD_0" in attrs:
        uv, _ = src.accessor(attrs["TEXCOORD_0"], as_float=True)
        for i in range(1, len(uv), 2):
            uv[i] = 1.0 - uv[i]  # glTF v runs down, USD t runs up
        st = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
        st.Set(_vec(uv, 2, Vt.Vec2fArray))
    if "TEXCOORD_1" in attrs:
        src.warnings.add("Only the first UV set is carried over to iPhone.")
    if "COLOR_0" in attrs:
        src.warnings.add("Vertex colours are not carried over to iPhone.")
    if prim.get("targets"):
        src.warnings.add("Morph targets (blend shapes) are not carried over to iPhone.")
    material_index = prim.get("material")
    material = src.doc["materials"][material_index] if material_index is not None else {}
    mesh.CreateDoubleSidedAttr(bool(material.get("doubleSided", False)))
    mesh.CreateExtentAttr(UsdGeom.PointBased.ComputeExtent(mesh.GetPointsAttr().Get()))
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mats.get(material_index))
    return mesh


def _xform(x: UsdGeom.Xformable, node: dict) -> None:
    if "matrix" in node:
        # glTF column-major == USD row-major with row vectors: the 16 numbers copy straight across.
        x.AddTransformOp().Set(Gf.Matrix4d(*node["matrix"]))
        return
    t = node.get("translation")
    r = node.get("rotation")
    s = node.get("scale")
    if t and any(t):
        x.AddTranslateOp().Set(Gf.Vec3d(*t))
    if r and list(r) != [0, 0, 0, 1]:
        x.AddOrientOp().Set(Gf.Quatf(float(r[3]), Gf.Vec3f(*r[:3])))
    if s and list(s) != [1, 1, 1]:
        x.AddScaleOp().Set(Gf.Vec3f(*s))


def convert_gltf(stage: Usd.Stage, parent: Sdf.Path, doc: dict[str, Any], binary: bytes, prefix: str) -> Source:
    """Writes the file's default scene under `parent` (its own Materials scope). Returns the Source (textures, warnings)."""
    src = Source(doc, binary, prefix)
    unreadable = UNREADABLE & set(doc.get("extensionsRequired", []))
    if unreadable:
        raise UsdConvertError(f"compressed meshes ({', '.join(sorted(unreadable))}) cannot be converted for iPhone yet")
    if doc.get("animations"):
        src.warnings.add("Animations are not carried over to iPhone yet.")
    if doc.get("skins"):
        src.warnings.add("Skinned models are shown in their rest pose on iPhone.")
    mats = MaterialBuilder(stage, parent.AppendChild("Materials"), src)
    taken = {"Materials"}

    def visit(index: int, path: Sdf.Path, stack: tuple[int, ...]) -> None:
        if index in stack:
            raise UsdConvertError("the node hierarchy has a cycle", "bad_file")
        node = doc["nodes"][index]
        x = UsdGeom.Xform.Define(stage, path)
        _xform(x, node)
        names: set[str] = set()
        if "mesh" in node:
            for k, prim in enumerate(doc["meshes"][node["mesh"]].get("primitives", [])):
                _mesh(stage, path.AppendChild(usd_name(f"mesh_{k}", names)), src, prim, mats)
        for c in node.get("children", []):
            visit(c, path.AppendChild(usd_name(doc["nodes"][c].get("name", f"node_{c}"), names)), stack + (index,))

    scenes = doc.get("scenes", [])
    if scenes:
        roots = scenes[doc.get("scene", 0)].get("nodes", [])
    else:
        children = {c for n in doc.get("nodes", []) for c in n.get("children", [])}
        roots = [i for i in range(len(doc.get("nodes", []))) if i not in children]
    for r in roots:
        visit(r, parent.AppendChild(usd_name(doc["nodes"][r].get("name", f"node_{r}"), taken)), ())
    return src
