import "server-only";
import { prisma } from "@/lib/db";
import { parseLayout, type FloorLayoutData } from "@/lib/domain/floor";

/** The drawn floor of one department — empty until the planner draws it. */
export async function getFloorLayout(dept: string): Promise<{ layout: FloorLayoutData; updatedBy: string | null; updatedAtISO: string | null }> {
  const row = await prisma.floorLayout.findUnique({ where: { dept } });
  return {
    layout: parseLayout(row?.data ?? null),
    updatedBy: row?.updatedBy ?? null,
    updatedAtISO: row ? row.updatedAt.toISOString() : null,
  };
}
