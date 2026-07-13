import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
const wb = XLSX.read(readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm"), { cellDates: false });
const dh = XLSX.utils.sheet_to_json(wb.Sheets["Daily Handover"], { header: 1, raw: true, defval: null });
let total = dh.length, nonEmpty = 0, numDate = 0, strDate = 0, deptOk = 0, planNums = {}, deptVals = {}, lastNonEmpty = 0;
for (let i = 1; i < dh.length; i++) {
  const r = dh[i]; if (!r) continue;
  const any = r.some((c) => c != null && String(c).trim() !== "");
  if (any) { nonEmpty++; lastNonEmpty = i + 1; }
  if (typeof r[0] === "number") numDate++;
  else if (r[0] != null && String(r[0]).trim() !== "") strDate++;
  const d = String(r[1] ?? "").trim(); if (d) deptVals[d] = (deptVals[d] || 0) + 1;
  if (d === "Cut" || d === "Welding") deptOk++;
  const p = r[5]; if (p != null && String(p).trim() !== "") planNums[String(p)] = (planNums[String(p)] || 0) + 1;
}
console.log({ total, nonEmpty, lastNonEmpty, numDate, strDate, deptOk });
console.log("dept values:", deptVals);
console.log("week/plan values:", planNums);
// show rows 150-165 to see the boundary
for (let i = 150; i < 168 && i < dh.length; i++) console.log(`r${i+1}:`, JSON.stringify((dh[i]||[]).map(c=>c==null?"":String(c))));
