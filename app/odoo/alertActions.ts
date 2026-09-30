"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, userPerms } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { isDoneStatus } from "@/lib/domain/odoo";
import { ODOO_ALERTS_PERM, ODOO_NEED_MO_PERM, type ReadyRow } from "@/lib/domain/odooAlerts";
import { getNeedingMo, getReadyToClose } from "@/lib/server/odooAlerts";
import { getOdooRowMaterial } from "@/lib/server/odoo";

// The alerts' calls: what is waiting now (polled), closing rows and typing an
// MO straight from the popup.

export interface OdooAlertsPoll {
  ok: boolean;
  close?: ReadyRow[]; // only for odoo.alerts
  mo?: ReadyRow[]; // only for odoo.needMo
  canEdit?: { TR: boolean; LV: boolean };
}

export async function pollOdooAlerts(): Promise<OdooAlertsPoll> {
  const me = await getCurrentUser();
  if (!me) return { ok: false };
  const perms = userPerms(me);
  const wantClose = perms.has(ODOO_ALERTS_PERM);
  const wantMo = perms.has(ODOO_NEED_MO_PERM);
  if (!wantClose && !wantMo) return { ok: false };
  const [close, mo] = await Promise.all([
    wantClose ? getReadyToClose() : Promise.resolve(undefined),
    wantMo ? getNeedingMo() : Promise.resolve(undefined),
  ]);
  return {
    ok: true,
    close,
    mo,
    canEdit: { TR: hasPerm(me, linePermKey("TR", "odoo")), LV: hasPerm(me, linePermKey("LV", "odoo")) },
  };
}

/** Mark rows Done — closed in Odoo now. Each row needs its own line's Odoo
 *  permission; a row closed meanwhile is left as it is. */
export async function closeOdooReady(formData: FormData): Promise<{ ok: boolean; closed?: number; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Sign in again." };
  const ids = formData.getAll("id").map(Number).filter(Number.isInteger);
  if (ids.length === 0) return { ok: false, error: "Nothing to close." };
  const rows = await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { id: true, line: true, status: true } });
  const allowed = rows.filter((r) => !isDoneStatus(r.status) && hasPerm(me, linePermKey(r.line, "odoo")));
  if (allowed.length === 0) return { ok: false, error: rows.length ? "You cannot close these rows." : "Those rows no longer exist." };
  const now = new Date();
  await prisma.odooEntry.updateMany({ where: { id: { in: allowed.map((r) => r.id) } }, data: { status: "Done", doneAt: now, recordedBy: me.name } });
  revalidatePath("/odoo");
  return { ok: true, closed: allowed.length };
}

/** The clerk's ✓: these rows are recorded on Odoo — they now wait for the
 *  planner's Done. Each row needs its MO and its line's Odoo permission; a
 *  row already ticked or closed is left as it is. `undo` takes the ✓ back. */
export async function checkOdooRows(formData: FormData): Promise<{ ok: boolean; checked?: number; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Sign in again." };
  const ids = formData.getAll("id").map(Number).filter(Number.isInteger);
  const undo = formData.get("undo") === "true";
  if (ids.length === 0) return { ok: false, error: "Nothing to tick." };
  const rows = await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { id: true, line: true, status: true, odooMo: true, checkedAt: true } });
  const allowed = rows.filter((r) => hasPerm(me, linePermKey(r.line, "odoo")) && !isDoneStatus(r.status)
    && (undo ? r.checkedAt !== null : r.checkedAt === null && r.odooMo.trim() !== ""));
  if (allowed.length === 0) {
    const noMo = rows.some((r) => r.odooMo.trim() === "");
    return { ok: false, error: noMo && !undo ? "Type the MO first." : rows.length ? "Nothing to change on these rows." : "Those rows no longer exist." };
  }
  await prisma.odooEntry.updateMany({
    where: { id: { in: allowed.map((r) => r.id) } },
    data: undo ? { checkedAt: null, checkedBy: null } : { checkedAt: new Date(), checkedBy: me.name },
  });
  revalidatePath("/odoo");
  return { ok: true, checked: allowed.length };
}

/** Type Odoo's MO on a row that has none, from the popup. Needs the row's own
 *  line's Odoo permission; a row someone filled meanwhile is left alone. */
export async function fillOdooMo(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Sign in again." };
  const id = Number(formData.get("id"));
  const odooMo = String(formData.get("odooMo") ?? "").trim().toUpperCase();
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid row." };
  if (!odooMo) return { ok: false, error: "Type the MO number." };
  const row = await prisma.odooEntry.findUnique({ where: { id }, select: { line: true, odooMo: true } });
  if (!row) return { ok: false, error: "That row no longer exists." };
  if (!hasPerm(me, linePermKey(row.line, "odoo"))) return { ok: false, error: "You cannot record on this line's ODOO tab." };
  if (row.odooMo.trim() !== "") return { ok: false, error: `Already has ${row.odooMo}.` };
  await prisma.odooEntry.update({ where: { id }, data: { odooMo, autoMo: false, recordedBy: me.name } });
  revalidatePath("/odoo");
  return { ok: true };
}

/** The material popup for one row, from the alert popup on any page —
 *  viewing is free for every account, like the ODOO tab itself. */
export async function odooRowMaterial(id: number): Promise<{ ok: boolean; error?: string; data?: Awaited<ReturnType<typeof getOdooRowMaterial>> }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Sign in again." };
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid row." };
  const data = await getOdooRowMaterial(id);
  return data ? { ok: true, data } : { ok: false, error: "That row no longer exists." };
}
