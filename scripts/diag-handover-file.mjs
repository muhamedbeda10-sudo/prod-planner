import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { parseHandoverGrid, validateHandoverRow } from "../lib/domain/importHandover.ts";

const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Daily_HandOver_Welding.xlsx";
const wb = XLSX.read(readFileSync(path), { cellDates: false });
console.log("sheets:", wb.SheetNames);
const ws = wb.Sheets[wb.SheetNames[0]];
console.log("ref:", ws["!ref"]);

const opts = { header: 1, raw: true, defval: null, blankrows: false };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const grid = XLSX.utils.sheet_to_json(ws, opts);

console.log("\nfirst 8 raw rows (with types):");
for (let i = 0; i < Math.min(8, grid.length); i++) {
  console.log(`r${i + 1}:`, JSON.stringify((grid[i] ?? []).slice(0, 10).map((v) => (v === null ? null : `${typeof v}:${v}`))));
}

const { rows } = parseHandoverGrid(grid);
console.log(`\nparsed rows: ${rows.length}`);
let bad = 0;
const reasons = {};
for (const r of rows) {
  const err = validateHandoverRow(r);
  if (err) {
    bad++;
    const kind = err.replace(/\(row \d+\)/, "").trim();
    reasons[kind] = (reasons[kind] || 0) + 1;
  }
}
console.log(`invalid: ${bad} / ${rows.length}`);
console.log("failure reasons:", reasons);
console.log("\nfirst 3 parsed rows:", JSON.stringify(rows.slice(0, 3), null, 1));
