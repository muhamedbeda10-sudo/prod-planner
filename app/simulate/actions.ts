"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin, requirePerm } from "@/lib/server/auth";
import { parseScenario, scenarioName } from "@/lib/domain/whatifScenario";

export interface SimActionResult {
  ok: boolean;
  error?: string;
}

const revalidate = () => {
  for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
};

/** Save (or overwrite) a named scenario — the knobs, queue and splits as one
 *  blob, checked first: a saved scenario is everyone's to load. */
export async function saveScenario(fd: FormData): Promise<SimActionResult> {
  const guard = await requirePerm("simulator.edit");
  if (guard.error) return { ok: false, error: guard.error };

  const name = scenarioName(fd.get("name"));
  if (!name) return { ok: false, error: "Give the scenario a name." };
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("data") ?? ""));
  } catch {
    return { ok: false, error: "Malformed scenario." };
  }
  const checked = parseScenario(raw);
  if (!checked.ok) return { ok: false, error: checked.error };
  const data = JSON.parse(JSON.stringify(checked.scenario));
  await prisma.simScenario.upsert({
    where: { name },
    create: { name, data, savedBy: guard.user!.name },
    update: { data, savedBy: guard.user!.name },
  });
  return { ok: true };
}

export async function deleteScenario(fd: FormData): Promise<SimActionResult> {
  const guard = await requirePerm("simulator.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const name = scenarioName(fd.get("name"));
  const r = await prisma.simScenario.deleteMany({ where: { name } });
  if (r.count === 0) return { ok: false, error: `No saved scenario is called "${name}".` };
  return { ok: true };
}

export interface RunOrderLine {
  mo: string;
  item: string;
  batchQty: number | null;
  batchNo: number | null;
}

const MAX_RUN_ORDER = 500;

/** A run order's lines, each checked, or what is wrong with them. */
function readRunOrder(raw: unknown): RunOrderLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Malformed run order." };
  if (raw.length > MAX_RUN_ORDER) return { error: "Run order too long." };
  const out: RunOrderLine[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    const mo = typeof e?.mo === "string" ? e.mo.trim() : "";
    const item = typeof e?.item === "string" ? e.item.trim() : "";
    const batchQty = e?.batchQty === null || e?.batchQty === undefined ? null : Number(e.batchQty);
    const batchNo = e?.batchNo === null || e?.batchNo === undefined ? null : Number(e.batchNo);
    if (!mo || mo.length > 80 || !item || item.length > 20) return { error: "Malformed run order." };
    if (batchQty !== null && !(Number.isFinite(batchQty) && batchQty > 0)) return { error: "Malformed run order." };
    if (batchNo !== null && !(Number.isInteger(batchNo) && batchNo > 0)) return { error: "Malformed run order." };
    out.push({ mo, item, batchQty, batchNo });
  }
  return out;
}

/** Commit the scenario's queue as THE run order: every dept worklist shows
 *  its slice of this sequence until it is replaced or cleared. Admin only —
 *  this is the button that moves the real factory. */
export async function applyRunOrder(fd: FormData): Promise<SimActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("entries") ?? ""));
  } catch {
    return { ok: false, error: "Malformed run order." };
  }
  const entries = readRunOrder(raw);
  if ("error" in entries) return { ok: false, error: entries.error };

  await prisma.$transaction([
    prisma.runOrderEntry.deleteMany({}),
    prisma.runOrderEntry.createMany({
      data: entries.map((e, i) => ({
        rank: i + 1,
        mo: e.mo,
        item: e.item,
        batchQty: e.batchQty ?? null,
        batchNo: e.batchNo ?? null,
        appliedBy: guard.user!.name,
      })),
    }),
  ]);
  revalidate();
  return { ok: true };
}

/** Take the run order back off the worklists. */
export async function clearRunOrder(): Promise<SimActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.runOrderEntry.deleteMany({});
  revalidate();
  return { ok: true };
}
