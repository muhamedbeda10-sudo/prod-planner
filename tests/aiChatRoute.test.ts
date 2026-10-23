import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  reserve: vi.fn(), ask: vi.fn(), messages: vi.fn(), link: vi.fn(), usage: vi.fn(), transaction: vi.fn(),
  message: vi.fn(), update: vi.fn(), outcomes: vi.fn(), hidden: new Set<string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {
  aiUsage: { update: h.usage }, aiConversation: { update: h.update }, aiMessage: { create: h.message }, $transaction: h.transaction,
} }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => ({ id: 1, name: "Sara" }), hasPerm: () => false, hiddenTabsOf: () => h.hidden }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "LV" }));
vi.mock("@/lib/server/ai/access", () => ({ aiStatusFor: async () => ({ ok: true }), apiKeyOf: () => "test", getAiSettings: async () => ({ model: "claude-opus-5-5", actionsPaused: false }) }));
vi.mock("@/lib/server/ai/chatReservation", () => ({ reserveChatTurn: h.reserve }));
vi.mock("@/lib/server/ai/agent", () => ({ ask: h.ask, questionMessages: h.messages }));
vi.mock("@/lib/server/ai/changes", () => ({ markOutcomesTold: h.outcomes, pendingOutcomes: async () => ({ ids: [], notes: [] }) }));
vi.mock("@/lib/server/ai/tools", () => ({ toolsFor: () => [] }));
vi.mock("@/lib/server/ai/playbook", () => ({ getPlaybookText: async () => "" }));
vi.mock("@/lib/server/ai/files", () => ({ questionFiles: async () => ({ ok: true, files: [] }), linkFiles: h.link, seenBlocks: () => [], fileExpander: () => undefined }));
import { POST } from "@/app/api/ai/chat/route";

beforeEach(() => {
  vi.resetAllMocks();
  h.hidden.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.reserve.mockResolvedValue({ conversation: { id: 4, title: "Chat", model: "claude-opus-5-5" }, usage: { id: 5 } });
  h.messages.mockReturnValue([]);
  h.usage.mockResolvedValue({});
  h.outcomes.mockResolvedValue(undefined);
  h.ask.mockResolvedValue({ tokens: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 1, queries: 0, added: [], text: "Answer" });
  h.transaction.mockResolvedValue([]);
});
function request() {
  return new Request("http://localhost/api/ai/chat", { method: "POST", body: JSON.stringify({ question: "إيه المتأخر هنا؟", page: { path: "/tracker", filters: { month: "October 2026", password: "not forwarded" } } }) });
}
async function events(response: Response) {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}

describe("the AI chat route", () => {
  it("sends selected line and sanitized page context, and finishes only after saving", async () => {
    const response = await POST(request());
    const sent = await events(response);
    expect(sent.map((e) => e.type)).toEqual(["start", "done"]);
    expect(sent[1].error).toBeUndefined();
    expect(h.messages.mock.calls[0][1]).toContain("LV panels");
    expect(h.messages.mock.calls[0][4]).toEqual({ path: "/tracker", filters: { month: "October 2026" } });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
  it("does not forward a hidden screen's context", async () => {
    h.hidden.add("tracker");
    await events(await POST(request()));
    expect(h.messages.mock.calls[0][4]).toBeNull();
  });
  it("rejects another running question before using the model", async () => {
    h.reserve.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(429);
    expect(h.ask).not.toHaveBeenCalled();
  });
  it("reports a failed save in the final event instead of claiming success", async () => {
    h.transaction.mockRejectedValue(new Error("Database disconnected"));
    const sent = await events(await POST(request()));
    expect(sent.at(-1).error).toContain("could not be saved");
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finishedAt: expect.any(Date) }) }));
  });
  it("releases the reservation if startup fails before streaming", async () => {
    h.link.mockRejectedValue(new Error("Could not link files"));
    expect((await POST(request())).status).toBe(503);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.usage).toHaveBeenCalledWith({ where: { id: 5 }, data: { error: "could not start", finishedAt: expect.any(Date) } });
  });
  it("finishes the usage record and emits a clear error if the runner throws", async () => {
    h.ask.mockRejectedValue(new Error("Runner failed"));
    expect((await events(await POST(request()))).at(-1).error).toContain("could not finish");
    expect(h.usage).toHaveBeenCalled();
  });
  it("does not misreport a bookkeeping failure as a failed save", async () => {
    h.outcomes.mockRejectedValue(new Error("Outcomes unavailable"));
    expect((await events(await POST(request()))).at(-1).error).toBeUndefined();
  });
});
