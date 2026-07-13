// Replicates importHandoverFile's exact server logic against the real DB,
// printing where each row dies.
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseHandoverGrid, validateHandoverRow } from "../lib/domain/importHandover.ts";
import { buildBomClassifier } from "../lib/domain/normalizeBoms.ts";
import { dayNumber } from "../lib/domain/dates.ts";

const prisma = new PrismaClient();
const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Daily_HandOver_Welding.xlsx";

const wb = XLSX.read(readFileSync(path), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: false };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const grid = XLSX.utils.sheet_to_json(ws, opts);
const { rows } = parseHandoverGrid(grid);
console.log("parsed:", rows.length);

const known = (await prisma.planOrder.findMany({ select: { bom: true }, distinct: ["bom"], orderBy: { bom: "asc" } })).map((r) => r.bom).filter(Boolean);
const plans = await prisma.plan.findMany({ select: { planNo: true } });
console.log("known boms:", known.length, "| plans:", JSON.stringify(plans));

const classify = buildBomClassifier(known);
const validPlans = new Set(plans.map((p) => p.planNo));

let pass = 0;
for (const row of rows.slice(0, 20)) {
  const err = validateHandoverRow(row);
  if (err) { console.log(`r${row.rowNum}: INVALID -> ${err}`); continue; }
  if (!validPlans.has(row.planNo)) { console.log(`r${row.rowNum}: PLAN FAIL -> planNo=${row.planNo} (${typeof row.planNo}) not in`, [...validPlans]); continue; }
  const c = classify(row.bom);
  pass++;
  console.log(`r${row.rowNum}: OK  bom=${row.bom} -> ${c.status}${c.status === "corrected" ? " => " + c.corrected : ""}`);
}
console.log(`\npassed: ${pass}/${rows.length}`);
await prisma.$disconnect();
