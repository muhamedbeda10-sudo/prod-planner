// The plant's playbook as the assistant reads it — the rules its people
// explained (how lines go on the machines, what a report must carry …), one
// numbered entry each so the assistant can name the one it changes.

export const PLAYBOOK_TOPICS = ["machines", "planning", "reports", "automations", "general"] as const;
export type PlaybookTopic = (typeof PLAYBOOK_TOPICS)[number];

export const PLAYBOOK_TOPIC_LABEL: Record<PlaybookTopic, string> = {
  machines: "Machines and their distribution",
  planning: "Planning and priorities",
  reports: "Reports and messages",
  automations: "Automations",
  general: "General",
};

export function isPlaybookTopic(v: string): v is PlaybookTopic {
  return (PLAYBOOK_TOPICS as readonly string[]).includes(v);
}

/** Limits on one rule: a rule is a paragraph, not a document. */
export const PLAYBOOK_TITLE_MAX = 120;
export const PLAYBOOK_BODY_MAX = 2000;
/** The most the assistant is handed with every question. Past it, the
 *  oldest rules are left out — and the page says so. */
export const PLAYBOOK_TEXT_MAX = 16_000;

export interface PlaybookEntryLike {
  id: number;
  topic: string;
  title: string;
  body: string;
}

/** The active rules as one text, grouped by topic in a fixed order, newest
 *  last within a topic; what does not fit the limit is left out (oldest
 *  first) and counted. */
export function playbookText(entries: readonly PlaybookEntryLike[], max = PLAYBOOK_TEXT_MAX): { text: string; left: number } {
  const order = (t: string) => {
    const i = (PLAYBOOK_TOPICS as readonly string[]).indexOf(t);
    return i < 0 ? PLAYBOOK_TOPICS.length : i;
  };
  // newest first while deciding what fits, so an old rule is what drops
  const byNewest = [...entries].sort((a, b) => b.id - a.id);
  const kept: PlaybookEntryLike[] = [];
  let size = 0;
  let left = 0;
  for (const e of byNewest) {
    const len = e.title.length + e.body.length + 24;
    if (size + len > max) {
      left++;
      continue;
    }
    size += len;
    kept.push(e);
  }
  kept.sort((a, b) => order(a.topic) - order(b.topic) || a.id - b.id);
  const lines: string[] = [];
  let topic = "";
  for (const e of kept) {
    if (e.topic !== topic) {
      topic = e.topic;
      lines.push(`## ${isPlaybookTopic(topic) ? PLAYBOOK_TOPIC_LABEL[topic] : topic}`);
    }
    lines.push(`#${e.id} ${e.title}: ${e.body}`);
  }
  return { text: lines.join("\n"), left };
}
