import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { computeDailyReport } from "../lib/domain/report.ts";
import { makeBomGrouper } from "../lib/domain/bom.ts";
import { excelSerialToDate } from "../lib/domain/dates.ts";

const wb = XLSX.read(readFileSync("reference/workbook/Production_Master_Excel.xlsm"), { cellDates: false });
const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
const S = (v) => (v == null ? "" : String(v).trim());
const N = (v) => (typeof v === "number" ? v : Number(v)) || 0;

const po = rows("Plan Orders");
const orders = [];
for (let i = 1; i < po.length; i++) { const r = po[i]; if (r && S(r[1])) orders.push({ planNo: N(r[0]), bom: S(r[1]), mo: S(r[3]), description: S(r[4]), item: S(r[5]), requiredQty: N(r[6]), targetQty: N(r[8]) }); }
const dh = rows("Daily Handover");
const logs = [];
for (let i = 1; i < dh.length; i++) { const r = dh[i]; if (r && S(r[2]) && typeof r[0] === "number") logs.push({ date: excelSerialToDate(N(r[0])), dept: S(r[1]), bom: S(r[2]), item: S(r[3]), qty: N(r[4]), planNo: N(r[5]) }); }

const grouper = makeBomGrouper(orders.map((o) => o.bom));
const target = 27;
const DAY = 46211;
const rep = computeDailyReport(orders, logs, excelSerialToDate(DAY), target, grouper);

// Expected from Daily Report sheet rows 6-7 (0-based rows 5-6)
const dr = rows("Daily Report");
const expected = { Cut: dr[5], Welding: dr[6] };
let mism = 0;
for (const d of rep.deptOutputs) {
  const e = expected[d.dept];
  const exp = { CF: N(e[1]), TC: N(e[2]), TN: N(e[3]), CB: N(e[4]), total: N(e[5]), sets: N(e[7]), eff: N(e[8]), bal: e[9] === "" || e[9] == null ? null : N(e[9]) };
  const probs = [];
  for (const it of ["CF", "TC", "TN", "CB"]) if (d.items[it] !== exp[it]) probs.push(`${it} ${d.items[it]}!=${exp[it]}`);
  if (d.total !== exp.total) probs.push(`total ${d.total}!=${exp.total}`);
  if (d.sets !== exp.sets) probs.push(`sets ${d.sets}!=${exp.sets}`);
  if (Math.abs(d.efficiency - exp.eff) > 1e-4) probs.push(`eff ${d.efficiency.toFixed(4)}!=${exp.eff}`);
  if (exp.bal !== null && Math.abs((d.balance ?? -9) - exp.bal) > 1e-4) probs.push(`bal ${d.balance}!=${exp.bal}`);
  console.log(`${d.dept}: ${probs.length ? "MISMATCH " + probs.join(", ") : "OK"}  (CF${d.items.CF} TC${d.items.TC} TN${d.items.TN} CB${d.items.CB} tot${d.total} sets${d.sets} eff${d.efficiency.toFixed(3)} bal${d.balance?.toFixed(2)})`);
  mism += probs.length ? 1 : 0;
}
console.log(`\nProjects worked today: ${rep.projects.length}`);
console.log(`Dept mismatches: ${mism}`);
