// Tracker validation WITH ReallocateExcess applied (as ShowPlan does).
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { computeTracker } from "../lib/domain/tracker.ts";
import { computeReallocations } from "../lib/domain/reallocate.ts";
import { makeBomGrouper } from "../lib/domain/bom.ts";
import { excelSerialToDate } from "../lib/domain/dates.ts";

const wb = XLSX.read(readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm"), { cellDates: false });
const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
const S = (v) => (v == null ? "" : String(v).trim());
const N = (v) => (typeof v === "number" ? v : Number(v)) || 0;
const PLAN = 27;

const po = rows("Plan Orders");
const orders = [];
for (let i = 1; i < po.length; i++) { const r = po[i]; if (r && N(r[0]) === PLAN && S(r[1])) orders.push({ bom: S(r[1]), mo: S(r[3]), description: S(r[4]), item: S(r[5]), requiredQty: N(r[6]), targetQty: N(r[8]) }); }

const dh = rows("Daily Handover");
const logs = []; let id = 1;
for (let i = 1; i < dh.length; i++) { const r = dh[i]; if (r && N(r[5]) === PLAN && S(r[2])) logs.push({ id: id++, date: excelSerialToDate(N(r[0])), dept: S(r[1]), bom: S(r[2]), item: S(r[3]), qty: N(r[4]) }); }

const grouper = makeBomGrouper(orders.map((o) => o.bom));
const moves = computeReallocations(orders.map((o) => ({ bom: o.bom, item: o.item, targetQty: o.targetQty })), logs, grouper);
console.log(`Reallocation proposals: ${moves.length}`);
const agg = {};
for (const m of moves) { const k = `${m.dept} ${m.item} ${m.fromBom} -> ${m.toBom}`; agg[k] = (agg[k] || 0) + m.qty; }
for (const [k, v] of Object.entries(agg)) console.log(`  ${k}: ${v}`);

// effective logs = raw + synthetic move rows
const effLogs = logs.map((l) => ({ dept: l.dept, bom: l.bom, item: l.item, qty: l.qty }));
for (const m of moves) {
  effLogs.push({ dept: m.dept, bom: m.fromBom, item: m.item, qty: -m.qty });
  effLogs.push({ dept: m.dept, bom: m.toBom, item: m.item, qty: m.qty });
}

const computed = computeTracker(orders, effLogs);
const byBom = new Map(computed.map((c) => [c.bom, c]));
const pt = rows("Plan Tracker");
let checked = 0, mism = 0; const IT = ["CF", "TC", "TN", "CB"];
for (let i = 4; i < pt.length; i++) {
  const r = pt[i]; const bom = S(r?.[0]); if (!bom) continue;
  const c = byBom.get(bom); if (!c) { mism++; console.log(`MISSING ${bom}`); continue; }
  const probs = [];
  if (c.required !== N(r[3])) probs.push(`req ${c.required}!=${N(r[3])}`);
  if (c.complete !== N(r[12])) probs.push(`complete ${c.complete}!=${N(r[12])}`);
  if (c.remaining !== N(r[13])) probs.push(`remaining ${c.remaining}!=${N(r[13])}`);
  for (let t = 0; t < 4; t++) {
    if (c.items[IT[t]].cutDone !== N(r[4 + 2 * t])) probs.push(`${IT[t]}cut ${c.items[IT[t]].cutDone}!=${N(r[4 + 2 * t])}`);
    if (c.items[IT[t]].weldDone !== N(r[5 + 2 * t])) probs.push(`${IT[t]}weld ${c.items[IT[t]].weldDone}!=${N(r[5 + 2 * t])}`);
  }
  checked++; if (probs.length) { mism++; console.log(`MISMATCH ${bom}: ${probs.join(", ")}`); }
}
console.log(`\nChecked ${checked}, mismatches ${mism}`);
