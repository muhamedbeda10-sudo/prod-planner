/* The ledger data guard: marks entries that LOOK wrong so a human checks them
 * before they poison the reports, forecasts and calibration built on the
 * ledger. Marks, never blocks — the hard guards at entry time already refuse
 * the impossible; this catches the merely implausible.
 */

export interface GuardEntry {
  id: number;
  dateISO: string; // work date
  dept: string;
  bom: string;
  mo: string | null;
  item: string;
  qty: number;
  createdISO: string; // when it was actually recorded
}

export interface GuardFlag {
  type: "outlier" | "duplicate" | "late" | "future";
  detail: string;
}

/** An entry recorded more than this many days after the work date is suspect —
 *  memory of what actually happened has faded by then. */
export const LATE_DAYS = 3;

/** Below this many historical entries for a dept×item, no outlier judgement —
 *  a median of four numbers says nothing. */
export const MIN_GROUP = 8;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Every flag for every entry, keyed by entry id. Entries the guard trusts
 *  simply have no key. */
export function guardLedger(entries: GuardEntry[]): Map<number, GuardFlag[]> {
  const flags = new Map<number, GuardFlag[]>();
  const add = (id: number, f: GuardFlag) => {
    if (!flags.has(id)) flags.set(id, []);
    flags.get(id)!.push(f);
  };

  // ---- outlier quantities: robust z-score per dept×item ----
  // median/MAD instead of mean/stddev so one earlier typo can't widen the
  // band enough to hide the next one
  const groups = new Map<string, GuardEntry[]>();
  for (const e of entries) {
    const k = `${e.dept}|${e.item}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  for (const group of groups.values()) {
    if (group.length < MIN_GROUP) continue;
    const qtys = group.map((e) => e.qty);
    const m = median(qtys);
    const mad = median(qtys.map((q) => Math.abs(q - m)));
    for (const e of group) {
      // high side only — a small entry is a small day, not a typo
      const extreme = mad > 0 ? (0.6745 * (e.qty - m)) / mad > 3.5 : e.qty > 3 * m;
      if (extreme && e.qty >= Math.max(10, 2 * m)) {
        add(e.id, {
          type: "outlier",
          detail: `${e.qty} pcs is far above the usual ${m} for ${e.dept} ${e.item} — a typo?`,
        });
      }
    }
  }

  // ---- exact duplicates: the same record twice on the same day ----
  const dupes = new Map<string, GuardEntry[]>();
  for (const e of entries) {
    const k = `${e.dateISO}|${e.dept}|${e.item}|${e.bom}|${e.mo ?? ""}|${e.qty}`;
    if (!dupes.has(k)) dupes.set(k, []);
    dupes.get(k)!.push(e);
  }
  for (const group of dupes.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      add(e.id, {
        type: "duplicate",
        detail: `this exact record (same day, dept, order, item, qty) appears ${group.length} times — recorded twice?`,
      });
    }
  }

  // ---- recording drift: entered long after the fact, or dated ahead of it ----
  for (const e of entries) {
    const workDay = Math.floor(Date.parse(`${e.dateISO}T00:00:00Z`) / 86400000);
    const createdDay = Math.floor(Date.parse(e.createdISO) / 86400000);
    if (Number.isNaN(workDay) || Number.isNaN(createdDay)) continue;
    const lag = createdDay - workDay;
    if (lag > LATE_DAYS) {
      add(e.id, { type: "late", detail: `recorded ${lag} days after the work date — backfilled from memory?` });
    } else if (lag < 0) {
      add(e.id, { type: "future", detail: "work date is AFTER the day this was recorded — output claimed in advance?" });
    }
  }

  return flags;
}
