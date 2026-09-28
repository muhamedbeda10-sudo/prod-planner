import { describe, expect, it } from "vitest";
import { isReadyToClose, pruneSeen, unseenReady } from "./odooAlerts";

describe("the ODOO closing alert", () => {
  it("calls a row ready once Odoo's MO is on it and it is still open", () => {
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "MO to be close" })).toBe(true);
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "Pending" })).toBe(true);
    expect(isReadyToClose({ odooMo: "  ", status: "MO to be close" })).toBe(false);
    expect(isReadyToClose({ odooMo: "SF01/MO/06215", status: "Done" })).toBe(false);
  });
  it("pops up for the rows not seen yet, and forgets rows that are no longer ready", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(unseenReady(rows, new Set([1, 3]))).toEqual([2]);
    expect(unseenReady(rows, new Set([1, 2, 3]))).toEqual([]);
    expect(pruneSeen([1, 2, 7, 7], rows)).toEqual([1, 2]);
  });
});
