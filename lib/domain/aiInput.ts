// The shape of what the assistant hands a tool, checked before anything runs.
//
// The model is told each tool's input as JSON Schema, and usually keeps to it —
// but "usually" is not a guarantee a write can stand on: a field can come back
// missing, as text instead of a number, or with an extra key the tool would
// silently ignore. So every call is checked here against the same schema the
// model read, and a call that does not fit is sent back with the field that is
// wrong, for the model to fix — never half-run.
//
// Only the slice of JSON Schema the tools use is understood: strings (enum,
// length, pattern, a "date" format), whole and decimal numbers with bounds,
// booleans, arrays of one item shape, and closed objects. A type may be paired
// with "null" for an optional value that can be cleared.

type Prim = "string" | "integer" | "number" | "boolean";

interface Base {
  description?: string;
}
export interface StringSchema extends Base {
  type: "string" | ["string", "null"];
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** "date" = a calendar day written YYYY-MM-DD; "time" = HH:MM on a 24-hour clock. */
  format?: "date" | "time";
}
export interface NumberSchema extends Base {
  type: "integer" | "number" | ["integer", "null"] | ["number", "null"];
  minimum?: number;
  maximum?: number;
}
export interface BooleanSchema extends Base {
  type: "boolean";
}
export interface ArraySchema extends Base {
  type: "array";
  items: JsonSchema;
  minItems?: number;
  maxItems?: number;
}
export interface ObjectSchema extends Base {
  type: "object";
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties: false;
}
export type JsonSchema = StringSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema;

export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function typesOf(s: JsonSchema): { base: Prim | "array" | "object"; nullable: boolean } {
  if (Array.isArray(s.type)) return { base: s.type[0] as Prim, nullable: true };
  return { base: s.type as Prim | "array" | "object", nullable: false };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRealDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function check(s: JsonSchema, v: unknown, path: string): { value: unknown } | { error: string } {
  const at = path || "input";
  const { base, nullable } = typesOf(s);
  if (v === null || v === undefined) {
    if (nullable) return { value: null };
    return { error: `${at}: a value is required.` };
  }
  switch (base) {
    case "string": {
      if (typeof v !== "string") return { error: `${at}: must be text.` };
      const ss = s as StringSchema;
      const t = v.trim();
      if (ss.minLength !== undefined && t.length < ss.minLength) return { error: ss.minLength === 1 ? `${at}: must not be empty.` : `${at}: at least ${ss.minLength} characters.` };
      if (ss.maxLength !== undefined && t.length > ss.maxLength) return { error: `${at}: at most ${ss.maxLength} characters.` };
      if (ss.enum && !ss.enum.includes(t)) return { error: `${at}: must be one of ${ss.enum.join(", ")}.` };
      if (ss.pattern && !new RegExp(ss.pattern).test(t)) return { error: `${at}: not in the expected form.` };
      if (ss.format === "date" && !isRealDate(t)) return { error: `${at}: a date written YYYY-MM-DD.` };
      if (ss.format === "time" && !TIME_RE.test(t)) return { error: `${at}: a time written HH:MM (24-hour).` };
      return { value: t };
    }
    case "integer":
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) return { error: `${at}: must be a number.` };
      if (base === "integer" && !Number.isInteger(n)) return { error: `${at}: must be a whole number.` };
      const ns = s as NumberSchema;
      if (ns.minimum !== undefined && n < ns.minimum) return { error: `${at}: at least ${ns.minimum}.` };
      if (ns.maximum !== undefined && n > ns.maximum) return { error: `${at}: at most ${ns.maximum}.` };
      return { value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { value: v };
      if (v === "true" || v === "false") return { value: v === "true" };
      return { error: `${at}: must be true or false.` };
    }
    case "array": {
      if (!Array.isArray(v)) return { error: `${at}: must be a list.` };
      const as = s as ArraySchema;
      if (as.minItems !== undefined && v.length < as.minItems) return { error: `${at}: at least ${as.minItems} ${as.minItems === 1 ? "entry" : "entries"}.` };
      if (as.maxItems !== undefined && v.length > as.maxItems) return { error: `${at}: at most ${as.maxItems} entries.` };
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = check(as.items, v[i], `${at}[${i}]`);
        if ("error" in r) return r;
        out.push(r.value);
      }
      return { value: out };
    }
    case "object": {
      if (typeof v !== "object" || Array.isArray(v)) return { error: `${at}: must be an object.` };
      const os = s as ObjectSchema;
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!(k in os.properties)) return { error: `${path ? `${path}.` : ""}${k}: not a field of this tool.` };
      }
      const out: Record<string, unknown> = {};
      for (const [k, ps] of Object.entries(os.properties)) {
        const has = o[k] !== undefined;
        if (!has) {
          if (os.required?.includes(k)) return { error: `${path ? `${path}.` : ""}${k}: required.` };
          continue;
        }
        const r = check(ps, o[k], path ? `${path}.${k}` : k);
        if ("error" in r) return r;
        out[k] = r.value;
      }
      return { value: out };
    }
  }
}

/** The call's input checked against the tool's schema — the cleaned value
 *  (text trimmed, numbers from numeric text) or the first thing wrong. */
export function validateInput(schema: ObjectSchema, raw: unknown): InputCheck {
  const r = check(schema, raw ?? {}, "");
  if ("error" in r) return { ok: false, error: r.error };
  return { ok: true, value: r.value as Record<string, unknown> };
}
