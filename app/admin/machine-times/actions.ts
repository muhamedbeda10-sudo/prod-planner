"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { ITEMS } from "@/lib/domain/constants";

// The planner's own time per piece, per item, per machine. Where a figure is
// set it outranks the standard-times estimate: the machine's queue is priced
// with it and the machine plan schedules the work with it. Clearing a cell puts
// that machine back on the estimate.

export interface TimesActionResult {
  ok: boolean;
  error?: string;
  saved?: number;
  cleared?: number;
}

/** Save one department's grid. Fields are `t:<machineId>:<item>`; a blank
 *  value means "no figure — use the estimate". */
export async function saveMachineItemTimes(fd: FormData): Promise<TimesActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const set: { machineId: number; item: string; hoursPerPc: number }[] = [];
  const clear: { machineId: number; item: string }[] = [];
  for (const [k, raw] of fd.entries()) {
    const m = /^t:(\d+):([A-Z]{2})$/.exec(k);
    if (!m) continue;
    const machineId = Number(m[1]);
    const item = m[2];
    if (!(ITEMS as readonly string[]).includes(item)) continue;
    const text = String(raw).trim();
    if (!text) {
      clear.push({ machineId, item });
      continue;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `"${text}" is not a time — give the hours one piece takes, or leave it empty.` };
    if (n > 500) return { ok: false, error: "That is more than 500 hours for one piece — check the figure." };
    set.push({ machineId, item, hoursPerPc: Math.round(n * 1000) / 1000 });
  }
  if (set.length === 0 && clear.length === 0) return { ok: true, saved: 0, cleared: 0 };

  const by = guard.user?.name ?? null;
  const cleared = await prisma.$transaction(async (tx) => {
    let gone = 0;
    if (clear.length > 0) {
      const { count } = await tx.machineItemTime.deleteMany({ where: { OR: clear.map((c) => ({ machineId: c.machineId, item: c.item })) } });
      gone = count;
    }
    for (const s of set) {
      await tx.machineItemTime.upsert({
        where: { machineId_item: { machineId: s.machineId, item: s.item } },
        create: { ...s, setBy: by },
        update: { hoursPerPc: s.hoursPerPc, setBy: by },
      });
    }
    return gone;
  });

  for (const p of ["/admin/machine-times", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
  return { ok: true, saved: set.length, cleared };
}
