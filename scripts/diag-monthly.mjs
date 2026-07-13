import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Monthly plan.xlsx";
const wb = XLSX.read(readFileSync(path), { cellDates: false });
console.log("sheets:", wb.SheetNames);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  console.log(`\n### "${name}"  ref=${ws["!ref"]}`);
  const opts = { header: 1, raw: true, defval: null, blankrows: true };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  range.s.r = 0; range.s.c = 0;
  opts.range = XLSX.utils.encode_range(range);
  const grid = XLSX.utils.sheet_to_json(ws, opts);
  console.log("rows:", grid.length, "| widest:", Math.max(...grid.map((r) => (r ? r.length : 0))));
  for (let i = 0; i < Math.min(12, grid.length); i++) {
    const row = (grid[i] ?? []).slice(0, 14).map((v) => (v === null ? "" : (typeof v === "number" ? v : String(v).slice(0, 22))));
    console.log(`r${i + 1}:`, JSON.stringify(row));
  }
}
