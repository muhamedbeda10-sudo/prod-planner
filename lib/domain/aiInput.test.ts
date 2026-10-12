import { describe, expect, it } from "vitest";
import { validateInput, type ObjectSchema } from "./aiInput";

const schema: ObjectSchema = {
  type: "object",
  properties: {
    mo: { type: "string", minLength: 1, maxLength: 40 },
    qty: { type: "integer", minimum: 0, maximum: 100000 },
    share: { type: "number", minimum: 0 },
    hold: { type: "boolean" },
    note: { type: ["string", "null"], maxLength: 10 },
    dept: { type: "string", enum: ["Cut", "Welding"] },
    day: { type: "string", format: "date" },
    at: { type: "string", format: "time" },
    mos: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 3 },
    machineId: { type: ["integer", "null"] },
  },
  required: ["mo"],
  additionalProperties: false,
};

describe("validateInput", () => {
  it("takes a call that fits, trimmed, numbers read from numeric text", () => {
    const r = validateInput(schema, { mo: "  PF01/MO/1 ", qty: "12", share: 1.5, hold: "true", dept: "Cut", day: "2026-10-12", at: "07:30", mos: ["a", " b "] });
    expect(r).toEqual({ ok: true, value: { mo: "PF01/MO/1", qty: 12, share: 1.5, hold: true, dept: "Cut", day: "2026-10-12", at: "07:30", mos: ["a", "b"] } });
  });

  it("names the field that is wrong", () => {
    expect(validateInput(schema, {})).toEqual({ ok: false, error: "mo: required." });
    expect(validateInput(schema, { mo: "x", qty: 1.5 })).toEqual({ ok: false, error: "qty: must be a whole number." });
    expect(validateInput(schema, { mo: "x", qty: -1 })).toEqual({ ok: false, error: "qty: at least 0." });
    expect(validateInput(schema, { mo: "x", dept: "Paint" })).toEqual({ ok: false, error: "dept: must be one of Cut, Welding." });
    expect(validateInput(schema, { mo: "x", mos: [] })).toEqual({ ok: false, error: "mos: at least 1 entry." });
    expect(validateInput(schema, { mo: "x", mos: ["a", ""] })).toEqual({ ok: false, error: "mos[1]: must not be empty." });
    expect(validateInput(schema, { mo: "x", hold: "yes" })).toEqual({ ok: false, error: "hold: must be true or false." });
  });

  it("refuses a field the tool does not have, rather than ignoring it", () => {
    expect(validateInput(schema, { mo: "x", status: "closed" })).toEqual({ ok: false, error: "status: not a field of this tool." });
  });

  it("knows a real calendar day and a 24-hour time", () => {
    expect(validateInput(schema, { mo: "x", day: "2026-02-30" }).ok).toBe(false);
    expect(validateInput(schema, { mo: "x", day: "12/10/2026" }).ok).toBe(false);
    expect(validateInput(schema, { mo: "x", at: "24:00" }).ok).toBe(false);
    expect(validateInput(schema, { mo: "x", at: "7:30" }).ok).toBe(false);
  });

  it("lets a nullable field be cleared, but not a plain one", () => {
    expect(validateInput(schema, { mo: "x", note: null, machineId: null })).toEqual({ ok: true, value: { mo: "x", note: null, machineId: null } });
    expect(validateInput(schema, { mo: null })).toEqual({ ok: false, error: "mo: a value is required." });
  });

  it("takes a missing input as an empty object", () => {
    const open: ObjectSchema = { type: "object", properties: {}, additionalProperties: false };
    expect(validateInput(open, undefined)).toEqual({ ok: true, value: {} });
  });
});
