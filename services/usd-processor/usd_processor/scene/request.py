"""Scene compile request (Phase 5 M14, ADR-032).

Body: u32be(len(manifest)) + manifest JSON (UTF-8) + payload. The manifest lists the scene nodes (canonical units: meters,
quaternion [x, y, z, w]) and the files they need, each by offset/length into the payload and its SHA-256. The Worker
builds it from the validated draft; everything is checked again here (the container trusts nothing).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from dataclasses import dataclass, field
from typing import Any, Optional

ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
KINDS = {"group", "model", "image-object", "text", "panel", "primitive", "hotspot"}
SHAPES = {"box", "sphere", "cylinder", "plane"}
FILE_KINDS = {"image-object": "model/gltf-binary", "model": "model/gltf-binary"}
MAX_NODES = 500
MAX_FILES = 100


class SceneRequestError(Exception):
    def __init__(self, message: str, code: str = "bad_scene"):
        super().__init__(message)
        self.code = code


@dataclass
class Transform:
    position: tuple[float, float, float]
    rotation: tuple[float, float, float, float]
    scale: tuple[float, float, float]


@dataclass
class Node:
    id: str
    kind: str
    transform: Transform
    visible: bool = True
    parent_id: Optional[str] = None
    file: Optional[str] = None
    props: dict[str, Any] = field(default_factory=dict)


@dataclass
class SceneRequest:
    mode: str
    nodes: list[Node]
    files: dict[str, bytes]
    tracking_width_m: Optional[float] = None
    tracking_file: Optional[str] = None

    def visible_nodes(self) -> list[Node]:
        """Nodes drawn in AR, parents before children; a hidden node hides its descendants."""
        by_id = {n.id: n for n in self.nodes}
        out: list[Node] = []

        def shown(n: Node) -> bool:
            seen = set()
            while n:
                if n.id in seen:
                    return False
                seen.add(n.id)
                if not n.visible:
                    return False
                n = by_id.get(n.parent_id) if n.parent_id else None  # type: ignore[assignment]
            return True

        done: set[str] = set()

        def visit(parent: Optional[str]) -> None:
            for n in self.nodes:
                if n.parent_id == parent and n.id not in done and shown(n):
                    done.add(n.id)
                    out.append(n)
                    visit(n.id)

        visit(None)
        return out


def _num(v: Any, what: str) -> float:
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        raise SceneRequestError(f"{what} must be a finite number")
    return float(v)


def _vec(v: Any, n: int, what: str) -> tuple:
    if not isinstance(v, list) or len(v) != n:
        raise SceneRequestError(f"{what} must have {n} numbers")
    return tuple(_num(x, what) for x in v)


def _transform(t: Any) -> Transform:
    if not isinstance(t, dict):
        raise SceneRequestError("transform missing")
    pos = _vec(t.get("position"), 3, "position")
    rot = _vec(t.get("rotation"), 4, "rotation")
    if abs(math.sqrt(sum(c * c for c in rot)) - 1) > 1e-4:
        raise SceneRequestError("rotation quaternion must be normalized")
    scale = _vec(t.get("scale"), 3, "scale")
    if any(s <= 0 for s in scale):
        raise SceneRequestError("scale components must be > 0")
    return Transform(pos, rot, scale)  # type: ignore[arg-type]


def _str(v: Any, what: str, max_len: int, allow_empty: bool = True) -> str:
    if not isinstance(v, str) or len(v) > max_len or (not allow_empty and not v.strip()):
        raise SceneRequestError(f"{what} is invalid")
    return v


def parse_scene_request(body: bytes) -> SceneRequest:
    if len(body) < 4:
        raise SceneRequestError("empty request")
    (mlen,) = struct.unpack_from(">I", body, 0)
    if 4 + mlen > len(body):
        raise SceneRequestError("manifest length exceeds the body")
    try:
        m = json.loads(body[4 : 4 + mlen].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise SceneRequestError("manifest is not valid JSON") from e
    payload = memoryview(body)[4 + mlen :]
    if not isinstance(m, dict) or m.get("version") != 1:
        raise SceneRequestError("unsupported manifest version")

    files_in = m.get("files", {})
    if not isinstance(files_in, dict) or len(files_in) > MAX_FILES:
        raise SceneRequestError("files must be an object with at most 100 entries")
    files: dict[str, bytes] = {}
    for fid, f in files_in.items():
        if not ID.match(fid) or not isinstance(f, dict):
            raise SceneRequestError("bad file entry")
        off, ln = f.get("offset"), f.get("length")
        if not isinstance(off, int) or not isinstance(ln, int) or off < 0 or ln < 0 or off + ln > len(payload):
            raise SceneRequestError(f"file {fid} lies outside the payload")
        data = bytes(payload[off : off + ln])
        if hashlib.sha256(data).hexdigest() != f.get("sha256"):
            raise SceneRequestError(f"file {fid} does not match its checksum", "checksum_mismatch")
        files[fid] = data

    p = m.get("placement")
    if not isinstance(p, dict) or p.get("mode") not in ("image", "floor", "wall"):
        raise SceneRequestError("placement mode must be image, floor or wall")
    tracking_width = tracking_file = None
    if p["mode"] == "image":
        tracking_width = _num(p.get("trackingWidthMeters"), "trackingWidthMeters")
        if not 0.03 <= tracking_width <= 5:
            raise SceneRequestError("trackingWidthMeters out of range")
        tracking_file = p.get("trackingFile")
        if tracking_file is not None and tracking_file not in files:
            raise SceneRequestError("trackingFile is not in files")

    raw_nodes = m.get("nodes")
    if not isinstance(raw_nodes, list) or len(raw_nodes) > MAX_NODES:
        raise SceneRequestError("nodes must be a list of at most 500")
    nodes: list[Node] = []
    ids: set[str] = set()
    for r in raw_nodes:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not ID.match(r["id"]) or r["id"] in ids:
            raise SceneRequestError("node ids must be unique and url-safe")
        if r.get("kind") not in KINDS:
            raise SceneRequestError(f"unknown node kind {r.get('kind')!r}")
        ids.add(r["id"])
        n = Node(id=r["id"], kind=r["kind"], transform=_transform(r.get("transform")), visible=r.get("visible", True) is not False, parent_id=r.get("parentId"))
        if n.kind in FILE_KINDS:
            if r.get("file") not in files:
                raise SceneRequestError(f"node {n.id} needs a file")
            n.file = r["file"]
        elif n.kind == "text":
            style = r.get("style") or {}
            n.props = {"text": _str(r.get("text"), "text", 500, allow_empty=False), "color": style.get("color"), "sizeMeters": _num(style.get("sizeMeters"), "sizeMeters")}
            if not HEX.match(str(n.props["color"])) or not 0 < n.props["sizeMeters"] <= 2:
                raise SceneRequestError("text style is invalid")
        elif n.kind == "panel":
            n.props = {"title": _str(r.get("title", ""), "title", 120), "body": _str(r.get("body", ""), "body", 2000)}
        elif n.kind == "primitive":
            if r.get("shape") not in SHAPES:
                raise SceneRequestError("unknown shape")
            color = r.get("color", "#9aa5b1")
            if not HEX.match(str(color)):
                raise SceneRequestError("shape colour is invalid")
            n.props = {"shape": r["shape"], "color": color}
        nodes.append(n)
    for n in nodes:
        if n.parent_id is not None and n.parent_id not in ids:
            raise SceneRequestError(f"node {n.id} has an unknown parent")
    # Cycles
    by_id = {n.id: n for n in nodes}
    for n in nodes:
        seen: set[str] = set()
        cur: Optional[Node] = n
        while cur and cur.parent_id:
            if cur.id in seen:
                raise SceneRequestError("parent cycle")
            seen.add(cur.id)
            cur = by_id.get(cur.parent_id)
    return SceneRequest(mode=p["mode"], nodes=nodes, files=files, tracking_width_m=tracking_width, tracking_file=tracking_file)


def build_scene_body(manifest: dict[str, Any], files: dict[str, bytes]) -> bytes:
    """Test helper (and documentation of the format): frame a manifest and its files."""
    payload = b""
    entries = {}
    for fid, data in files.items():
        entries[fid] = {"offset": len(payload), "length": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        payload += data
    m = dict(manifest, files=entries)
    j = json.dumps(m).encode("utf-8")
    return struct.pack(">I", len(j)) + j + payload
