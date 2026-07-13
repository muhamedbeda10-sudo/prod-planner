import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const wb = XLSX.read(
  readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm"),
  { cellDates: false }
);
const rows = (name, a, b) =>
  XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });

function groupKey(u) {
  const m = /^(.+?)E\d+(M\d+)$/.exec(u);
  return m ? `${m[1]}|${m[2]}` : u;
}

// distinct BOMs in Plan Orders (col B) for plan 27
const po = rows("Plan Orders");
const bomsPO = new Set();
for (let i = 1; i < po.length; i++) {
  const r = po[i];
  if (r && String(r[0]) === "27" && r[1]) bomsPO.add(String(r[1]).trim().toUpperCase());
}
console.log("=== Plan Orders BOMs matching 12011* ===");
[...bomsPO].filter((b) => b.startsWith("12011")).forEach((b) => console.log(b, "->", groupKey(b)));

console.log("\n=== All distinct groupKeys with >1 BOM member (Plan Orders) ===");
const byKey = {};
for (const b of bomsPO) (byKey[groupKey(b)] ??= []).push(b);
Object.entries(byKey)
  .filter(([, v]) => v.length > 1)
  .forEach(([k, v]) => console.log(k, "<=", v.join(", ")));

// Plan Tracker output rows (col A = BOM shown, col B = MO text)
console.log("\n=== Plan Tracker rows with 12011 ===");
const pt = rows("Plan Tracker");
for (let i = 4; i < pt.length; i++) {
  const r = pt[i];
  if (r && r[0] && String(r[0]).includes("12011")) console.log(`A=${r[0]}  MO=${r[1]}  Req=${r[3]}`);
}

// Daily Handover distinct 12011 BOMs
console.log("\n=== Daily Handover distinct 12011 BOMs ===");
const dh = rows("Daily Handover");
const hb = new Set();
for (let i = 1; i < dh.length; i++) {
  const r = dh[i];
  if (r && r[2] && String(r[2]).includes("12011")) hb.add(String(r[2]).trim().toUpperCase());
}
[...hb].forEach((b) => console.log(b, "->", groupKey(b), bomsPO.has(b) ? "(in PO)" : "(NOT in PO)"));
