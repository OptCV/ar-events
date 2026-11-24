"""Minimal ICC v2 RGB matrix/TRC profiles for tests (mirrors packages/image-to-ar/src/iccFixture.ts, ADR-039)."""

from __future__ import annotations

import struct


def _s15(x: float) -> bytes:
    return struct.pack(">i", round(x * 65536))


def _pad4(b: bytes) -> bytes:
    return b + b"\0" * (-len(b) % 4)


def icc_profile(description: str, gamma: float) -> bytes:
    desc = _pad4(b"desc" + b"\0" * 4 + struct.pack(">I", len(description) + 1) + description.encode("ascii") + b"\0" + b"\0" * 8 + b"\0" * 3 + b"\0" * 67)

    def xyz(x: float, y: float, z: float) -> bytes:
        return b"XYZ " + b"\0" * 4 + _s15(x) + _s15(y) + _s15(z)

    g = round(gamma * 256)
    curv = _pad4(b"curv" + b"\0" * 4 + struct.pack(">I", 1) + struct.pack(">H", g))
    tags = [
        (b"desc", desc),
        (b"wtpt", xyz(0.9642, 1, 0.8249)),
        (b"rXYZ", xyz(0.4361, 0.2225, 0.0139)),
        (b"gXYZ", xyz(0.3851, 0.7169, 0.0971)),
        (b"bXYZ", xyz(0.1431, 0.0606, 0.7141)),
        (b"rTRC", curv),
        (b"gTRC", curv),
        (b"bTRC", curv),
    ]
    offset = 128 + 4 + len(tags) * 12
    table = struct.pack(">I", len(tags))
    data = b""
    for sig, body in tags:
        table += sig + struct.pack(">II", offset, len(body))
        data += body
        offset += len(body)
    size = 128 + len(table) + len(data)
    header = (
        struct.pack(">I", size) + b"\0" * 4 + bytes([2, 0x10, 0, 0]) + b"mntr" + b"RGB " + b"XYZ " + b"\0" * 12 + b"acsp" + b"\0" * 28
        + _s15(0.9642) + _s15(1) + _s15(0.8249) + b"\0" * 48
    )
    assert len(header) == 128, len(header)
    return header + table + data
