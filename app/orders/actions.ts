"use server";

import { revalidatePath } from "next/cache";
import { emitEvent, listed } from "@/lib/server/events";
import { prisma } from "@/lib/db";
import { importMonthlyPlan, type MonthlyImportResult } from "@/lib/server/importMonthly";
import { requirePerm, requireAdmin, getCurrentUser, hasPerm } from "@/lib/server/auth";
import { applicableItems, ospOf, isDept, isPaintExempt, deptLabel, itemOverrides, isItem } from "@/lib/domain/constants";
import { finsGroup, spreadOverGroup } from "@/lib/domain/groupSpread";
import { getActiveLine } from "@/lib/server/line";
import { isLvFamily } from "@/lib/domain/lv";
import { linePermKey } from "@/lib/domain/permissions";
import { fullyDeliveredOpenOrders } from "@/lib/server/deliveredOrders";
import { finishedAndClosedInOdooOf } from "@/lib/server/odooAutoClose";
import { orderDeletePreview, type OrderDeletePreview } from "@/lib/server/orderDelete";
import { userMessage } from "@/lib/server/errors";
import { ORDER_TEXT_KEYS, orderTextValue, type OrderTextField } from "@/lib/domain/orderFields";

/** Order lifecycle: close a finished order (drops out of the daily screens) or
 *  reopen it. Closing is a display/lifecycle state — the logs are untouched. */
export async function setOrderStatus(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  // one MO, or the `mos` of a merged BOM row — its head closes / reopens them all
  const mos = String(formData.get("mos") ?? formData.get("mo") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const status = String(formData.get("status") ?? "");
  if (mos.length === 0) return { ok: false, error: "Missing MO." };
  if (status !== "open" && status !== "closed") return { ok: false, error: "Invalid status." };
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: mos } }, select: { mo: true, line: true } });
  if (orders.length === 0) return { ok: false, error: `MO ${mos[0]} not found.` };
  // a panel order closes behind the LV key, a transformer's behind the tracker's
  for (const line of new Set(orders.map((o) => o.line))) {
    const guard = await requirePerm(linePermKey(line, "status"));
    if (guard.error) return { ok: false, error: guard.error };
  }
  const found = orders.map((o) => o.mo);
  if (status === "closed") {
    await prisma.masterOrder.updateMany({ where: { mo: { in: found } }, data: { status, closedAt: new Date(), autoCloseOff: false, autoClosedAt: null } });
  } else {
    // reopened by hand while Odoo has it all closed, it stays open — it would
    // close by itself again within the hour — until someone closes it again;
    // any other reopen (an undo, an order taken off the plan) still closes by
    // itself once it is finished and Odoo has closed it all
    const odooFull = await finishedAndClosedInOdooOf(orders.filter((o) => o.line === "TR").map((o) => o.mo));
    await prisma.$transaction([
      prisma.masterOrder.updateMany({ where: { mo: { in: found.filter((m) => odooFull.has(m)) } }, data: { status, closedAt: null, autoCloseOff: true, autoClosedAt: null } }),
      prisma.masterOrder.updateMany({ where: { mo: { in: found.filter((m) => !odooFull.has(m)) } }, data: { status, closedAt: null, autoCloseOff: false, autoClosedAt: null } }),
    ]);
  }
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/trace"]) revalidatePath(p);
  await emitEvent({
    type: status === "closed" ? "order.closed" : "order.reopened",
    subject: listed(found),
    summary: `${status === "closed" ? "Closed" : "Reopened"} ${listed(found, 6)}`,
    data: { mos: found, reason: "tracker" },
  });
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
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"]) revalidatePath(p);
  return { ok: true };
}

/** The planner's answer to a qty a plan import held back: "use" writes the
 *  sheet's figure (pendingPlanQty) into the plan, "keep" leaves the old one.
 *  Either way the question is closed. `mos` may list several orders (the
 *  import screen's "use all" / "keep all"); an order with nothing pending is
 *  skipped. Needs the tracker's qty right or the line's import right. */
export async function decidePlanQty(formData: FormData): Promise<{ ok: boolean; error?: string; done?: number }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "You are not logged in — refresh the page." };
  const anyLine = hasPerm(me, "tracker.qty");
  if (!anyLine && !hasPerm(me, linePermKey(await getActiveLine(), "import"))) {
    return { ok: false, error: "You do not have permission to change plan quantities — ask the admin." };
  }
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "use" && decision !== "keep") return { ok: false, error: "Pick use or keep." };
  const mos = String(formData.get("mos") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (mos.length === 0) return { ok: false, error: "No order picked." };
  const orders = await prisma.masterOrder.findMany({
    where: { mo: { in: mos }, pendingPlanQty: { not: null } },
    select: { mo: true, pendingPlanQty: true, line: true },
  });
  if (orders.length === 0) return { ok: false, error: "Nothing is waiting on these orders any more." };
  // without the tracker's qty right, each order needs the import right of its own line
  const notMine = anyLine ? [] : orders.filter((o) => !hasPerm(me, linePermKey(o.line, "import")));
  if (notMine.length > 0) {
    return { ok: false, error: `You do not have permission to change the plan quantity of ${notMine.map((o) => o.mo).join(", ")} — ask the admin.` };
  }
  const clear = { pendingPlanQty: null, pendingQtyMonth: null, pendingQtyAt: null };
  await prisma.$transaction(
    orders.map((o) =>
      prisma.masterOrder.update({
        where: { mo: o.mo },
        data: decision === "use" && o.pendingPlanQty! > 0 ? { planQty: o.pendingPlanQty!, ...clear } : clear,
      })
    )
  );
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"]) revalidatePath(p);
  return { ok: true, done: orders.length };
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

/**
 * The same spec on every MO of a merged BOM row.
 *
 * A colour, a CRC size or an SFM belongs to the transformer, not to the slice
 * of it one MO happens to cover — typing it twelve times down an expanded
 * group was the planner copying a value the app could have copied itself. So
 * the group row takes it once and every member gets THAT value, unchanged.
 * Nothing is split: these are descriptions, not quantities.
 *
 * The BOM decides the members, not the page: a stale or filtered view can
 * never write a spec onto an order that is no longer part of the group.
 */
/**
 * FINS typed on a merged BOM row, and spread over the MOs under it.
 *
 * Fins is a count of the order's tanks that carry fins, not a property of the
 * BOM, so this one cannot behave like Colour or CRC: the planner types the
 * whole BOM's figure and the app fills the MOs the way he would by hand —
 * the first order finished before the second is touched, a reduction off the
 * last orders first. Nothing is clamped: a total the MOs cannot hold is
 * refused whole, naming what would fit.
 *
 * The MOs arrive in the order the row shows them, so the fill order is the
 * one he read in the preview; every one of them is checked against the BOM
 * here, so a stale or filtered page can never write onto an order that has
 * since left the group.
 */
export async function setGroupFins(formData: FormData): Promise<{ ok: boolean; error?: string; changed?: number }> {
  const guard = await requirePerm("tracker.qty");
  if (guard.error) return { ok: false, error: guard.error };
  const bom = String(formData.get("bom") ?? "").trim().toUpperCase();
  if (!bom) return { ok: false, error: "Missing BOM." };
  const mos = [...new Set(String(formData.get("mos") ?? "").split(",").map((m) => m.trim()).filter(Boolean))];
  if (mos.length === 0) return { ok: false, error: "The group has no MOs to spread over." };

  const raw = String(formData.get("total") ?? "").trim();
  const total = raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(total) || total < 0) return { ok: false, error: "Type the BOM's whole Fins count — a whole number, 0 or more." };

  const orders = await prisma.masterOrder.findMany({
    where: { mo: { in: mos } },
    select: { mo: true, bom: true, planQty: true, fins: true },
  });
  const byMo = new Map(orders.map((o) => [o.mo, o]));
  if (mos.some((mo) => byMo.get(mo)?.bom !== bom)) {
    return { ok: false, error: `An MO in the group is no longer on ${bom} — refresh the page.` };
  }
  const rows = mos.map((mo) => {
    const o = byMo.get(mo)!;
    return { mo, required: o.planQty, fins: o.fins };
  });

  const group = finsGroup(rows);
  if (!group) {
    return { ok: false, error: "One of these MOs has Fins written as text, not a number — set those MOs one at a time." };
  }
  const spread = spreadOverGroup(group.members, total - group.current);
  if (spread.left > 0) {
    const tanks = rows.reduce((s, r) => s + r.required, 0);
    return { ok: false, error: `Only ${group.current + spread.fits} fit — the ${rows.length} MOs carry ${tanks} tanks in all.` };
  }
  if (spread.alloc.length === 0) return { ok: true, changed: 0 };

  const now = new Map(rows.map((r) => [r.mo, Number((r.fins ?? "").trim() || 0)]));
  await prisma.$transaction(
    spread.alloc.map((a) => {
      const v = (now.get(a.mo) ?? 0) + a.qty;
      // nothing finned reads as an empty cell, the way it does before anyone
      // types on the line — "0 of them" and "none" are the same thing here
      return prisma.masterOrder.update({ where: { mo: a.mo }, data: { fins: v > 0 ? String(v) : null } });
    })
  );
  for (const p of ["/tracker", "/orders"]) revalidatePath(p);
  return { ok: true, changed: spread.alloc.length };
}

export async function setGroupOrderSpec(formData: FormData): Promise<{ ok: boolean; error?: string; changed?: number }> {
  const guard = await requirePerm("tracker.qty");
  if (guard.error) return { ok: false, error: guard.error };
  const bom = String(formData.get("bom") ?? "").trim().toUpperCase();
  if (!bom) return { ok: false, error: "Missing BOM." };
  const field = String(formData.get("field") ?? "");
  if (!isSpecField(field)) return { ok: false, error: "Unknown spec column." };
  const raw = String(formData.get("value") ?? "").trim();
  if (raw.length > 40) return { ok: false, error: `Keep ${SPEC_LABEL[field]} under 40 characters.` };

  const members = await prisma.masterOrder.findMany({ where: { bom }, select: { mo: true } });
  if (members.length === 0) return { ok: false, error: `No order carries BOM ${bom} — refresh the page.` };
  const res = await prisma.masterOrder.updateMany({
    where: { mo: { in: members.map((m) => m.mo) } },
    data: { [field]: raw || null },
  });
  for (const p of ["/tracker", "/orders"]) revalidatePath(p);
  return { ok: true, changed: res.count };
}

/** tracker.priority — flag/unflag an order as PRIORITY: it shows in a dedicated
 *  table on top of every dept worklist until its work is done. */
export async function setOrderPriority(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.priority");
  if (guard.error) return { ok: false, error: guard.error };
  // one MO, or the `mos` of a merged BOM row
  const mos = String(formData.get("mos") ?? formData.get("mo") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const priority = String(formData.get("priority") ?? "") === "true";
  if (mos.length === 0) return { ok: false, error: "Missing MO." };
  const res = await prisma.masterOrder.updateMany({ where: { mo: { in: mos } }, data: { priority } });
  if (res.count === 0) return { ok: false, error: `MO ${mos[0]} not found.` };
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
  return { ok: true };
}

const HOLD_PATHS = ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/punching", "/worklist/bending", "/trace", "/simulate"];

/** tracker.status — put an order ON HOLD, or release it. A held order stays
 *  open on the tracker (tinted, with the reason) and leaves every worklist
 *  queue and the ETA until released. Its logs are untouched. */
export async function setOrderHold(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const mos = String(formData.get("mos") ?? formData.get("mo") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const hold = String(formData.get("hold") ?? "") === "true";
  const note = String(formData.get("note") ?? "").trim().slice(0, 200) || null;
  if (mos.length === 0) return { ok: false, error: "Missing MO." };
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: mos } }, select: { mo: true, status: true, line: true } });
  if (orders.length === 0) return { ok: false, error: `MO ${mos[0]} not found.` };
  // each line's own key — a mixed selection needs both
  let guard: Awaited<ReturnType<typeof requirePerm>> = {};
  for (const line of [...new Set(orders.map((o) => o.line))]) {
    guard = await requirePerm(linePermKey(line, "status"));
    if (guard.error) return { ok: false, error: guard.error };
  }
  const closed = orders.filter((o) => o.status === "closed");
  if (hold && closed.length === orders.length) return { ok: false, error: "A closed order cannot be put on hold — reopen it first." };
  const touched = orders.filter((o) => o.status === "open").map((o) => o.mo);
  await prisma.masterOrder.updateMany({
    where: { mo: { in: touched } },
    data: hold ? { holdAt: new Date(), holdNote: note, holdBy: guard.user?.name ?? null } : { holdAt: null, holdNote: null, holdBy: null },
  });
  for (const p of HOLD_PATHS) revalidatePath(p);
  if (touched.length > 0) {
    await emitEvent({
      type: hold ? "order.held" : "order.released",
      subject: listed(touched),
      summary: hold ? `Put ${listed(touched, 6)} on hold${note ? ` — ${note}` : ""}` : `Released ${listed(touched, 6)} from hold`,
      data: { mos: touched, ...(note ? { note } : {}) },
    });
  }
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
  if (order.line === "LV") return { ok: false, error: `MO ${mo} is an LV panel order — panels are not pushed to the transformer worklists.` };

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

/** Which of the six components an order needs — the planner's ticks on the
 *  tracker, whatever the KVA/rating rule says. A tick against the rule forces
 *  the component on (an Arrester on an order the rule skipped); an untick
 *  against it marks the component N/A (no Cable Box for this project). Items
 *  not needed leave the cut worklist and stop gating completion/OTD. */
export async function setExcludedItems(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm("tracker.components");
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  const raw = String(formData.get("required") ?? "").trim(); // CSV of the ticked components
  if (!mo) return { ok: false, error: "Missing MO." };
  const needed = raw ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
  if (needed.some((i) => !isItem(i))) return { ok: false, error: "Invalid component." };
  if (needed.length === 0) return { ok: false, error: "An order needs at least one component." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  await prisma.masterOrder.update({ where: { mo }, data: itemOverrides(order, needed) });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"]) revalidatePath(p);
  return { ok: true };
}

export async function importMonthlyAction(formData: FormData): Promise<MonthlyImportResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "import"));
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file." };
  const label = monthLabel(String(formData.get("month") ?? ""));
  if (!label) return { ok: false, error: "Pick the plan month." };
  try {
    const buffer = await file.arrayBuffer();
    const preview = formData.get("preview") === "on"; // dry-run: report only, write nothing
    // the toggle at the top says which product the sheet plans
    const line = await getActiveLine();
    // the LV line imports two plans — the panels' and the meter boxes'
    const family = line === "LV" ? String(formData.get("family") ?? "") : "";
    if (!isLvFamily(family)) return { ok: false, error: "Pick which plan the sheet is." };
    // "add and update only" unless taking orders out is chosen on purpose —
    // a form that does not say (an older page, the assistant) keeps them
    const keepMissing = String(formData.get("missing") ?? "keep") !== "takeOut";
    const res = await importMonthlyPlan(buffer, label, preview, line, family, { keepMissing });
    if (res.ok && !preview) {
      revalidatePath("/orders");
      const removed = res.removed?.length ?? 0;
      await emitEvent({
        type: "plan.imported",
        subject: `${label}${line === "LV" ? " (LV)" : ""}`,
        summary: `Imported the ${label} plan${line === "LV" ? ` (LV${family ? `, ${family}` : ""})` : ""} — ${res.added ?? 0} new orders, ${res.updatedMos ?? 0} revised${removed ? `, ${removed} taken out` : ""}`,
        data: { kind: "monthly", month: label, line, added: res.added ?? 0, updated: res.updatedMos ?? 0, removed },
      });
      // the orders taken out with history behind them were closed, not deleted — say so as a close
      const closed = (res.removed ?? []).filter((r) => r.action === "closed").map((r) => r.mo);
      if (closed.length > 0) {
        await emitEvent({
          type: "order.closed",
          subject: listed(closed),
          summary: `Closed ${listed(closed, 6)} — not on the ${label} plan any more`,
          data: { mos: closed, reason: "import" },
        });
      }
    }
    return res;
  } catch (e) {
    return { ok: false, error: userMessage(e, "import the plan") };
  }
}

// ---- Deleting orders out of the registry ----

/** Count what hangs off each MO, so the delete button can say it out loud. */
export async function previewOrderDelete(formData: FormData): Promise<{ ok: boolean; error?: string; rows?: OrderDeletePreview[] }> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const mos = parseMos(formData.get("mos"));
  if (mos.length === 0) return { ok: false, error: "Pick at least one order." };
  const rows = await orderDeletePreview(mos);
  if (rows.length === 0) return { ok: false, error: "None of those MOs is in the registry." };
  return { ok: true, rows };
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

  for (const p of ["/orders", "/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"]) revalidatePath(p);
  return { ok: true, deleted: keys.length, keptLedgerRows: loggedRows };
}

/** The selection as it comes off the form: a CSV of MOs, deduped and capped so
 *  one click can never sweep the whole registry by accident. */
function parseMos(raw: FormDataEntryValue | null): string[] {
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].slice(0, 500);
}

// ---- closing the orders that are finished ----

/**
 * Close every OPEN order whose components have all reached the customer.
 *
 * The tracker can show which rows those are, but it must not be what decides:
 * the list is recomputed here from the registry and the ledger, so a stale
 * page, a filter, or a hand-made request can never close an order that is
 * still short. The planner's click says "close the finished ones", not "close
 * these ones".
 */
export async function closeDeliveredOrders(): Promise<{ ok: boolean; error?: string; closed?: number; mos?: string[] }> {
  const line = await getActiveLine();
  const guard = await requirePerm(linePermKey(line, "status"));
  if (guard.error) return { ok: false, error: guard.error };

  const done = await fullyDeliveredOpenOrders(line);
  if (done.length === 0) return { ok: true, closed: 0, mos: [] };

  const at = new Date();
  const mos = done.map((o) => o.mo);
  await prisma.masterOrder.updateMany({
    where: { mo: { in: mos } },
    data: { status: "closed", closedAt: at, autoCloseOff: false, autoClosedAt: null },
  });
  for (const p of ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"]) revalidatePath(p);
  // the same event a close on the tracker records, so "order closed" automations hear of these too
  await emitEvent({
    type: "order.closed",
    subject: listed(mos),
    summary: `Closed ${listed(mos, 6)} — fully delivered`,
    data: { mos, reason: "delivered" },
  });
  return { ok: true, closed: done.length, mos };
}

// ---- editing an order on the registry ----

const STALE_ORDER = "This order was changed by someone else meanwhile — reload and try again.";

/** The registry's own edit: every plan field of one order at once, from the
 *  row on the Orders Registry. Admin-only like the page. The qty may go down
 *  here as well — the registry is where planning's word is kept. Fins, colour,
 *  CRC and SFM are the tracker's columns and are not touched.
 *
 *  The form carries the row's `updatedAt` as it was rendered: the write only
 *  lands while the row still reads so, so two people editing the same order
 *  cannot overwrite each other unawares. A form without it (an older page)
 *  writes as before. */
export async function updateOrder(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const mo = String(formData.get("mo") ?? "").trim();
  if (!mo) return { ok: false, error: "Missing MO." };
  const order = await prisma.masterOrder.findUnique({ where: { mo } });
  if (!order) return { ok: false, error: `MO ${mo} not found.` };
  const seenRaw = String(formData.get("updatedAt") ?? "").trim();
  const seen = seenRaw ? new Date(seenRaw) : null;
  if (seen && Number.isNaN(seen.getTime())) return { ok: false, error: "This page is out of date — reload and try again." };

  const texts: Partial<Record<OrderTextField, string | null>> = {};
  for (const k of ORDER_TEXT_KEYS) {
    const r = orderTextValue(k, formData.get(k));
    if ("error" in r) return { ok: false, error: r.error };
    texts[k] = r.value;
  }
  try {
    const bom = String(formData.get("bom") ?? "").trim().toUpperCase();
    if (!bom) return { ok: false, error: "The BOM cannot be empty." };
    const planQty = Number(formData.get("planQty"));
    if (!Number.isInteger(planQty) || planQty < 0) return { ok: false, error: "Plan qty must be a whole number ≥ 0." };
    const ospEncloser = Number(formData.get("ospEncloser") ?? order.ospEncloser);
    if (!Number.isInteger(ospEncloser) || ospEncloser < 0) return { ok: false, error: "OSP Encloser must be a whole number ≥ 0." };
    // only the row as it was read: someone else's save in between wins, and this one is told
    const written = await prisma.masterOrder.updateMany({
      where: { mo, ...(seen ? { updatedAt: seen } : {}) },
      data: {
        bom,
        planQty,
        urgent: String(formData.get("urgent") ?? "") === "true",
        ...texts,
        ospEncloser,
      },
    });
    if (written.count === 0) return { ok: false, error: STALE_ORDER };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the order") };
  }
  for (const p of ["/orders", "/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/punching", "/worklist/bending", "/trace", "/"]) revalidatePath(p);
  return { ok: true };
}
