import { describe, expect, it } from "vitest";
import { headChanged, inboxPreview, NO_INBOX_HEAD, tabOfKind } from "./inbox";

describe("headChanged", () => {
  it("is false for the same count and newest item", () => {
    expect(headChanged({ unread: 2, latestId: 9 }, { unread: 2, latestId: 9 })).toBe(false);
  });
  it("sees a new item even when another was read meanwhile (same count)", () => {
    expect(headChanged({ unread: 2, latestId: 9 }, { unread: 2, latestId: 12 })).toBe(true);
  });
  it("sees an item read", () => {
    expect(headChanged({ unread: 2, latestId: 9 }, { unread: 1, latestId: 9 })).toBe(true);
  });
  it("sees the first item", () => {
    expect(headChanged(NO_INBOX_HEAD, { unread: 1, latestId: 3 })).toBe(true);
  });
});

describe("tabOfKind", () => {
  it("puts each kind on its tab", () => {
    expect(tabOfKind("report")).toBe("reports");
    expect(tabOfKind("task")).toBe("tasks");
    expect(tabOfKind("message")).toBe("alerts");
    expect(tabOfKind("suggestion")).toBe("alerts");
  });
});

describe("inboxPreview", () => {
  it("drops Markdown marks, charts and table rules", () => {
    expect(inboxPreview("## Late\n**T-1** is late\n```chart\n{}\n```\n|a|b|\n|---|---|")).toBe("Late T-1 is late a b");
  });
  it("cuts to the length given", () => {
    expect(inboxPreview("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
