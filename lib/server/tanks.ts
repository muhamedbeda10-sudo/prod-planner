import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { toISODate } from "@/lib/domain/dates";
import {
  TANK_ITEM,
  serialsForBatch,
  normalizeSerialBom,
  parseTankSerial,
  TANK_QUEUE_STATUS,
  type TankStatus,
  type QaResult,
  type LeakTestResult,
} from "@/lib/domain/tanks";

// The per-piece layer over the quantity ledger, for tanks only. Reads for the
// leak-test worklist, the welding repair list, the painting tank picker, the
// barcode sheet and the scanned tank page all come from here.

export interface TankDTO {
  id: number;
  serial: string;
  bom: string;
  mo: string;
  seq: number;
  status: TankStatus;
  // the order behind it (null when the MO left the registry)
  so: string | null;
  customer: string | null;
  kva: string | null;
  rating: string | null; // the order's voltage rating, e.g. "13.8/0.4"
  fgCode: string | null;
  // stages
  weldedISO: string;
  weldedBy: string | null;
  testedISO: string | null;
  testedBy: string | null;
  testResult: LeakTestResult | null;
  testNote: string | null;
  paintedISO: string | null;
  paintedBy: string | null;
  qaISO: string | null;
  qaBy: string | null;
  qaResult: QaResult | null;
  qaNote: string | null;
  /** Working days the tank has been sitting in its current stage. */
  ageDays: number;
}

export interface TankEventDTO {
  id: number;
  kind: string;
  atISO: string;
  atTime: string;
  workerName: string | null;
  byUser: string | null;
  note: string | null;
}

type TankRow = Prisma.TankUnitGetPayload<object>;
type OrderBits = { soi: string | null; customer: string | null; kva: string | null; rating: string | null; fgCode: string | null } | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(d: Date | null): number {
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS));
}

/** The date the tank's CURRENT stage started — what "waiting since" means. */
function stageSince(t: TankRow): Date {
  switch (t.status) {
    case "painted":
      return t.paintedAt ?? t.weldedAt;
    case "tested":
    case "repair":
      return t.testedAt ?? t.weldedAt;
    default:
      return t.weldedAt;
  }
}

function toDTO(t: TankRow, order: OrderBits): TankDTO {
  return {
    id: t.id,
    serial: t.serial,
    bom: t.bom,
    mo: t.mo,
    seq: t.seq,
    status: t.status as TankStatus,
    so: order?.soi ?? null,
    customer: order?.customer ?? null,
    kva: order?.kva ?? null,
    rating: order?.rating ?? null,
    fgCode: order?.fgCode ?? null,
    weldedISO: toISODate(t.weldedAt),
    weldedBy: t.weldedBy,
    testedISO: t.testedAt ? toISODate(t.testedAt) : null,
    testedBy: t.testedBy,
    testResult: (t.testResult as LeakTestResult | null) ?? null,
    testNote: t.testNote,
    paintedISO: t.paintedAt ? toISODate(t.paintedAt) : null,
    paintedBy: t.paintedBy,
    qaISO: t.qaAt ? toISODate(t.qaAt) : null,
    qaBy: t.qaBy,
    qaResult: (t.qaResult as QaResult | null) ?? null,
    qaNote: t.qaNote,
    ageDays: daysSince(stageSince(t)),
  };
}

/** Attach each tank's order details in ONE extra query, never one per row. */
async function withOrders(rows: TankRow[]): Promise<TankDTO[]> {
  if (rows.length === 0) return [];
  const mos = [...new Set(rows.map((r) => r.mo).filter(Boolean))];
  const orders = mos.length
    ? await prisma.masterOrder.findMany({
        where: { mo: { in: mos } },
        select: { mo: true, soi: true, customer: true, kva: true, rating: true, fgCode: true },
      })
    : [];
  const byMo = new Map(orders.map((o) => [o.mo, o]));
  return rows.map((r) => toDTO(r, byMo.get(r.mo)));
}

// ---- minting ----

export interface MintedTank {
  serial: string;
  seq: number;
}

/**
 * Give `count` freshly welded tanks their serials, inside the CALLER's
 * transaction so a serial is never minted for a welding record that then fails
 * to save. The per-BOM counter row is what makes two technicians saving at the
 * same moment safe: the `ON CONFLICT DO UPDATE` locks it, so the second batch
 * waits and then continues from the new value.
 *
 * When the counter row is missing (a BOM that never made a tank, or a database
 * restored without it) it is seeded past the highest serial that already
 * exists, so a re-created counter can never re-issue a number.
 */
export async function mintTankSerials(
  tx: Prisma.TransactionClient,
  opts: {
    bom: string;
    mo: string;
    planNo: number;
    count: number;
    date: Date;
    workerId?: number | null;
    workerName?: string | null;
    byUser?: string | null;
  }
): Promise<MintedTank[]> {
  const count = Math.trunc(opts.count);
  if (count <= 0) return [];
  const bom = normalizeSerialBom(opts.bom);

  const existing = await tx.tankSerialCounter.findUnique({ where: { bom } });
  const seed = existing
    ? existing.next
    : ((await tx.tankUnit.aggregate({ where: { bom }, _max: { seq: true } }))._max.seq ?? 0) + 1;

  const counter = await tx.tankSerialCounter.upsert({
    where: { bom },
    create: { bom, next: seed + count },
    update: { next: { increment: count } },
  });
  // `next` is the value AFTER the bump, so this batch owns the numbers below it
  const start = counter.next - count;

  const minted = serialsForBatch(bom, start, count);
  for (const m of minted) {
    await tx.tankUnit.create({
      data: {
        serial: m.serial,
        bom,
        mo: opts.mo,
        item: TANK_ITEM,
        seq: m.seq,
        planNo: opts.planNo,
        status: "welded",
        weldedAt: opts.date,
        weldedById: opts.workerId ?? null,
        weldedBy: opts.workerName ?? null,
        weldedLogBy: opts.byUser ?? null,
        events: {
          create: {
            kind: "welded",
            at: opts.date,
            workerId: opts.workerId ?? null,
            workerName: opts.workerName ?? null,
            byUser: opts.byUser ?? null,
          },
        },
      },
    });
  }
  return minted;
}

/**
 * Take tanks back off the ledger when a welding quantity is CORRECTED
 * downwards. Only tanks still sitting untouched at "welded" can go — the
 * newest first — because anything already tested or painted is a piece of
 * history, not a typo. Returns how many it could not remove.
 */
export async function unmintTankSerials(
  tx: Prisma.TransactionClient,
  opts: { bom: string; mo: string; count: number }
): Promise<{ removed: number; short: number }> {
  const count = Math.trunc(opts.count);
  if (count <= 0) return { removed: 0, short: 0 };
  const bom = normalizeSerialBom(opts.bom);
  const victims = await tx.tankUnit.findMany({
    where: { bom, mo: opts.mo, status: TANK_QUEUE_STATUS.leakTest },
    orderBy: { seq: "desc" },
    take: count,
    select: { id: true },
  });
  if (victims.length > 0) {
    await tx.tankUnit.deleteMany({ where: { id: { in: victims.map((v) => v.id) } } });
  }
  return { removed: victims.length, short: count - victims.length };
}

/** How many tanks of an MO are sitting in each status — the counts the
 *  worklists show next to a line. */
export async function getTankStatusCounts(mos: string[]): Promise<Map<string, Record<TankStatus, number>>> {
  const out = new Map<string, Record<TankStatus, number>>();
  if (mos.length === 0) return out;
  const rows = await prisma.tankUnit.groupBy({
    by: ["mo", "status"],
    where: { mo: { in: mos } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const cur = out.get(r.mo) ?? { welded: 0, repair: 0, tested: 0, painted: 0 };
    if (r.status in cur) cur[r.status as TankStatus] = r._count._all;
    out.set(r.mo, cur);
  }
  return out;
}

// ---- queues ----

/** Everything waiting for the leak test: welded, not yet tested. Oldest first
 *  — a tank that has been standing around longest is the one to test next. */
export async function getLeakTestQueue(): Promise<TankDTO[]> {
  const rows = await prisma.tankUnit.findMany({
    where: { status: TANK_QUEUE_STATUS.leakTest },
    orderBy: [{ weldedAt: "asc" }, { seq: "asc" }],
  });
  return withOrders(rows);
}

/** Tanks the leak test sent back — they show on the WELDING worklist until the
 *  welder confirms the repair. */
export async function getRepairQueue(): Promise<TankDTO[]> {
  const rows = await prisma.tankUnit.findMany({
    where: { status: TANK_QUEUE_STATUS.repair },
    orderBy: [{ testedAt: "asc" }, { seq: "asc" }],
  });
  return withOrders(rows);
}

/** Tanks that passed the leak test and are waiting to be painted, grouped by
 *  the MO the painting worklist lists them under. */
export async function getPaintableTanks(): Promise<Map<string, TankDTO[]>> {
  const rows = await prisma.tankUnit.findMany({
    where: { status: TANK_QUEUE_STATUS.paintable },
    orderBy: [{ testedAt: "asc" }, { seq: "asc" }],
  });
  const dtos = await withOrders(rows);
  const byMo = new Map<string, TankDTO[]>();
  for (const t of dtos) {
    const list = byMo.get(t.mo) ?? [];
    list.push(t);
    byMo.set(t.mo, list);
  }
  return byMo;
}

/** Tanks that finished every stage — the barcode tab's list. */
export async function getFinishedTanks(): Promise<TankDTO[]> {
  const rows = await prisma.tankUnit.findMany({
    where: { status: TANK_QUEUE_STATUS.finished },
    orderBy: [{ paintedAt: "desc" }, { seq: "desc" }],
    take: 2000,
  });
  return withOrders(rows);
}

/** Tanks of one MO in a given status — what the painting picker opens with. */
export async function getTanksOfOrder(mo: string, status?: TankStatus): Promise<TankDTO[]> {
  const rows = await prisma.tankUnit.findMany({
    where: { mo, ...(status ? { status } : {}) },
    orderBy: { seq: "asc" },
  });
  return withOrders(rows);
}

/** One tank plus its whole history — the page a scanned barcode opens. */
export async function getTankBySerial(
  serial: string
): Promise<{ tank: TankDTO; events: TankEventDTO[] } | null> {
  const parsed = parseTankSerial(serial);
  if (!parsed) return null;
  const row = await prisma.tankUnit.findUnique({
    where: { serial: `${serial}`.trim().toUpperCase() },
    include: { events: { orderBy: [{ at: "asc" }, { id: "asc" }] } },
  });
  if (!row) return null;
  const [dto] = await withOrders([row]);
  return {
    tank: dto,
    events: row.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      atISO: toISODate(e.at),
      atTime: e.at.toISOString().slice(11, 16),
      workerName: e.workerName,
      byUser: e.byUser,
      note: e.note,
    })),
  };
}

/** Absolute origin of the running app, read off the request — so the QR on a
 *  printed sticker points at whatever host the factory actually opens, with
 *  nothing to configure. */
export async function getBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}
