// Cut list — one CSV a planner can open in Excel: what is on every sheet,
// and the per-part totals against what was requested.

import type { NestPartInput, NestResult } from "../nesting/types";
import { loopBBox } from "../geometry/polygon";

const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v;
  // a cell that starts like a formula (=, +, -, @, tab) is prefixed with an
  // apostrophe so a spreadsheet shows it as text instead of evaluating it —
  // file names come from outside the plant
  if (typeof v === "string" && /^[\s]*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells: (string | number | null | undefined)[]) => cells.map(cell).join(",");

export function cutListCsv(result: NestResult, parts: NestPartInput[]): string {
  const s = result.settings;
  const lines: string[] = [];
  lines.push(row(["Nesting run", result.runId]));
  lines.push(row(["Engine", result.engineVersion]));
  lines.push(row(["Created", result.createdAt]));
  lines.push(row(["Material", s.sheet.material, "Thickness mm", s.sheet.thicknessMm, "Sheet mm", `${s.sheet.widthMm} x ${s.sheet.heightMm}`]));
  lines.push(row(["Part spacing mm", s.spacingMm, "Edge margin mm", s.marginMm, "Rotations", s.rotationsDeg.join(" / "), "Mirror", s.allowMirror ? "allowed" : "not allowed"]));
  lines.push(row(["Sheets used", result.sheets.length, "Parts placed", result.sheets.reduce((n, x) => n + x.placements.length, 0), "Parts unplaced", result.unplaced.reduce((n, u) => n + u.quantity, 0)]));
  lines.push("");
  lines.push(row(["Sheet", "Part", "BOM", "Part no.", "Name", "Qty on sheet", "Width mm", "Height mm", "Area mm2 (outer)", "Rotations used", "Mirrored", "Source file", "Source pieces"]));
  for (const sh of result.sheets) {
    const byPart = new Map<string, { qty: number; rots: Set<number>; mirrored: boolean }>();
    for (const pl of sh.placements) {
      const e = byPart.get(pl.partId) ?? { qty: 0, rots: new Set<number>(), mirrored: false };
      e.qty++;
      e.rots.add(pl.rotationDeg);
      if (pl.mirrored) e.mirrored = true;
      byPart.set(pl.partId, e);
    }
    for (const [id, e] of byPart) {
      const p = parts.find((x) => x.id === id);
      if (!p) continue;
      const b = loopBBox(p.outer);
      const summary = result.parts.find((x) => x.id === id);
      lines.push(row([sh.index + 1, p.label, p.bom, p.partNo, p.name, e.qty, b.maxX - b.minX, b.maxY - b.minY, summary?.grossArea, [...e.rots].sort((a, b2) => a - b2).join(" / "), e.mirrored ? "yes" : "no", p.source?.file, p.source?.pieceIds.join(" ")]));
    }
  }
  lines.push("");
  lines.push(row(["Sheet", "Parts", "Utilization %", "Gross part area mm2", "Net part area mm2", "Used box mm"]));
  for (const sh of result.sheets) lines.push(row([sh.index + 1, sh.placements.length, Math.round(sh.utilization * 1000) / 10, sh.grossPartArea, sh.netPartArea, sh.usedBBox ? `${Math.round(sh.usedBBox.maxX - sh.usedBBox.minX)} x ${Math.round(sh.usedBBox.maxY - sh.usedBBox.minY)}` : ""]));
  lines.push("");
  lines.push(row(["Part", "BOM", "Part no.", "Name", "Requested", "Placed", "Unplaced", "Reason"]));
  for (const p of result.parts) {
    const un = result.unplaced.find((u) => u.partId === p.id);
    lines.push(row([p.label, p.bom, p.partNo, p.name, p.quantity, p.placed, un?.quantity ?? 0, un?.reason]));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
