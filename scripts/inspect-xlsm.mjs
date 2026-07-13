import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm";
const wb = XLSX.read(readFileSync(path), { cellDates: false });

console.log("=== SHEETS ===");
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws["!ref"] || "(empty)";
  const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  const rows = range ? range.e.r - range.s.r + 1 : 0;
  const cols = range ? range.e.c - range.s.c + 1 : 0;
  const merges = (ws["!merges"] || []).length;
  console.log(`- "${name}"  ref=${ref}  rows=${rows} cols=${cols} merges=${merges}`);
}

function dump(name, maxRows = 8) {
  const ws = wb.Sheets[name];
  if (!ws) { console.log(`\n### ${name}: NOT FOUND`); return; }
  console.log(`\n### ${name}`);
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  for (let i = 0; i < Math.min(maxRows, arr.length); i++) {
    const row = (arr[i] || []).slice(0, 32).map((v) => (v === null ? "" : String(v)));
    console.log(`r${i + 1}: ${JSON.stringify(row)}`);
  }
  console.log(`... total rows: ${arr.length}`);
}

for (const s of wb.SheetNames) dump(s, 6);
