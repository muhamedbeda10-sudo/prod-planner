import "server-only";
import { AUTOMATIONS_KEY } from "@/lib/server/automations/store";
import { ideasForUser } from "@/lib/server/automations/ideas";
import { describeAction, describeTrigger } from "@/lib/domain/automations";
import type { ReadTool } from "./types";

// The automations the assistant suggested lately (lib/server/automations/
// ideas.ts) — the same ones the person sees above the ready-made automations —
// so it can say what it suggested and make one with create_automation.

export const automationIdeasTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "list_automation_ideas",
  title: "Looking at the automation ideas",
  description: "The automations suggested lately for this plant (new ones each week, from what happens in it), the ones fit for the person and not set aside: each one's title, what it does and why, whether it is new this week, and its full configuration — to explain one or to make it with create_automation once the person says who it goes to.",
  needs: AUTOMATIONS_KEY,
  schema: { type: "object", properties: {}, additionalProperties: false },
  async run(_i, ctx) {
    const ideas = await ideasForUser(ctx.user);
    if (ideas.length === 0) return { ok: true, text: "No automation ideas for this person right now — new ones come each week." };
    return {
      ok: true,
      text: JSON.stringify(ideas.map((i) => ({ title: i.title, does: i.desc, why: i.why, group: i.group, new: i.isNew, when: describeTrigger(i.config), what: describeAction(i.config, []), config: i.config }))),
      links: [{ label: "Automations", href: "/automations" }],
    };
  },
};

export const AUTOMATION_IDEA_TOOLS = [automationIdeasTool] as const;
