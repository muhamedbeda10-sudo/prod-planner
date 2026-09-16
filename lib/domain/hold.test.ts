import { describe, expect, it } from "vitest";
import { holdLabel, holdView, isOnHold } from "./hold";

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
