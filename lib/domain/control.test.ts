import { describe, expect, it } from "vitest";
import { attentionOf, backlogOf, backlogSeries, bottleneckOf, deliveredUnitsOf, paceOf, piecesOf, planSummaryOf, stageLoadOf, workingDaysBetween, workingDaysLeft, type ControlRow } from "./control";

const it6 = (v: Partial<ControlRow["items"]["CF"]> = {}) => ({ cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true, ...v });
const row = (over: Partial<ControlRow> = {}): ControlRow => ({
  mo: "PF01/MO/1", bom: "B1", soi: "S1", customer: "PRI", required: 10, complete: 0, status: "open", urgent: false, priority: false, onHold: false, months: [],
  items: { CF: it6(), TC: it6(), TN: it6(), CB: it6(), AR: it6({ eligible: false }), MB: it6({ eligible: false }) },
  ...over,
});

describe("piecesOf / backlogOf / bottleneckOf", () => {
  it("counts required pieces stage by stage, the core finishing at shot blast", () => {
    const r = row({ items: { CF: it6({ cut: 10, weld: 8, shp: 6, paint: 0, delivered: 2 }), TC: it6({ cut: 10, weld: 10, paint: 10, delivered: 10 }), TN: it6({ cut: 5 }), CB: it6({ excluded: true, cut: 10 }), AR: it6({ eligible: false }), MB: it6({ eligible: false }) } });
    const p = piecesOf([r]);
    expect(p).toEqual({ need: 30, cut: 25, weld: 18, finished: 16, delivered: 12 });
    expect(backlogOf(p)).toEqual({ fab: 5, weld: 7, finish: 2, deliver: 4 });
    expect(bottleneckOf(backlogOf(p))).toBe("weld");
  });
  it("OSP pieces are bought — they are not the plant's need, and output is capped at the need", () => {
    const r = row({ required: 10, items: { ...row().items, CF: it6({ osp: 4, cut: 9 }) } });
    const p = piecesOf([r]);
    expect(p.need).toBe(6 + 30); // CF needs 6; TC/TN/CB 10 each
    expect(p.cut).toBe(6);
  });
  it("closed orders are not on the floor", () => {
    expect(piecesOf([row({ status: "closed", items: { ...row().items, CF: it6({ cut: 10 }) } })]).need).toBe(0);
    expect(bottleneckOf({ fab: 0, weld: 0, finish: 0, deliver: 0 })).toBeNull();
  });
});

describe("planSummaryOf", () => {
  it("sums units, and a unit is delivered only when every required component was", () => {
    const a = row({ required: 10, complete: 4, items: { ...row().items, CF: it6({ delivered: 3 }), TC: it6({ delivered: 5 }), TN: it6({ delivered: 3 }), CB: it6({ delivered: 3 }) } });
    const b = row({ mo: "PF01/MO/2", required: 5, complete: 5, urgent: true, onHold: true, items: { ...row().items, CF: it6({ delivered: 5 }), TC: it6({ delivered: 5 }), TN: it6({ delivered: 5 }), CB: it6({ delivered: 5 }) } });
    expect(deliveredUnitsOf(a)).toBe(3);
    expect(planSummaryOf([a, b, row({ status: "closed" })])).toEqual({ orders: 2, required: 15, complete: 9, delivered: 8, remaining: 6, pct: 0.6, urgent: 1, priority: 0, onHold: 1 });
  });
});

describe("working days and pace", () => {
  it("counts Sat–Thu from tomorrow to month end, holidays off", () => {
    // 2026-09-17 is a Thursday; the 18th is Friday. 19..30 = 12 days with one Friday (25th) → 11, minus a holiday
    expect(workingDaysLeft("2026-09-17", new Set(["2026-09-23"]))).toBe(10);
    expect(workingDaysBetween("2026-09-13", "2026-09-19", new Set())).toBe(6); // Sun..Sat, Friday 18th off
  });
  it("compares the actual pace with the required one", () => {
    const p = paceOf(120, 100, 10, 8); // 10/day actual, 15/day needed
    expect(p.actualPerDay).toBe(10);
    expect(p.requiredPerDay).toBe(15);
    expect(p.ratio).toBeCloseTo(0.667, 3);
    expect(p.daysNeeded).toBe(12);
    expect(paceOf(0, 0, 0, 0)).toEqual({ actualPerDay: null, requiredPerDay: null, daysLeft: 0, ratio: null, daysNeeded: null });
  });
});

describe("attentionOf", () => {
  const eta = (v: Partial<{ etaISO: string | null; dueISO: string | null; late: boolean; done: boolean; blockedBy: string | null }>) =>
    ({ etaISO: null, dueISO: null, late: false, done: false, blockedBy: null, ...v });
  it("ranks late, due soon, blocked, then holds — urgent first, most late on top", () => {
    const rows = [
      row({ mo: "A", required: 10, complete: 2 }),
      row({ mo: "B", required: 10, complete: 2, urgent: true }),
      row({ mo: "C", required: 10, complete: 2 }),
      row({ mo: "D", required: 10, complete: 2, onHold: true }),
      row({ mo: "E", required: 10, complete: 10 }), // nothing left — never listed
      row({ mo: "F", required: 10, complete: 0 }), // due in 20 days — not soon
    ];
    const etas = new Map([
      ["A", eta({ etaISO: "2026-09-25", dueISO: "2026-09-20", late: true })],
      ["B", eta({ etaISO: "2026-09-22", dueISO: "2026-09-20", late: true })],
      ["C", eta({ etaISO: "2026-09-19", dueISO: "2026-09-21" })],
      ["E", eta({ done: true })],
      ["F", eta({ etaISO: "2026-10-01", dueISO: "2026-10-07" })],
    ]);
    const out = attentionOf(rows, etas, "2026-09-17");
    expect(out.map((o) => `${o.mo}:${o.kind}:${o.days}`)).toEqual(["B:late:2", "A:late:5", "C:dueSoon:4", "D:hold:0"]);
  });
  it("names a blocked forecast and honours the cap", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ mo: `M${i}`, required: 5 }));
    const etas = new Map(rows.map((r) => [r.mo, eta({ blockedBy: "Cut" })]));
    expect(attentionOf(rows, etas, "2026-09-17", 5)).toHaveLength(5);
    expect(attentionOf(rows, etas, "2026-09-17", 5)[0].kind).toBe("blocked");
  });
});

describe("backlogSeries", () => {
  const rows = [row({ mo: "A", required: 10, items: { CF: it6(), TC: it6(), TN: it6({ excluded: true }), CB: it6({ excluded: true }), AR: it6({ eligible: false }), MB: it6({ eligible: false }) } })];
  const led = (mo: string, item: string, dept: string, dateISO: string, qty: number) => ({ mo, item, dept, dateISO, qty });
  it("walks the ledger day by day, from what stood before the window, capped at the need", () => {
    const ledger = [
      led("A", "CF", "Cut", "2026-09-01", 6), // before the window
      led("A", "CF", "Cut", "2026-09-11", 14), // 20 cut — capped at 10
      led("A", "CF", "Welding", "2026-09-11", 3),
      led("A", "CF", "ShotBlast", "2026-09-12", 2), // the core finishes at shot blast
      led("A", "CF", "Painting", "2026-09-12", 5), // not the core's finishing — ignored
      led("A", "TC", "Cut", "2026-09-12", 4),
      led("A", "TC", "Painting", "2026-09-12", 1), // ahead of its welding — still capped at need, backlog never negative
      led("B", "CF", "Cut", "2026-09-12", 9), // an order not open — ignored
    ];
    const s = backlogSeries(rows, ledger, "2026-09-10", "2026-09-12");
    expect(s.map((p) => p.dateISO)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
    expect(s[0]).toMatchObject({ fab: 14, weld: 6, finish: 0, deliver: 0 }); // 6 cut of 20 needed
    expect(s[1]).toMatchObject({ fab: 10, weld: 7, finish: 3, deliver: 0 }); // CF 10 cut, 3 welded
    // TC 4 cut (14 cut of 20); CF 2 shot blasted + TC 1 painted = 3 finished with only 3 welded → nothing waits for finishing, 3 wait for delivery
    expect(s[2]).toMatchObject({ fab: 6, weld: 11, finish: 0, deliver: 3 });
  });
  it("is the backlog card on its last day", () => {
    const ledger = [led("A", "CF", "Cut", "2026-09-01", 10), led("A", "CF", "Welding", "2026-09-02", 4)];
    const last = backlogSeries(rows, ledger, "2026-09-10", "2026-09-10")[0];
    const today = backlogOf(piecesOf([row({ mo: "A", required: 10, items: { ...rows[0].items, CF: it6({ cut: 10, weld: 4 }) } })]));
    expect({ fab: last.fab, weld: last.weld, finish: last.finish, deliver: last.deliver }).toEqual(today);
  });
});

describe("stageLoadOf", () => {
  it("turns queued hours into days of work and utilisation", () => {
    const l = stageLoadOf("cut", 480, 60, 80, 96);
    expect(l.daysOfWork).toBe(8);
    expect(l.utilisation).toBe(0.75);
    expect(stageLoadOf("weld", 100, 0, null, null)).toMatchObject({ daysOfWork: null, utilisation: null });
  });
});
