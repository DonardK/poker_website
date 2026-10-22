"use client";

import { useEffect, useState } from "react";

/**
 * A QR code drawn in the browser as one SVG path from uqr's module matrix
 * (uqr 0.1.3, loaded on first use). SECURITY: the value (an otpauth:// URI
 * holding a TOTP secret) never leaves the page: no remote QR service, no
 * innerHTML, no data: URL; inline SVG is not subject to img-src. Dark modules
 * on white with a 4-module quiet zone, which every scanner reads.
 */
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const [matrix, setMatrix] = useState<{ size: number; path: string } | null>(null);
  useEffect(() => {
    let live = true;
    void import("uqr").then(({ encode }) => {
      if (!live) return;
      const qr = encode(value, { ecc: "M", border: 4 });
      let path = "";
      qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x} ${y}h1v1h-1z`; }));
      setMatrix({ size: qr.size, path });
    }).catch(() => { if (live) setMatrix(null); });
    return () => { live = false; };
  }, [value]);
  if (!matrix) {
    return <div aria-hidden="true" className="animate-pulse rounded-lg bg-white/10" style={{ width: size, height: size }} />;
  }
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${matrix.size} ${matrix.size}`} shapeRendering="crispEdges"
      className="rounded-lg">
      <title>{label}</title>
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#071912" />
    </svg>
  );
}
