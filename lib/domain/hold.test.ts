import { describe, expect, it } from "vitest";
import { heldOrders, holdLabel, holdView, isOnHold } from "./hold";

describe("hold", () => {
  it("is on hold exactly when holdAt is set", () => {
    expect(isOnHold({ holdAt: null })).toBe(false);
    expect(isOnHold({ holdAt: new Date("2026-09-16T08:00:00Z") })).toBe(true);
    expect(isOnHold({ holdAt: "2026-09-16T08:00:00Z" })).toBe(true);
  });

  it("carries the reason, who and since only while on hold", () => {
    const on = holdView({ holdAt: "2026-09-16T08:00:00Z", holdNote: "  waiting for CRC  ", holdBy: "Beda" });
    expect(on).toEqual({ onHold: true, holdNote: "waiting for CRC", holdSinceISO: "2026-09-16", holdBy: "Beda" });
    // a stale note on a released order says nothing
    const off = holdView({ holdAt: null, holdNote: "old reason", holdBy: "Beda" });
    expect(off).toEqual({ onHold: false, holdNote: null, holdSinceISO: null, holdBy: null });
  });

  it("labels the hold in one line", () => {
    expect(holdLabel(holdView({ holdAt: "2026-09-16T08:00:00Z", holdNote: "waiting for CRC", holdBy: "Beda" }))).toBe("On hold — waiting for CRC (Beda, since 2026-09-16)");
    expect(holdLabel(holdView({ holdAt: "2026-09-16T08:00:00Z", holdNote: "", holdBy: null }))).toBe("On hold (since 2026-09-16)");
    expect(holdLabel(holdView({ holdAt: null, holdNote: null, holdBy: null }))).toBe("");
  });
});

describe("heldOrders — the strip a worklist names them in", () => {
  it("lists the open orders on hold by MO, with their rating", () => {
    const at = new Date("2026-10-10T08:00:00Z");
    const o = (mo: string, over: Partial<{ status: string; holdAt: Date | null }> = {}) => ({ mo, bom: `B-${mo}`, status: "open", holdAt: at, holdNote: "waiting for the client", holdBy: "Sara", kva: "1000 kVA", rating: "11 kV", ...over });
    const held = heldOrders([o("M3"), o("M1"), o("M2", { holdAt: null }), o("M4", { status: "closed" })]);
    expect(held.map((h) => h.mo)).toEqual(["M1", "M3"]);
    expect(held[0]).toMatchObject({ bom: "B-M1", description: "1000 kVA · 11 kV", hold: { onHold: true, holdNote: "waiting for the client", holdSinceISO: "2026-10-10" } });
  });
});
