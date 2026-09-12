import { useMemo } from 'react';
import { encodeQr } from './qr-encode';

/** Renders a QR code as SVG. The encoding itself lives in qr-encode.ts. */
export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const grid = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);

  if (!grid) return null;

  // The quiet zone is required by the spec; without it many scanners fail.
  const quiet = 2;
  const span = grid.size + quiet * 2;

  // One path for every dark module is far fewer DOM nodes than one rect each.
  const path = grid.modules
    .flatMap((row, r) =>
      row.map((on, c) => (on ? `M${String(c + quiet)} ${String(r + quiet)}h1v1h-1z` : '')),
    )
    .join('');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(span)} ${String(span)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${value}`}
    >
      <rect width={span} height={span} fill="#fff" rx="1" />
      <path d={path} fill="#000" />
    </svg>
  );
}
