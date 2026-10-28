import { LEGACY_SOURCE_ANCHOR } from "./ai";

// A long chat, as it is sent back to the model: the results its earlier
// look-ups brought back are what grows it — a few hundred rows a time — and
// the model has long since written its answer from them. Before it is sent,
// the big results of every question but the last few are folded to a short
// note, and the model reads the data again when a new question needs it; a
// read kept from when answers cited their sources goes back without its
// source wrapper. What is kept in the database is never touched.
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

/** The note a folded result leaves. */
export function foldedResult(content: string): string {
  return `(omitted: ${content.length.toLocaleString("en")} characters read earlier in this chat — read it again if this answer needs it)`;
}

type ReadLink = { label: string; href: string };

// a read with the app's links to the screens behind it goes as { data, links }
const withLinks = (data: unknown, links: readonly ReadLink[]) => JSON.stringify({ data, links });

/** What a read sends the model — the tool's own text, with the app's own
 *  links to the screens behind it when it has any — and its data, parsed
 *  once (JSON, else the sentence it is). */
export function readContent(text: string, links: readonly ReadLink[]): { content: string; data: unknown } {
  let data: unknown = text;
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON after all — a sentence */
    }
  }
  return { content: links.length ? withLinks(data, links) : text, data };
}

/** A read kept from before 28 Oct 2026 came wrapped with a source to cite
 *  ({ data, source: { citation, links } }) — sent back as a read is now: its
 *  data, with its links when it had any, never the citation. */
export function withoutLegacySource(content: string): string {
  if (!content.startsWith('{"data":') || !content.includes(LEGACY_SOURCE_ANCHOR)) return content;
  try {
    const v = JSON.parse(content) as { data?: unknown; source?: { links?: unknown } } | null;
    if (!v || typeof v !== "object" || !("data" in v) || !v.source || typeof v.source !== "object") return content;
    const links = Array.isArray(v.source.links) ? (v.source.links as ReadLink[]) : [];
    if (links.length) return withLinks(v.data, links);
    return typeof v.data === "string" ? v.data : JSON.stringify(v.data);
  } catch {
    return content;
  }
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
    if (m.role !== "user" || typeof m.content === "string") return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result" || typeof b.content !== "string") return b;
      const read = withoutLegacySource(b.content);
      const next = i < from && read.length > min ? foldedResult(read) : read;
      if (next === b.content) return b;
      changed = true;
      return { ...b, content: next };
    });
    // the same message with its folded blocks — the type the caller handed in
    return changed ? ({ ...m, content } as T) : m;
  });
}
