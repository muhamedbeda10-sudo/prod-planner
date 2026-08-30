import { describe, it, expect } from "vitest";
import {
  tankSerial,
  parseTankSerial,
  serialsForBatch,
  statusAfterLeakTest,
  blockedReason,
  TANK_QUEUE_STATUS,
  tankEventLook,
  tankQrPayload,
  tankPath,
  normalizeSerialBom,
  normalizeEmpId,
  isWorkerDept,
  isTankStatus,
} from "./tanks";

describe("tank serials", () => {
  it("formats SF-<BOM>-<0001> with four digits", () => {
    expect(tankSerial("25301", 1)).toBe("SF-25301-0001");
    expect(tankSerial("25301", 42)).toBe("SF-25301-0042");
    expect(tankSerial("25301", 1234)).toBe("SF-25301-1234");
  });

  it("keeps growing past four digits instead of wrapping", () => {
    expect(tankSerial("25301", 12345)).toBe("SF-25301-12345");
  });

  it("normalizes the BOM — a serial written on steel carries no spaces", () => {
    expect(normalizeSerialBom(" 25 301 ")).toBe("25301");
    expect(tankSerial(" ab-12 ", 7)).toBe("SF-AB-12-0007");
  });

  it("round-trips through the parser", () => {
    const s = tankSerial("25301", 9);
    expect(parseTankSerial(s)).toEqual({ bom: "25301", seq: 9 });
  });

  it("parses a BOM that itself contains dashes (last dash wins)", () => {
    expect(parseTankSerial("SF-AB-12-0007")).toEqual({ bom: "AB-12", seq: 7 });
  });

  it("rejects anything that is not one of our serials", () => {
    expect(parseTankSerial("")).toBeNull();
    expect(parseTankSerial("25301-0001")).toBeNull(); // no prefix
    expect(parseTankSerial("SF-25301")).toBeNull(); // no running number
    expect(parseTankSerial("SF-25301-ABCD")).toBeNull(); // not digits
    expect(parseTankSerial("SF-25301-0000")).toBeNull(); // numbering starts at 1
    expect(parseTankSerial("SF--0001")).toBeNull(); // no BOM
  });

  it("is case-insensitive when parsing a hand-typed serial", () => {
    expect(parseTankSerial("sf-25301-0003")).toEqual({ bom: "25301", seq: 3 });
  });
});

describe("serialsForBatch", () => {
  it("mints one serial per tank, running on from the counter", () => {
    expect(serialsForBatch("25301", 5, 3)).toEqual([
      { seq: 5, serial: "SF-25301-0005" },
      { seq: 6, serial: "SF-25301-0006" },
      { seq: 7, serial: "SF-25301-0007" },
    ]);
  });

  it("returns nothing for an empty batch", () => {
    expect(serialsForBatch("25301", 1, 0)).toEqual([]);
  });

  it("restarts at 1 for a BOM that never made a tank before", () => {
    expect(serialsForBatch("99999", 1, 1)).toEqual([{ seq: 1, serial: "SF-99999-0001" }]);
  });
});

describe("the tank's path through the stages", () => {
  it("a passing leak test opens painting, a failing one sends it back", () => {
    expect(statusAfterLeakTest("pass")).toBe("tested");
    expect(statusAfterLeakTest("repair")).toBe("repair");
  });

  it("each screen's queue names one status, and no two name the same one", () => {
    expect(TANK_QUEUE_STATUS).toEqual({
      leakTest: "welded",
      repair: "repair",
      paintable: "tested",
      finished: "painted",
    });
    const statuses = Object.values(TANK_QUEUE_STATUS);
    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe("blockedReason", () => {
  it("lets the normal moves through", () => {
    expect(blockedReason("leak-test", "welded")).toBeNull();
    expect(blockedReason("repair", "repair")).toBeNull();
    expect(blockedReason("paint", "tested")).toBeNull();
  });

  it("explains an untested tank reaching painting", () => {
    expect(blockedReason("paint", "welded")).toMatch(/leak test/);
  });

  it("explains a failed tank reaching painting", () => {
    expect(blockedReason("paint", "repair")).toMatch(/needs repair/);
  });

  it("refuses a re-test before the repair is confirmed", () => {
    expect(blockedReason("leak-test", "repair")).toMatch(/needs its repair first/);
  });

  it("refuses testing or painting a tank twice", () => {
    expect(blockedReason("leak-test", "tested")).not.toBeNull();
    expect(blockedReason("leak-test", "painted")).not.toBeNull();
    expect(blockedReason("paint", "painted")).not.toBeNull();
  });

  it("refuses repairing a tank nobody failed", () => {
    expect(blockedReason("repair", "welded")).not.toBeNull();
    expect(blockedReason("repair", "tested")).not.toBeNull();
  });
});

describe("the scanned page", () => {
  it("builds the URL quality's scanner opens", () => {
    expect(tankPath("SF-25301-0001")).toBe("/tank/SF-25301-0001");
    expect(tankQrPayload("https://atc.example.com", "SF-25301-0001")).toBe(
      "https://atc.example.com/tank/SF-25301-0001"
    );
  });

  it("never doubles the slash when the base URL carries one", () => {
    expect(tankQrPayload("https://atc.example.com/", "SF-25301-0001")).toBe(
      "https://atc.example.com/tank/SF-25301-0001"
    );
  });
});

describe("event labels", () => {
  it("names every kind the actions write", () => {
    for (const kind of ["welded", "repaired", "leak-pass", "leak-repair", "painted", "qa-ok", "qa-not-ok"]) {
      expect(tankEventLook(kind).label).not.toBe(kind);
      expect(tankEventLook(kind).tone).toMatch(/^pill-/);
    }
  });

  it("falls back to the raw kind rather than rendering nothing", () => {
    expect(tankEventLook("something-new")).toEqual({ label: "something-new", tone: "pill-muted" });
  });
});

describe("normalizeEmpId", () => {
  it("survives how a badge number gets typed on the floor", () => {
    expect(normalizeEmpId("100058")).toBe("100058");
    expect(normalizeEmpId("  100058 ")).toBe("100058");
    expect(normalizeEmpId("100 058")).toBe("100058"); // read off the badge in two halves
    expect(normalizeEmpId("\t100058\n")).toBe("100058");
  });

  it("upper-cases so a lettered ID matches either way", () => {
    expect(normalizeEmpId("w-12a")).toBe("W-12A");
  });

  it("treats a blank box as no answer, not as a worker", () => {
    expect(normalizeEmpId("")).toBe("");
    expect(normalizeEmpId("   ")).toBe("");
  });
});

describe("guards", () => {
  it("knows its own statuses and worker departments", () => {
    expect(isTankStatus("welded")).toBe(true);
    expect(isTankStatus("shipped")).toBe(false);
    expect(isWorkerDept("LeakTest")).toBe(true);
    expect(isWorkerDept("Cut")).toBe(false);
  });
});
