// Validates computeTracker against the workbook's own "Plan Tracker" sheet output.
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { computeTracker } from "../lib/domain/tracker.ts";

const wb = XLSX.read(
  readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm"),
  { cellDates: false }
);
const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
const S = (v) => (v == null ? "" : String(v).trim());
const N = (v) => (typeof v === "number" ? v : Number(v)) || 0;

const PLAN = 27;
const po = rows("Plan Orders");
const orders = [];
for (let i = 1; i < po.length; i++) {
  const r = po[i];
  if (r && N(r[0]) === PLAN && S(r[1]))
    orders.push({ bom: S(r[1]), mo: S(r[3]), description: S(r[4]), item: S(r[5]), requiredQty: N(r[6]), targetQty: N(r[8]) });
}
const dh = rows("Daily Handover");
const logs = [];
for (let i = 1; i < dh.length; i++) {
  const r = dh[i];
  if (r && N(r[5]) === PLAN && S(r[2])) logs.push({ dept: S(r[1]), bom: S(r[2]), item: S(r[3]), qty: N(r[4]) });
}

const computed = computeTracker(orders, logs);
const byBom = new Map(computed.map((c) => [c.bom, c]));

// Expected from Plan Tracker sheet (row 5+): A=bom,D=req,E..L cut/weld,M=complete,N=remaining,O=ach
const pt = rows("Plan Tracker");
let checked = 0, mismatches = 0;
const IT = ["CF", "TC", "TN", "CB"];
for (let i = 4; i < pt.length; i++) {
  const r = pt[i];
  const bom = S(r?.[0]);
  if (!bom) continue;
  const c = byBom.get(bom);
  if (!c) { console.log(`MISSING computed row for ${bom}`); mismatches++; continue; }
  const exp = { req: N(r[3]), complete: N(r[12]), remaining: N(r[13]), ach: r[14] == null || r[14] === "" ? null : N(r[14]) };
  const cells = [];
  for (let t = 0; t < 4; t++) cells.push([N(r[4 + 2 * t]), N(r[5 + 2 * t])]); // cut,weld
  const probs = [];
  if (c.required !== exp.req) probs.push(`req ${c.required}!=${exp.req}`);
  if (c.complete !== exp.complete) probs.push(`complete ${c.complete}!=${exp.complete}`);
  if (c.remaining !== exp.remaining) probs.push(`remaining ${c.remaining}!=${exp.remaining}`);
  if (exp.ach !== null && Math.abs((c.achievement ?? 0) - exp.ach) > 1e-6) probs.push(`ach ${c.achievement}!=${exp.ach}`);
  for (let t = 0; t < 4; t++) {
    if (c.items[IT[t]].cutDone !== cells[t][0]) probs.push(`${IT[t]}cut ${c.items[IT[t]].cutDone}!=${cells[t][0]}`);
    if (c.items[IT[t]].weldDone !== cells[t][1]) probs.push(`${IT[t]}weld ${c.items[IT[t]].weldDone}!=${cells[t][1]}`);
  }
  checked++;
  if (probs.length) { mismatches++; console.log(`MISMATCH ${bom}: ${probs.join(", ")}`); }
}
console.log(`\nChecked ${checked} tracker rows against the sheet. Mismatches: ${mismatches}`);
console.log(`Computed rows: ${computed.length}, sheet rows: ${checked}`);
process.exit(mismatches ? 1 : 0);
