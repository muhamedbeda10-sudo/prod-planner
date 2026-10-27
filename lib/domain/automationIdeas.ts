// Automation ideas — what the assistant suggests each week from what happens
// in the plant, shown above the ready-made automations. Pure: what a
// suggestion must be to be kept, and which ones a person sees.

import { checkAutomation, type AutomationConfig, type AutomationInput, type AutomationRecipe } from "./automations";

export type IdeaGroup = AutomationRecipe["group"];
export const IDEA_GROUPS: readonly IdeaGroup[] = ["Quality", "Production", "Orders", "Reports", "Tasks"];

/** Ideas kept from one round of suggestions. */
export const IDEAS_PER_ROUND = 3;
/** The weekly round comes on the first working day of the week, from this time (Cairo). */
export const IDEAS_AT = "09:00";
/** An idea reads as new for this many days. */
export const IDEA_NEW_DAYS = 7;
/** Ideas shown at once, newest first. */
export const IDEAS_SHOWN = 9;
/** Earlier ideas the assistant is told of, so it does not suggest them again. */
export const IDEAS_REMEMBERED = 40;

export const IDEA_LIMITS = { title: 80, desc: 240, why: 240 } as const;

export interface IdeaDraft {
  title: string;
  desc: string;
  /** What in the plant made it worth suggesting. */
  why: string;
  group: IdeaGroup;
  config: AutomationConfig;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A name as compared with others — case, spaces and punctuation aside. */
export const ideaKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** One suggestion as the assistant wrote it, cleaned — or why it is not kept.
 *  It goes to nobody yet (the person picks who when they turn it on), and
 *  never changes data by itself. */
export function cleanIdea(raw: unknown): { ok: true; idea: IdeaDraft } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Not an idea." };
  const r = raw as Record<string, unknown>;
  const title = text(r.title, IDEA_LIMITS.title);
  const desc = text(r.desc, IDEA_LIMITS.desc);
  const why = text(r.why, IDEA_LIMITS.why);
  if (!title || !desc) return { ok: false, error: "An idea needs a title and what it does." };
  const group = IDEA_GROUPS.find((g) => g === r.group);
  if (!group) return { ok: false, error: `"${String(r.group)}" is not a group.` };
  if (!r.config || typeof r.config !== "object") return { ok: false, error: "An idea needs its automation." };
  const config: Record<string, unknown> = { ...(r.config as Record<string, unknown>), recipientIds: [], eventActorIds: [] };
  if (config.action === "act") return { ok: false, error: "An idea does not change data by itself." };
  const checked = checkAutomation(config as AutomationInput);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, idea: { title, desc, why, group, config: checked.config } };
}

export interface IdeaRow {
  id: number;
  title: string;
  desc: string;
  why: string;
  group: string;
  config: unknown;
  dismissedBy: readonly number[];
  createdAt: Date;
}

export type IdeaView = Omit<IdeaDraft, "group"> & { id: number; group: string; isNew: boolean };

/** The ideas one person sees, from `rows` newest first: not the ones they set
 *  aside, nor one they already keep an automation of (by its name), nor one
 *  no longer valid or not `fit` for them. */
export function ideasFor(
  rows: readonly IdeaRow[],
  o: { viewerId: number; liveNames: readonly string[]; now: Date; fits?: (c: AutomationConfig) => boolean },
): IdeaView[] {
  const live = new Set(o.liveNames.map(ideaKey));
  const newSince = o.now.getTime() - IDEA_NEW_DAYS * 86_400_000;
  const out: IdeaView[] = [];
  for (const r of rows) {
    if (r.dismissedBy.includes(o.viewerId)) continue;
    const checked = checkAutomation((r.config ?? {}) as AutomationInput);
    if (!checked.ok || live.has(ideaKey(checked.config.name)) || (o.fits && !o.fits(checked.config))) continue;
    out.push({ id: r.id, title: r.title, desc: r.desc, why: r.why, group: r.group, config: checked.config, isNew: r.createdAt.getTime() >= newSince });
    if (out.length === IDEAS_SHOWN) break;
  }
  return out;
}
