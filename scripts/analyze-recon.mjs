// Deep-dive: reconciliation 28 vs 27 + root-cause breakdown.
import { PrismaClient } from "@prisma/client";
import { computeReconciliation } from "../lib/domain/reconcile.ts";

const prisma = new PrismaClient();
const CUR = 28, PREV = 27;

const [curOrders, prevOrders, weldPrevRows, weldAllRows] = await Promise.all([
  prisma.planOrder.findMany({ where: { planNo: CUR } }),
  prisma.planOrder.findMany({ where: { planNo: PREV } }),
  prisma.handoverEntry.findMany({ where: { planNo: PREV, dept: "Welding" } }),
  prisma.handoverEntry.findMany({ where: { dept: "Welding" } }),
]);
const agg = (rows) => {
  const m = new Map();
  for (const h of rows) m.set(`${h.bom}|${h.item}`, (m.get(`${h.bom}|${h.item}`) ?? 0) + h.qty);
  return m;
};
const rows = computeReconciliation(
  curOrders.map((o) => ({ bom: o.bom, mo: o.mo, item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty, plannerBalance: o.plannerBalance })),
  prevOrders.map((o) => ({ bom: o.bom, mo: o.mo, item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty })),
  agg(weldPrevRows),
  agg(weldAllRows)
);

console.log(`TOTAL review rows: ${rows.length}`);
const byCat = {};
const bySev = {};
let balConflicts = 0;
for (const r of rows) {
  byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  bySev[r.severity] = (bySev[r.severity] ?? 0) + 1;
  if (r.balanceConflict) balConflicts++;
}
console.log("by category:", byCat);
console.log("by severity:", bySev);
console.log("balance conflicts:", balConflicts);

// distinct BOMs per category
const bomsOf = (cat) => [...new Set(rows.filter((r) => r.category === cat).map((r) => r.bom))];
console.log(`\nDROPPED_WITH_BACKLOG boms (${bomsOf("DROPPED_WITH_BACKLOG").length}):`, bomsOf("DROPPED_WITH_BACKLOG").join(", "));
console.log(`\nNEW boms (${bomsOf("NEW").length}):`, bomsOf("NEW").join(", "));

// CONTINUED delta distribution
const cont = rows.filter((r) => r.category === "CONTINUED");
const deltaPlus = cont.filter((r) => r.delta > 0);
const deltaMinus = cont.filter((r) => r.delta < 0);
console.log(`\nCONTINUED with delta: ${cont.length} (+${deltaPlus.length} / -${deltaMinus.length})`);
console.log("worst 10 CONTINUED by |delta|:");
[...cont].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10).forEach((r) =>
  console.log(`  ${r.bom} ${r.item}: old=${r.oldTarget} weldedPrev=${r.weldedPrev} expected=${r.expected} new=${r.newTarget} delta=${r.delta > 0 ? "+" : ""}${r.delta}${r.balanceConflict ? ` [BAL: remark=${r.plannerBalance} actual=${r.actualRemaining}]` : ""}`)
);

console.log("\nworst 10 BALANCE conflicts:");
rows.filter((r) => r.balanceConflict).sort((a, b) => Math.abs((b.plannerBalance ?? 0) - (b.actualRemaining ?? 0)) - Math.abs((a.plannerBalance ?? 0) - (a.actualRemaining ?? 0))).slice(0, 10).forEach((r) =>
  console.log(`  ${r.bom} ${r.item} [${r.category}]: remark says ${r.plannerBalance}, actual remaining ${r.actualRemaining} (req from orders, welded all-time)`)
);

console.log("\nDROPPED_WITH_BACKLOG detail:");
rows.filter((r) => r.category === "DROPPED_WITH_BACKLOG").slice(0, 20).forEach((r) =>
  console.log(`  ${r.bom} ${r.item}: oldTarget=${r.oldTarget} weldedPrev=${r.weldedPrev} backlog=${r.backlog}`)
);

// cross-check: are "dropped" boms really absent, or present under a DIFFERENT code (family sibling)?
const curBoms = new Set(curOrders.map((o) => o.bom));
const groupKey = (u) => { const m = /^(.+?)E\d+(M\d+)$/.exec(u); return m ? `${m[1]}|${m[2]}` : u; };
const curKeys = new Set([...curBoms].map(groupKey));
console.log("\nDropped boms whose FAMILY exists in plan 28 under another code:");
for (const b of bomsOf("DROPPED_WITH_BACKLOG")) {
  if (!curBoms.has(b) && curKeys.has(groupKey(b))) {
    const siblings = [...curBoms].filter((c) => groupKey(c) === groupKey(b));
    console.log(`  ${b} -> plan 28 has sibling(s): ${siblings.join(", ")}`);
  }
}
console.log("\nNEW boms whose FAMILY existed in plan 27 under another code:");
const prevBoms = new Set(prevOrders.map((o) => o.bom));
const prevKeys = new Set([...prevBoms].map(groupKey));
for (const b of bomsOf("NEW")) {
  if (!prevBoms.has(b) && prevKeys.has(groupKey(b))) {
    const siblings = [...prevBoms].filter((c) => groupKey(c) === groupKey(b));
    console.log(`  ${b} -> plan 27 had sibling(s): ${siblings.join(", ")}`);
  }
}
await prisma.$disconnect();
