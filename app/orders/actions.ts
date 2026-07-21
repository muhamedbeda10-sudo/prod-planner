"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { importMonthlyPlan, type MonthlyImportResult } from "@/lib/server/importMonthly";
import { requirePerm } from "@/lib/server/auth";
import { ITEMS, isDept, isPaintExempt, deptLabel } from "@/lib/domain/constants";

/** Order lifecycle: close a finished order (drops out of the daily screens) or
 *  reopen it. Closing is a display/lifecycle state — the logs are untouched. */
export async function setOrderStatus(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.status");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const status = String(formData.get("status") ?? "");
  if (!mo) return { ok: false, error: "Missing MO." };
  if (status !== "open" && status !== "closed") return { ok: false, error: "Invalid status." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({
    where: { mo },
    data: { status, closedAt: status === "closed" ? new Date() : null },
  });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/report", "/trace"]) revalidatePath(p);
  return { ok: true };
}

/** Manually set an order's required quantity. The monthly import only RAISES
 *  quantities automatically — a revision that lowers one is just reported, and
 *  the planner confirms it here (a lowered qty may cancel produced work). */
export async function setOrderQty(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.qty");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const qty = Number(formData.get("qty"));
  if (!mo) return { ok: false, error: "Missing MO." };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Quantity must be a number > 0." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({ where: { mo }, data: { planQty: qty } });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/report", "/trace", "/"]) revalidatePath(p);
  return { ok: true };
}

/** tracker.priority — flag/unflag an order as PRIORITY: it shows in a dedicated
 *  table on top of every dept worklist until its work is done. */
export async function setOrderPriority(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.priority");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const priority = String(formData.get("priority") ?? "") === "true";
  if (!mo) return { ok: false, error: "Missing MO." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({ where: { mo }, data: { priority } });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
  return { ok: true };
}

/** tracker.push — send an order DOWN from the Plan Tracker to a dept's worklist:
 *  chosen quantity per item, each capped at the order's UNFINISHED remainder
 *  for that dept (in-house qty − dept output). Replaces any previous push of
 *  this MO to the same dept; all-zero quantities just clear it. */
export async function pushOrderToWorklist(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.push");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const dept = String(formData.get("dept") ?? "");
  if (!mo) return { ok: false, error: "Missing MO." };
  if (!isDept(dept)) return { ok: false, error: "Invalid department." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  if (order.status !== "open") return { ok: false, error: `MO ${mo} is closed.` };

  const sums = await prisma.handoverEntry.groupBy({
    by: ["item"],
    where: { mo, dept },
    _sum: { qty: true },
  });
  const done = new Map(sums.map((s) => [s.item, s._sum.qty ?? 0]));
  const osp = { CF: order.ospCF, TC: order.ospTC, TN: order.ospTN, CB: order.ospCB } as const;
  const excluded = new Set((order.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const lines: { item: string; qty: number }[] = [];
  for (const item of ITEMS) {
    const raw = String(formData.get(`qty${item}`) ?? "").trim();
    if (!raw) continue;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: `${item}: quantity must be a number ≥ 0.` };
    if (qty === 0) continue;
    if (excluded.has(item)) return { ok: false, error: `${item} is N/A for this order.` };
    if (dept === "Painting" && isPaintExempt(item)) return { ok: false, error: `${item} is never painted — it cannot go to the Painting worklist.` };
    const remaining = Math.max(0, order.planQty - osp[item] - (done.get(item) ?? 0));
    if (qty > remaining) {
      return { ok: false, error: `${item}: only ${remaining} pcs remain un-${dept === "Cut" ? "cut" : dept === "Welding" ? "welded" : "painted"} — cannot send ${qty}.` };
    }
    lines.push({ item, qty });
  }

  await prisma.$transaction(async (tx) => {
    await tx.worklistPush.deleteMany({ where: { dept, mo } });
    if (lines.length > 0) {
      await tx.worklistPush.createMany({
        data: lines.map((l) => ({ dept, bom: order.bom, mo, item: l.item, qty: l.qty, createdBy: guard.user?.name ?? null })),
      });
    }
  });
  for (const p of ["/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
  return lines.length > 0
    ? { ok: true }
    : { ok: false, error: `Nothing sent — enter a quantity for at least one item (the ${deptLabel(dept)} push was cleared).` };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07" (from <input type="month">) → "July 2026". */
function monthLabel(value: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return null;
  return `${MONTHS[idx]} ${m[1]}`;
}

/** Mark which components an order does NOT need (e.g. no Cable Box for this
 *  project). The plan sheets can't express this, so it is set on the tracker.
 *  Excluded items leave the cut worklist and stop gating completion/OTD. */
export async function setExcludedItems(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.components");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const raw = String(formData.get("excluded") ?? "").trim(); // CSV of CF/TC/TN/CB
  if (!mo) return { ok: false, error: "Missing MO." };
  const items = raw ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
  if (items.some((i) => !["CF", "TC", "TN", "CB"].includes(i))) return { ok: false, error: "Invalid component." };
  if (items.length === 4) return { ok: false, error: "An order cannot exclude all four components." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({
    where: { mo },
    data: { excludedItems: items.length > 0 ? items.join(",") : null },
  });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/report", "/trace", "/"]) revalidatePath(p);
  return { ok: true };
}

export async function importMonthlyAction(formData: FormData): Promise<MonthlyImportResult> {
  const guard = await requirePerm("plans.import");
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file." };
  const label = monthLabel(String(formData.get("month") ?? ""));
  if (!label) return { ok: false, error: "Pick the plan month." };
  try {
    const buffer = await file.arrayBuffer();
    const preview = formData.get("preview") === "on"; // dry-run: report only, write nothing
    const res = await importMonthlyPlan(buffer, label, preview);
    if (res.ok && !preview) revalidatePath("/orders");
    return res;
  } catch (e) {
    return { ok: false, error: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
