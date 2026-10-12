// The inbox's words — pure, for the page and the server alike.

export const INBOX_KINDS = ["report", "message", "suggestion"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_KIND_LABEL: Record<InboxKind, string> = {
  report: "Report",
  message: "Message",
  suggestion: "Suggestion",
};

/** A notification's one or two lines out of a Markdown body: no chart
 *  blocks, no table rules, no Markdown marks, the whitespace folded. */
export function inboxPreview(markdown: string, max = 180): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
