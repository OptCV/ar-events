"""HTTP front for the converter, run inside the Cloudflare Container (ADR-023).

    python -m usd_processor serve --port 8080

The Worker is the only client: it streams the source image from R2 in the request body and stores the result
itself, so this process needs no network access, credentials or storage (the Container runs with internet
access disabled). One request at a time; every job works in a fresh temporary directory that is removed after.

    GET  /healthz                       -> 200 {"ok": true, "converterVersion": ..., "usd": ...}
    POST /v1/texture?max_edge=2048        body: PNG/JPEG/WebP -> framed JSON + prepared PNG or JPEG (ADR-025)
    POST /v1/scene/glb                    body: scene request (scene/request.py) -> framed JSON + composed GLB (ADR-032)
    POST /v1/image-plane?width_m=0.5&alpha_mode=BLEND&alpha_cutoff=0.5&double_sided=0&pivot=center&orientation=upright
         body: image bytes (PNG/JPEG, Content-Length required, <= MAX_BODY)
         header X-Source-SHA256 (optional): refuse if the body does not hash to it
      200 application/vnd.ar-creator.conversion  body = u32be(len(json)) + json + usdz
      400 bad parameters · 411 no length · 413 too large · 422 conversion/validation failure · 500 unexpected

Errors are JSON {"ok": false, "code": ..., "error": ...}. Messages never include file paths from the host.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from pxr import Usd

from .image_plane import CONVERTER_VERSION, ConversionError, ImagePlaneRequest, build_image_plane_usdz
from .texture import TEXTURE_CONVERTER_VERSION, TextureError, prepare_texture
from .scene.compose_glb import SCENE_COMPILER_VERSION, SceneCompileError, compose_glb
from .scene.request import SceneRequestError, parse_scene_request

MAX_BODY = 32 * 1024 * 1024
#: A scene request carries every model and image-object file it uses (models up to 25 MB each).
MAX_SCENE_BODY = 64 * 1024 * 1024
FRAME_TYPE = "application/vnd.ar-creator.conversion"


class BadRequest(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def _one(q: dict[str, list[str]], name: str, default: str | None = None) -> str:
    v = q.get(name)
    if v is None:
        if default is None:
            raise BadRequest(400, "bad_parameter", f"missing parameter {name}")
        return default
    if len(v) != 1:
        raise BadRequest(400, "bad_parameter", f"parameter {name} given more than once")
    return v[0]


def _float(q: dict[str, list[str]], name: str, default: str | None = None) -> float:
    raw = _one(q, name, default)
    try:
        f = float(raw)
    except ValueError:
        raise BadRequest(400, "bad_parameter", f"parameter {name} is not a number") from None
    if f != f or f in (float("inf"), float("-inf")):
        raise BadRequest(400, "bad_parameter", f"parameter {name} is not finite")
    return f


def _choice(q: dict[str, list[str]], name: str, allowed: tuple[str, ...], default: str | None = None) -> str:
    v = _one(q, name, default)
    if v not in allowed:
        raise BadRequest(400, "bad_parameter", f"parameter {name} must be one of {', '.join(allowed)}")
    return v


def parse_image_plane_query(query: str) -> dict:
    q = parse_qs(query, keep_blank_values=True, strict_parsing=False)
    known = {"width_m", "alpha_mode", "alpha_cutoff", "double_sided", "pivot", "orientation"}
    unknown = sorted(set(q) - known)
    if unknown:
        raise BadRequest(400, "bad_parameter", f"unknown parameter {unknown[0]}")
    return {
        "width_m": _float(q, "width_m"),
        "alpha_mode": _choice(q, "alpha_mode", ("OPAQUE", "MASK", "BLEND")),
        "alpha_cutoff": _float(q, "alpha_cutoff", "0.5"),
        "double_sided": _choice(q, "double_sided", ("0", "1"), "0") == "1",
        "pivot": _choice(q, "pivot", ("center", "bottom-center"), "center"),
        "orientation": _choice(q, "orientation", ("upright", "flat"), "upright"),
    }


def parse_texture_query(query: str) -> dict:
    q = parse_qs(query, keep_blank_values=True, strict_parsing=False)
    unknown = sorted(set(q) - {"max_edge"})
    if unknown:
        raise BadRequest(400, "bad_parameter", f"unknown parameter {unknown[0]}")
    raw = _one(q, "max_edge")
    if not raw.isdigit():
        raise BadRequest(400, "bad_parameter", "parameter max_edge must be a whole number")
    return {"max_edge": int(raw)}


def convert(body: bytes, params: dict) -> tuple[dict, bytes]:
    """Run one conversion in a fresh temp dir. Returns (result json, usdz bytes); raises ConversionError."""
    with tempfile.TemporaryDirectory(prefix="req-") as tmp_s:
        tmp = Path(tmp_s)
        src = tmp / "source.bin"  # generated name; the uploaded filename never reaches this process
        src.write_bytes(body)
        out = tmp / "image-object.usdz"
        res = build_image_plane_usdz(ImagePlaneRequest(image=src, out_usdz=out, **params))
        usdz = out.read_bytes()
        d = res.to_dict()
        d.pop("usdz", None)  # temp path, meaningless to the caller
        d["ok"] = not res.validation_errors
        d["sizeBytes"] = len(usdz)
        return d, usdz


class Handler(BaseHTTPRequestHandler):
    server_version = "usd-processor"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        # One structured line per request on stderr (Container logs); never request bodies.
        sys.stderr.write(json.dumps({"event": "request", "line": format % args}) + "\n")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _frame(self, meta_obj: dict, payload: bytes) -> None:
        meta = json.dumps(meta_obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", FRAME_TYPE)
        self.send_header("Content-Length", str(4 + len(meta) + len(payload)))
        self.end_headers()
        self.wfile.write(struct.pack(">I", len(meta)) + meta + payload)

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path == "/healthz":
            self._json(200, {"ok": True, "converterVersion": CONVERTER_VERSION, "textureVersion": TEXTURE_CONVERTER_VERSION, "sceneVersion": SCENE_COMPILER_VERSION, "usd": ".".join(map(str, Usd.GetVersion()))})
        else:
            self._json(404, {"ok": False, "code": "not_found", "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        try:
            if url.path not in ("/v1/image-plane", "/v1/texture", "/v1/scene/glb"):
                raise BadRequest(404, "not_found", "not found")
            if url.path == "/v1/scene/glb":
                if url.query:
                    raise BadRequest(400, "bad_parameter", "this endpoint takes no parameters")
                params = {}
            else:
                params = parse_image_plane_query(url.query) if url.path == "/v1/image-plane" else parse_texture_query(url.query)
            limit = MAX_SCENE_BODY if url.path == "/v1/scene/glb" else MAX_BODY
            length_raw = self.headers.get("Content-Length")
            if length_raw is None or not length_raw.isdigit():
                raise BadRequest(411, "length_required", "Content-Length is required")
            length = int(length_raw)
            if length == 0:
                raise BadRequest(400, "empty_body", "the request has no image")
            if length > limit:
                raise BadRequest(413, "too_large", f"the request is larger than {limit} bytes")
            body = self.rfile.read(length)
            if len(body) != length:
                raise BadRequest(400, "incomplete_body", "the request body ended early")
            expected = self.headers.get("X-Source-SHA256")
            if expected is not None and hashlib.sha256(body).hexdigest() != expected.strip().lower():
                raise BadRequest(422, "checksum_mismatch", "the image does not match X-Source-SHA256")
            if url.path == "/v1/scene/glb":
                try:
                    glb, res = compose_glb(parse_scene_request(body))
                except SceneRequestError as e:
                    raise BadRequest(400 if e.code == "bad_scene" else 422, e.code, str(e)) from None
                except SceneCompileError as e:
                    raise BadRequest(422, e.code, str(e)) from None
                self._frame({"ok": True, **res.to_dict()}, glb)
                return
            if url.path == "/v1/texture":
                try:
                    data, tex = prepare_texture(body, params["max_edge"])
                except TextureError as e:
                    raise BadRequest(422, "texture_failed", str(e)) from None
                result = {"ok": True, **tex.to_dict(), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}
                self._frame(result, data)
                return
            try:
                result, usdz = convert(body, params)
            except ConversionError as e:
                raise BadRequest(422, "conversion_failed", str(e)) from None
            if not result["ok"]:
                self._json(422, {"ok": False, "code": "validation_failed", "error": "the USDZ failed structural validation", "result": result})
                return
            self._frame(result, usdz)
        except BadRequest as e:
            # Unread bodies would desynchronise keep-alive; close instead.
            self.close_connection = True
            self._json(e.status, {"ok": False, "code": e.code, "error": str(e)})
        except Exception:  # noqa: BLE001 - last-resort guard; detail only in logs
            traceback.print_exc(file=sys.stderr)
            self.close_connection = True
            self._json(500, {"ok": False, "code": "internal", "error": "unexpected converter error"})


def serve(port: int, host: str = "0.0.0.0") -> None:
    httpd = HTTPServer((host, port), Handler)
    sys.stderr.write(json.dumps({"event": "listening", "port": port, "converterVersion": CONVERTER_VERSION}) + "\n")
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
