// Command-line run of the whole pipeline on your own files:
//   npm run cli -- --file part.dxf --file other.dxf --unit mm --sheet 1220x2440 \
//       --material Steel --thickness 5 --spacing 5 --margin 5 --rotations 0,90,180,270 \
//       --qty F1-T1=10 --exclude F1-T3 --mark-layer 02___PRT_ALL_AXES --out out/my-run
// Defaults: sheet 1220x2440, Steel, thickness 5, spacing 5, margin 5, four rotations,
// no mirror, 30 s budget. --file is required; a unitless file needs --unit.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDxf } from "../src/engine/dxf/analyze";
import type { LayerRole } from "../src/engine/dxf/primitives";
import type { SelectableUnit } from "../src/engine/dxf/units";
import type { NestPartInput, NestSettings } from "../src/engine/nesting/types";
import type { MachinesFile } from "../src/engine/machines/types";
import { partDxf } from "../src/engine/export/sheetExport";
import { partIdOf, partsFromAnalysis, type PartOverride } from "../src/engine/parts";
import { runPipeline } from "./lib/runPipeline";

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    (out[key] ??= []).push(val);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const one = (k: string, d?: string) => args[k]?.[0] ?? d;
const files = args.file ?? [];
if (files.length === 0) {
  console.error("Usage: npm run cli -- --file <dxf> [--file <dxf>…] [--unit mm|cm|m|in] [--sheet WxH] [--material Steel] [--thickness 5] [--spacing 5] [--margin 5] [--rotations 0,90,180,270] [--mirror] [--qty ID=n…] [--exclude ID…] [--mark-layer NAME…] [--ignore-layer NAME…] [--budget 30] [--out dir]");
  process.exit(2);
}
const unit = (one("unit") ?? null) as SelectableUnit | null;
const [sw, sh] = (one("sheet", "1220x2440") as string).toLowerCase().split(/[x*×]/).map(Number);
const thickness = Number(one("thickness", "5"));
const layerRoles: Record<string, LayerRole> = {};
for (const l of args["mark-layer"] ?? []) layerRoles[l] = "mark";
for (const l of args["ignore-layer"] ?? []) layerRoles[l] = "ignore";
const qty: Record<string, number> = {};
for (const q of args.qty ?? []) {
  const [id, n] = q.split("=");
  qty[id] = Number(n);
}
const exclude = new Set(args.exclude ?? []);
const outDir = one("out", `out/cli-${Date.now().toString(36)}`) as string;
mkdirSync(join(outDir, "parts"), { recursive: true });

const parts: NestPartInput[] = [];
files.forEach((f, fi) => {
  const a = analyzeDxf(basename(f), new Uint8Array(readFileSync(f)), { unit, layerRoles, thicknessMm: thickness });
  const tag = `F${fi + 1}`;
  console.log(`\n== ${tag} ${basename(f)}: ${a.acadVersion}, units ${a.units.stated ? a.units.name : `not stated → ${unit ?? "MISSING (use --unit)"}`}`);
  for (const w of a.warnings) console.log(`   ! ${w}`);
  if (a.needsUnit) {
    console.error("   The file is unitless; pass --unit mm (or cm, m, in).");
    process.exit(3);
  }
  const cls = a.classification!;
  console.log(`   ${cls.kind}; ${cls.pieces.length} pieces, ${a.parts!.groups.length} part types${cls.sheetSize ? `; sheet boundary ${cls.sheetSize.w}×${cls.sheetSize.h}` : ""}`);
  writeFileSync(join(outDir, `${tag}-analysis.json`), JSON.stringify({ ...a, marks: undefined, classification: { ...cls, pieces: cls.pieces.map((p) => ({ id: p.id, bbox: p.bbox, area: p.area, holes: p.holes.length, marks: p.marks.length, depth: p.depth, flags: p.flags })) }, parts: a.parts!.groups.map((g, i) => ({ id: partIdOf(tag, i), instances: g.instances.length, mirrorOf: g.mirrorOf })) }, null, 2));
  const overrides: Record<number, PartOverride> = {};
  a.parts!.groups.forEach((_g, gi) => {
    const id = partIdOf(tag, gi);
    overrides[gi] = { include: exclude.has(id) ? false : undefined, quantity: qty[id] };
  });
  const built = partsFromAnalysis(a, { idPrefix: tag, overrides });
  a.parts!.groups.forEach((g, gi) => {
    const id = partIdOf(tag, gi);
    const rep = g.representative;
    const part = built.parts.find((p) => p.id === id);
    const skip = built.skipped.find((x) => x.id === id);
    console.log(`   ${id}: ${(rep.bbox.maxX - rep.bbox.minX).toFixed(1)}×${(rep.bbox.maxY - rep.bbox.minY).toFixed(1)} mm, ${rep.holes.length} holes, found ×${g.instances.length}${g.mirrorOf !== null ? ` (mirror of ${partIdOf(tag, g.mirrorOf)})` : ""} → ${part ? `nest ×${part.quantity}` : `skipped (${skip?.reason})`}${rep.flags.length ? ` [${rep.flags.join("; ")}]` : ""}`);
    // the part library holds every type, nested or not
    const lib: NestPartInput = part ?? { id, label: id, quantity: 0, outer: rep.outer.loop, holes: rep.holes.map((h) => h.loop), marks: rep.marks };
    writeFileSync(join(outDir, "parts", `${id}.dxf`), partDxf(lib));
  });
  parts.push(...built.parts);
});
const settings: NestSettings = {
  sheet: { widthMm: sw, heightMm: sh, quantity: one("sheets") ? Number(one("sheets")) : null, material: one("material", "Steel") as string, thicknessMm: thickness, label: `${sw}*${sh}` },
  spacingMm: Number(one("spacing", "5")),
  marginMm: Number(one("margin", "5")),
  rotationsDeg: (one("rotations", "0,90,180,270") as string).split(",").map(Number),
  allowMirror: one("mirror") === "true",
  noGoZones: [],
  timeBudgetMs: Number(one("budget", "30")) * 1000,
};
const machines = JSON.parse(readFileSync(fileURLToPath(new URL("../config/machines.local.json", import.meta.url)), "utf8")) as MachinesFile;
console.log(`\nNesting ${parts.reduce((n, p) => n + p.quantity, 0)} parts on ${sw}×${sh} mm ${settings.sheet.material} ${thickness} mm, spacing ${settings.spacingMm}, margin ${settings.marginMm}, rotations ${settings.rotationsDeg.join("/")}…`);
const out = runPipeline(parts, settings, outDir, machines, (m) => process.stdout.write(`\r${m}        `));
const r = out.result;
const v = out.report.verification!;
console.log(`\n${r.sheets.length} sheet(s): ${r.sheets.map((s) => `${s.placements.length} parts ${(s.utilization * 100).toFixed(1)}%`).join(" | ")}; unplaced ${r.unplaced.reduce((n, u) => n + u.quantity, 0)}; ${r.timings.totalMs.toFixed(0)} ms`);
for (const u of r.unplaced) console.log(`   unplaced ${u.partId} ×${u.quantity}: ${u.reason}`);
console.log(`verification ${v.ok ? "passed" : `FAILED (${v.violations.length})`}; DXF read-back ${out.report.roundTrip.every((x) => x.report.ok) ? "passed" : "FAILED"}`);
console.log(`machines: ${out.report.machines?.slice(0, 4).map((m) => `${m.rank}. ${m.code} ${m.compatibility}`).join(", ")}`);
console.log(`files in ${outDir}: ${out.files.map((f) => basename(f)).join(", ")}`);
