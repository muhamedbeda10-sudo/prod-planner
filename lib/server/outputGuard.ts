import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { UserError } from "@/lib/server/errors";
import { isItem, isPaintExempt, ospOf } from "@/lib/domain/constants";
import { LV_ITEM, isLvChainStage, lvChainViolation, type LvState } from "@/lib/domain/lv";

// The physical chain — one rule enforced everywhere the log is written:
//   delivered ≤ finished ≤ … ≤ welded ≤ cut ≤ order qty   (per MO × item)
// where "finished" is the item's FINAL stage: SHOT BLAST for the paint-exempt
// core CF (welded → shot blasted → delivered), painting otherwise. Entries
// carrying an MO are checked against that MO's totals; entries without one
// are checked at BOM level (the chain holds for the aggregate too).
// The WHOLE chain is re-checked after the proposed change, so reducing or
// deleting an upstream entry can't leave downstream output hanging.
// Totals are all-time, so date edits can never break the chain by themselves.

/** The ids of the rows that are leaving (an edit's own row, a delete's rows). */
function leavingIds(opts: { excludeId?: number; excludeIds?: number[] }): number[] {
  return [...(opts.excludeId ? [opts.excludeId] : []), ...(opts.excludeIds ?? [])];
}

/** The rows that are leaving, kept out of the totals the chain is judged on. */
function excludeWhere(opts: { excludeId?: number; excludeIds?: number[] }) {
  const ids = leavingIds(opts);
  return ids.length > 0 ? { id: { notIn: ids } } : {};
}

/** The client the chain is read through: the app's, or the transaction a
 *  write is being made in (the same connection, so the read sees what the
 *  transaction already holds and needs no second connection). */
type Db = Prisma.TransactionClient | typeof prisma;

/** Arbitrary, fixed: the first key of the advisory lock an LV order's chain
 *  check takes (the second is the MO's hash) — its own, apart from the
 *  consumable limits' key. */
const LV_LOCK = 52_613;

/** Hold an LV order's chain for the rest of the transaction: a second record
 *  on the same MO waits until this one is written (or refused), then reads
 *  the ledger it left. Without it two records at one stage both read the same
 *  totals, both pass the chain check, and the ledger ends up with more bent
 *  than punched. Released when the transaction ends. */
export async function lockLvOrder(tx: Prisma.TransactionClient, mo: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LV_LOCK}::int, hashtext(${mo})::int)`;
}

/** A chain refusal found inside a write's transaction — thrown to roll it back. */
export class ChainRefused extends UserError {}

/** Inside a write's transaction, for an LV panel row on an MO: take the
 *  order's lock and judge the chain again on what the ledger holds now, so a
 *  record that slipped in between the first check and this write is seen —
 *  every path that writes a panel row (the LV tracker, a worklist or machine
 *  card, the Daily log) waits on the same lock. Throws ChainRefused. Other
 *  rows are checked once before the write, as they always were. */
export async function recheckLvChainLocked(
  tx: Prisma.TransactionClient,
  opts: Parameters<typeof checkOutputChain>[0],
): Promise<void> {
  if (opts.item !== LV_ITEM) return;
  const mo = (opts.mo ?? "").trim();
  if (!mo) return;
  await lockLvOrder(tx, mo);
  const error = await checkOutputChain(opts, tx);
  if (error) throw new ChainRefused(error);
}

export async function checkOutputChain(opts: {
  dept: string;
  bom: string;
  mo?: string | null;
  item: string;
  qty: number; // the entry's quantity after the change (0 = deletion)
  excludeId?: number; // when editing/deleting an existing entry
  /** Deleting SEVERAL rows at once: every one of them leaves the totals
   *  together, so the chain is judged on the world after the whole batch —
   *  dropping a cut row and the weld row it fed is fine, dropping the cut
   *  row alone is not. */
  excludeIds?: number[];
}, db: Db = prisma): Promise<string | null> {
  // an LV panel is one thing through four stages — its own chain, whole
  if (opts.item === LV_ITEM) return checkLvChain(opts, db);
  const mo = (opts.mo ?? "").trim();
  const scope = mo ? { mo, item: opts.item } : { bom: opts.bom, item: opts.item };
  const label = `${mo || opts.bom} ${opts.item}`;

  const [sums, master] = await Promise.all([
    db.handoverEntry.groupBy({
      by: ["dept"],
      where: { ...scope, ...excludeWhere(opts) },
      _sum: { qty: true },
    }),
    mo ? db.masterOrder.findUnique({ where: { mo } }) : Promise.resolve(null),
  ]);
  const tot = (d: string) =>
    (sums.find((s) => s.dept === d)?._sum.qty ?? 0) + (opts.dept === d ? opts.qty : 0);
  const cut = tot("Cut");
  const weld = tot("Welding");
  const paint = tot("Painting");
  const shp = tot("ShotBlast");
  const delivered = tot("Delivered");

  const finished = isPaintExempt(opts.item) ? shp : paint;
  if (delivered > finished)
    return `Chain check: ${label} would have ${delivered} delivered but only ${finished} finished — delivered must stay ≤ ${isPaintExempt(opts.item) ? "shot blasted" : "painted"}.`;
  if (isPaintExempt(opts.item) && shp > weld)
    return `Chain check: ${label} would have ${shp} shot blasted but only ${weld} welded — shot blasted must stay ≤ welded.`;
  if (paint > weld)
    return `Chain check: ${label} would have ${paint} painted but only ${weld} welded — painted must stay ≤ welded.`;
  if (weld > cut)
    return `Chain check: ${label} would have ${weld} welded but only ${cut} cut — welded must stay ≤ cut.`;
  // the ceiling is what the plant MAKES of the order: the pieces bought out
  // (OSP) are never cut here — the same rule the merged-row path (capsFor)
  // and the worklist's own target already follow
  const osp = master && isItem(opts.item) ? ospOf(master, opts.item) : 0;
  const inHouse = master ? master.planQty - osp : 0;
  if (opts.dept === "Cut" && master && master.planQty > 0 && cut > inHouse) {
    // only a change that RAISES the cut is refused: a correction or a delete on
    // an order already over its in-house share (the OSP typed after cutting)
    // must still be able to bring the figure down
    const ids = leavingIds(opts);
    const before = ids.length === 0
      ? cut - opts.qty
      : (await db.handoverEntry.aggregate({ where: { ...scope, dept: "Cut" }, _sum: { qty: true } }))._sum.qty ?? 0;
    if (cut > before)
      return `Chain check: order ${mo} is for ${master.planQty} pcs${osp > 0 ? ` (${osp} outsourced, ${inHouse} made here)` : ""} — cut would reach ${cut}. Max extra cut now: ${Math.max(0, inHouse - before)}.`;
  }
  return null;
}

/** The panel's chain — delivered ≤ painted ≤ welded ≤ bent ≤ punched ≤ order
 *  — re-checked as a whole after the proposed change, per MO. */
async function checkLvChain(opts: { dept: string; bom: string; mo?: string | null; qty: number; excludeId?: number; excludeIds?: number[] }, db: Db): Promise<string | null> {
  if (!isLvChainStage(opts.dept)) return `Chain check: "${opts.dept}" is not a panel stage — a panel is punched, bent, welded, painted, then delivered.`;
  const mo = (opts.mo ?? "").trim();
  const scope = mo ? { mo, item: LV_ITEM } : { bom: opts.bom, item: LV_ITEM };
  const [sums, master] = await Promise.all([
    db.handoverEntry.groupBy({
      by: ["dept"],
      where: { ...scope, ...excludeWhere(opts) },
      _sum: { qty: true },
    }),
    mo ? db.masterOrder.findUnique({ where: { mo }, select: { planQty: true } }) : Promise.resolve(null),
  ]);
  const tot = (d: string) => (sums.find((s) => s.dept === d)?._sum.qty ?? 0) + (opts.dept === d ? opts.qty : 0);
  const state: LvState = {
    required: master?.planQty ?? 0,
    punch: tot("Punching"), bend: tot("Bending"), weld: tot("Welding"), paint: tot("Painting"), delivered: tot("Delivered"),
  };
  return lvChainViolation(state, mo || opts.bom);
}
