import "server-only";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { emitEvent, listed } from "@/lib/server/events";
import { withLine } from "@/lib/server/line";
import { getMasterTracker } from "@/lib/server/masterTracker";
import { closesByItself } from "@/lib/domain/trackerOdoo";

// An order closes by itself once it is finished AND Odoo has closed it all —
// read off the Plan Tracker's own row (closesByItself), so it closes exactly
// when the tracker shows it finished (what its Close button asks) and its
// Odoo column full. Never one on hold or with a plan qty waiting for the
// planner. The transformers only — the panels' Odoo rows are not allocated to
// orders. An order someone reopened by hand after it closed by itself
// (autoClosedAt) stays open (autoCloseOff) until they close it again. It never reopens by
// itself: the Odoo allocation is recomputed (a tracking start moved, another
// order of the same BOM given more room), and an order must not come back on
// the floor's screens for that. Runs after Odoo rows change, and each hour.

/** The screens an order's close takes it off. */
const ORDER_SCREENS = ["/tracker", "/orders", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/trace", "/"];

/** Close the open transformer orders that are finished and closed in full in
 *  Odoo; the MOs it closed. */
export async function closeOrdersClosedInOdoo(): Promise<string[]> {
  const rows = await withLine("TR", () => getMasterTracker());
  const closed: string[] = [];
  for (const r of rows.filter(closesByItself)) {
    // one at a time, each only as it still reads — a reopen, a hold or a plan
    // qty that landed meanwhile wins, and the event names only what moved
    const now = new Date();
    const res = await prisma.masterOrder.updateMany({
      where: { mo: r.mo, status: "open", autoCloseOff: false, holdAt: null, pendingPlanQty: null },
      data: { status: "closed", closedAt: now, autoClosedAt: now },
    });
    if (res.count === 1) closed.push(r.mo);
  }
  if (closed.length === 0) return closed;
  await emitEvent({
    type: "order.closed",
    subject: listed(closed),
    summary: `Closed ${listed(closed, 6)} — finished and all closed in Odoo`,
    data: { mos: closed, reason: "odoo" },
  });
  for (const p of ORDER_SCREENS) revalidatePath(p);
  return closed;
}

/** After Odoo rows changed: the orders they finish close. A failure never
 *  fails the Odoo write — the hourly run catches up. */
export async function settleOrdersAfterOdoo(): Promise<void> {
  try {
    await closeOrdersClosedInOdoo();
  } catch (e) {
    console.error("odoo: closing the orders Odoo closed failed", e);
  }
}

