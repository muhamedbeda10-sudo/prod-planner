import "server-only";
import { prisma } from "@/lib/db";
import {
  batchBase, normMo, odooAgreement, suggestChildMos,
  type ChildMoView, type MoStateView, type RowOdooFacts,
} from "@/lib/domain/odooSync";

// What the last Odoo sync read, joined onto the close-out log's rows at read
// time: how each row's MO stands in Odoo, and — for a row still waiting for
// its MO — the open sub-assembly MOs it can be booked against. Read from the
// sync's own tables only: no page waits on Odoo.

const childView = (c: {
  parentMo: string; name: string; item: string; productCode: string; qty: number; qtyProduced: number; uom: string; state: string; doneAt: Date | null; linkHow: string; sharedWith: string;
}): ChildMoView => ({
  parentMo: c.parentMo, name: c.name, item: c.item, productCode: c.productCode, qty: c.qty, qtyProduced: c.qtyProduced, uom: c.uom, state: c.state,
  doneAtISO: c.doneAt ? c.doneAt.toISOString() : null, linkHow: c.linkHow, sharedWith: c.sharedWith ? c.sharedWith.split(",").filter(Boolean) : [],
});

/** The states the sync keeps for these MO names, by name (upper case). */
export async function moStatesOf(names: readonly string[]): Promise<Map<string, MoStateView>> {
  const list = [...new Set(names.map(normMo).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.odooMoState.findMany({ where: { name: { in: list } } });
  return new Map(rows.map((r) => [r.name, {
    name: r.name, found: r.found, productCode: r.productCode, currentName: r.currentName || r.name, state: r.state, qty: r.qty, qtyProduced: r.qtyProduced,
    doneAtISO: r.doneAt ? r.doneAt.toISOString() : null, checkedAtISO: r.checkedAt.toISOString(),
  }]));
}

/** The sub-assembly MOs the sync found under these orders, by order MO —
 *  with `family`, under every batch of each order's family too (keyed by the
 *  batch they hang under). */
export async function childMosOf(orderMos: readonly string[], family = false): Promise<Map<string, ChildMoView[]>> {
  const list = [...new Set(orderMos.map(normMo).filter(Boolean))];
  const out = new Map<string, ChildMoView[]>();
  if (!list.length) return out;
  const bases = family ? [...new Set(list.map(batchBase))] : [];
  const rows = await prisma.odooChildMo.findMany({
    where: { OR: [{ parentMo: { in: [...list, ...bases] } }, ...bases.map((b) => ({ parentMo: { startsWith: `${b}-` } }))] },
    orderBy: [{ item: "asc" }, { name: "asc" }],
  });
  for (const r of rows) out.set(r.parentMo, [...(out.get(r.parentMo) ?? []), childView(r)]);
  return out;
}

/** An order's own children and its family's, as one list. */
const familyOf = (children: ReadonlyMap<string, ChildMoView[]>, order: string) => {
  const base = batchBase(order);
  return [...children.entries()].filter(([p]) => p === order || batchBase(p) === base).flatMap(([, list]) => list);
};

/**
 * Each row's Odoo facts, by row id. `ledger` is the closing each born row
 * came from (its order's MO and component), by ledger id.
 */
export async function odooFactsFor(
  rows: readonly { id: number; odooMo: string; status: string; fgCode: string; qty: number; ledgerId: number | null }[],
  ledger: ReadonlyMap<number, { mo: string | null; item: string | null }>,
): Promise<Map<number, RowOdooFacts>> {
  const needMo = rows.filter((r) => !normMo(r.odooMo) && r.ledgerId !== null);
  const [states, children] = await Promise.all([
    moStatesOf(rows.map((r) => r.odooMo)),
    childMosOf(needMo.map((r) => ledger.get(r.ledgerId!)?.mo ?? ""), true),
  ]);
  const out = new Map<number, RowOdooFacts>();
  for (const r of rows) {
    const st = states.get(normMo(r.odooMo)) ?? null;
    let suggest: ChildMoView[] = [];
    if (!normMo(r.odooMo) && r.ledgerId !== null) {
      const l = ledger.get(r.ledgerId);
      const kids = l?.mo ? familyOf(children, normMo(l.mo)) : [];
      suggest = suggestChildMos({ qty: r.qty, fgCode: r.fgCode, item: l?.item ?? null, parentMo: l?.mo ?? null }, kids);
    }
    out.set(r.id, { agreement: odooAgreement(r, st), state: st, suggest });
  }
  return out;
}
