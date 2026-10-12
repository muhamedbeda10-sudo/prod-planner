import "server-only";
import { blockedTableIn, blockedTablesFor } from "@/lib/domain/ai";
import { runAiQuery } from "../reader";
import type { ReadTool } from "./types";

// The assistant's general way to read: one SELECT, run through ai_reader, the
// read-only login (lib/server/ai/reader.ts). The data of a screen hidden from
// the person is not read for them.

interface Input {
  purpose: string;
  sql: string;
}

export const queryDatabase: ReadTool<Input> = {
  kind: "read",
  name: "query_database",
  title: "Looking it up in the database",
  description:
    "Run ONE read-only SQL query (SELECT, or WITH … SELECT) on the app's PostgreSQL database and get the rows back as {columns, rows} — at most 200 rows, so aggregate in SQL for anything bigger. Table and column names are case-sensitive and must be double-quoted. Call it as often as you need; every figure in your answer must come from a result. For what an order still owes, the machine queues or a simulated week, prefer the dedicated tools — they compute it exactly as the app's screens do.",
  schema: {
    type: "object",
    properties: {
      purpose: { type: "string", minLength: 1, maxLength: 200, description: "A few words on what this query looks up, in the language of the question — shown to the person while it runs (e.g. \"Late orders this month\")." },
      sql: { type: "string", minLength: 1, maxLength: 20000, description: "One SELECT statement — no semicolons, no writes." },
    },
    required: ["purpose", "sql"],
    additionalProperties: false,
  },
  status: (i) => i.purpose,
  async run(i, ctx) {
    const closed = blockedTableIn(i.sql, blockedTablesFor(ctx.hidden));
    if (closed) return { ok: false, text: `"${closed}" belongs to a screen that is not opened for this person, so it cannot be read for them. Answer without it, and say so.` };
    const r = await runAiQuery(i.sql);
    return { ok: r.ok, text: r.text };
  },
};
