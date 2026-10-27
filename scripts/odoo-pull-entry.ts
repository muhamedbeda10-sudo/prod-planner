// The browser side of the Odoo pull, as /odoo-pull.js: loaded by the scheduled
// task into an Odoo page (the user's own login) and started with
// window.__odooPullStart(plan); window.__odooPullJob then says when it is done
// and holds the payload for odoo_ingest() in pieces (`chunks`, JSON strings
// small enough to copy into one call each). Reads only.
import { pageRpc, pullOdoo, splitPayload, type OdooPullPlan } from "../lib/domain/odooPull";

type Job = { status: "running" | "done" | "error"; startedAt: number; chunks?: string[]; sizes?: number[]; summary?: string; error?: string };
const w = window as unknown as { __odooPullJob?: Job; __odooPullStart?: (plan: OdooPullPlan) => string };

w.__odooPullStart = (plan) => {
  const job: Job = { status: "running", startedAt: Date.now() };
  w.__odooPullJob = job;
  pullOdoo(pageRpc(window.fetch.bind(window)), plan)
    .then((p) => {
      job.chunks = splitPayload(p).map((c) => JSON.stringify(c));
      job.sizes = job.chunks.map((c) => c.length);
      job.summary = `${p.log.length} log MOs, ${p.orders.length} orders changed (${p.children.length} MOs), ${p.unchanged} unchanged, stock ${p.stock ? p.stock.values.length : "not read"}, ${p.issues.length} issues, ${p.ms} ms`;
      job.status = "done";
    })
    .catch((e) => { job.error = String(e); job.status = "error"; });
  return "started";
};
