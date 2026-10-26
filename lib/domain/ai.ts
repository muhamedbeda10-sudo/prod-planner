// The AI assistant's rules that need no database: the models the owner can
// pick and what they cost, what one question cost, who may ask right now,
// and what the assistant's SQL may be and how its rows go back to it.

import { filesOfNote, isAttachmentNote } from "./aiFiles";
import { evidenceFromContent, type AiEvidence } from "./aiEvidence";
import type { AiArea } from "./aiActions";

export interface AiModelDef {
  id: string;
  label: string;
  note: string;
  /** US dollars per million tokens. */
  inUsd: number;
  outUsd: number;
  cacheReadUsd: number;
  /** A five-minute cache write — 1.25× the input price. */
  cacheWriteUsd: number;
  /** The API re-runs a declined request on another model (server-side fallback). */
  fallbacks: boolean;
}

export const AI_MODELS: AiModelDef[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "The most capable — the best answers and suggestions", inUsd: 4, outUsd: 20, cacheReadUsd: 0.2, cacheWriteUsd: 5, fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Half the price and quick — good for everyday questions", inUsd: 2, outUsd: 10, cacheReadUsd: 0.2, cacheWriteUsd: 2.5, fallbacks: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "The cheapest — simple look-ups", inUsd: 0.1, outUsd: 0.5, cacheReadUsd: 0.01, cacheWriteUsd: 0.125, fallbacks: false },
];

export const DEFAULT_AI_MODEL = AI_MODELS[0].id;

export function aiModel(id: string | null | undefined): AiModelDef {
  return AI_MODELS.find((m) => m.id === id) ?? AI_MODELS[0];
}

/** How hard the model thinks before it answers (the API's output_config.effort)
 *  — every model above takes all five. Higher answers harder questions better,
 *  and costs more tokens and time. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const DEFAULT_AI_EFFORT: AiEffort = "medium";

export const AI_EFFORT_LABEL: Record<AiEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isAiEffort(v: unknown): v is AiEffort {
  return typeof v === "string" && (AI_EFFORTS as readonly string[]).includes(v);
}

/** A stored effort as the API takes it — anything unknown is the default. */
export function aiEffort(v: string | null | undefined): AiEffort {
  return isAiEffort(v) ? v : DEFAULT_AI_EFFORT;
}

/** The model calls one question may take, as the owner may set it. */
export const AI_CALLS_RANGE = { min: 4, max: 30 } as const;

export interface AiTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_TOKENS: AiTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addTokens(a: AiTokens, b: AiTokens): AiTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** What the tokens cost on a model, in US dollars. */
export function costUsd(model: string, t: AiTokens): number {
  const m = aiModel(model);
  const usd = (t.inputTokens * m.inUsd + t.outputTokens * m.outUsd + t.cacheReadTokens * m.cacheReadUsd + t.cacheWriteTokens * m.cacheWriteUsd) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** "$0.042", "$1.20", "$12" — small sums keep the cents that matter. */
export function usdText(v: number): string {
  if (v === 0) return "$0";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** The first instant of the calendar month a moment falls in (UTC — how the
 *  API bills). The monthly caps count from here. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type AiDeny = "noKey" | "off" | "noAccess" | "userDayCap" | "userCap" | "plantDayCap" | "plantCap";

export interface AiGate {
  isOwner: boolean;
  hasKey: boolean;
  /** Open to the team (the owner can use it either way). */
  enabled: boolean;
  /** The person's own caps (0 = none of their own). */
  access: { enabled: boolean; monthlyUsd: number; dailyUsd?: number } | null;
  /** Spent this month / this factory day. */
  userSpent: number;
  userSpentToday?: number;
  plantSpent: number;
  plantSpentToday?: number;
  /** The plant's caps (0 = none). */
  plantCap: number;
  plantDayCap?: number;
}

export const AI_DENY_TEXT: Record<AiDeny, string> = {
  noKey: "The assistant has no Claude API key yet — the owner adds it on AI assistant settings.",
  off: "The assistant is switched off for now.",
  noAccess: "The assistant is not opened for your account — ask the owner.",
  userDayCap: "You have used today's AI allowance — it starts again tomorrow.",
  userCap: "You have used this month's AI allowance — ask the owner to raise it.",
  plantDayCap: "The plant's AI budget for today is used up — it starts again tomorrow.",
  plantCap: "The plant's AI budget for this month is used up — the owner can raise it.",
};

/** Whether a person may ask now, and why not. The owner holds no allowance
 *  of their own, but the plant's caps hold for them too — it is what guards
 *  the account's credit. */
export function aiDecision(g: AiGate): { ok: true } | { ok: false; reason: AiDeny } {
  if (!g.hasKey) return { ok: false, reason: "noKey" };
  if (!g.isOwner) {
    if (!g.enabled) return { ok: false, reason: "off" };
    if (!g.access?.enabled) return { ok: false, reason: "noAccess" };
    if ((g.access.dailyUsd ?? 0) > 0 && (g.userSpentToday ?? 0) >= g.access.dailyUsd!) return { ok: false, reason: "userDayCap" };
    if (g.access.monthlyUsd > 0 && g.userSpent >= g.access.monthlyUsd) return { ok: false, reason: "userCap" };
  }
  if ((g.plantDayCap ?? 0) > 0 && (g.plantSpentToday ?? 0) >= g.plantDayCap!) return { ok: false, reason: "plantDayCap" };
  if (g.plantCap > 0 && g.plantSpent >= g.plantCap) return { ok: false, reason: "plantCap" };
  return { ok: true };
}

/** Whether the AI tab shows for someone at all — a cap reached still shows
 *  it (the page says why it cannot answer). */
export function aiVisible(g: Pick<AiGate, "isOwner" | "hasKey" | "enabled" | "access">): boolean {
  if (!g.hasKey) return g.isOwner;
  return g.isOwner || (g.enabled && !!g.access?.enabled);
}

/** A conversation's name: the first line of its first question. */
export function conversationTitle(question: string): string {
  const line = question.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "New chat";
}

// ---- the assistant's SQL ----

/** The tables the assistant may not read (revoked from ai_reader by the
 *  ai_assistant migration); of User it reads these columns alone. */
export const AI_PRIVATE_TABLES = [
  "Session", "LoginFailure", "UserPref", "ChatMessage", "ChatGroup", "ChatGroupMember", "ChatMessageHide", "ChatReaction",
  "AiSettings", "AiAccess", "AiConversation", "AiMessage", "AiUsage", "AiAction",
  "AiPlaybookEntry", "AiPlaybookRevision", "AiInboxItem", "PushSubscription", "PushKeys", "Automation", "AutomationRun", "AiFile",
  "Task", "TaskAssignee", "TaskUpdate", "TaskTemplate", "TaskRepeat", "AppEvent", "AiFeedback", "AiMemory", "AiCheck",
] as const;
export const AI_USER_COLUMNS = ["id", "name", "active"] as const;

/** The tables behind a screen the owner can hide from someone. A person who
 *  does not see the screen is not read its data by the assistant either.
 *  Only data that lives on ONE screen is listed: the orders, the daily log,
 *  the plans and the machines are every screen's, and stay readable. */
export const AI_TAB_TABLES: Record<string, readonly string[]> = {
  odoo: ["OdooEntry", "OdooNote"],
  consumables: [
    "ConsumableIssue", "ConsumableIssueRevision", "ConsumableItem", "ConsumableLimit",
    "ConsumableCatalogueChange", "ConsumableIssueRecipient", "PowderScrap", "PowderScrapRevision", "ConsumableHeadcount",
  ],
  physical: ["PhysicalStock"],
  material: ["MaterialUsage"],
  // the machine stops are recorded there, and the cockpit's stored trend is read off them and the shift log
  shifts: ["ShiftEntry", "DeptDayHours", "MachineDowntime", "KpiSnapshot"],
  barcode: ["TankUnit", "TankEvent", "TankSerialCounter"],
  // FloorLayout: the drawn floors are gone from the app; the table stays until it is dropped
  simulate: ["SimScenario", "FloorLayout"],
};

/** The tables closed to someone by the screens hidden from them. */
export function blockedTablesFor(hidden: ReadonlySet<string>): string[] {
  return [...hidden].flatMap((t) => AI_TAB_TABLES[t] ?? []);
}

/** The first closed table a query names, or null. Table names are case
 *  sensitive and must be double-quoted to resolve at all, so the quoted name
 *  is what to look for. The XML functions that run a query given as text
 *  could name a table without quoting it in the statement, and a
 *  Unicode-escaped identifier can name one without spelling it, so with
 *  anything closed both are refused outright. */
export function blockedTableIn(sql: string, blocked: readonly string[]): string | null {
  if (blocked.length === 0) return null;
  if (/\b(query|table|cursor|schema|database)_to_xml/i.test(sql)) return blocked[0];
  // the text-search statistics run a query given as text too (ts_stat('SELECT …'))
  if (/\b(ts_stat|ts_rewrite)\s*\(/i.test(sql)) return blocked[0];
  // a Unicode-escaped identifier (U&"\004FdooEntry") names a table without
  // spelling it, so it is refused the same way
  if (/\bU&"/i.test(sql)) return blocked[0];
  // the planner's statistics (pg_stats, pg_statistic …) carry sampled VALUES
  // of every readable table's columns, keyed by the table's name as text; the
  // catalog and information_schema name a closed table's columns and counts
  if (/\b(pg_stat\w*|pg_catalog|pg_class|pg_attribute|pg_description|information_schema)\b/i.test(sql)) return blocked[0];
  // the name as a string literal reaches those same views and the catalog
  return blocked.find((t) => sql.includes(`"${t}"`) || sql.includes(`'${t}'`)) ?? null;
}

/** Rows handed back per query — anything bigger is for SQL to aggregate. */
export const AI_ROW_LIMIT = 200;
/** How much of a result goes back to the model, in characters. */
export const AI_RESULT_CHARS = 30_000;

/** Leading whitespace and comments off, so the first keyword can be read. */
function stripLead(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) { const nl = t.indexOf("\n"); s = nl < 0 ? "" : t.slice(nl + 1); continue; }
    if (t.startsWith("/*")) { const end = t.indexOf("*/"); s = end < 0 ? "" : t.slice(end + 2); continue; }
    return t;
  }
}

/** One read-only statement, wrapped so it can only ever be a query and never
 *  return more than the limit (+1, to tell a full result from a cut one).
 *  The database login is what really keeps it read-only; this keeps the
 *  statement to one SELECT. */
export function prepareSql(raw: string, limit = AI_ROW_LIMIT): { sql: string } | { error: string } {
  const body = (raw ?? "").trim().replace(/;\s*$/, "");
  const head = stripLead(body);
  if (!head) return { error: "Empty query." };
  if (!/^(select|with)\b/i.test(head)) return { error: "Only a SELECT (or WITH … SELECT) query can run." };
  if (body.includes(";")) return { error: "One statement only — remove the semicolons." };
  // a Unicode-escaped name (U&"pg_\0073leep", or any UESCAPE) spells a
  // function the list below cannot see — no reading query needs one
  if (/\bU&["']/i.test(body) || /\bUESCAPE\b/i.test(body)) return { error: "Unicode-escaped names are not allowed — write the name plainly." };
  // a SELECT can still change the session or hold the connection: a lifted
  // statement timeout, a sleep, a cancelled or terminated backend, a lock —
  // named plainly, quoted ("pg_sleep"), schema-qualified or with a comment
  // before the parenthesis, so the name alone is what is looked for
  const held = /\b(set_config|pg_sleep\w*|pg_cancel_backend|pg_terminate_backend|pg_advisory_\w+|pg_try_advisory_\w+|pg_reload_conf|lo_\w+|pg_read_\w+|pg_ls_\w+|dblink\w*)\b/i.exec(body);
  if (held) return { error: `${held[1]}() is not for reading the data — leave it out.` };
  return { sql: `SELECT * FROM (\n${body}\n) AS ai_q LIMIT ${limit + 1}` };
}

/** A value as JSON can carry it: whole-number bigints as numbers, dates as
 *  ISO text, Prisma decimals as numbers. */
export function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "object") {
    const o = v as { toNumber?: () => number; constructor?: { name?: string } };
    if (typeof o.toNumber === "function") return o.toNumber();
    if (v instanceof Uint8Array) return `<${v.length} bytes>`;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

/** The rows as the model reads them: the columns once, then each row as a
 *  list — about half the tokens of a list of objects. Cut to the limit and
 *  to a size the conversation can carry, and say so when cut. */
export function formatRows(rows: readonly Record<string, unknown>[], limit = AI_ROW_LIMIT, maxChars = AI_RESULT_CHARS): string {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const all = rows.slice(0, limit).map((r) => columns.map((c) => jsonSafe(r[c])));
  const render = (n: number, note?: string) =>
    JSON.stringify({ columns, rowCount: n, ...(n < rows.length ? { truncated: true } : {}), ...(note ? { note } : {}), rows: all.slice(0, n) });
  let n = all.length;
  let text = render(n, rows.length > limit ? `More than ${limit} rows — only the first ${limit} are here; aggregate or filter in SQL for the rest.` : undefined);
  // too big for the conversation: halve until it fits, and say so
  while (text.length > maxChars && n > 1) {
    n = Math.floor(n / 2);
    text = render(n, `The result was too large — only the first ${n} rows are here; select fewer columns or aggregate in SQL.`);
  }
  if (text.length <= maxChars) return text;
  return JSON.stringify({ columns, rowCount: 0, truncated: true, note: "One row alone is too large — select fewer or shorter columns.", rows: [] });
}

/** The read-only login's connection string, made from the app's own: the
 *  same host, port, database and options, the user swapped for ai_reader
 *  (kept with the pooler's ".<project>" suffix) and one connection. */
export function readerUrl(base: string, password: string): string {
  const u = new URL(base);
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf(".");
  u.username = dot >= 0 ? `ai_reader${user.slice(dot)}` : "ai_reader";
  u.password = password;
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

// ---- the chat as people read it ----

export interface AiChatTurn {
  sources?: AiEvidence[];
  role: "user" | "assistant";
  text: string;
  /** What the assistant looked up on the way (each look-up's purpose). */
  lookups: string[];
  /** The tool calls that prepared changes — the cards shown under the answer. */
  actionIds?: string[];
  /** The files sent with a question. */
  files?: { id: number; name: string; kind: string }[];
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: { purpose?: unknown }; content?: unknown; tool_use_id?: string };

/** The kept API messages as a chat: each question (the last text block of
 *  its message, with the files its note names), then one answer gathering
 *  every assistant message, look-up and prepared change up to the next
 *  question. The app's own context messages (role "system") are not part of
 *  what people read. `readTitles` names the read tools, whose calls show as
 *  look-ups; any other tool call prepared a change. */
export function displayTurns(rows: readonly { role: string; content: unknown }[], readTitles: Readonly<Record<string, string>> = {}): AiChatTurn[] {
  const out: AiChatTurn[] = [];
  for (const r of rows) {
    if (r.role === "system") continue;
    const blocks: Block[] = Array.isArray(r.content) ? (r.content as Block[]) : typeof r.content === "string" ? [{ type: "text", text: r.content }] : [];
    if (r.role === "user") {
      // tool results belong to the answer being worked out
      if (blocks.some((b) => b.type === "tool_result")) {
        const answer = out.at(-1);
        if (answer?.role === "assistant") for (const block of blocks) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const source = evidenceFromContent(block.content, block.tool_use_id);
          if (source) (answer.sources ??= []).push(source);
        }
        continue;
      }
      const texts = blocks.filter((b) => b.type === "text");
      const note = texts.find((b) => typeof b.text === "string" && isAttachmentNote(b.text));
      const own = texts.filter((b) => b !== note);
      const files = note ? filesOfNote(note.text!) : [];
      out.push({ role: "user", text: own[own.length - 1]?.text ?? "", lookups: [], ...(files.length ? { files } : {}) });
      continue;
    }
    let cur = out[out.length - 1];
    if (!cur || cur.role !== "assistant") {
      cur = { role: "assistant", text: "", lookups: [] };
      out.push(cur);
    }
    for (const b of blocks) {
      if (b.type === "text" && b.text) cur.text += (cur.text ? "\n\n" : "") + b.text;
      if (b.type !== "tool_use") continue;
      const purpose = b.input?.purpose;
      if (typeof purpose === "string" && purpose.trim()) cur.lookups.push(purpose.trim());
      else if (b.name && readTitles[b.name]) cur.lookups.push(readTitles[b.name]);
      else if (b.name && !(b.name in readTitles) && b.id) (cur.actionIds ??= []).push(b.id);
    }
  }
  return out;
}

const FACTORY_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** The areas as the assistant is told it may work on them. */
export const AI_AREA_LABEL: Record<AiArea, string> = {
  tracker: "the Plan Tracker and the Daily log",
  machines: "the machines and their distribution",
  simulator: "the simulator",
  data: "other data (the ODOO log, Material, Physical material, Consumables with its catalogue, limits and powder scrap, the shift roster, the calendar, workers, machines)",
  setup: "the plant's set-up (the standard times, capacity and calibration, the times per machine, the shift hours and the master switches)",
  imports: "imports of files attached in this chat (plans, the Daily log, ODOO, Material, Physical material)",
  automations: "automations — scheduled reports, watched conditions and instant alerts on what happens in the app",
  tasks: "tasks — giving them, and reporting on and reviewing the person's own",
  playbook: "the plant's playbook",
  users: "users and permissions (the owner's)",
};

/** The app's context for one question — the system message after it: who
 *  asks and when, what the assistant may change for them, what they have open
 *  beside the chat, and what became of the changes it prepared before. */
export function questionContext(o: {
  askedBy: string;
  now: Date;
  areas: readonly AiArea[];
  canDelete: boolean;
  noconfirm: boolean;
  paused: boolean;
  notes: readonly string[];
  /** The What-if Simulator is open beside the chat. */
  simulatorOpen?: boolean;
  line?: "TR" | "LV";
  /** What the assistant keeps about this person (lib/domain/aiLearn memoryNote). */
  memory?: string;
}): string {
  const lines = [`Asked by ${o.askedBy} on ${FACTORY_CLOCK.format(o.now)}, Cairo time.`];
  if (o.line) lines.push(`The app's selected production line is ${o.line === "LV" ? "LV panels (including meter boxes)" : "TR transformers"}. Use that line by default for this question unless the person explicitly asks for the other line or both. Filter SQL by the correct line; pass line explicitly to tools that accept it.`);
  if (o.paused) lines.push("The owner has paused every change by the assistant: you can only read and advise right now.");
  else if (o.areas.length === 0) lines.push("You may not change anything for this person — you only read and advise.");
  else {
    lines.push(`You may prepare changes for this person on: ${o.areas.map((a) => AI_AREA_LABEL[a]).join("; ")}.${o.canDelete ? " Deletions too — each one waits for their approval." : " No deletions."}`);
    lines.push(o.noconfirm ? "A small, low-risk change runs at once (the person opted into that); everything else waits for their approval." : "Every change waits for the person's approval.");
  }
  if (o.simulatorOpen) {
    lines.push("The person has the What-if Simulator open beside this chat: show_on_simulator changes what it shows, at once and with no card (the plant's data does not change, and the scenario it replaces stays one click away), and it and simulate_scenario start from what it shows unless told otherwise.");
  }
  if (o.notes.length > 0) lines.push("Since your last answer:", ...o.notes.map((n) => `- ${n}`));
  if (o.memory) lines.push(o.memory);
  return lines.join("\n");
}

/** The context of an automation's run — the system message after its
 *  instruction: whose it is, that nobody is reading live, who receives the
 *  answer, and what may be changed. */
export function automationContext(o: {
  name: string;
  owner: string;
  now: Date;
  action: "report" | "act";
  recipients: readonly string[];
  areas: readonly AiArea[];
  canDelete: boolean;
  noconfirm: boolean;
}): string {
  const lines = [
    `This is ${o.owner}'s automation "${o.name}", running by itself on ${FACTORY_CLOCK.format(o.now)}, Cairo time. Nobody is reading live and nobody can answer a question: do not ask one.`,
  ];
  if (o.action === "report") {
    lines.push(`Your final answer is sent as it is to ${o.recipients.join(", ")} — write the complete report: a short headline first, then the figures (tables, charts where they help). Read only; you change nothing.`);
  } else {
    lines.push(`Prepare the changes the instruction calls for with your write tools — on: ${o.areas.map((a) => AI_AREA_LABEL[a]).join("; ")}.${o.canDelete ? "" : " No deletions."}`);
    lines.push(o.noconfirm ? `A small, low-risk change runs at once (${o.owner} opted into that); everything else waits in ${o.owner}'s inbox for approval.` : `Every change waits in ${o.owner}'s inbox for their approval.`);
    lines.push(`Your final answer goes to ${o.owner} with them: say in a few lines what you prepared and why — or that nothing needed changing.`);
  }
  return lines.join("\n");
}

/** The morning review's instruction and context (lib/server/automations/
 *  review.ts): what to look at for this person, what to prepare, and that
 *  every change waits for them. */
export function reviewQuestion(name: string, language: "Arabic" | "English"): string {
  return [
    `Morning review for ${name}. Start from get_kpis — the Planning dashboard's decisions, the weekly plan's lines behind, each work centre's efficiency, the load ahead, welding's coverage and what stopped the floor — then look at the plant as it stands now, from ${name}'s side — what they work on and may change: orders late or about to be late, work blocked or on hold, machines overloaded or idle, figures that look wrong or missing.`,
    "1. Lead with the two or three things that matter most today, each in a line with its figures.",
    `2. For each concrete fix you can make with your tools, prepare it — it waits for ${name}'s approval. At most five, the most important first; nothing speculative.`,
    "3. End with what they should look at themselves, outside your tools, if anything.",
    "If nothing needs attention, say so in one line and prepare nothing.",
    `Write it in ${language === "Arabic" ? "Egyptian Arabic" : "English"}; keep MO numbers, BOMs and codes as they are.`,
  ].join("\n");
}

export function reviewContext(o: { name: string; now: Date; areas: readonly AiArea[]; canDelete: boolean }): string {
  const lines = [`This is ${o.name}'s morning review, which the owner set up for them, running by itself on ${FACTORY_CLOCK.format(o.now)}, Cairo time. Nobody is reading live and nobody can answer a question: do not ask one. Your final answer goes to ${o.name}'s inbox with the changes you prepare.`];
  if (o.areas.length === 0) lines.push(`You may not change anything for ${o.name}: advise only.`);
  else lines.push(`You may prepare changes for ${o.name} on: ${o.areas.map((a) => AI_AREA_LABEL[a]).join("; ")}.${o.canDelete ? "" : " No deletions."} Every one waits for their approval — none runs by itself.`);
  return lines.join("\n");
}

/** Arabic letters in a text — what tells the language a person asks in. */
export function writesArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

/** A conversation longer than this many kept messages takes a new chat —
 *  every question re-reads the whole of it. */
export const AI_MAX_MESSAGES = 120;
/** The longest question taken, in characters. */
export const AI_MAX_QUESTION = 4000;
