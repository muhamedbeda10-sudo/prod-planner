import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const before = await p.handoverEntry.count();
const moves = await p.reallocationMove.count();
await p.reallocationMove.deleteMany();
await p.handoverEntry.deleteMany();
console.log(`Wiped ${before} log entries + ${moves} reallocation moves.`);
console.log("Remaining: logs =", await p.handoverEntry.count(), "| plans =", (await p.plan.findMany()).map(x => x.planNo).join(", "), "| plan orders =", await p.planOrder.count());
await p.$disconnect();
