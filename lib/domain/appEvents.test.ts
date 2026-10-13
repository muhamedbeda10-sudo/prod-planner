import { describe, expect, it } from "vitest";
import { APP_EVENT_TYPES, APP_EVENTS, eventMatches, eventRow, outputSentence } from "./appEvents";

describe("the event list", () => {
  it("describes every event it lists", () => {
    for (const t of APP_EVENT_TYPES) expect(APP_EVENTS[t].label.length, t).toBeGreaterThan(0);
  });
});

describe("eventMatches", () => {
  const e = { type: "order.held" as const, actorId: 9, subject: "SF01/MO/06326", summary: "Put SF01/MO/06326 on hold — no steel" };
  it("needs one of the rule's kinds", () => {
    expect(eventMatches({ eventTypes: ["order.closed"], eventActorIds: [], eventMatch: null }, e)).toBe(false);
    expect(eventMatches({ eventTypes: ["order.closed", "order.held"], eventActorIds: [], eventMatch: null }, e)).toBe(true);
  });
  it("watches only the people named, when it names any", () => {
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [10], eventMatch: null }, e)).toBe(false);
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [9, 10], eventMatch: null }, e)).toBe(true);
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [9], eventMatch: null }, { ...e, actorId: null })).toBe(false);
  });
  it("looks for its words in what it is about and its sentence, whatever the case", () => {
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [], eventMatch: "steel" }, e)).toBe(true);
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [], eventMatch: "mo/06326" }, e)).toBe(true);
    expect(eventMatches({ eventTypes: ["order.held"], eventActorIds: [], eventMatch: "welding" }, e)).toBe(false);
  });
});

describe("outputSentence", () => {
  it("says what was recorded, and a correction down with the total it leaves", () => {
    expect(outputSentence({ qty: 5, item: "TN", on: "SF01/MO/1", stage: "Welding" })).toBe("Recorded 5 × TN on SF01/MO/1 — Welding");
    expect(outputSentence({ qty: -2, item: "TN", on: "SF01/MO/1", stage: "Painting", total: 8 })).toBe("Took 2 × TN on SF01/MO/1 — Painting off (total now 8)");
  });
});

describe("eventRow", () => {
  it("is the row a message or a report is written from", () => {
    const row = eventRow({ id: 1, type: "order.closed", at: "", actorId: 9, actorName: "Sara", subject: "MO/1", summary: "Closed MO/1" }, "13 Oct 10:00");
    expect(row).toEqual({ when: "13 Oct 10:00", who: "Sara", what: "Order closed", about: "MO/1", detail: "Closed MO/1" });
  });
});
