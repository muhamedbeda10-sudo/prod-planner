import { describe, it, expect } from "vitest";
import { TRACKER_PREF_KEYS, isUserPrefKey } from "./userPrefs";

describe("isUserPrefKey", () => {
  it("accepts only the settings an account keeps", () => {
    for (const k of TRACKER_PREF_KEYS) expect(isUserPrefKey(k)).toBe(true);
    expect(isUserPrefKey("tracker:open")).toBe(false);
    expect(isUserPrefKey("isAdmin")).toBe(false);
  });
});
