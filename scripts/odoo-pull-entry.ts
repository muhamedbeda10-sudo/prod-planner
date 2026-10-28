// The browser side of the Odoo sync, as /odoo-pull.js: loaded by the scheduled
// task into an Odoo page (the user's own login, reads only) and started with
// window.__odooSyncStart({ url, key, ticket }) — the database's address, its
// publishable key and the one-time pass from odoo_issue_ticket(). The page
// reads the plan, pulls Odoo and writes what it read straight to the database;
// window.__odooSyncJob says when it is done and what the database answered.
// window.__odooPullStart(plan) only pulls, leaving the pieces in
// window.__odooPullJob.chunks — for a hand check.
import { pageRpc, pullOdoo, runOdooSync, splitPayload, supabaseDb, type OdooPullPlan, type OdooSyncTarget } from "../lib/domain/odooPull";

type PullJob = { status: "running" | "done" | "error"; startedAt: number; chunks?: string[]; sizes?: number[]; summary?: string; error?: string };
type SyncJob = { status: "running" | "done" | "error"; startedAt: number; finishedAt?: number; summary?: unknown; pieces?: number; chars?: number; error?: string };
const w = window as unknown as {
  __odooPullJob?: PullJob; __odooPullStart?: (plan: OdooPullPlan) => string;
  __odooSyncJob?: SyncJob; __odooSyncStart?: (t: OdooSyncTarget) => string;
};
const odoo = () => pageRpc(window.fetch.bind(window));

w.__odooSyncStart = (t) => {
  const job: SyncJob = { status: "running", startedAt: Date.now() };
  w.__odooSyncJob = job;
  Promise.resolve()
    .then(() => runOdooSync(odoo(), supabaseDb(window.fetch.bind(window), t)))
    .then((r) => { Object.assign(job, r); job.status = "done"; })
    .catch((e) => { job.error = String(e); job.status = "error"; })
    .finally(() => { job.finishedAt = Date.now(); });
  return "started";
};

w.__odooPullStart = (plan) => {
  const job: PullJob = { status: "running", startedAt: Date.now() };
  w.__odooPullJob = job;
  pullOdoo(odoo(), plan)
    .then((p) => {
      job.chunks = splitPayload(p).map((c) => JSON.stringify(c));
      job.sizes = job.chunks.map((c) => c.length);
      job.summary = `${p.log.length} log MOs, ${p.orders.length} orders changed (${p.children.length} MOs), ${p.unchanged} unchanged, stock ${p.stock ? p.stock.values.length : "not read"}, BoMs ${p.bomRoots ? `${p.boms?.length ?? 0} changed of ${p.bomRoots.length} codes` : "not read"}, ${p.issues.length} issues, ${p.ms} ms`;
      job.status = "done";
    })
    .catch((e) => { job.error = String(e); job.status = "error"; });
  return "started";
};
