import "server-only";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/server/ai/secret";
import type { OdooRpc } from "@/lib/domain/odooChildren";

// Odoo's external API (JSON-RPC, with a user's API key) — READ ONLY. The app
// reads Odoo and never writes to it: every call goes through `rpc`, which
// refuses any method that is not a read before anything leaves the server,
// whatever rights the key's user has in Odoo.

/** The only methods the app ever calls on an Odoo model. */
export const ODOO_READ_METHODS: ReadonlySet<string> = new Set(["search_read", "read", "search_count", "read_group", "search"]);

export interface OdooConn {
  url: string;
  db: string;
  login: string;
  apiKey: string;
}

/** The address as the settings keep it: https, a host name, no path. Null
 *  when it is not one. */
export function normalizeOdooUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || u.username || u.password) return null;
  return `https://${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}`;
}

export async function getOdooSettings() {
  return prisma.odooSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/** The connection the sync uses, or why there is none. */
export async function getOdooConn(): Promise<{ conn: OdooConn | null; reason: string | null }> {
  const s = await getOdooSettings();
  if (!s.url || !s.db || !s.login || !s.apiKeyEnc) return { conn: null, reason: "Odoo is not connected yet — the owner sets it up in Admin → Settings." };
  const apiKey = decryptSecret(s.apiKeyEnc);
  if (!apiKey) return { conn: null, reason: "The saved Odoo API key cannot be read any more — the owner enters it again." };
  return { conn: { url: s.url, db: s.db, login: s.login, apiKey }, reason: null };
}

class OdooError extends Error {}

async function call(url: string, service: string, method: string, args: unknown[], timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new OdooError(`Odoo answered HTTP ${res.status}.`);
    const j = (await res.json()) as { result?: unknown; error?: { message?: string; data?: { message?: string } } };
    if (j.error) throw new OdooError(j.error.data?.message || j.error.message || "Odoo returned an error.");
    return j.result;
  } catch (e) {
    if (e instanceof OdooError) throw e;
    if ((e as { name?: string }).name === "AbortError") throw new OdooError(`Odoo did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new OdooError(`Could not reach Odoo: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Sign in with the API key and hand back a read-only `rpc`. Throws with
 *  Odoo's own words when the key or the database is wrong. */
export async function connectOdoo(conn: OdooConn, timeoutMs = 60_000): Promise<{ rpc: OdooRpc; uid: number }> {
  const uid = await call(conn.url, "common", "authenticate", [conn.db, conn.login, conn.apiKey, {}], 20_000);
  if (typeof uid !== "number" || uid <= 0) throw new OdooError("Odoo refused the login — check the database, the login and the API key.");
  const rpc: OdooRpc = async (model, method, args, kwargs = {}) => {
    if (!ODOO_READ_METHODS.has(method)) throw new OdooError(`Refused: "${method}" is not a read — the app never writes to Odoo.`);
    return call(conn.url, "object", "execute_kw", [conn.db, uid, conn.apiKey, model, method, args, kwargs], timeoutMs);
  };
  return { rpc, uid };
}
