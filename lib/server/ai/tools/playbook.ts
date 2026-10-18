import "server-only";
import { prisma } from "@/lib/db";
import { checkPlaybookInput } from "@/lib/server/ai/playbook";
import { savePlaybookRule, setPlaybookRuleActive } from "@/app/ai/playbook/actions";
import { PLAYBOOK_BODY_MAX, PLAYBOOK_TITLE_MAX, PLAYBOOK_TOPICS, PLAYBOOK_TOPIC_LABEL, isPlaybookTopic } from "@/lib/domain/aiPlaybook";
import { formOf, type WriteTool } from "./types";

// The playbook for the assistant: when an admin explains how this plant works
// — "tanks of 1000 kVA and up are welded in bay 2", "reports in Arabic" — the
// assistant writes it down as a rule, which it is then told with every
// question and every automation's run, for everyone. An admin's (the area's
// own rule); through the playbook page's actions; undone by putting the rule
// back as it was.

interface SaveInput {
  id?: number;
  topic: string;
  title: string;
  body: string;
}

export const savePlaybookRuleTool: WriteTool<SaveInput> = {
  kind: "write",
  name: "save_playbook_rule",
  title: "Remember a rule of the plant",
  description: `Write down a rule of how this plant works, as an admin explains it, so you are told it from now on with every question and every automation, for everyone — or rewrite one (its #id is in the playbook in your instructions). One rule per call, a short paragraph in the admin's own words. Topics: ${PLAYBOOK_TOPICS.map((t) => `${t} (${PLAYBOOK_TOPIC_LABEL[t]})`).join(", ")}. For which machine takes which work, use the machines' rules instead — the machine plan follows those.`,
  area: "playbook",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "The rule to rewrite; leave out for a new one." },
      topic: { type: "string", enum: PLAYBOOK_TOPICS },
      title: { type: "string", minLength: 1, maxLength: PLAYBOOK_TITLE_MAX },
      body: { type: "string", minLength: 1, maxLength: PLAYBOOK_BODY_MAX },
    },
    required: ["topic", "title", "body"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: "Only an admin keeps the plant's playbook." };
    const clean = checkPlaybookInput(i);
    if ("error" in clean) return clean;
    const before = i.id ? await prisma.aiPlaybookEntry.findUnique({ where: { id: i.id } }) : null;
    if (i.id && !before) return { error: `Rule #${i.id} is not in the playbook.` };
    const label = isPlaybookTopic(clean.topic) ? PLAYBOOK_TOPIC_LABEL[clean.topic] : clean.topic;
    return {
      title: before ? `Rewrite playbook rule #${before.id}` : `New playbook rule: ${clean.title}`,
      summary: `${before ? `Rewrite rule #${before.id} of` : "Add to"} the plant's playbook (${label}) — the assistant is told it from now on, for everyone: "${clean.title}: ${clean.body.slice(0, 300)}${clean.body.length > 300 ? "…" : ""}"`,
      changes: [{ label: clean.title, before: before ? `${before.title}: ${before.body}`.slice(0, 300) : "—", after: clean.body.slice(0, 300) }],
      snapshot: before ? { id: before.id, topic: before.topic, title: before.title, body: before.body, active: before.active } : { id: null },
    };
  },
  async execute(i) {
    const before = i.id ? await prisma.aiPlaybookEntry.findUnique({ where: { id: i.id } }) : null;
    const r = await savePlaybookRule(formOf({ id: i.id, topic: i.topic, title: i.title, body: i.body }));
    if (!r.ok || !r.id) return { ok: false, error: r.error };
    // a new rule is undone by retiring it; a rewritten one by its old words
    const undo = before
      ? before.active
        ? { tool: "save_playbook_rule", input: { id: before.id, topic: before.topic, title: before.title, body: before.body } }
        : null
      : { tool: "set_playbook_rule_active", input: { id: r.id, active: false } };
    return { ok: true, message: `Rule #${r.id} is in the playbook.`, ...(undo ? { undo } : {}) };
  },
};

export const setPlaybookRuleActiveTool: WriteTool<{ id: number; active: boolean }> = {
  kind: "write",
  name: "set_playbook_rule_active",
  title: "Retire a playbook rule, or bring it back",
  description: "Retire a rule of the plant's playbook (you are no longer told it; it stays on record) or bring a retired one back — by its #id.",
  area: "playbook",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, active: { type: "boolean", description: "false = retire, true = bring back." } }, required: ["id", "active"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: "Only an admin keeps the plant's playbook." };
    const e = await prisma.aiPlaybookEntry.findUnique({ where: { id: i.id } });
    if (!e) return { error: `Rule #${i.id} is not in the playbook.` };
    if (e.active === i.active) return { error: `Rule #${i.id} is ${e.active ? "in force" : "retired"} already.` };
    return {
      title: `${i.active ? "Bring back" : "Retire"} playbook rule #${e.id}`,
      summary: `${i.active ? "Bring back" : "Retire"} the playbook rule "${e.title}".`,
      changes: [{ label: `#${e.id} ${e.title}`, before: e.active ? "in force" : "retired", after: i.active ? "in force" : "retired" }],
      snapshot: { id: e.id, active: e.active, updatedAt: e.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const r = await setPlaybookRuleActive(formOf({ id: i.id, active: i.active }));
    return r.ok ? { ok: true, message: `Rule #${i.id} is ${i.active ? "back" : "retired"}.`, undo: { tool: "set_playbook_rule_active", input: { id: i.id, active: !i.active } } } : { ok: false, error: r.error };
  },
};

export const PLAYBOOK_TOOLS = [savePlaybookRuleTool, setPlaybookRuleActiveTool] as const;
