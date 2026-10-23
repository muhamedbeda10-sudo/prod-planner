import "server-only";
import { validateInput } from "@/lib/domain/aiInput";
import type { ObjectSchema } from "@/lib/domain/aiInput";

export function checkToolInput<I>(tool: { schema: ObjectSchema; parse?: (raw: Record<string, unknown>) => I | string }, raw: unknown): { ok: true; input: I } | { ok: false; error: string } {
  const value = validateInput(tool.schema, raw);
  if (!value.ok) return value;
  if (!tool.parse) return { ok: true, input: value.value as I };
  const parsed = tool.parse(value.value);
  return typeof parsed === "string" ? { ok: false, error: parsed } : { ok: true, input: parsed };
}
