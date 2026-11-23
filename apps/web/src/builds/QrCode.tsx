import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code as SVG (no inline styles, CSP-safe). Error correction M; a 4-module quiet zone. */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n: count + 8, path: d };
  }, [value]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges" data-testid="qr-code">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
