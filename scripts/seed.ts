/**
 * Migration seed — loads the legacy workbook into SQLite.
 *
 *   Lists          -> Settings (J2:J5) + Plan registry (E:F -> Plan headers)
 *   Plans          -> PlanSchedule  (A:H)
 *   Plan Orders    -> PlanOrder     (A:J)
 *   Daily Handover -> HandoverEntry (A:F)
 *
 * Excel serial dates are converted to UTC-midnight dates. Idempotent: wipes and
 * reloads every table. Run with:  npm run seed  [-- "path\to.xlsm"]
 */
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { excelSerialToDate } from "../lib/domain/dates";
import { isItem, isDept } from "../lib/domain/constants";

const prisma = new PrismaClient();

const XLSM_PATH =
  process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm";

type Row = (string | number | boolean | null)[];

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found in workbook`);
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: null });
}

const S = (v: unknown): string => (v == null ? "" : String(v).trim());
const N = (v: unknown): number => (typeof v === "number" ? v : Number(v)) || 0;
const isNum = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v);

async function main() {
  console.log(`Reading workbook: ${XLSM_PATH}`);
  const wb = XLSX.read(readFileSync(XLSM_PATH), { cellDates: false });

  // ---- Settings (Lists!J2:J5) ----
  const lists = sheetRows(wb, "Lists");
  const J = 9; // column J (0-based)
  const val = (r: number, def: number) => (isNum(lists[r]?.[J]) ? N(lists[r][J]) : def);
  const settings = {
    leadCut: val(1, 2),
    leadWeld: val(2, 1),
    capacityPerItem: val(3, 27),
    dailyTarget: val(4, 27),
  };

  // ---- Plan registry (Lists!E2:F..) -> plan start dates ----
  const planStart = new Map<number, Date>();
  for (let i = 1; i < lists.length; i++) {
    const r = lists[i];
    if (!r) continue;
    const planNo = r[4]; // E
    const start = r[5]; // F
    if (isNum(planNo) && planNo !== 0 && isNum(start)) {
      planStart.set(planNo, excelSerialToDate(start));
    }
  }

  const plans = sheetRows(wb, "Plans");
  const orders = sheetRows(wb, "Plan Orders");
  const handover = sheetRows(wb, "Daily Handover");

  // Collect every planNo referenced anywhere so FK targets always exist.
  const referenced = new Set<number>();
  const collect = (rows: Row[], col: number, from = 1) => {
    for (let i = from; i < rows.length; i++) {
      const v = rows[i]?.[col];
      if (isNum(v) && v !== 0) referenced.add(v);
    }
  };
  collect(plans, 0);
  collect(orders, 0);
  collect(handover, 5);

  // Fallback start date (earliest oven date) for plans missing from the registry.
  const earliestOven = new Map<number, number>();
  for (let i = 1; i < plans.length; i++) {
    const r = plans[i];
    if (!r) continue;
    const p = r[0];
    const ov = r[6];
    if (isNum(p) && isNum(ov)) {
      earliestOven.set(p, Math.min(earliestOven.get(p) ?? Infinity, ov));
    }
  }

  const planHeaders: { planNo: number; startDate: Date }[] = [];
  for (const planNo of [...referenced, ...planStart.keys()].sort((a, b) => a - b)) {
    if (planHeaders.some((p) => p.planNo === planNo)) continue;
    let start = planStart.get(planNo);
    if (!start) {
      const ov = earliestOven.get(planNo);
      start = ov ? excelSerialToDate(ov) : new Date(0);
      console.warn(
        `⚠ Plan ${planNo} has no registry start date; falling back to ${
          ov ? "earliest oven date" : "epoch"
        }.`
      );
    }
    planHeaders.push({ planNo, startDate: start });
  }
  const validPlan = new Set(planHeaders.map((p) => p.planNo));

  // ---- Build rows ----
  const scheduleRows: Prisma.PlanScheduleCreateManyInput[] = [];
  let scheduleSkipped = 0;
  for (let i = 1; i < plans.length; i++) {
    const r = plans[i];
    if (!r) continue;
    const planNo = r[0];
    if (!isNum(planNo) || !validPlan.has(planNo)) continue;
    const item = S(r[5]);
    if (!isNum(r[6]) || !item) {
      scheduleSkipped++;
      continue;
    }
    scheduleRows.push({
      planNo,
      bom: S(r[1]),
      soi: S(r[2]) || null,
      mo: S(r[3]),
      description: S(r[4]) || null,
      item,
      ovenDate: excelSerialToDate(N(r[6])),
      qty: N(r[7]),
    });
  }

  const orderRows: Prisma.PlanOrderCreateManyInput[] = [];
  for (let i = 1; i < orders.length; i++) {
    const r = orders[i];
    if (!r) continue;
    const planNo = r[0];
    if (!isNum(planNo) || !validPlan.has(planNo)) continue;
    const mo = S(r[3]);
    const item = S(r[5]);
    if (!mo || !item) continue;
    const pb = r[7];
    orderRows.push({
      planNo,
      bom: S(r[1]),
      soi: S(r[2]) || null,
      mo,
      description: S(r[4]) || null,
      item,
      requiredQty: N(r[6]),
      plannerBalance: isNum(pb) ? N(pb) : null,
      targetQty: N(r[8]),
      remark: S(r[9]) || null,
    });
  }

  const handoverRows: Prisma.HandoverEntryCreateManyInput[] = [];
  let handoverSkipped = 0;
  for (let i = 1; i < handover.length; i++) {
    const r = handover[i];
    if (!r) continue;
    const date = r[0];
    const dept = S(r[1]);
    const planNo = r[5];
    if (!isNum(date) || !isDept(dept) || !isNum(planNo) || !validPlan.has(planNo)) {
      if (S(r[2]) || S(r[3])) handoverSkipped++;
      continue;
    }
    handoverRows.push({
      date: excelSerialToDate(date),
      dept,
      bom: S(r[2]),
      item: S(r[3]),
      qty: N(r[4]),
      planNo,
      source: "seed",
    });
  }

  // ---- Wipe + reload (idempotent) ----
  await prisma.$transaction([
    prisma.reallocationMove.deleteMany(),
    prisma.handoverEntry.deleteMany(),
    prisma.planSchedule.deleteMany(),
    prisma.planOrder.deleteMany(),
    prisma.plan.deleteMany(),
    prisma.settings.deleteMany(),
  ]);

  await prisma.settings.create({ data: { id: 1, ...settings } });
  await prisma.plan.createMany({ data: planHeaders });
  await prisma.planSchedule.createMany({ data: scheduleRows });
  await prisma.planOrder.createMany({ data: orderRows });
  // handover in chunks (SQLite variable limit)
  for (let i = 0; i < handoverRows.length; i += 500) {
    await prisma.handoverEntry.createMany({ data: handoverRows.slice(i, i + 500) });
  }

  console.log("\n=== Seed complete ===");
  console.log("Settings:", settings);
  console.log(`Plans:          ${planHeaders.length}  -> ${planHeaders.map((p) => p.planNo).join(", ")}`);
  console.log(`PlanSchedule:   ${scheduleRows.length}  (skipped ${scheduleSkipped} non-item/target rows)`);
  console.log(`PlanOrder:      ${orderRows.length}`);
  console.log(`HandoverEntry:  ${handoverRows.length}  (skipped ${handoverSkipped} unresolved rows)`);
  const withBalance = orderRows.filter((o) => o.plannerBalance != null).length;
  console.log(`  PlanOrders with a planner balance: ${withBalance}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
