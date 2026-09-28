"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, userPerms } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { isDoneStatus } from "@/lib/domain/odoo";
import { ODOO_ALERTS_PERM, type ReadyRow } from "@/lib/domain/odooAlerts";
import { getReadyToClose } from "@/lib/server/odooAlerts";

// The alert's two calls: what is ready to close now (polled), and closing
// rows straight from the popup.

export async function pollOdooReady(): Promise<{ ok: boolean; rows?: ReadyRow[]; canClose?: { TR: boolean; LV: boolean } }> {
  const me = await getCurrentUser();
  if (!me || !userPerms(me).has(ODOO_ALERTS_PERM)) return { ok: false };
  return {
    ok: true,
    rows: await getReadyToClose(),
    canClose: { TR: hasPerm(me, linePermKey("TR", "odoo")), LV: hasPerm(me, linePermKey("LV", "odoo")) },
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
