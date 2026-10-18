import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";

// The planner's own time per piece, per item, per machine.
//
// The timings sheet prices a STAGE for a class of tank; it cannot know that a
// 6 kW laser cuts a top cover in half the time a punch does. Where the planner
// types a figure here it outranks the estimate: that machine's queue is priced
// with it, and the machine plan schedules the work with it, so the fast machines
// are given the work that suits them.

/** machine id → item → hours ONE piece costs on that machine. */
export type MachineRates = Record<number, Record<string, number>>;

export const getMachineItemTimes = cache(async (): Promise<MachineRates> => {
  const rows = await prisma.machineItemTime.findMany({ select: { machineId: true, item: true, hoursPerPc: true } });
  const out: MachineRates = {};
  for (const r of rows) {
    if (!(r.hoursPerPc > 0)) continue; // 0 or nonsense is "no figure"
    (out[r.machineId] ??= {})[r.item] = r.hoursPerPc;
  }
  return out;
});
