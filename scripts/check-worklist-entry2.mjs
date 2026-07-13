import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const rows = await p.handoverEntry.findMany({ where: { source: "worklist" } });
console.log(JSON.stringify(rows.map(r => ({ id: r.id, date: r.date.toISOString().slice(0,10), dept: r.dept, bom: r.bom, mo: r.mo, item: r.item, qty: r.qty, planNo: r.planNo })), null, 1));
await p.$disconnect();
