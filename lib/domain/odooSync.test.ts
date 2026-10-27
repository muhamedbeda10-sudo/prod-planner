import { describe, expect, it } from "vitest";
import {
  dueOdooSlot, effectiveDoneAt, firstBatchName, hasBatchSuffix, itemOfCode, nextOdooSlotLabel, odooAgreement, odooDiffers, productCodeOf,
  suggestChildMos, summaryText, syncClock, EMPTY_SUMMARY, type ChildMoView,
} from "./odooSync";
import { EMPTY_ODOO_FILTERS, filterOdooEntries, type OdooEntryView } from "./odoo";

// Riyadh is UTC+3 all year: 06:00Z is 09:00 there.
const at = (iso: string) => new Date(iso);

describe("the sync's clock", () => {
  it("reads the moment in Riyadh", () => {
    expect(syncClock(at("2026-10-28T06:30:00Z"))).toEqual({ dateISO: "2026-10-28", weekday: 3, hour: 9, minute: 30 });
    // just after midnight there is the next day
    expect(syncClock(at("2026-10-28T21:30:00Z")).dateISO).toBe("2026-10-29");
  });

  it("is due at 09:00 and 13:00 on the working days", () => {
    expect(dueOdooSlot(at("2026-10-28T05:59:00Z"))).toBeNull(); // 08:59 Wednesday
    expect(dueOdooSlot(at("2026-10-28T06:00:00Z"))).toBe("2026-10-28@09");
    expect(dueOdooSlot(at("2026-10-28T09:59:00Z"))).toBe("2026-10-28@09"); // 12:59
    expect(dueOdooSlot(at("2026-10-28T10:00:00Z"))).toBe("2026-10-28@13");
    expect(dueOdooSlot(at("2026-10-28T20:00:00Z"))).toBe("2026-10-28@13"); // the evening still names the day's last
  });

  it("does not make up a missed morning run after 13:00 — the afternoon one reads the same Odoo", () => {
    expect(dueOdooSlot(at("2026-10-28T10:30:00Z"))).toBe("2026-10-28@13");
  });

  it("never runs on Friday or Saturday", () => {
    expect(dueOdooSlot(at("2026-10-30T07:00:00Z"))).toBeNull(); // Friday
    expect(dueOdooSlot(at("2026-10-31T11:00:00Z"))).toBeNull(); // Saturday
    expect(dueOdooSlot(at("2026-11-01T06:05:00Z"))).toBe("2026-11-01@09"); // Sunday
  });

  it("names the next run", () => {
    expect(nextOdooSlotLabel(at("2026-10-28T05:00:00Z"))).toBe("2026-10-28 09:00");
    expect(nextOdooSlotLabel(at("2026-10-28T07:00:00Z"))).toBe("2026-10-28 13:00");
    expect(nextOdooSlotLabel(at("2026-10-29T11:00:00Z"))).toBe("2026-11-01 09:00"); // Thursday afternoon → Sunday
  });
});

describe("Odoo's codes and names", () => {
  it("reads the product code and the component", () => {
    expect(productCodeOf("[FB-022-44005E11M11] TN_XMR_EXP_LIBYA")).toBe("FB-022-44005E11M11");
    expect(productCodeOf("no code")).toBe("");
    expect(itemOfCode("FB-022-44005E11M11")).toBe("TN");
    expect(itemOfCode("FB-051-1")).toBe("TC");
    expect(itemOfCode("FB-058-1")).toBe("CF");
    expect(itemOfCode("FB-036-1")).toBe("FN");
    expect(itemOfCode("FA-001-1")).toBeNull();
  });

  it("knows a batch and the name Odoo gives the first one", () => {
    expect(hasBatchSuffix("SF01/MO/15295-002")).toBe(true);
    expect(hasBatchSuffix("SF01/MO/15295")).toBe(false);
    expect(firstBatchName("SF01/MO/12686")).toBe("SF01/MO/12686-001");
  });
});

describe("a close-out row against Odoo", () => {
  const st = (state: string, found = true) => ({ found, state });
  it("agrees when both are closed or both open", () => {
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done" }, st("done"))).toBe("agree");
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "MO to be close" }, st("confirmed"))).toBe("agree");
  });
  it("flags a row Done here that Odoo has not closed — the planner's alert", () => {
    expect(odooAgreement({ odooMo: "SF01/MO/10416-004", status: "Done" }, st("progress"))).toBe("openInOdoo");
  });
  it("says when Odoo closed what is still open here", () => {
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "MO to be close" }, st("done"))).toBe("closedInOdoo");
  });
  it("says when Odoo cancelled it or has no such MO", () => {
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done" }, st("cancel"))).toBe("cancelledInOdoo");
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done" }, st("", false))).toBe("notFound");
  });
  it("has nothing to compare with no MO, a cancelled row, or before a sync", () => {
    expect(odooAgreement({ odooMo: "", status: "MO to be close" }, st("done"))).toBe("none");
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Cancelled" }, st("progress"))).toBe("none");
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done" }, null)).toBe("unchecked");
  });
  it("flags an MO that makes another component than the row's", () => {
    // a top cover row booked against a tank MO
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done", fgCode: "FB-051-14003E11M11" }, { found: true, state: "done", productCode: "FB-022-14003E11M11" })).toBe("otherPart");
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done", fgCode: "FB-022-X" }, { found: true, state: "done", productCode: "FB-022-Y" })).toBe("agree");
    // a code with no part prefix is not judged
    expect(odooAgreement({ odooMo: "SF01/MO/1", status: "Done", fgCode: "USS" }, { found: true, state: "done", productCode: "FB-022-Y" })).toBe("agree");
  });
  it("only the ones that want a look differ", () => {
    expect(["openInOdoo", "closedInOdoo", "cancelledInOdoo", "otherPart", "notFound"].every(odooDiffers)).toBe(true);
    expect(["agree", "none", "unchecked"].some(odooDiffers)).toBe(false);
  });

  it("filters the log to the rows that differ", () => {
    const row = (id: number, agreement: string | undefined): OdooEntryView => ({
      id, dateISO: "2026-10-27", soi: null, fgCode: "FB-022-1", product: "Tank", odooMo: "SF01/MO/1", qty: 1, status: "Done", tone: "ok", done: true,
      doneAtISO: null, version: "", recordedBy: null, source: "manual", fgGuessed: false, line: "TR", mo: null, bom: { boms: [], via: null }, notes: [],
      odoo: agreement ? { agreement: agreement as never, state: null, suggest: [] } : undefined,
    });
    const rows = [row(1, "agree"), row(2, "openInOdoo"), row(3, undefined), row(4, "notFound")];
    expect(filterOdooEntries(rows, { ...EMPTY_ODOO_FILTERS, odoo: "differs" }).map((r) => r.id)).toEqual([2, 4]);
    expect(filterOdooEntries(rows, EMPTY_ODOO_FILTERS)).toHaveLength(4);
  });

  it("counts a closing on Odoo's own moment when known", () => {
    const ticked = at("2026-10-27T10:00:00Z");
    const odoo = at("2026-10-26T12:25:30Z");
    expect(effectiveDoneAt({ status: "Done", doneAt: ticked }, odoo)).toEqual(odoo);
    expect(effectiveDoneAt({ status: "Done", doneAt: ticked }, null)).toEqual(ticked);
    expect(effectiveDoneAt({ status: "MO to be close", doneAt: null }, odoo)).toBeNull();
  });
});

describe("the MO a row born from a closing can take", () => {
  const c = (name: string, o: Partial<ChildMoView> = {}): ChildMoView => ({
    parentMo: "PF01/MO/1", name, item: "TN", productCode: "FB-022-14003E11M11", qty: 10, qtyProduced: 0, uom: "Units", state: "confirmed",
    doneAtISO: null, linkHow: "direct", sharedWith: [], ...o,
  });

  it("offers only the open MOs of the row's component", () => {
    const got = suggestChildMos({ qty: 5, fgCode: "FB-022-14003E11M11", item: "TN" }, [
      c("SF01/MO/1-001", { state: "done" }), c("SF01/MO/1-002"), c("SF01/MO/2", { item: "TC", productCode: "FB-051-X" }), c("SF01/MO/3", { state: "cancel" }),
    ]);
    expect(got.map((x) => x.name)).toEqual(["SF01/MO/1-002"]);
  });

  it("puts the row's own FG code first, then an exact fit, then the smallest that holds it", () => {
    const got = suggestChildMos({ qty: 4, fgCode: "FB-022-14003E11M11", item: "TN" }, [
      c("SF01/MO/9", { productCode: "FB-022-OTHER", qty: 4 }),
      c("SF01/MO/5", { qty: 20 }),
      c("SF01/MO/6", { qty: 10, qtyProduced: 6 }), // exactly 4 left
      c("SF01/MO/7", { qty: 8 }),
      c("SF01/MO/8", { qty: 3 }), // too small
    ], 5);
    expect(got.map((x) => x.name)).toEqual(["SF01/MO/6", "SF01/MO/7", "SF01/MO/5", "SF01/MO/8", "SF01/MO/9"]);
  });

  it("reaches the order's other batches after its own — the floor books against any open MO of the order", () => {
    const got = suggestChildMos({ qty: 2, fgCode: "", item: "TN", parentMo: "PF01/MO/39611-006" }, [
      c("SF01/MO/15290-002", { parentMo: "PF01/MO/39611-003", qty: 2 }),
      c("SF01/MO/15300-001", { parentMo: "PF01/MO/39611-006", qty: 9 }),
      // the same MO under both batches is offered once, as the row's own
      c("SF01/MO/15306-005", { parentMo: "PF01/MO/39611-003", qty: 2 }),
      c("SF01/MO/15306-005", { parentMo: "PF01/MO/39611-006", qty: 2 }),
    ], 5);
    expect(got.map((x) => [x.name, x.parentMo])).toEqual([
      ["SF01/MO/15306-005", "PF01/MO/39611-006"],
      ["SF01/MO/15300-001", "PF01/MO/39611-006"],
      ["SF01/MO/15290-002", "PF01/MO/39611-003"],
    ]);
  });

  it("an LV order's own batches fit any component", () => {
    const got = suggestChildMos({ qty: 1, fgCode: "", item: "USS" }, [c("SF01/MO/10416-004", { item: "", productCode: "" })]);
    expect(got).toHaveLength(1);
  });
});

describe("a run's summary", () => {
  it("reads in one line", () => {
    const s = { ...EMPTY_SUMMARY, log: { ...EMPTY_SUMMARY.log, checked: 12, differs: 2 }, children: { orders: 3, mos: 20, unresolved: 0 }, stock: { updated: 5, unchanged: 1, missing: 0 }, issues: ["x"] };
    expect(summaryText(s)).toBe("12 MOs checked (2 differ from the log) · 20 sub-assembly MOs under 3 orders · SF01 stock: 5 updated · 1 issue");
    expect(summaryText(null)).toBe("");
  });
});
