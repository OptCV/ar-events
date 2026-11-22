"""CLI: python -m usd_processor image-plane --image in.png --out out.usdz --width-m 0.3 --alpha-mode BLEND [...]

Prints a JSON result (dimensions, package contents, compliance diagnostics). Exit code 2 on
conversion error, 3 when structural validation reports errors.
All arguments are passed as an argv array by the caller; no shell interpolation.
"""

import argparse
import json
import sys
from pathlib import Path

from .image_plane import ConversionError, ImagePlaneRequest, build_image_plane_usdz


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="usd_processor")
    sub = p.add_subparsers(dest="cmd", required=True)
    ip = sub.add_parser("image-plane", help="flat image object -> USDZ")
    ip.add_argument("--image", type=Path, required=True)
    ip.add_argument("--out", type=Path, required=True)
    ip.add_argument("--width-m", type=float, required=True)
    ip.add_argument("--alpha-mode", choices=["OPAQUE", "MASK", "BLEND"], required=True)
    ip.add_argument("--alpha-cutoff", type=float, default=0.5)
    ip.add_argument("--double-sided", action="store_true")
    ip.add_argument("--pivot", choices=["center", "bottom-center"], default="center")
    ip.add_argument("--orientation", choices=["upright", "flat"], default="upright")
    ip.add_argument("--anchor", choices=["none", "image", "floor", "wall"], default="none")
    ip.add_argument("--tracking-image", type=Path)
    ip.add_argument("--tracking-width-m", type=float)
    sv = sub.add_parser("serve", help="HTTP converter for the Cloudflare Container (server.py)")
    sv.add_argument("--port", type=int, default=8080)
    a = p.parse_args(argv)

    if a.cmd == "serve":
        from .server import serve

        serve(a.port)
        return 0

    try:
        res = build_image_plane_usdz(
            ImagePlaneRequest(
                image=a.image,
                out_usdz=a.out,
                width_m=a.width_m,
                alpha_mode=a.alpha_mode,
                alpha_cutoff=a.alpha_cutoff,
                double_sided=a.double_sided,
                pivot=a.pivot,
                orientation=a.orientation,
                anchor=a.anchor,
                tracking_image=a.tracking_image,
                tracking_width_m=a.tracking_width_m,
            )
        )
    except ConversionError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    ok = not res.validation_errors
    print(json.dumps({"ok": ok, **res.to_dict()}, indent=2))
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
