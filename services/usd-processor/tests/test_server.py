"""HTTP converter (server.py) tests: real server on a loopback port inside the sandbox."""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import struct
import threading
import zipfile
from http.server import HTTPServer
from pathlib import Path

import pytest

from usd_processor.image_plane import CONVERTER_VERSION
from usd_processor.server import FRAME_TYPE, MAX_BODY, Handler, parse_image_plane_query
from usd_processor.validate import validate_usdz

FIX = Path(os.environ.get("FIXTURES_DIR", "/fixtures"))
LOGO = (FIX / "images" / "logo_transparent_border.png").read_bytes()
PHOTO = (FIX / "images" / "opaque_photo.jpg").read_bytes()


@pytest.fixture(scope="module")
def server():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def call(port: int, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    h = dict(headers or {})
    if body is not None and "Content-Length" not in h:
        h["Content-Length"] = str(len(body))
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, r.getheader("Content-Type"), data


def unframe(data: bytes) -> tuple[dict, bytes]:
    (n,) = struct.unpack(">I", data[:4])
    return json.loads(data[4 : 4 + n]), data[4 + n :]


def test_healthz(server):
    status, ctype, data = call(server, "GET", "/healthz")
    assert status == 200 and ctype == "application/json"
    body = json.loads(data)
    assert body["ok"] is True and body["converterVersion"] == CONVERTER_VERSION
    assert body["usd"].startswith("0.")


def test_converts_png_with_alpha_and_frames_result(server, tmp_path):
    q = "width_m=0.5&alpha_mode=BLEND&alpha_cutoff=0.5&double_sided=1&pivot=bottom-center&orientation=upright"
    status, ctype, data = call(server, "POST", f"/v1/image-plane?{q}", LOGO, {"X-Source-SHA256": hashlib.sha256(LOGO).hexdigest()})
    assert status == 200 and ctype == FRAME_TYPE
    meta, usdz = unframe(data)
    assert meta["ok"] is True and meta["alpha_mode"] == "BLEND" and meta["anchor"] == "none"
    assert meta["sha256"] == hashlib.sha256(usdz).hexdigest() and meta["sizeBytes"] == len(usdz)
    assert "usdz" not in meta  # no temp paths leak
    assert meta["width_m"] == 0.5
    # The texture is embedded byte-identical (ADR-009) and the package validates.
    with zipfile.ZipFile(io.BytesIO(usdz)) as z:
        assert z.namelist()[0] == "scene.usdc"
        tex = [n for n in z.namelist() if "display" in n]
        assert len(tex) == 1
        assert hashlib.sha256(z.read(tex[0])).hexdigest() == hashlib.sha256(LOGO).hexdigest()
    out = tmp_path / "x.usdz"
    out.write_bytes(usdz)
    assert validate_usdz(str(out)).errors == []


def test_same_input_same_bytes(server):
    q = "width_m=0.3&alpha_mode=OPAQUE"
    a = unframe(call(server, "POST", f"/v1/image-plane?{q}", PHOTO)[2])[1]
    b = unframe(call(server, "POST", f"/v1/image-plane?{q}", PHOTO)[2])[1]
    assert a == b  # ADR-011: byte-reproducible


@pytest.mark.parametrize(
    "query,code",
    [
        ("alpha_mode=BLEND", "bad_parameter"),  # width missing
        ("width_m=abc&alpha_mode=BLEND", "bad_parameter"),
        ("width_m=nan&alpha_mode=BLEND", "bad_parameter"),
        ("width_m=0.5&alpha_mode=SOMETIMES", "bad_parameter"),
        ("width_m=0.5&alpha_mode=BLEND&anchor=image", "bad_parameter"),  # anchoring is not offered here
        ("width_m=0.5&width_m=0.6&alpha_mode=BLEND", "bad_parameter"),
    ],
)
def test_bad_parameters(server, query, code):
    status, _, data = call(server, "POST", f"/v1/image-plane?{query}", LOGO)
    assert status == 400 and json.loads(data)["code"] == code


def test_conversion_errors_are_422(server):
    # JPEG cannot be BLEND; width out of range; not an image; wrong checksum.
    for q, body, extra in [
        ("width_m=0.5&alpha_mode=BLEND", PHOTO, {}),
        ("width_m=50&alpha_mode=OPAQUE", PHOTO, {}),
        ("width_m=0.5&alpha_mode=OPAQUE", b"<html>not an image</html>", {}),
        ("width_m=0.5&alpha_mode=OPAQUE", PHOTO, {"X-Source-SHA256": "0" * 64}),
    ]:
        status, ctype, data = call(server, "POST", f"/v1/image-plane?{q}", body, extra)
        assert status == 422 and ctype == "application/json", q
        payload = json.loads(data)
        assert payload["ok"] is False and payload["code"] in ("conversion_failed", "checksum_mismatch")
        assert "/tmp" not in payload["error"]


def test_length_rules(server):
    status, _, data = call(server, "POST", "/v1/image-plane?width_m=0.5&alpha_mode=OPAQUE", b"", {"Content-Length": "0"})
    assert status == 400
    status, _, data = call(server, "POST", "/v1/image-plane?width_m=0.5&alpha_mode=OPAQUE", b"x", {"Content-Length": str(MAX_BODY + 1)})
    assert status == 413 and json.loads(data)["code"] == "too_large"


def test_unknown_routes(server):
    assert call(server, "GET", "/v1/image-plane")[0] == 404
    assert call(server, "POST", "/other", b"x")[0] == 404


def test_query_parser_defaults():
    assert parse_image_plane_query("width_m=1&alpha_mode=MASK") == {
        "width_m": 1.0,
        "alpha_mode": "MASK",
        "alpha_cutoff": 0.5,
        "double_sided": False,
        "pivot": "center",
        "orientation": "upright",
    }


def test_texture_endpoint(server):
    from PIL import Image

    b = io.BytesIO()
    Image.new("RGBA", (3000, 1000), (255, 255, 255, 128)).save(b, format="WEBP", lossless=True)
    status, ctype, data = call(server, "POST", "/v1/texture?max_edge=2048", b.getvalue())
    assert status == 200 and ctype == FRAME_TYPE
    meta, png = unframe(data)
    assert meta["ok"] is True and meta["mime"] == "image/png" and meta["changes"] == ["converted", "resized"]
    assert (meta["width"], meta["height"], meta["source_width"]) == (2048, 683, 3000)
    assert meta["sha256"] == hashlib.sha256(png).hexdigest() and png[:4] == b"\x89PNG"
    assert call(server, "POST", "/v1/texture?max_edge=big", b.getvalue())[0] == 400
    assert call(server, "POST", "/v1/texture?max_edge=2048&x=1", b.getvalue())[0] == 400
    status, _, data = call(server, "POST", "/v1/texture?max_edge=2048", b"not an image")
    assert status == 422 and json.loads(data)["code"] == "texture_failed"
