"""Make USDZ packages byte-reproducible.

UsdUtils packaging stamps each ZIP entry with the wall-clock time, so identical inputs produced different
SHA-256s across runs (found 2026-11-14). We overwrite the DOS time/date fields in every local file header
and central directory entry with 1980-01-01 00:00. Those fields are fixed-width and not covered by the CRC,
so entry offsets, 64-byte data alignment and checksums are unchanged.
"""

import struct
import zipfile
from pathlib import Path

DOS_TIME = 0
DOS_DATE = (0 << 9) | (1 << 5) | 1  # 1980-01-01


def normalize_zip_timestamps(path: Path) -> None:
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        cd_offset = z.start_dir
    raw = bytearray(path.read_bytes())
    for info in infos:
        o = info.header_offset
        if raw[o : o + 4] != b"PK\x03\x04":
            raise ValueError(f"bad local header for {info.filename}")
        struct.pack_into("<HH", raw, o + 10, DOS_TIME, DOS_DATE)
    o = cd_offset
    for _ in infos:
        if raw[o : o + 4] != b"PK\x01\x02":
            raise ValueError("bad central directory entry")
        struct.pack_into("<HH", raw, o + 12, DOS_TIME, DOS_DATE)
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", raw, o + 28)
        o += 46 + name_len + extra_len + comment_len
    path.write_bytes(bytes(raw))
