// Excess reallocation — pure port of modBoms.ReallocateExcess.
//
// Within a BOM family (same BomGroup), when a member has logged MORE than its
// target for a given dept+item (excess) and a sibling has logged LESS than its
// target (deficit), move the excess to the sibling. The VBA mutates the handover
// log in place; here we instead return explicit, reviewable MOVE proposals and
// never touch the raw entries. Applying the approved moves reproduces the sheet.
//
// Donor rows are consumed LAST-to-first (matching the VBA), so each move carries
// the donor row's own date and id for a full audit trail.

import { ITEMS, DEPTS, type Item, type Dept } from "./constants";
import type { BomGrouper } from "./bom";

export interface ReallocOrderRow {
  bom: string;
  item: string;
  targetQty: number;
}

export interface ReallocLogRow {
  id: number;
  date: Date;
  dept: string;
  bom: string;
  item: string;
  qty: number;
}

export interface ReallocationProposal {
  dept: Dept;
  item: Item;
  fromBom: string;
  toBom: string;
  qty: number;
  date: Date;
  donorRowId: number;
}

export function computeReallocations(
  orders: ReallocOrderRow[],
  handover: ReallocLogRow[],
  grouper: BomGrouper
): ReallocationProposal[] {
  // capD[bom|item] = sum targetQty ; fam[groupKey] = ordered member boms
  const capD = new Map<string, number>();
  const fam = new Map<string, string[]>();
  const famSeen = new Map<string, Set<string>>();
  for (const o of orders) {
    const bom = (o.bom ?? "").trim();
    if (!bom) continue;
    capD.set(`${bom}|${o.item}`, (capD.get(`${bom}|${o.item}`) ?? 0) + (o.targetQty || 0));
    const fk = grouper(bom);
    if (!fam.has(fk)) {
      fam.set(fk, []);
      famSeen.set(fk, new Set());
    }
    if (!famSeen.get(fk)!.has(bom)) {
      famSeen.get(fk)!.add(bom);
      fam.get(fk)!.push(bom);
    }
  }

  // tot[dept|bom|item] = sum qty ; rowsOf[dept|bom|item] = rows (insertion order)
  const tot = new Map<string, number>();
  const rowsOf = new Map<string, ReallocLogRow[]>();
  // mutable per-row remaining qty, keyed by row id
  const rowQty = new Map<number, number>();
  for (const r of handover) {
    const dept = r.dept;
    const bom = (r.bom ?? "").trim();
    const item = r.item;
    const q = r.qty || 0;
    if (dept !== "Cut" && dept !== "Welding") continue;
    if (!bom || !item || q <= 0) continue;
    const k = `${dept}|${bom}|${item}`;
    tot.set(k, (tot.get(k) ?? 0) + q);
    if (!rowsOf.has(k)) rowsOf.set(k, []);
    rowsOf.get(k)!.push(r);
    rowQty.set(r.id, q);
  }

  const get = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
  const proposals: ReallocationProposal[] = [];

  for (const [, boms] of fam) {
    if (boms.length < 2) continue;
    for (const dept of DEPTS) {
      for (const item of ITEMS) {
        for (let d = 0; d < boms.length; d++) {
          const donor = boms[d];
          const dk = `${dept}|${donor}|${item}`;
          let excess = get(tot, dk) - get(capD, `${donor}|${item}`);
          if (excess <= 0) continue;
          for (let rc = 0; rc < boms.length; rc++) {
            if (rc === d || excess <= 0) continue;
            const rcv = boms[rc];
            const rk = `${dept}|${rcv}|${item}`;
            const deficit = get(capD, `${rcv}|${item}`) - get(tot, rk);
            if (deficit <= 0) continue;
            let mv = Math.min(excess, deficit);
            let remaining = mv;
            const donorRows = rowsOf.get(dk);
            if (donorRows) {
              for (let j = donorRows.length - 1; j >= 0 && remaining > 0; j--) {
                const row = donorRows[j];
                const cur = rowQty.get(row.id) ?? 0;
                const take = Math.min(cur, remaining);
                if (take > 0) {
                  rowQty.set(row.id, cur - take);
                  proposals.push({
                    dept,
                    item,
                    fromBom: donor,
                    toBom: rcv,
                    qty: take,
                    date: row.date,
                    donorRowId: row.id,
                  });
                  remaining -= take;
                }
              }
            }
            const moved = mv - remaining;
            tot.set(dk, get(tot, dk) - moved);
            tot.set(rk, get(tot, rk) + moved);
            excess -= moved;
          }
        }
      }
    }
  }
  return proposals;
}

/** Net effect of a set of moves on logged qty per `dept|bom|item`. */
export function applyReallocations(
  logged: Map<string, number>,
  moves: { dept: string; item: string; fromBom: string; toBom: string; qty: number }[]
): Map<string, number> {
  const out = new Map(logged);
  const add = (k: string, q: number) => out.set(k, (out.get(k) ?? 0) + q);
  for (const m of moves) {
    add(`${m.dept}|${m.fromBom}|${m.item}`, -m.qty);
    add(`${m.dept}|${m.toBom}|${m.item}`, m.qty);
  }
  return out;
}
