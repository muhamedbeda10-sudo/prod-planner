// The Odoo pull — what the scheduled task runs INSIDE an Odoo page, with the
// user's own login: reads only (search_read / read / read_group through the
// page's own JSON-RPC), never a write. It takes the database's plan
// (odoo_pull_plan(): which MOs, orders and codes to read, and how each order's
// sub-assemblies read last time) and returns one compact payload for
// odoo_ingest(). Built into /odoo-pull.js by scripts/gen-odoo-pull.ts; the
// task loads it into the Odoo page and calls window.__odooPull(plan).

import { walkChildMos, MO_FIELDS, type OdooRpc, type RawMo } from "./odooChildren";
import { batchBase, firstBatchName, hasBatchSuffix, normMo, odooErrorText, productCodeOf } from "./odooSync";

/** What odoo_pull_plan() hands the pull. */
export interface OdooPullPlan {
  /** The close-out log's MOs Odoo has not settled yet (or never read). */
  logNames: string[];
  /** The open orders: transformers (PF01 MOs, walked down) and LV panels (their own SF01 MO). */
  tr: string[];
  lv: string[];
  /** Physical Material's codes. */
  codes: string[];
  /** Each order's sub-assemblies as they read last time — unchanged orders are not sent again. */
  hashes: Record<string, string>;
}

/** [name, found 0|1, currentName, odooId, state, productCode, qty, qtyProduced, doneAt] */
export type LogRow = [string, 0 | 1, string, number | null, string, string, number, number, string | null];
/** [parentMo, name, odooId, item, productCode, qty, qtyProduced, uom, state, doneAt, linkHow, sharedWith csv] */
export type ChildRow = [string, string, number, string, string, number, number, string, string, string | null, string, string];

export interface OdooPullPayload {
  v: 1;
  /** Which of `parts` pieces this is (splitPayload) — the whole pull is part 0 of 1. */
  part?: number;
  parts?: number;
  /** When the pull read Odoo (ISO). */
  at: string;
  ms: number;
  log: LogRow[];
  /** The orders whose sub-assemblies changed: their rows below replace the stored ones. */
  orders: { mo: string; hash: string }[];
  children: ChildRow[];
  unchanged: number;
  /** SF01/Shop Floor Warehouse on-hand per code Odoo knows; null when the read failed. */
  stock: { values: [string, number][]; missing: string[] } | null;
  issues: string[];
}

/** The store's location — on-hand there only, not SF01's other locations. */
export const SF01_STOCK_LOCATION = "SF01/Shop Floor Warehouse";

const chunk = <T,>(a: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

/** A short, stable fingerprint of an order's rows (FNV-1a, 32 bit, hex). */
export function rowsHash(rows: readonly ChildRow[]): string {
  const text = [...rows].map((r) => r.slice(1).join("|")).sort().join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const ctx = { context: { lang: "en_US", active_test: false } };
const odooTime = (v: string | false | undefined) => (v ? v : null);

async function readByName(rpc: OdooRpc, names: readonly string[]): Promise<Map<string, RawMo>> {
  const out = new Map<string, RawMo>();
  for (const c of chunk(names, 200)) {
    const rows = (await rpc("mrp.production", "search_read", [[["name", "in", c]]], { fields: [...MO_FIELDS], ...ctx })) as RawMo[];
    for (const m of rows) out.set(m.name.toUpperCase(), m);
  }
  return out;
}

/** The log's MOs: by name, else — Odoo renamed the first batch on splitting — by "<name>-001". */
export async function pullLog(rpc: OdooRpc, names: readonly string[]): Promise<LogRow[]> {
  const list = [...new Set(names.map(normMo).filter(Boolean))];
  const own = await readByName(rpc, list);
  const firsts = list.filter((n) => !own.has(n) && !hasBatchSuffix(n)).map(firstBatchName);
  const renamed = firsts.length ? await readByName(rpc, firsts) : new Map<string, RawMo>();
  return list.map((name): LogRow => {
    const m = own.get(name) ?? renamed.get(firstBatchName(name).toUpperCase());
    if (!m) return [name, 0, "", null, "", "", 0, 0, null];
    return [
      name, 1, m.name, m.id, m.state, productCodeOf(m.product_id ? m.product_id[1] : ""), m.product_qty, m.qty_produced ?? 0,
      m.state === "done" ? odooTime(m.date_finished) : null,
    ];
  });
}

/** Every open order's sub-assembly MOs, as rows per order. */
export async function pullChildren(rpc: OdooRpc, tr: readonly string[], lv: readonly string[]): Promise<Map<string, ChildRow[]>> {
  const byOrder = new Map<string, ChildRow[]>();
  for (const o of [...tr, ...lv]) byOrder.set(normMo(o), []);
  if (tr.length) {
    const w = await walkChildMos(rpc, tr);
    for (const c of w.children) {
      byOrder.get(c.orderMo)?.push([
        c.orderMo, c.name, c.odooId, c.item, c.productCode, c.qty, c.qtyProduced, c.uom, c.state, c.doneAt, c.linkHow, c.sharedWith.join(","),
      ]);
    }
  }
  // LV panels: the order IS an SF01 MO — its own batches are what a row closes
  for (const c of chunk(lv.map(normMo), 40)) {
    const bases = [...new Set(c.map(batchBase))];
    const conds: unknown[] = bases.flatMap((b) => [["name", "=", b], ["name", "=like", `${b}-___`]]);
    const domain = [...Array(Math.max(0, conds.length - 1)).fill("|"), ...conds];
    const found = (await rpc("mrp.production", "search_read", [domain], { fields: [...MO_FIELDS], ...ctx })) as RawMo[];
    for (const order of c) {
      for (const m of found.filter((f) => batchBase(f.name.toUpperCase()) === batchBase(order) && f.state !== "cancel")) {
        byOrder.get(order)?.push([
          order, m.name, m.id, "", productCodeOf(m.product_id ? m.product_id[1] : ""), m.product_qty, m.qty_produced ?? 0,
          m.product_uom_id ? m.product_uom_id[1] : "", m.state, m.state === "done" ? odooTime(m.date_finished) : null, "self", "",
        ]);
      }
    }
  }
  return byOrder;
}

/** SF01/Shop Floor Warehouse on-hand for the codes Odoo knows (0 where none is there). */
export async function pullStock(rpc: OdooRpc, codes: readonly string[]): Promise<{ values: [string, number][]; missing: string[] }> {
  const locs = (await rpc("stock.location", "search_read", [[["complete_name", "=", SF01_STOCK_LOCATION]]], { fields: ["id"], limit: 2, ...ctx })) as { id: number }[];
  if (locs.length !== 1) throw new Error(`Odoo has ${locs.length} locations named "${SF01_STOCK_LOCATION}".`);
  const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const qty = new Map<string, number>();
  for (const c of chunk(wanted, 200)) {
    const products = (await rpc("product.product", "search_read", [[["default_code", "in", c]]], { fields: ["id", "default_code"], ...ctx })) as { id: number; default_code: string | false }[];
    const codeOf = new Map(products.map((p) => [p.id, String(p.default_code || "").toUpperCase()]));
    for (const code of codeOf.values()) if (!qty.has(code)) qty.set(code, 0);
    if (!products.length) continue;
    const groups = (await rpc("stock.quant", "read_group", [[["location_id", "=", locs[0].id], ["product_id", "in", products.map((p) => p.id)]], ["product_id", "quantity:sum"], ["product_id"]], { lazy: false })) as { product_id: [number, string] | false; quantity: number }[];
    for (const g of groups) {
      const code = g.product_id ? codeOf.get(g.product_id[0]) : undefined;
      if (code) qty.set(code, (qty.get(code) ?? 0) + (g.quantity ?? 0));
    }
  }
  return {
    values: [...qty.entries()].map(([code, q]) => [code, Math.round(q * 1e4) / 1e4]),
    missing: wanted.filter((c) => !qty.has(c.toUpperCase())),
  };
}

/** Read everything the plan asks for; a part that fails is named in `issues`
 *  and leaves the others. */
export async function pullOdoo(rpc: OdooRpc, plan: OdooPullPlan, now: () => number = Date.now): Promise<OdooPullPayload> {
  const t0 = now();
  const out: OdooPullPayload = { v: 1, at: new Date(t0).toISOString(), ms: 0, log: [], orders: [], children: [], unchanged: 0, stock: null, issues: [] };
  try {
    out.log = await pullLog(rpc, plan.logNames);
  } catch (e) {
    out.issues.push(`close-out log: ${odooErrorText(e)}`);
  }
  try {
    const byOrder = await pullChildren(rpc, plan.tr, plan.lv);
    for (const [mo, rows] of byOrder) {
      const hash = rowsHash(rows);
      if (plan.hashes[mo] === hash) { out.unchanged++; continue; }
      out.orders.push({ mo, hash });
      out.children.push(...rows);
    }
  } catch (e) {
    out.issues.push(`sub-assembly MOs: ${odooErrorText(e)}`);
  }
  try {
    out.stock = await pullStock(rpc, plan.codes);
  } catch (e) {
    out.issues.push(`SF01 stock: ${odooErrorText(e)}`);
  }
  out.ms = now() - t0;
  return out;
}

/**
 * The payload cut into pieces of at most about `maxChars` of JSON, so each
 * fits one odoo_ingest() call the task can copy whole: the first carries the
 * stock, the issues and the count of unchanged orders; the log's MOs and the
 * orders (each with all of its rows, never split) fill the pieces in turn.
 * Every piece names the same pull (`at`), so the database keeps one run.
 */
export function splitPayload(p: OdooPullPayload, maxChars = 24_000): OdooPullPayload[] {
  const piece = (part: number): OdooPullPayload => ({
    v: 1, at: p.at, ms: p.ms, part, parts: 0, log: [], orders: [], children: [],
    unchanged: part === 0 ? p.unchanged : 0, stock: part === 0 ? p.stock : null, issues: part === 0 ? p.issues : [],
  });
  const out: OdooPullPayload[] = [piece(0)];
  let size = JSON.stringify(out[0]).length;
  const room = (chars: number) => {
    const cur = out[out.length - 1];
    const empty = !cur.log.length && !cur.orders.length;
    if (size + chars > maxChars && !empty) {
      out.push(piece(out.length));
      size = JSON.stringify(out[out.length - 1]).length;
    }
    size += chars;
    return out[out.length - 1];
  };
  for (const row of p.log) room(JSON.stringify(row).length + 1).log.push(row);
  const rowsOf = new Map<string, ChildRow[]>();
  for (const r of p.children) rowsOf.set(r[0], [...(rowsOf.get(r[0]) ?? []), r]);
  for (const o of p.orders) {
    const rows = rowsOf.get(o.mo) ?? [];
    const cur = room(JSON.stringify(o).length + 1 + rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0));
    cur.orders.push(o);
    cur.children.push(...rows);
  }
  return out.map((x) => ({ ...x, parts: out.length }));
}

/** The page's own JSON-RPC, as the logged-in user — reads only. */
export const PULL_READ_METHODS: ReadonlySet<string> = new Set(["search_read", "read", "read_group", "search_count"]);

export function pageRpc(fetchFn: typeof fetch): OdooRpc {
  return async (model, method, args, kwargs = {}) => {
    if (!PULL_READ_METHODS.has(method)) throw new Error(`Refused: "${method}" is not a read — the pull never writes to Odoo.`);
    const r = await fetchFn(`/web/dataset/call_kw/${model}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { model, method, args, kwargs } }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message?: string; data?: { message?: string } } };
    if (j.error) throw new Error(`${model}.${method}: ${j.error.data?.message || j.error.message || "error"}`);
    return j.result;
  };
}

// ---- straight to the database: the scheduled task's one-time pass ----
//
// The task asks the database for a pass (odoo_issue_ticket(), good for 15
// minutes) and hands it to the Odoo page with the database project's address
// and anon key (the Edge Function's gateway checks that JWT). The page then reads the plan and writes what it read
// itself, through the "odoo-sync" Edge Function (supabase/functions) into
// odoo_pull_plan_t / odoo_ingest_t, which do nothing without a live pass — so
// nothing big passes through the task. Reads from Odoo stay reads.

export interface OdooSyncTarget {
  /** https://<project>.supabase.co — nothing else is accepted. */
  url: string;
  /** The project's anon key (a JWT: the function's gateway checks it). */
  key: string;
  /** The one-time pass from odoo_issue_ticket(). */
  ticket: string;
}

/** The database calls the sync makes — the plan, and each piece of what it read. */
export interface OdooSyncDb {
  plan(): Promise<OdooPullPlan>;
  ingest(piece: OdooPullPayload): Promise<unknown>;
}

/** Only a Supabase project's own address takes the pass. */
export function supabaseBase(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim());
  return m ? `https://${m[1]}.supabase.co` : null;
}

/** The Edge Function the page posts to. */
export const ODOO_SYNC_FUNCTION = "odoo-sync";

export function supabaseDb(fetchFn: typeof fetch, t: OdooSyncTarget): OdooSyncDb {
  const base = supabaseBase(t.url);
  if (!base) throw new Error("Not a Supabase project address.");
  if (!/^[0-9a-f]{64}$/.test(t.ticket)) throw new Error("Not a sync pass.");
  const call = async (op: "plan" | "ingest", p?: OdooPullPayload) => {
    const r = await fetchFn(`${base}/functions/v1/${ODOO_SYNC_FUNCTION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: t.key, Authorization: `Bearer ${t.key}` },
      body: JSON.stringify(p ? { op, ticket: t.ticket, p } : { op, ticket: t.ticket }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${op}: HTTP ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    plan: () => call("plan") as Promise<OdooPullPlan>,
    ingest: (piece) => call("ingest", piece),
  };
}

/** Read the plan, pull Odoo, write each piece — the whole run, from the page.
 *  Returns what the database said after the last piece (the run's summary). */
export async function runOdooSync(rpc: OdooRpc, db: OdooSyncDb, now: () => number = Date.now, maxChars = 400_000): Promise<{ summary: unknown; pieces: number; chars: number }> {
  const plan = await db.plan();
  const payload = await pullOdoo(rpc, plan, now);
  const pieces = splitPayload(payload, maxChars);
  let summary: unknown = null;
  let chars = 0;
  for (const piece of pieces) {
    chars += JSON.stringify(piece).length;
    summary = await db.ingest(piece);
  }
  return { summary, pieces: pieces.length, chars };
}
