"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { importMonthlyPlan, type MonthlyImportResult } from "@/lib/server/importMonthly";
import { requirePerm, requireAdmin } from "@/lib/server/auth";
import { applicableItems, ospOf, eligibleItems, isDept, isPaintExempt, deptLabel, type Item } from "@/lib/domain/constants";

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

/** The order's spec columns — Fins, Colour RAL, CRC size, SFM. No monthly
 *  sheet carries them in a form the import can trust, so the planner types
 *  them on the tracker and a re-import never touches them. All four are free
 *  text: a spec is a size on some orders and a dash on others, and the dashes
 *  he types are worth keeping as typed. */
const SPEC_FIELDS = ["fins", "colorRal", "crcSize", "sfm"] as const;
type SpecField = (typeof SPEC_FIELDS)[number];
const SPEC_LABEL: Record<SpecField, string> = { fins: "Fins", colorRal: "Colour", crcSize: "CRC size", sfm: "SFM" };
const isSpecField = (v: string): v is SpecField => (SPEC_FIELDS as readonly string[]).includes(v);

export async function setOrderSpec(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.qty");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  if (!mo) return { ok: false, error: "Missing MO." };
  const field = String(formData.get("field") ?? "");
  if (!isSpecField(field)) return { ok: false, error: "Unknown spec column." };
  const raw = String(formData.get("value") ?? "").trim();
  if (raw.length > 40) return { ok: false, error: `Keep ${SPEC_LABEL[field]} under 40 characters.` };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({ where: { mo }, data: { [field]: raw || null } });
  for (const p of ["/tracker", "/orders"]) revalidatePath(p);
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

  // applicableItems already drops N/A components and AR/MB the order's rule
  // doesn't match — only the order's real components can be pushed.
  const lines: { item: string; qty: number }[] = [];
  for (const item of applicableItems(order)) {
    const raw = String(formData.get(`qty${item}`) ?? "").trim();
    if (!raw) continue;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: `${item}: quantity must be a number ≥ 0.` };
    if (qty === 0) continue;
    if (dept === "Painting" && isPaintExempt(item)) return { ok: false, error: `${item} is never painted — it cannot go to the Painting worklist.` };
    const remaining = Math.max(0, order.planQty - ospOf(order, item) - (done.get(item) ?? 0));
    if (qty > remaining) {
      return { ok: false, error: `${item}: only ${remaining} pcs remain un-${dept === "Cut" ? "cut" : dept === "Welding" ? "welded" : "painted"} — cannot send ${qty}.` };
    }
    lines.push({ item, qty });
  }

  await prisma.$transaction(async (tx) => {
    await tx.worklistPush.deleteMany({ where: { dept, mo } });
    if (lines.length > 0) {
      await tx.worklistPush.createMany({
        // baseDone = the dept total NOW: only output recorded AFTER the push
        // consumes the pushed quantity (work done before is never re-counted)
        data: lines.map((l) => ({ dept, bom: order.bom, mo, item: l.item, qty: l.qty, baseDone: done.get(l.item) ?? 0, createdBy: guard.user?.name ?? null })),
      });
    }
  });
  for (const p of ["/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
  return lines.length > 0
    ? { ok: true }
    : { ok: false, error: `Nothing sent — enter a quantity for at least one item (the ${deptLabel(dept)} push was cleared).` };
}

/** ADMIN ONLY — remove a wrongly-tagged plan month from an order (the 🔁
 *  badge editor on the tracker). At least one month must remain. */
export async function removeOrderMonth(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const monthLabel = String(formData.get("month") ?? "").trim();
  if (!mo || !monthLabel) return { ok: false, error: "Missing MO / month." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  const months = (order.months || order.source || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!months.includes(monthLabel)) return { ok: false, error: `${mo} is not tagged with ${monthLabel}.` };
  if (months.length <= 1) return { ok: false, error: "An order must keep at least one plan month." };
  await prisma.masterOrder.update({
    where: { mo },
    data: { months: months.filter((m) => m !== monthLabel).join(",") },
  });
  for (const p of ["/tracker", "/orders"]) revalidatePath(p);
  return { ok: true };
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
  const raw = String(formData.get("excluded") ?? "").trim(); // CSV of the order's components
  if (!mo) return { ok: false, error: "Missing MO." };
  const items = raw ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  // only the order's own components (base four + AR/MB when its KVA/rating match)
  // can be marked N/A, and it must keep at least one
  const eligible = eligibleItems(order);
  if (items.some((i) => !eligible.includes(i as Item))) return { ok: false, error: "Invalid component." };
  if (eligible.every((i) => items.includes(i))) return { ok: false, error: "An order cannot exclude all its components." };
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

// ---- Deleting orders out of the registry ----

/** What a delete would take with it, and what it would leave behind. An order
 *  that has RECORDED WORK against it is not a mistaken import — deleting it
 *  would orphan the ledger, so the registry says so and refuses unless the
 *  planner confirms it deliberately. */
export interface OrderDeletePreview {
  mo: string;
  bom: string;
  planQty: number;
  /** Pieces already recorded against the MO in the daily log. */
  loggedQty: number;
  loggedRows: number;
  /** Serial-tracked tanks born from it. */
  tanks: number;
  /** Planning rows that go with it (worklist dates, hides, pushes, machine
   *  placements, run order, queue notes) — none of them is history. */
  planningRows: number;
}

/** Count what hangs off each MO, so the delete button can say it out loud. */
export async function previewOrderDelete(formData: FormData): Promise<{ ok: boolean; error?: string; rows?: OrderDeletePreview[] }> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const mos = parseMos(formData.get("mos"));
  if (mos.length === 0) return { ok: false, error: "Pick at least one order." };
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: mos } } });
  if (orders.length === 0) return { ok: false, error: "None of those MOs is in the registry." };

  const [ledger, tanks, dates, hides, pushes, machines, runOrder, notes] = await Promise.all([
    prisma.handoverEntry.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _sum: { qty: true }, _count: { _all: true } }),
    prisma.tankUnit.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.worklistDateOverride.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.worklistLineHide.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.worklistPush.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.worklistMachine.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.runOrderEntry.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
    prisma.queueNote.groupBy({ by: ["mo"], where: { mo: { in: mos } }, _count: { _all: true } }),
  ]);
  const count = (g: { mo: string | null; _count: { _all: number } }[], mo: string) =>
    g.find((x) => x.mo === mo)?._count._all ?? 0;

  return {
    ok: true,
    rows: orders.map((o) => {
      const l = ledger.find((x) => x.mo === o.mo);
      return {
        mo: o.mo,
        bom: o.bom,
        planQty: o.planQty,
        loggedQty: l?._sum.qty ?? 0,
        loggedRows: l?._count._all ?? 0,
        tanks: count(tanks, o.mo),
        planningRows:
          count(dates, o.mo) + count(hides, o.mo) + count(pushes, o.mo) +
          count(machines, o.mo) + count(runOrder, o.mo) + count(notes, o.mo),
      };
    }),
  };
}

/**
 * Delete orders out of the registry — the way back from an import that brought
 * in orders that do not belong (a wrong sheet, a duplicated month, a plan that
 * was cancelled).
 *
 * It takes the registry row and the PLANNING layers keyed on that MO with it:
 * worklist date overrides, hidden lines, pushes, machine placements, run order
 * and queue notes. Those only ever described how the order was going to be
 * worked, so they are meaningless without it.
 *
 * It never touches HISTORY — daily-log entries, returns, serial-tracked tanks,
 * material lines and Odoo rows all stay exactly as recorded. An order that has
 * any of that is refused unless `force` says the planner means it, and then
 * what it leaves behind is reported rather than quietly dropped.
 */
export async function deleteOrders(formData: FormData): Promise<{ ok: boolean; error?: string; deleted?: number; keptLedgerRows?: number }> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const mos = parseMos(formData.get("mos"));
  if (mos.length === 0) return { ok: false, error: "Pick at least one order." };
  const force = String(formData.get("force") ?? "") === "true";

  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: mos } }, select: { mo: true } });
  if (orders.length === 0) return { ok: false, error: "None of those MOs is in the registry." };
  const keys = orders.map((o) => o.mo);

  const [loggedRows, tankRows] = await Promise.all([
    prisma.handoverEntry.count({ where: { mo: { in: keys } } }),
    prisma.tankUnit.count({ where: { mo: { in: keys } } }),
  ]);
  if ((loggedRows > 0 || tankRows > 0) && !force) {
    const parts = [
      loggedRows > 0 ? `${loggedRows} daily-log entr${loggedRows === 1 ? "y" : "ies"}` : "",
      tankRows > 0 ? `${tankRows} tracked tank(s)` : "",
    ].filter(Boolean).join(" and ");
    return { ok: false, error: `Work is already recorded against this selection (${parts}). Tick "delete anyway" to remove the order and leave that history in place, or close the order instead.` };
  }

  await prisma.$transaction([
    prisma.worklistDateOverride.deleteMany({ where: { mo: { in: keys } } }),
    prisma.worklistLineHide.deleteMany({ where: { mo: { in: keys } } }),
    prisma.worklistPush.deleteMany({ where: { mo: { in: keys } } }),
    prisma.worklistMachine.deleteMany({ where: { mo: { in: keys } } }),
    prisma.runOrderEntry.deleteMany({ where: { mo: { in: keys } } }),
    prisma.queueNote.deleteMany({ where: { mo: { in: keys } } }),
    prisma.masterOrder.deleteMany({ where: { mo: { in: keys } } }),
  ]);

  for (const p of ["/orders", "/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/report", "/trace", "/"]) revalidatePath(p);
  return { ok: true, deleted: keys.length, keptLedgerRows: loggedRows };
}

/** The selection as it comes off the form: a CSV of MOs, deduped and capped so
 *  one click can never sweep the whole registry by accident. */
function parseMos(raw: FormDataEntryValue | null): string[] {
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].slice(0, 500);
}
