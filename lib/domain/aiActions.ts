// The assistant's changes: what a proposal is, when one runs without asking,
// and how a change is checked against the data it was proposed on. Pure — the
// database side is lib/server/ai/actions.ts.
//
// The assistant never writes on its own authority. It prepares a change with
// one of its write tools; the change runs through the app's own action for it
// (the same validation, the same permission, the same audit as a click), as the
// person it acts for. Most changes wait for that person's approval in the chat;
// a small one runs at once only for someone who opted into that.

/** What a change can break, which decides whether it may run unasked. */
export type AiRisk = "low" | "high" | "destructive";

/** The part of the app a write tool works on — each has its own key. */
export type AiArea = "tracker" | "machines" | "simulator" | "data" | "setup" | "imports" | "automations" | "playbook" | "users";

/** The key a person needs for the assistant to work on an area for them. The
 *  playbook has none: it is the plant's own rules, kept by its admins; nor
 *  have users and permissions, which are the owner's alone. */
export const AI_AREA_KEY: Record<AiArea, string | null> = {
  tracker: "ai.act.tracker",
  machines: "ai.act.machines",
  simulator: "ai.act.simulator",
  data: "ai.act.data",
  setup: "ai.act.setup",
  imports: "ai.act.import",
  automations: "ai.automations",
  playbook: null,
  users: null,
};

export const AI_DELETE_KEY = "ai.act.delete";
export const AI_NOCONFIRM_KEY = "ai.act.noconfirm";

export type AiActionStatus =
  | "proposed" // waiting for the person's approval
  | "executing" // approved and running
  | "executed"
  | "failed" // the app's action refused it (the reason is kept)
  | "rejected" // the person said no
  | "stale" // the data moved after it was proposed — not run
  | "expired" // nobody answered in time
  | "undone"; // run, then put back

/** A proposal nobody answers is dropped after a day: the floor has moved on. */
export const AI_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** One line of a proposal, as the approval card shows it. */
export interface AiChange {
  label: string;
  before: string;
  after: string;
}

/** A change as the chat shows it. */
export interface AiActionView {
  id: number;
  toolUseId: string | null;
  tool: string;
  title: string;
  summary: string;
  changes: AiChange[];
  risk: AiRisk;
  status: AiActionStatus;
  /** It ran without an approval click (a small change the person opted into). */
  auto: boolean;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  /** What the app said when it ran. */
  result: string | null;
  error: string | null;
  canUndo: boolean;
  undoneAt: string | null;
  /** Proposed by an automation rather than in a chat. */
  automationId: number | null;
}

/** Whether a change runs at once or waits for a click. Only a LOW-risk change
 *  runs unasked, and only for someone who opted into that; anything over
 *  several rows, any quantity, closing or deletion is never low. */
export function executionMode(o: { risk: AiRisk; noconfirm: boolean }): "auto" | "ask" {
  return o.risk === "low" && o.noconfirm ? "auto" : "ask";
}

/** A value as canonical JSON — keys sorted at every level — so two reads of
 *  the same data compare equal however their objects were built. */
export function stableJson(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

function sortDeep(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
  }
  return v;
}

/** The data a proposal was made on still reads the same. */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** A value as one cell of an approval card. */
export function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.length ? v.map(cell).join(", ") : "—";
  return String(v);
}

/** What the person is told the assistant did, at the start of their next
 *  question — the assistant itself never sees the click. */
export function outcomeNote(a: { id: number; title: string; status: AiActionStatus; result: string | null; error: string | null }): string {
  switch (a.status) {
    case "executed":
      return `Change #${a.id} "${a.title}" was approved and done${a.result ? `: ${a.result}` : "."}`;
    case "failed":
      return `Change #${a.id} "${a.title}" was approved but the app refused it: ${a.error ?? "no reason given"}`;
    case "rejected":
      return `Change #${a.id} "${a.title}" was rejected by the person — not done.`;
    case "stale":
      return `Change #${a.id} "${a.title}" was not done: the data changed after it was proposed${a.error ? ` (${a.error})` : ""}.`;
    case "expired":
      return `Change #${a.id} "${a.title}" expired unanswered — not done.`;
    case "undone":
      return `Change #${a.id} "${a.title}" was done and then undone by the person.`;
    default:
      return `Change #${a.id} "${a.title}" is ${a.status}.`;
  }
}

/** A risk as the card says it. */
export const RISK_TEXT: Record<AiRisk, string> = {
  low: "Small change",
  high: "Needs a careful look",
  destructive: "Deletes data",
};
