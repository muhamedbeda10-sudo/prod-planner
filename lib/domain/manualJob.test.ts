import { describe, expect, it } from "vitest";
import { editedJobQty } from "./manualJob";

describe("editedJobQty — a new count of pieces wanted on a manual job", () => {
  it("is refused below what is done, or when it is not whole pieces above 0", () => {
    expect(editedJobQty(5, 4)).toEqual({ ok: false, error: expect.stringContaining("5 piece(s) are done already") });
    expect(editedJobQty(0, 0)).toEqual({ ok: false, error: expect.stringContaining("above 0") });
    expect(editedJobQty(0, 2.5)).toEqual({ ok: false, error: expect.stringContaining("whole number") });
    expect(editedJobQty(0, Number.NaN)).toMatchObject({ ok: false });
  });

  it("finishes the job when it equals what is done, and leaves it open above that", () => {
    expect(editedJobQty(5, 5)).toEqual({ ok: true, finished: true });
    expect(editedJobQty(5, 6)).toEqual({ ok: true, finished: false });
    expect(editedJobQty(0, 1)).toEqual({ ok: true, finished: false });
  });
});
