import "server-only";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatRows, jsonSafe, prepareSql, readerUrl } from "@/lib/domain/ai";

// The assistant's own way into the database: a second client logged in as
// ai_reader, the read-only login the ai_assistant migration made. Whatever
// SQL the model writes runs under that login — SELECT only, the private
// tables out of reach, every statement cut off after 15 seconds — so no
// query of its can change or leak what the app's own login can.

let reader: { url: string; client: PrismaClient } | null = null;

async function readerClient(): Promise<PrismaClient> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set.");
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { dbPassword: true } });
  if (!s?.dbPassword) throw new Error("The read-only database login is not set up (run the migrations).");
  const url = readerUrl(base, s.dbPassword);
  if (reader?.url !== url) {
    await reader?.client.$disconnect().catch(() => {});
    reader = { url, client: new PrismaClient({ datasourceUrl: url, log: ["error"] }) };
  }
  return reader.client;
}

const QUERY_TIMEOUT_MS = 20_000;

/** Runs the model's query and returns what goes back to it: the rows as
 *  compact JSON, or the database's error (the model reads it and fixes the
 *  query). `ok` is false for an error. */
export async function runAiQuery(sql: string): Promise<{ ok: boolean; text: string; rows: number }> {
  const prepared = prepareSql(sql);
  if ("error" in prepared) return { ok: false, text: prepared.error, rows: 0 };
  try {
    const client = await readerClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rows = await Promise.race([
      client.$queryRawUnsafe<Record<string, unknown>[]>(prepared.sql),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The query took too long — narrow it down.")), QUERY_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, text: formatRows(rows), rows: rows.length };
  } catch (e) {
    return { ok: false, text: errorText(e), rows: 0 };
  }
}

/** The rows themselves, as JSON can carry them — what an automation's
 *  condition reads. At most `limit`; `truncated` when there were more. Same
 *  login, same checks, same time limit as the assistant's own queries. */
export async function runAiRows(sql: string, limit: number): Promise<{ ok: true; rows: Record<string, unknown>[]; truncated: boolean } | { ok: false; error: string }> {
  const prepared = prepareSql(sql, limit);
  if ("error" in prepared) return { ok: false, error: prepared.error };
  try {
    const client = await readerClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rows = await Promise.race([
      client.$queryRawUnsafe<Record<string, unknown>[]>(prepared.sql),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The query took too long — narrow it down.")), QUERY_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, rows: rows.slice(0, limit).map((r) => jsonSafe(r) as Record<string, unknown>), truncated: rows.length > limit };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** The database's own words, without Prisma's wrapping. */
function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /Message:\s*`?([\s\S]*?)`?\s*$/.exec(msg) ?? /ERROR:\s*([\s\S]*)$/.exec(msg);
  return (m ? m[1] : msg).trim().slice(0, 1500);
}

/** The owner's check that the login works and keeps out of the private
 *  tables: a count of the orders, and a read of the sessions that must fail. */
export async function testReader(): Promise<{ ok: boolean; text: string }> {
  const orders = await runAiQuery(`SELECT count(*) AS n FROM "MasterOrder"`);
  if (!orders.ok) return { ok: false, text: `The read-only login cannot read the orders: ${orders.text}` };
  const n = (JSON.parse(orders.text) as { rows: unknown[][] }).rows[0]?.[0];
  const priv = await runAiQuery(`SELECT 1 FROM "Session" LIMIT 1`);
  if (priv.ok) return { ok: false, text: "The read-only login can read the sessions table — it must not. Do not open the assistant to anyone until this is fixed." };
  return { ok: true, text: `Connected read-only: it sees ${n} orders, and the private tables are closed to it.` };
}
