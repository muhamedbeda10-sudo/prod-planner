import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { parseWeeklyPlan } from "../lib/domain/importPlan.ts";

const buf = readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\WEEK - 28 PLAN-FB UPDATED- WITH MO - SOI.xlsx");
const wb = XLSX.read(new Uint8Array(buf), { cellDates: false });
const ws = wb.Sheets["week-28"];
console.log("week-28 ref:", ws["!ref"]);

const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const grid = XLSX.utils.sheet_to_json(ws, opts);
console.log("rows:", grid.length, "| widest:", Math.max(...grid.map((r) => (r ? r.length : 0))));

console.log("\nrows 1-10 (cols A..H + AD):");
for (let i = 0; i < 10 && i < grid.length; i++) {
  const r = grid[i] ?? [];
  console.log(`r${i + 1}:`, JSON.stringify([r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]]), "AD=", JSON.stringify(r[29]));
}

const parsed = parseWeeklyPlan(grid);
console.log(`\nparse: ${parsed.orders.length} orders (${parsed.orderRowCount} rows), ${parsed.schedules.length} schedules, ${parsed.warnings.length} warnings`);
parsed.warnings.slice(0, 8).forEach((w) => console.log("  warn:", w.kind, "row", w.row, w.message.slice(0, 90)));
const rems = [...new Set(parsed.orders.filter((o) => o.remark).map((o) => o.remark))];
console.log("remarks:", rems.length);
rems.slice(0, 10).forEach((r) => console.log("  •", r));
const withBal = parsed.orders.filter((o) => o.plannerBalance != null).length;
console.log("orders with balance:", withBal);
