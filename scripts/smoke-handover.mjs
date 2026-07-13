import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const before = await prisma.handoverEntry.count();
const e = await prisma.handoverEntry.create({
  data: { date: new Date(Date.UTC(2026, 6, 10)), dept: "Cut", bom: "12011E13M12", item: "CF", qty: 3, planNo: 27, source: "smoke" },
});
const after = await prisma.handoverEntry.count();
console.log(`count ${before} -> ${after}, created id ${e.id}`);
await prisma.handoverEntry.delete({ where: { id: e.id } });
console.log(`cleaned up -> ${await prisma.handoverEntry.count()}`);
await prisma.$disconnect();
