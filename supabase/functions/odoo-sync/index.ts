// The Odoo sync's way into the database (a Supabase Edge Function, deployed
// as "odoo-sync"). The Odoo page the scheduled task opens posts here with the
// task's one-time pass: { op: "plan", ticket } reads what to pull
// (odoo_pull_plan_t), { op: "ingest", ticket, p } writes one piece of what it
// read (odoo_ingest_t). Both database functions check the pass themselves;
// this function only carries the call, from the Odoo origin alone. The
// database's tables stay off the public API.
import postgres from "npm:postgres@3.4.5";

const ODOO_ORIGIN = "https://atcodoo.odoo.com";
const PASS = /^[0-9a-f]{64}$/;
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 20 });

const cors = {
  "Access-Control-Allow-Origin": ODOO_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { message: "POST only" });
  let body: { op?: string; ticket?: string; p?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { message: "not JSON" });
  }
  const { op, ticket, p } = body;
  if (typeof ticket !== "string" || !PASS.test(ticket)) return reply(403, { message: "odoo sync: no live pass" });
  try {
    if (op === "plan") {
      const [r] = await sql`select odoo_pull_plan_t(${ticket}) as r`;
      return reply(200, r.r);
    }
    if (op === "ingest") {
      if (!p || typeof p !== "object") return reply(400, { message: "no piece" });
      const [r] = await sql`select odoo_ingest_t(${ticket}, ${sql.json(p as Record<string, unknown>)}) as r`;
      return reply(200, r.r);
    }
    return reply(400, { message: "unknown op" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return reply(/no live pass/.test(message) ? 403 : 500, { message: message.slice(0, 500) });
  }
});
