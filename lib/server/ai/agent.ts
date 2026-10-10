import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { addTokens, aiModel, NO_TOKENS, type AiModelDef, type AiTokens } from "@/lib/domain/ai";
import { AI_SCHEMA_TEXT } from "./schemaText.generated";
import { runAiQuery } from "./reader";

// One question to the assistant: Claude reads the question, looks the facts
// up with read-only SQL (as many times as it needs, up to a limit), and
// answers. The conversation is only ever appended to — the system prompt and
// the tool are the same on every request, and every message goes back
// exactly as the API sent it, thinking blocks included — so the prompt cache
// keeps hitting and the model keeps its earlier reasoning.

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
/** A kept message as the API takes it back. */
export type AiMessageParam = MessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

const RULES = `You are the data assistant inside the production-planning app of ATC (Arabian Transformers Co.) — the steel-fabrication plant that makes the steel parts of distribution transformers (tanks, top covers, core frames, cable boxes …) and LV panels. Planners, supervisors and managers ask you about the plant's orders, plans, output, machines, material and nesting, Odoo close-outs, shifts and consumables. You answer from the app's live PostgreSQL database and help them decide what to do.

How you work
- Look facts up with the query_database tool. Every number, order, date or name you give must come from a query result in this conversation — never guess or invent one. If the data cannot answer the question, say so plainly and say what is missing.
- You only read. You cannot change anything in the app; when the person wants something changed, tell them where in the app to do it.
- Prefer a few well-aimed queries: aggregate and filter in SQL (GROUP BY, SUM, COUNT, date ranges), select only the columns you need, ORDER BY what matters. Results come back as {columns, rows}, at most 200 rows.
- If a query fails, read the error, fix the SQL and try again.

The database
- PostgreSQL. Each table is named after its Prisma model and each column after its field, case-sensitive — always double-quote them: SELECT "mo", "planQty" FROM "MasterOrder" WHERE "status" = 'open'. A relation field (a model type, or a list such as Machine[]) is not a column; its foreign key is (e.g. "machineId").
- The schema below, with its comments, is the reference for what every table and column means — read the comments, they carry the plant's rules.
- Some tables are private and closed to you: the accounts' details, sessions, the in-app chat, people's preferences and this assistant's own records. Of "User" you can read "id", "name" and "active" only.
- Timestamps are UTC. The factory runs on Cairo time (Africa/Cairo); a column holding a work day stores it at midnight UTC of that day. Fridays and the days in "Holiday" are not working days.

The plant's words
- Departments ("dept"): Cut = Fabrication (laser cutting, punching, bending of the steel parts), Welding, LeakTest (tanks), Painting, ShotBlast (the core frame's last stage instead of paint); Delivered = what the customer has received. The panels (LV) also have Punching and Bending.
- Items, the components of a transformer order: CF Core Frame, TC Top Cover, TN Tank, CB Cable Box, AR Arrester Bracket, MB Mono Box.
- Lines: TR = transformers, LV = LV panels ("line" on "MasterOrder").
- An order is an MO (manufacturing order) of a BOM. "MasterOrder" is the registry of every order the monthly plans brought; output is recorded in "HandoverEntry" (the daily log: date × dept × BOM/MO × item × qty).
- SOI = the sales order, KVA = the transformer's rating, OSP = the quantity made outside.

How you answer
- Answer in the language of the question — Egyptian Arabic when asked in Arabic; keep MO numbers, BOMs, codes and item codes as they are.
- Lead with the answer in a sentence or two, then the detail: a short Markdown table for lists of orders or figures, bullets otherwise. Keep it short — people read it on the floor, often on a phone.
- When it helps, end with up to three concrete suggestions (what to push first, what looks wrong or missing in the data, what to check) under a "Suggestions" heading in the answer's language. Suggestions are your judgement; the facts in them still come from the data.
- Don't show the SQL unless asked.

Charts and figures
- Show numbers visually whenever it helps the reader: comparing departments, machines or orders, a ranking, a split into parts, a change over days or weeks. The app draws a chart from a fenced code block whose language is "chart", holding ONE JSON object. Put it where it belongs in the answer, with a sentence saying what it shows.
- Bars (grouped; "stacked": true to stack, "horizontal": true for rankings or long names):
  {"type":"bar","title":"Output by department — this week","unit":"pcs","series":["Done","Plan"],"data":[{"name":"Fabrication","Done":120,"Plan":150},{"name":"Welding","Done":95,"Plan":150}]}
- Lines or areas over time — "name" is the x value, in order (days as "2026-10-05", or "Week 41"): {"type":"line","title":"…","unit":"pcs","series":["Welding"],"data":[{"name":"2026-10-04","Welding":31}]}
- A split into parts (at most 6 slices): {"type":"pie","title":"Open orders by line","series":["Orders"],"data":[{"name":"TR","Orders":40},{"name":"LV","Orders":12}]}
- Headline figures as cards (tone optional — ok, warn or bad — when a figure is good or a problem): {"type":"kpi","title":"Today","items":[{"label":"Late orders","value":"12","note":"of 85 open","tone":"bad"}]}
- Every number in a chart comes from a query result. At most 6 series and 40 points — group the rest as "Other". Titles, labels and series names in the answer's language. One chart per idea; don't repeat the same figures as a table unless the person needs the exact list.`;

const SYSTEM: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
  { type: "text", text: `${RULES}\n\n<database_schema>\n${AI_SCHEMA_TEXT}</database_schema>`, cache_control: { type: "ephemeral" } },
];

const QUERY_TOOL: Anthropic.Beta.Messages.BetaTool = {
  name: "query_database",
  description:
    "Run ONE read-only SQL query (SELECT, or WITH … SELECT) on the app's PostgreSQL database and get the rows back as {columns, rows} — at most 200 rows, so aggregate in SQL for anything bigger. Table and column names are case-sensitive and must be double-quoted. Call it as often as you need; every figure in your answer must come from a result.",
  input_schema: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "A few words on what this query looks up, in the language of the question — shown to the person while it runs (e.g. \"Late orders this month\")." },
      sql: { type: "string", description: "One SELECT statement — no semicolons, no writes." },
    },
    required: ["purpose", "sql"],
    additionalProperties: false,
  },
};

// tool inputs stream as they are written (a long query shows up sooner); the
// input is then the app's to check, which it does before running anything
const TOOLS: Anthropic.Beta.Messages.BetaToolUnion[] = [{ ...QUERY_TOOL, eager_input_streaming: true }];
// the plain request — no beta feature at all — that a turn falls back on when
// the API refuses the full one (see callModel)
const TOOLS_PLAIN: Anthropic.Beta.Messages.BetaToolUnion[] = [QUERY_TOOL];

/** Calls per question — each look-up is one; the last one must answer. */
const MAX_CALLS = 10;

export interface AskEvents {
  /** What the assistant is looking up now. */
  status(text: string): void;
  /** A piece of the answer. */
  text(delta: string): void;
}

export interface AskResult {
  /** The messages this question added, to keep — empty when it failed before any answer. */
  added: { role: "user" | "assistant"; content: ContentBlockParam[] }[];
  tokens: AiTokens;
  calls: number;
  queries: number;
  /** "refusal" when the model declined (it says so in `error`). */
  stop: string;
  error?: string;
}

const FACTORY_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** The question as the API gets it: who asks and when (the date goes in the
 *  message, never the system prompt, which stays the same for the cache),
 *  then the question itself — always the LAST block, which is what the chat
 *  shows back. */
export function questionMessage(question: string, askedBy: string, now: Date): MessageParam {
  return {
    role: "user",
    content: [
      { type: "text", text: `(Asked by ${askedBy} on ${FACTORY_CLOCK.format(now)}, Cairo time.)` },
      { type: "text", text: question },
    ],
  };
}

function usageTokens(u: Message["usage"]): AiTokens {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Thinking blocks out — only for the plain fallback request, never kept. */
function withoutThinking(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) =>
    typeof m.content === "string" ? m : { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") },
  );
}

async function callModel(
  client: Anthropic,
  m: AiModelDef,
  messages: MessageParam[],
  opts: { plain: boolean; answerNow: boolean },
  events: AskEvents,
  signal?: AbortSignal,
): Promise<Message> {
  const base = {
    model: m.id,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium" as const },
    // caches the conversation so far, on top of the system prompt's own mark
    cache_control: { type: "ephemeral" as const },
    ...(opts.answerNow ? { tool_choice: { type: "none" as const } } : {}),
  };
  const stream = opts.plain
    ? client.beta.messages.stream({ ...base, tools: TOOLS_PLAIN, thinking: { type: "adaptive" }, messages: withoutThinking(messages) }, { signal })
    : client.beta.messages.stream(
        {
          ...base,
          tools: TOOLS,
          // a changed system prompt (a new deployment's schema) drops the old
          // thinking blocks instead of failing the conversation
          thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
          messages,
          betas: ["thinking-binding-controls-2026-08-01", ...(m.fallbacks ? ["server-side-fallback-2026-07-01" as const] : [])],
          // a request the model declines is re-run server-side on the model
          // Anthropic recommends for that kind of refusal
          ...(m.fallbacks ? { fallbacks: "default" as const } : {}),
        },
        { signal },
      );
  stream.on("text", (d) => events.text(d));
  return stream.finalMessage();
}

/** The API's own message for a failed call, in words a person can act on. */
export function apiErrorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Claude API key was refused — the owner should check it on AI assistant settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return "The Claude API key may not use this model — the owner should check the key or pick another model.";
  if (e instanceof Anthropic.RateLimitError) return "Too many requests to Claude right now — try again in a minute.";
  if (e instanceof Anthropic.APIError) {
    const inner = (e.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `Claude API error${e.status ? ` ${e.status}` : ""}: ${inner ?? e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export async function ask(opts: {
  apiKey: string;
  model: string;
  history: MessageParam[];
  question: MessageParam;
  events: AskEvents;
  signal?: AbortSignal;
}): Promise<AskResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 180_000 });
  const m = aiModel(opts.model);
  const turn: MessageParam[] = [opts.question];
  let tokens = NO_TOKENS;
  let calls = 0;
  let queries = 0;
  let plain = false;
  let jsonRetries = 0;
  let stop = "";
  let error: string | undefined;
  let wroteText = false;

  const events: AskEvents = {
    status: opts.events.status,
    text: (d) => {
      wroteText = true;
      opts.events.text(d);
    },
  };

  try {
    for (let step = 0; step < MAX_CALLS; step++) {
      // a second stretch of answer after a look-up starts on its own paragraph
      if (wroteText && step > 0) opts.events.text("\n\n");
      let msg: Message;
      try {
        msg = await callModel(client, m, [...opts.history, ...turn], { plain, answerNow: step === MAX_CALLS - 1 }, events, opts.signal);
        jsonRetries = 0;
      } catch (e) {
        // a 400 on the full request: the plain one, once, for the rest of the
        // question — a beta feature the account does not have, or history the
        // API will not take with its thinking blocks
        if (e instanceof Anthropic.BadRequestError && !plain) {
          plain = true;
          step--;
          continue;
        }
        // a tool input that was not even JSON (a streamed input cut short):
        // the same request again, at most twice
        if (!(e instanceof Anthropic.APIError) && jsonRetries++ < 2) {
          step--;
          continue;
        }
        throw e;
      }
      calls++;
      tokens = addTokens(tokens, usageTokens(msg.usage));
      stop = msg.stop_reason ?? "";

      // declined even by the fallback: what it started is not kept (it may
      // hold a tool call cut off half-way)
      if (msg.stop_reason === "refusal") {
        error = "Claude declined to answer this question.";
        break;
      }
      turn.push({ role: "assistant", content: msg.content as ContentBlockParam[] });

      const uses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || uses.length === 0) break;

      const results: ContentBlockParam[] = [];
      for (const u of uses) {
        const input = u.input as { sql?: unknown; purpose?: unknown } | null;
        const sql = typeof input?.sql === "string" ? input.sql : "";
        if (u.name !== QUERY_TOOL.name || !sql.trim()) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Invalid call — query_database takes {purpose, sql}." } satisfies ToolResult);
          continue;
        }
        events.status(typeof input?.purpose === "string" && input.purpose.trim() ? input.purpose.trim() : "Looking it up in the database");
        const r = await runAiQuery(sql);
        queries++;
        results.push({ type: "tool_result", tool_use_id: u.id, ...(r.ok ? {} : { is_error: true }), content: r.text } satisfies ToolResult);
      }
      // the next call is the last: it answers with what it has
      if (step + 1 === MAX_CALLS - 1) {
        results.push({ type: "text", text: "That is the last look-up for this question — answer now with what you have, and say what you could not check." });
      }
      turn.push({ role: "user", content: results });
    }
  } catch (e) {
    error = apiErrorText(e);
  }

  // keep the turn only if it ends on an answer — a turn cut off on a tool
  // call would make the next request invalid; the question itself is kept
  const last = turn[turn.length - 1];
  const complete = !error && last.role === "assistant";
  const added = (complete ? turn : [opts.question]).map((t) => ({ role: t.role as "user" | "assistant", content: t.content as ContentBlockParam[] }));
  return { added, tokens, calls, queries, stop, error };
}
