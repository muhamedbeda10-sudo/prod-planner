import { describe, expect, it } from "vitest";
import { FINISHED_STATUSES, alertKey, isReadyToClose, needsMo, pruneSeen, unseenKeys } from "./odooAlerts";
import { STATUS_TONE_WORDS, statusTone } from "./odoo";

describe("the ODOO alerts", () => {
  it("calls a row ready once Odoo's MO is on it and it is still open", () => {
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "MO to be close" })).toBe(true);
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "Pending" })).toBe(true);
    expect(isReadyToClose({ odooMo: "  ", status: "MO to be close" })).toBe(false);
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "Done" })).toBe(false);
    // not waiting on anyone either
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "Blocked" })).toBe(false);
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "cancelled" })).toBe(false);
  });
  it("calls a row waiting for an MO while it has none and is still to be closed", () => {
    expect(needsMo({ odooMo: "", status: "MO to be close" })).toBe(true);
    expect(needsMo({ odooMo: " ", status: "Pending" })).toBe(true);
    expect(needsMo({ odooMo: "SF01/MO/1", status: "MO to be close" })).toBe(false);
    expect(needsMo({ odooMo: "", status: "Done" })).toBe(false);
    expect(needsMo({ odooMo: "", status: "Cancelled" })).toBe(false);
    expect(needsMo({ odooMo: "", status: "Blocked" })).toBe(false);
  });
  it("pops up for keys not seen yet, per kind, and forgets keys no longer live", () => {
    const keys = [alertKey("close", 1), alertKey("close", 2), alertKey("mo", 3)];
    expect(unseenKeys(keys, new Set(["close:1", "mo:3"]))).toEqual(["close:2"]);
    expect(unseenKeys(keys, new Set(["close:1", "close:2", "mo:3", "mo:1"]))).toEqual([]);
    // seen while it needed an MO, the same row is news again once ready
    expect(unseenKeys([alertKey("close", 3)], new Set(["mo:3"]))).toEqual(["close:3"]);
    expect(pruneSeen(["close:1", "close:7", "close:1", "mo:3"], keys)).toEqual(["close:1", "mo:3"]);
  });
  // FINISHED_STATUSES is the database prefilter for the polls above; statusTone
  // is the rule they apply after. A word only the prefilter calls finished
  // hides an open row from the alerts; one only statusTone calls finished
  // loads rows the poll then throws away.
  it("keeps the database prefilter and statusTone on the same finished words", () => {
    const finishedTones = new Set(["ok", "bad"]);
    for (const s of FINISHED_STATUSES) {
      expect(finishedTones.has(statusTone(s)), s).toBe(true);
      expect(isReadyToClose({ odooMo: "SF01/MO/1", status: s }), s).toBe(false);
      expect(needsMo({ odooMo: "", status: s }), s).toBe(false);
    }
    const prefiltered = new Set(FINISHED_STATUSES.map((s) => s.toLowerCase()));
    const toneFinished = [...STATUS_TONE_WORDS.ok, ...STATUS_TONE_WORDS.bad];
    for (const w of toneFinished) {
      expect(finishedTones.has(statusTone(w)), w).toBe(true);
      expect(prefiltered.has(w.toLowerCase()), w).toBe(true);
    }
    // the open tones stay out of the prefilter
    for (const w of STATUS_TONE_WORDS.warn) expect(prefiltered.has(w.toLowerCase()), w).toBe(false);
  });
});
