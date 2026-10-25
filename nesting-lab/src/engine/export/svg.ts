// SVG preview of a sheet: exact arcs (SVG arc commands), one colour per part
// type, labels, sheet outline and no-go zones. Shared by the file export and
// the on-screen preview.

import type { Loop, Seg } from "../geometry/types";
import { arcSweep } from "../geometry/arc";
import type { NestPartInput, NestResult, SheetLayout } from "../nesting/types";
import { placedGeometry } from "../nesting/placement";

export const PART_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f", "#b45309", "#1d4ed8", "#059669", "#9333ea", "#c026d3", "#0e7490", "#ca8a04", "#15803d"];

export const MARK_COLOR = "#0f766e";

export function colorForIndex(i: number): string {
  return PART_COLORS[i % PART_COLORS.length];
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

export function segPath(s: Seg, first: boolean): string {
  let d = first ? `M${f(s.a.x)} ${f(s.a.y)}` : "";
  if (s.kind === "line") return d + `L${f(s.b.x)} ${f(s.b.y)}`;
  if (s.full) {
    // two half arcs from the start point to its antipode and back
    const o = { x: 2 * s.center.x - s.a.x, y: 2 * s.center.y - s.a.y };
    d = `M${f(s.a.x)} ${f(s.a.y)}`;
    return d + `A${f(s.r)} ${f(s.r)} 0 1 ${s.ccw ? 1 : 0} ${f(o.x)} ${f(o.y)}A${f(s.r)} ${f(s.r)} 0 1 ${s.ccw ? 1 : 0} ${f(s.a.x)} ${f(s.a.y)}`;
  }
  const large = arcSweep(s) > Math.PI ? 1 : 0;
  // SVG sweep-flag 1 = positive-angle direction in a y-down system; with the
  // y-up transform applied by the caller, ccw in model space is sweep 1
  return d + `A${f(s.r)} ${f(s.r)} 0 ${large} ${s.ccw ? 1 : 0} ${f(s.b.x)} ${f(s.b.y)}`;
}

export function loopPath(loop: Loop): string {
  let d = "";
  loop.segs.forEach((s, i) => {
    d += segPath(s, i === 0);
  });
  return d + "Z";
}

export function segsPath(segs: Seg[]): string {
  return segs.map((s) => segPath(s, true)).join("");
}

export interface SheetSvgOptions {
  showLabels?: boolean;
  showHoles?: boolean;
  showMarks?: boolean;
  width?: number;
  partIndex?: Map<string, number>;
}

/** Full SVG document for one sheet. */
export function sheetSvg(result: NestResult, sheet: SheetLayout, parts: NestPartInput[], opts: SheetSvgOptions = {}): string {
  const s = result.settings;
  const W = s.sheet.widthMm;
  const H = s.sheet.heightMm;
  const pad = Math.max(W, H) * 0.02;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const idx = opts.partIndex ?? new Map(parts.map((p, i) => [p.id, i]));
  const body: string[] = [];
  body.push(`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="#f8fafc" stroke="#334155" stroke-width="${f(Math.max(W, H) / 800)}"/>`);
  if (s.marginMm > 0) body.push(`<rect x="${f(s.marginMm)}" y="${f(s.marginMm)}" width="${f(W - 2 * s.marginMm)}" height="${f(H - 2 * s.marginMm)}" fill="none" stroke="#94a3b8" stroke-dasharray="${f(W / 100)} ${f(W / 100)}" stroke-width="${f(Math.max(W, H) / 1500)}"/>`);
  for (const z of s.noGoZones) body.push(`<rect x="${f(z.x)}" y="${f(z.y)}" width="${f(z.w)}" height="${f(z.h)}" fill="#fecaca" fill-opacity="0.6" stroke="#b91c1c" stroke-width="${f(Math.max(W, H) / 1200)}"/>`);
  const stroke = Math.max(W, H) / 1200;
  for (const pl of sheet.placements) {
    const part = byId.get(pl.partId);
    if (!part) continue;
    const g = placedGeometry(part, pl);
    const color = colorForIndex(idx.get(pl.partId) ?? 0);
    let d = loopPath(g.outer);
    if (opts.showHoles !== false) for (const hl of g.holes) d += loopPath(hl);
    body.push(`<path d="${d}" fill="${color}" fill-opacity="0.35" fill-rule="evenodd" stroke="${color}" stroke-width="${f(stroke)}" stroke-linejoin="round"/>`);
    if (opts.showMarks !== false && g.marks.length) body.push(`<path d="${segsPath(g.marks)}" fill="none" stroke="${MARK_COLOR}" stroke-width="${f(stroke)}"/>`);
    if (opts.showLabels !== false) {
      const cx = (pl.bbox.minX + pl.bbox.maxX) / 2;
      const cy = (pl.bbox.minY + pl.bbox.maxY) / 2;
      const size = Math.max(6, Math.min(30, Math.min(pl.bbox.maxX - pl.bbox.minX, pl.bbox.maxY - pl.bbox.minY) / 5));
      const label = `${part.label} #${pl.instance + 1}`;
      // text is drawn in a y-down group so it is not mirrored
      body.push(`<text transform="translate(${f(cx)} ${f(cy)}) scale(1,-1)" font-family="system-ui, sans-serif" font-size="${f(size)}" text-anchor="middle" dominant-baseline="middle" fill="#0f172a">${escapeXml(label)}</text>`);
    }
  }
  const title = `${s.sheet.label ?? `${W}×${H}`} — sheet ${sheet.index + 1}/${result.sheets.length} — ${sheet.placements.length} parts — utilization ${(sheet.utilization * 100).toFixed(1)}% — run ${result.runId}`;
  const widthPx = opts.width ?? 900;
  const heightPx = Math.round((widthPx * (H + 2 * pad + pad * 2)) / (W + 2 * pad));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${f(-pad)} ${f(-pad * 3)} ${f(W + 2 * pad)} ${f(H + 4 * pad)}">
<title>${escapeXml(title)}</title>
<text x="${f(W / 2)}" y="${f(-pad * 1.5)}" font-family="system-ui, sans-serif" font-size="${f(pad)}" text-anchor="middle" fill="#0f172a">${escapeXml(title)}</text>
<g transform="translate(0 ${f(H)}) scale(1,-1)">
${body.join("\n")}
</g>
</svg>
`;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
