import { describe, expect, it } from "vitest";
import { cleanIdea, ideaKey, ideasFor, ideaWeekISO, IDEAS_SHOWN, type IdeaRow } from "./automationIdeas";

const notify = { name: "Order on hold", trigger: "event", eventTypes: ["order.held"], action: "notify", message: "{about} on hold" };

describe("ideaWeekISO", () => {
  it("is the Saturday that starts the plant's week", () => {
    expect(ideaWeekISO("2026-10-24")).toBe("2026-10-24"); // Saturday
    expect(ideaWeekISO("2026-10-27")).toBe("2026-10-24"); // Tuesday
    expect(ideaWeekISO("2026-10-30")).toBe("2026-10-24"); // Friday
    expect(ideaWeekISO("2026-10-31")).toBe("2026-10-31"); // the next Saturday
  });
});

describe("cleanIdea", () => {
  it("keeps a valid idea, going to nobody yet", () => {
    const r = cleanIdea({ title: "  Holds → a message ", desc: "Tells you", why: "12 holds last month", group: "Orders", config: { ...notify, recipientIds: [4], eventActorIds: [2] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idea.title).toBe("Holds → a message");
    expect(r.idea.config.recipientIds).toEqual([]);
    expect(r.idea.config.eventActorIds).toEqual([]);
  });
  it("reads an escalation of 0 as never", () => {
    const r = cleanIdea({ title: "x", desc: "y", group: "Orders", config: { name: "Held", trigger: "condition", conditionSql: 'SELECT "mo" AS key FROM "Order"', action: "notify", message: "{rows}", escalateAfterMin: 0 } });
    expect(r.ok && r.idea.config.escalateAfterMin).toBe(null);
  });
  it("refuses one that would change data, an unknown group, or a broken automation", () => {
    expect(cleanIdea({ title: "x", desc: "y", group: "Orders", config: { ...notify, action: "act", prompt: "do" } }).ok).toBe(false);
    expect(cleanIdea({ title: "x", desc: "y", group: "Stores", config: notify }).ok).toBe(false);
    expect(cleanIdea({ title: "x", desc: "y", group: "Orders", config: { ...notify, eventTypes: ["nope"] } }).ok).toBe(false);
    expect(cleanIdea({ title: "x", desc: "y", group: "Orders", config: { ...notify, eventTypes: "order.held" } }).ok).toBe(false);
    expect(cleanIdea({ title: "", desc: "y", group: "Orders", config: notify }).ok).toBe(false);
    expect(cleanIdea(null).ok).toBe(false);
  });
});

describe("ideasFor", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  const row = (id: number, daysAgo: number, o: Partial<IdeaRow> = {}): IdeaRow => ({
    id, title: `Idea ${id}`, desc: "d", why: "w", group: "Orders", config: { ...notify, name: `Idea ${id}` }, dismissedBy: [], createdAt: new Date(now.getTime() - daysAgo * 86_400_000), ...o,
  });
  it("shows the newest first, marks this week's new, and hides what the person set aside or keeps already", () => {
    const v = ideasFor([row(1, 20), row(2, 2), row(3, 1, { dismissedBy: [7] }), row(4, 3), row(5, 1, { config: { name: "bad" } })], { viewerId: 7, liveNames: ["idea 4!"], now });
    expect(v.map((i) => [i.id, i.isNew])).toEqual([[2, true], [1, false]]);
  });
  it("shows at most a handful", () => {
    const rows = Array.from({ length: IDEAS_SHOWN + 4 }, (_, k) => row(k + 1, k));
    expect(ideasFor(rows, { viewerId: 1, liveNames: [], now })).toHaveLength(IDEAS_SHOWN);
  });
  it("compares names without case or punctuation", () => {
    expect(ideaKey("Orders — late!")).toBe(ideaKey("orders late"));
  });
});
