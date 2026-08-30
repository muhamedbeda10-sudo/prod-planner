"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

// A QR code as inline SVG — no canvas, no image request, so it survives the
// print dialog and the PDF export exactly as it looks on screen.
//
// Error-correction level M is the sticker's sweet spot: it still scans through
// a scuff or a fingerprint of paint dust without the code growing so dense
// that a phone camera struggles at arm's length.

export function QrSvg({
  value,
  size = 96,
  className = "",
  title,
}: {
  value: string;
  /** Rendered edge length in px — the SVG scales to it. */
  size?: number;
  className?: string;
  title?: string;
}) {
  const path = useMemo(() => {
    // type 0 = pick the smallest version that fits the payload
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { d: parts.join(""), count };
  }, [value]);

  // one module of quiet zone on each side keeps scanners happy without eating
  // the sticker (the spec asks for four; stickers are small and high-contrast)
  const quiet = 2;
  const box = path.count + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title ?? "QR code"}
      shapeRendering="crispEdges"
    >
      <rect width={box} height={box} fill="#fff" />
      <g transform={`translate(${quiet} ${quiet})`} fill="#000">
        <path d={path.d} />
      </g>
    </svg>
  );
}
