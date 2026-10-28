import { describe, it, expect } from "vitest";
import { LV_TRACKER_PREF_KEYS, MATERIAL_PREF_KEYS, TRACKER_PREF_KEYS, isUserPrefKey } from "./userPrefs";

describe("isUserPrefKey", () => {
  it("accepts only the settings an account keeps", () => {
    for (const k of [...TRACKER_PREF_KEYS, ...LV_TRACKER_PREF_KEYS, ...MATERIAL_PREF_KEYS]) expect(isUserPrefKey(k)).toBe(true);
    expect(isUserPrefKey("lvtracker:collapsed")).toBe(false);
    expect(isUserPrefKey("tracker:open")).toBe(false);
    expect(isUserPrefKey("material:filters")).toBe(false);
    expect(isUserPrefKey("isAdmin")).toBe(false);
  });
});
