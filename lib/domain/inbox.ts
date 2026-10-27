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

/** What the bar's poll says of a person's inbox: how much is not read, and
 *  the newest unread item (0 for none) — a new item and one read since the
 *  last look show up even when the count stays the same. */
export interface InboxHead {
  unread: number;
  latestId: number;
}

export const NO_INBOX_HEAD: InboxHead = { unread: 0, latestId: 0 };

/** Something came or was read since `a` was told. */
export const headChanged = (a: InboxHead, b: InboxHead): boolean => a.unread !== b.unread || a.latestId !== b.latestId;

/** An unread item as it pops up on the screen until it is marked read. */
export interface InboxPopupItem {
  id: number;
  kind: InboxKind;
  title: string;
  /** The body as a line or two of plain text. */
  preview: string;
  fromName: string | null;
  createdAt: string;
  /** A task's news: the task it is about. */
  taskId: number | null;
}

/** The popup cards on the screen at most — the rest is counted under them. */
export const INBOX_POPUP_SHOWN = 3;
export const INBOX_POPUP_PREVIEW = 140;
