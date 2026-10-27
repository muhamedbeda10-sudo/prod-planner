"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";
import { encryptSecret } from "@/lib/server/ai/secret";
import { connectOdoo, getOdooConn, getOdooSettings, normalizeOdooUrl } from "@/lib/server/odooApi";
import { getOdooSyncStatus, startOdooSyncNow, type OdooSyncStatus } from "@/lib/server/odooSync";
import { odooErrorText } from "@/lib/domain/odooSync";

// The Odoo connection is the owner's — it carries an API key; any admin can
// ask for a sync. The app only ever READS Odoo (lib/server/odooApi.ts).

export interface OdooActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const PAGES = ["/admin/settings", "/odoo", "/physical", "/trace"];

async function requireOwnerHere(): Promise<{ name?: string; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { error: "Sign in again." };
  if (!me.isOwner) return { error: "Only the owner connects the app to Odoo." };
  return { name: me.name };
}

/** Try the connection: sign in and read one count. */
async function probe(conn: { url: string; db: string; login: string; apiKey: string }): Promise<string | null> {
  try {
    const { rpc } = await connectOdoo(conn, 20_000);
    await rpc("mrp.production", "search_count", [[["name", "=like", "SF01/MO/%"]]]);
    return null;
  } catch (e) {
    return odooErrorText(e);
  }
}

/** Save the connection — tried first, saved only when Odoo lets it in. An
 *  empty key keeps the one already saved. */
export async function saveOdooConnection(fd: FormData): Promise<OdooActionResult> {
  const g = await requireOwnerHere();
  if (g.error) return { ok: false, error: g.error };
  const url = normalizeOdooUrl(String(fd.get("url") ?? ""));
  const db = String(fd.get("db") ?? "").trim();
  const login = String(fd.get("login") ?? "").trim();
  const typedKey = String(fd.get("apiKey") ?? "").trim();
  if (!url) return { ok: false, error: "Enter Odoo's address, e.g. https://atcodoo.odoo.com." };
  if (!db || db.length > 120) return { ok: false, error: "Enter the Odoo database name." };
  if (!login || login.length > 200) return { ok: false, error: "Enter the login of the Odoo user the key belongs to." };
  if (typedKey.length > 500) return { ok: false, error: "That API key is too long." };

  let apiKey = typedKey;
  if (!apiKey) {
    const { conn } = await getOdooConn();
    if (!conn) return { ok: false, error: "Enter the API key." };
    apiKey = conn.apiKey;
  }
  const failed = await probe({ url, db, login, apiKey });
  if (failed) return { ok: false, error: `Odoo did not accept it: ${failed}` };

  await getOdooSettings();
  await prisma.odooSettings.update({
    where: { id: 1 },
    data: { url, db, login, ...(typedKey ? { apiKeyEnc: encryptSecret(typedKey), apiKeyHint: typedKey.slice(-4) } : {}), updatedBy: g.name ?? null },
  });
  for (const p of PAGES) revalidatePath(p);
  return { ok: true, message: "Connected — Odoo accepted the key." };
}

/** Forget the key: the scheduled runs stop until it is entered again. */
export async function removeOdooConnection(): Promise<OdooActionResult> {
  const g = await requireOwnerHere();
  if (g.error) return { ok: false, error: g.error };
  await getOdooSettings();
  await prisma.odooSettings.update({ where: { id: 1 }, data: { apiKeyEnc: "", apiKeyHint: "", updatedBy: g.name ?? null } });
  revalidatePath("/admin/settings");
  return { ok: true, message: "The API key is removed." };
}

/** The scheduled runs on or off — "Sync now" works either way. */
export async function setOdooSyncEnabled(fd: FormData): Promise<OdooActionResult> {
  const g = await requireOwnerHere();
  if (g.error) return { ok: false, error: g.error };
  await getOdooSettings();
  await prisma.odooSettings.update({ where: { id: 1 }, data: { enabled: fd.get("on") === "true", updatedBy: g.name ?? null } });
  revalidatePath("/admin/settings");
  return { ok: true };
}

/** Read Odoo now, after the answer — the card shows the run when it ends. */
export async function syncOdooNow(): Promise<OdooActionResult> {
  const g = await requireAdmin();
  if (g.error) return { ok: false, error: g.error };
  const r = await startOdooSyncNow(g.user!.name);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message: "Reading Odoo — this takes a minute or two." };
}

/** The card's state, re-read while a run is going. */
export async function odooSyncStatusNow(): Promise<{ ok: boolean; error?: string; status?: OdooSyncStatus }> {
  const g = await requireAdmin();
  if (g.error) return { ok: false, error: g.error };
  return { ok: true, status: await getOdooSyncStatus() };
}
