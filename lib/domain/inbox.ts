// The inbox's words — pure, for the page and the server alike.

/** An inbox item's title and body, at most (characters) — what the server
 *  cuts to, and what a sender is told before it tries. */
export const INBOX_TITLE_MAX = 200;
export const INBOX_BODY_MAX = 60_000;

export const INBOX_KINDS = ["report", "message", "suggestion", "task"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_KIND_LABEL: Record<InboxKind, string> = {
  report: "Report",
  message: "Message",
  suggestion: "Suggestion",
  task: "Task",
};

/** The inbox's tabs: what reaches a person (messages, changes to approve),
 *  the reports written for them, and their tasks. */
export const INBOX_TABS = ["alerts", "reports", "tasks"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const INBOX_TAB_LABEL: Record<InboxTab, string> = {
  alerts: "Alerts",
  reports: "Reports",
  tasks: "Tasks",
};

/** The kinds each tab lists. A task's news is read on the task itself. */
export const TAB_KINDS: Record<InboxTab, readonly InboxKind[]> = {
  alerts: ["message", "suggestion"],
  reports: ["report"],
  tasks: ["task"],
};

export function tabOfKind(kind: InboxKind): InboxTab {
  return kind === "report" ? "reports" : kind === "task" ? "tasks" : "alerts";
}

export const isInboxTab = (s: string): s is InboxTab => (INBOX_TABS as readonly string[]).includes(s);

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
