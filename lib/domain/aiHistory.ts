// A long chat, as it is sent back to the model: the results its earlier
// look-ups brought back are what grows it — a few hundred rows a time — and
// the model has long since written its answer from them. Before it is sent,
// the big results of every question but the last few are folded to a short
// note (their source kept, so an earlier citation still resolves), and the
// model reads the data again when a new question needs it. What is kept in
// the database is never touched: the chat on screen shows every source.
//
// The folded prefix is the same from one question to the next, so the
// prompt cache keeps hitting on it; only the last few questions, which are
// re-read in full, move in and out of the fold.

/** A content block as this reads it — any block the API takes, by its type
 *  and (a tool result's) content. */
export interface HistoryBlock {
  type?: string;
  content?: unknown;
}

export interface HistoryMessage {
  role: string;
  content: readonly HistoryBlock[] | string;
}

export const AI_HISTORY_FOLD = {
  /** The latest questions sent in full. */
  keepQuestions: 2,
  /** A tool result longer than this (characters) is folded. */
  minChars: 1_500,
} as const;

/** The note a folded result leaves — the source kept where it had one. */
export function foldedResult(content: string): string {
  const note = `(omitted: ${content.length.toLocaleString("en")} characters read earlier in this chat — read it again if this answer needs it)`;
  if (!content.includes('"source"')) return note;
  try {
    const v = JSON.parse(content) as { source?: unknown };
    if (v && typeof v === "object" && v.source && typeof v.source === "object") return JSON.stringify({ data: note, source: v.source });
  } catch { /* not a sourced result */ }
  return note;
}

/** The kept messages with the old look-ups folded. A question's turn starts
 *  at its user message that carries no tool results. */
export function compactHistory<T extends HistoryMessage>(messages: readonly T[], o: { keepQuestions?: number; minChars?: number } = {}): T[] {
  const keep = o.keepQuestions ?? AI_HISTORY_FOLD.keepQuestions;
  const min = o.minChars ?? AI_HISTORY_FOLD.minChars;
  const isQuestion = (m: HistoryMessage) => m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
  // where the last `keep` questions begin — nothing from there on is folded
  let from = messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isQuestion(messages[i])) continue;
    seen++;
    from = i;
    if (seen >= keep) break;
  }
  return messages.map((m, i) => {
    if (i >= from || m.role !== "user" || typeof m.content === "string") return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result" || typeof b.content !== "string" || b.content.length <= min) return b;
      changed = true;
      return { ...b, content: foldedResult(b.content) };
    });
    // the same message with its folded blocks — the type the caller handed in
    return changed ? ({ ...m, content } as T) : m;
  });
}
