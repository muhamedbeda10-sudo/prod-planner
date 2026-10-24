import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import type { StdData } from "@/lib/domain/stdEngine";
import { isWorkCentre } from "@/lib/domain/shifts";

/** The standard-times data as the app uses it — straight from the DB (seeded
 *  by migration from the engineering timings sheet, edited in Admin →
 *  Standard Times). Cached per request. */
export const getStdData = cache(async (): Promise<StdData> => {
  const [tiers, fgs, centres] = await Promise.all([
    prisma.stdTime.findMany(),
    prisma.stdFgMap.findMany(),
    prisma.centerStdTime.findMany(),
  ]);
  const centre: NonNullable<StdData["centre"]> = {};
  for (const c of centres) {
    if (!isWorkCentre(c.center)) continue;
    ((centre[c.kva] ??= {})[c.item] ??= {})[c.center] = c.hoursPerPc;
  }
  return {
    tiers: Object.fromEntries(tiers.map((t) => [t.kva, { cut: t.cutMh, weld: t.weldMh, shb: t.shbMh, paint: t.paintMh }])),
    fgMap: Object.fromEntries(fgs.map((f) => [f.fg, f.kva])),
    centre,
  };
});

/** Available man-hours per WORKING DAY per stage (Cut / Welding / ShotBlast /
 *  Painting). A stage with no row simply has no capacity figure yet. */
export const getStageCapacity = cache(async (): Promise<Record<string, number>> => {
  const rows = await prisma.stageCapacity.findMany();
  return Object.fromEntries(rows.map((r) => [r.dept, r.mhPerDay]));
});
