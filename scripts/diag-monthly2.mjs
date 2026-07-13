import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const wb = XLSX.read(readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Monthly plan.xlsx"), { cellDates: false });
const ws = wb.Sheets["Sheet2"];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const grid = XLSX.utils.sheet_to_json(ws, opts);

const show = (r, from, to) => JSON.stringify((grid[r] ?? []).slice(from, to).map((v) => (v === null ? "" : (typeof v === "number" ? v : String(v).replace(/\r?\n/g, " ").slice(0, 16)))));
console.log("header r2 cols N..AT:", show(1, 13, 46));
console.log("subhdr r3 cols N..AT:", show(2, 13, 46));
console.log("data   r4 cols N..AT:", show(3, 13, 46));
console.log("data   r6 cols N..AT:", show(5, 13, 46));

console.log("\nlast 8 rows (cols A..M):");
for (let i = grid.length - 8; i < grid.length; i++) {
  console.log(`r${i + 1}:`, show(i, 0, 13));
}
// count data rows (MO present in col F)
let n = 0;
const mos = new Set();
for (let i = 3; i < grid.length; i++) {
  const mo = grid[i]?.[5];
  if (mo && String(mo).trim()) { n++; mos.add(String(mo).trim()); }
}
console.log(`\ndata rows with MO: ${n} | distinct MOs: ${mos.size}`);
