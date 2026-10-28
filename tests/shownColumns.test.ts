import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/prefs/actions", () => ({ saveUserPref: vi.fn() }));
import { shownColumns } from "@/components/TrackerColumns";

describe("shownColumns", () => {
  it("reads nothing saved as the defaults", () => {
    expect([...shownColumns(null, ["a", "b"])]).toEqual(["a", "b"]);
    expect([...shownColumns("garbage", ["a"])]).toEqual(["a"]);
  });
  it("reads a saved value as it is, the Plan Tracker's v1 included", () => {
    expect([...shownColumns("v1|b,c", ["a", "b", "c"])]).toEqual(["b", "c"]);
    expect([...shownColumns("v1|", ["a"])]).toEqual([]);
  });
  it("shows a column a later version brought to whoever saved before it", () => {
    expect([...shownColumns("v1|b", ["a", "b", "order"], [["order"]])]).toEqual(["b", "order"]);
  });
  it("leaves a column hidden once it was saved hidden after its version", () => {
    expect([...shownColumns("v2|b", ["a", "b", "order"], [["order"]])]).toEqual(["b"]);
  });
});
