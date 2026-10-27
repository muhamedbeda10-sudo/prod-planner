import "server-only";
import { Prisma } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { connectOdoo, getOdooConn, getOdooSettings } from "@/lib/server/odooApi";
import { MO_FIELDS, odooDateTime, walkChildMos, type OdooRpc, type RawMo } from "@/lib/domain/odooChildren";
import {
  EMPTY_SUMMARY, batchBase, dueOdooSlot, firstBatchName, hasBatchSuffix, isOdooOpen, normMo, odooAgreement, odooDiffers, odooErrorText, productCodeOf,
  type OdooSyncSummary,
} from "@/lib/domain/odooSync";
import { isCancelledStatus } from "@/lib/domain/odoo";

// Odoo, read on a schedule: at 09:00 and 13:00 Riyadh time on the working
// days (lib/domain/odooSync.ts dueOdooSlot), from the automations' clock
// (lib/server/automations/runner.ts), and on an admin's "Sync now". One run
// reads three things, each on its own so one failing leaves the others:
//   1. what Odoo says about every MO the close-out log names (OdooMoState);
//   2. the sub-assembly MOs under each open order (OdooChildMo);
//   3. the store's SF01/Shop Floor Warehouse on-hand into Physical Material's
//      Odoo column, for the codes the table already lists.
// Nothing a person typed is moved: a row's status, MO and version stay theirs.

/** The store's location — on-hand there only, not SF01's other locations. */
export const SF01_STOCK_LOCATION = "SF01/Shop Floor Warehouse";
/** Who the stock column's change is stamped by. */
export const SYNC_BY = "Odoo sync";
/** A run left "running" longer than this died with its function. */
const STALE_MS = 15 * 60_000;

const chunk = <T,>(a: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

// ---- 1. the close-out log's MOs ----

/** The log's MO names that still need Odoo's word: never read, not found
 *  last time, or still open in Odoo. A done or cancelled MO stays as read. */
async function logNamesToCheck(): Promise<string[]> {
  // every row, not one per MO: an MO counts while any of its rows is not cancelled
  const rows = await prisma.odooEntry.findMany({ where: { NOT: { odooMo: "" } }, select: { odooMo: true, status: true } });
  const names = [...new Set(rows.filter((r) => !isCancelledStatus(r.status)).map((r) => normMo(r.odooMo)).filter(Boolean))];
  const known = await prisma.odooMoState.findMany({ where: { name: { in: names } }, select: { name: true, found: true, state: true } });
  const settled = new Set(known.filter((k) => k.found && (k.state === "done" || k.state === "cancel")).map((k) => k.name));
  return names.filter((n) => !settled.has(n));
}

async function checkLog(rpc: OdooRpc, s: OdooSyncSummary): Promise<void> {
  const names = await logNamesToCheck();
  const read = async (list: string[]) => {
    const out: RawMo[] = [];
    for (const c of chunk(list, 200)) out.push(...((await rpc("mrp.production", "search_read", [[["name", "in", c]]], { fields: [...MO_FIELDS], context: { active_test: false } })) as RawMo[]));
    return new Map(out.map((m) => [m.name.toUpperCase(), m]));
  };
  const byName = await read(names);
  // Odoo renames an MO "<name>-001" when it first splits it
  const renamedFrom = new Map(names.filter((n) => !byName.has(n) && !hasBatchSuffix(n)).map((n) => [firstBatchName(n).toUpperCase(), n]));
  const renamed = renamedFrom.size ? await read([...renamedFrom.keys()]) : new Map<string, RawMo>();

  const now = new Date();
  const data = names.map((name) => {
    const own = byName.get(name);
    const first = own ? undefined : renamed.get(firstBatchName(name).toUpperCase());
    const m = own ?? first;
    if (!m) return { name, found: false, currentName: "", odooId: null, state: "", productCode: "", qty: 0, qtyProduced: 0, doneAt: null, checkedAt: now };
    if (first) s.log.renamed++;
    if (m.state === "done") s.log.done++; else if (isOdooOpen(m.state)) s.log.open++;
    return {
      name, found: true, currentName: m.name, odooId: m.id, state: m.state, productCode: productCodeOf(m.product_id ? m.product_id[1] : ""),
      qty: m.product_qty, qtyProduced: m.qty_produced ?? 0, doneAt: m.state === "done" ? odooDateTime(m.date_finished) : null, checkedAt: now,
    };
  });
  s.log.checked = data.length;
  s.log.notFound = data.filter((d) => !d.found).length;
  for (const c of chunk(data, 100)) {
    await prisma.$transaction(c.map((d) => prisma.odooMoState.upsert({ where: { name: d.name }, create: d, update: d })));
  }
}

/** How many of the log's rows read differently from Odoo now. */
async function countDiffers(): Promise<number> {
  const rows = await prisma.odooEntry.findMany({ where: { NOT: { odooMo: "" } }, select: { odooMo: true, status: true, fgCode: true } });
  const states = await prisma.odooMoState.findMany({ select: { name: true, found: true, state: true, productCode: true } });
  const by = new Map(states.map((x) => [x.name, x]));
  return rows.filter((r) => odooDiffers(odooAgreement(r, by.get(normMo(r.odooMo))))).length;
}

// ---- 2. the sub-assembly MOs under the open orders ----

async function mirrorChildren(rpc: OdooRpc, s: OdooSyncSummary): Promise<void> {
  const orders = await prisma.masterOrder.findMany({ where: { status: "open" }, select: { mo: true, line: true } });
  const tr = [...new Set(orders.filter((o) => o.line !== "LV").map((o) => normMo(o.mo)).filter(Boolean))];
  const lv = [...new Set(orders.filter((o) => o.line === "LV").map((o) => normMo(o.mo)).filter(Boolean))];
  const now = new Date();
  type Row = Prisma.OdooChildMoCreateManyInput;
  const rows: Row[] = [];

  // transformers: walked down from the PF01 MO
  if (tr.length) {
    const w = await walkChildMos(rpc, tr);
    s.children.unresolved += w.unresolved;
    for (const c of w.children) {
      rows.push({
        parentMo: c.orderMo, name: c.name, odooId: c.odooId, item: c.item, productCode: c.productCode, qty: c.qty, qtyProduced: c.qtyProduced,
        uom: c.uom, state: c.state, doneAt: odooDateTime(c.doneAt), linkHow: c.linkHow, sharedWith: c.sharedWith.join(","), syncedAt: now,
      });
    }
  }
  // LV panels: the order IS an SF01 MO — its own batches are what a row closes
  for (const c of chunk(lv, 40)) {
    const bases = [...new Set(c.map(batchBase))];
    const conds: unknown[] = bases.flatMap((b) => [["name", "=", b], ["name", "=like", `${b}-___`]]);
    const domain = [...Array(Math.max(0, conds.length - 1)).fill("|"), ...conds];
    const found = (await rpc("mrp.production", "search_read", [domain], { fields: [...MO_FIELDS], context: { active_test: false } })) as RawMo[];
    for (const order of c) {
      for (const m of found.filter((f) => batchBase(f.name.toUpperCase()) === batchBase(order) && f.state !== "cancel")) {
        rows.push({
          parentMo: order, name: m.name, odooId: m.id, item: "", productCode: productCodeOf(m.product_id ? m.product_id[1] : ""), qty: m.product_qty,
          qtyProduced: m.qty_produced ?? 0, uom: m.product_uom_id ? m.product_uom_id[1] : "", state: m.state,
          doneAt: m.state === "done" ? odooDateTime(m.date_finished) : null, linkHow: "self", sharedWith: "", syncedAt: now,
        });
      }
    }
  }

  // each synced order's rows replaced together; a closed order keeps its last
  const synced = [...tr, ...lv];
  await prisma.$transaction([
    prisma.odooChildMo.deleteMany({ where: { parentMo: { in: synced } } }),
    ...chunk(rows, 500).map((r) => prisma.odooChildMo.createMany({ data: r, skipDuplicates: true })),
  ]);
  s.children.orders = new Set(rows.map((r) => r.parentMo)).size;
  s.children.mos = new Set(rows.map((r) => r.odooId)).size;
}

// ---- 3. the store's SF01 on-hand ----

async function syncStock(rpc: OdooRpc, s: OdooSyncSummary): Promise<void> {
  const items = await prisma.physicalStock.findMany({ select: { id: true, code: true, odoo: true } });
  if (items.length === 0) return;
  const locs = (await rpc("stock.location", "search_read", [[["complete_name", "=", SF01_STOCK_LOCATION]]], { fields: ["id"], limit: 1 })) as { id: number }[];
  if (!locs.length) throw new Error(`Odoo has no location "${SF01_STOCK_LOCATION}".`);
  const codes = [...new Set(items.map((i) => i.code.trim()).filter(Boolean))];
  const known = new Set<string>();
  const onHand = new Map<string, number>();
  for (const c of chunk(codes, 200)) {
    const products = (await rpc("product.product", "search_read", [[["default_code", "in", c]]], { fields: ["id", "default_code"], context: { active_test: false } })) as { id: number; default_code: string | false }[];
    const codeOf = new Map(products.map((p) => [p.id, String(p.default_code || "").toUpperCase()]));
    products.forEach((p) => known.add(String(p.default_code || "").toUpperCase()));
    if (!products.length) continue;
    const groups = (await rpc("stock.quant", "read_group", [[["location_id", "=", locs[0].id], ["product_id", "in", products.map((p) => p.id)]], ["product_id", "quantity:sum"], ["product_id"]], { lazy: false })) as { product_id: [number, string] | false; quantity: number }[];
    for (const g of groups) {
      if (!g.product_id) continue;
      const code = codeOf.get(g.product_id[0]);
      if (code) onHand.set(code, (onHand.get(code) ?? 0) + (g.quantity ?? 0));
    }
  }
  const updates: { id: number; odoo: number }[] = [];
  for (const it of items) {
    const code = it.code.trim().toUpperCase();
    if (!known.has(code)) { s.stock.missing++; continue; }
    // as Odoo writes it, to its own precision; no quant there = none on hand
    const v = Math.round((onHand.get(code) ?? 0) * 1e4) / 1e4;
    if (Math.abs(v - it.odoo) < 1e-9) { s.stock.unchanged++; continue; }
    updates.push({ id: it.id, odoo: v });
  }
  for (const c of chunk(updates, 100)) {
    await prisma.$transaction(c.map((u) => prisma.physicalStock.update({ where: { id: u.id }, data: { odoo: u.odoo, updatedBy: SYNC_BY } })));
  }
  s.stock.updated = updates.length;
}

// ---- a run ----

/** Claim a run's slot: false when another tick or person has it. */
async function claim(slot: string, trigger: "schedule" | "manual", by: string | null): Promise<number | null> {
  try {
    const r = await prisma.odooSyncRun.create({ data: { slot, trigger, startedBy: by } });
    return r.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
    throw e;
  }
}

/** Run a claimed sync to the end and record what it found. */
async function execute(runId: number): Promise<OdooSyncSummary> {
  const t0 = Date.now();
  const s: OdooSyncSummary = structuredClone(EMPTY_SUMMARY);
  let status = "ok";
  let error: string | null = null;
  try {
    const { conn, reason } = await getOdooConn();
    if (!conn) throw new Error(reason ?? "Odoo is not connected.");
    const { rpc } = await connectOdoo(conn);
    const parts: [string, () => Promise<void>][] = [
      ["close-out log", () => checkLog(rpc, s)],
      ["sub-assembly MOs", () => mirrorChildren(rpc, s)],
      ["SF01 stock", () => syncStock(rpc, s)],
    ];
    for (const [name, run] of parts) {
      try {
        await run();
      } catch (e) {
        status = "partial";
        s.issues.push(`${name}: ${odooErrorText(e)}`);
      }
    }
    s.log.differs = await countDiffers();
  } catch (e) {
    status = "failed";
    error = odooErrorText(e);
  }
  s.ms = Date.now() - t0;
  await prisma.odooSyncRun.update({ where: { id: runId }, data: { status, error, summary: s as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
  return s;
}

/** The automations' clock asks every minute: runs the scheduled slot once,
 *  when it is due and Odoo is connected with the scheduled runs on. */
export async function runOdooSyncIfDue(now = new Date()): Promise<void> {
  const slot = dueOdooSlot(now);
  if (!slot) return;
  if (await prisma.odooSyncRun.findUnique({ where: { slot }, select: { id: true } })) return;
  // read, never written here: this is asked every minute until the slot runs
  const settings = await prisma.odooSettings.findUnique({ where: { id: 1 }, select: { enabled: true, apiKeyEnc: true } });
  if (!settings?.enabled || !settings.apiKeyEnc) return;
  const id = await claim(slot, "schedule", null);
  if (id !== null) await execute(id);
}

/** An admin's "Sync now": refused while a run is going; runs after the answer. */
export async function startOdooSyncNow(by: string): Promise<{ ok: boolean; error?: string }> {
  const { conn, reason } = await getOdooConn();
  if (!conn) return { ok: false, error: reason ?? "Odoo is not connected." };
  const busy = await prisma.odooSyncRun.findFirst({ where: { status: "running", startedAt: { gt: new Date(Date.now() - STALE_MS) } }, select: { id: true } });
  if (busy) return { ok: false, error: "A sync is running right now — wait for it to finish." };
  const id = await claim(`manual@${new Date().toISOString()}`, "manual", by);
  if (id === null) return { ok: false, error: "A sync is starting right now." };
  after(async () => {
    await execute(id).catch((e) => console.error("odoo sync: failed", e));
  });
  return { ok: true };
}

/** A run that died with its function (a deploy, a timeout) — closed as failed
 *  so the card stops saying "running". */
export async function closeStaleOdooRuns(): Promise<void> {
  await prisma.odooSyncRun.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", error: "The run stopped before it finished.", finishedAt: new Date() },
  });
}

export interface OdooSyncStatus {
  connected: boolean;
  enabled: boolean;
  url: string;
  db: string;
  login: string;
  keyHint: string;
  keyReadable: boolean;
  last: { status: string; trigger: string; startedAtISO: string; finishedAtISO: string | null; summary: OdooSyncSummary | null; error: string | null } | null;
  lastOkAtISO: string | null;
}

export async function getOdooSyncStatus(): Promise<OdooSyncStatus> {
  await closeStaleOdooRuns();
  const [st, { conn }, last, lastOk] = await Promise.all([
    getOdooSettings(),
    getOdooConn(),
    prisma.odooSyncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.odooSyncRun.findFirst({ where: { status: { in: ["ok", "partial"] } }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
  ]);
  return {
    connected: !!conn,
    enabled: st.enabled,
    url: st.url, db: st.db, login: st.login, keyHint: st.apiKeyHint,
    keyReadable: !st.apiKeyEnc || !!conn,
    last: last ? {
      status: last.status, trigger: last.trigger, startedAtISO: last.startedAt.toISOString(), finishedAtISO: last.finishedAt?.toISOString() ?? null,
      summary: (last.summary as unknown as OdooSyncSummary | null) ?? null, error: last.error,
    } : null,
    lastOkAtISO: lastOk?.finishedAt?.toISOString() ?? null,
  };
}
