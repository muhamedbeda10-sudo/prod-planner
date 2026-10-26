import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  reserve: vi.fn(), ask: vi.fn(), messages: vi.fn(), link: vi.fn(), usage: vi.fn(), transaction: vi.fn(),
  message: vi.fn(), update: vi.fn(), outcomes: vi.fn(), find: vi.fn(), hidden: new Set<string>(), model: "claude-opus-5-5",
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {
  aiUsage: { update: h.usage }, aiConversation: { update: h.update, findFirst: h.find }, aiMessage: { create: h.message }, $transaction: h.transaction,
} }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => ({ id: 1, name: "Sara" }), hasPerm: () => false, hiddenTabsOf: () => h.hidden }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "LV" }));
vi.mock("@/lib/server/ai/access", () => ({ aiStatusFor: async () => ({ ok: true }), apiKeyOf: () => "test", getAiSettings: async () => ({ model: h.model, effort: "medium", maxCalls: 14, actionsPaused: false }) }));
vi.mock("@/lib/server/ai/memory", () => ({ memoriesOf: async () => [{ id: 7, text: "Works in Welding" }] }));
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
  h.model = "claude-opus-5-5";
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.reserve.mockResolvedValue({ conversation: { id: 4, title: "Chat", model: "claude-opus-5-5" }, usage: { id: 5 } });
  h.messages.mockReturnValue([]);
  h.usage.mockResolvedValue({});
  h.outcomes.mockResolvedValue(undefined);
  h.ask.mockResolvedValue({ tokens: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 1, queries: 0, added: [], text: "Answer", firstTokenMs: 420, totalMs: 3100 });
  h.transaction.mockResolvedValue([]);
  h.find.mockResolvedValue(null);
});
const ask = (body: object) => POST(new Request("http://localhost/api/ai/chat", { method: "POST", body: JSON.stringify(body) }));
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
  it("hands the assistant what it remembers about the person", async () => {
    await events(await POST(request()));
    expect(h.messages.mock.calls[0][1]).toContain("- [7] Works in Welding");
  });
  it("on Auto, picks the model the question needs and steps the chat up to it", async () => {
    h.model = "auto";
    h.update.mockResolvedValue({ id: 4, title: "Chat", model: "claude-haiku-5-5" });
    h.reserve.mockResolvedValue({ conversation: { id: 4, title: "Chat", model: "claude-opus-5-5" }, usage: { id: 5 } });
    await events(await POST(request()));
    // a short look-up on a new chat: the cheapest model
    expect(h.reserve.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(h.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { model: "claude-haiku-5-5" } });
  });
  it("a Deep question on Auto takes the strongest model, thinks harder with more calls, and the chat steps up to it", async () => {
    h.model = "auto";
    h.update.mockResolvedValue({ id: 4, title: "Chat", model: "claude-opus-5-5" });
    h.reserve.mockResolvedValue({ conversation: { id: 4, title: "Chat", model: "claude-haiku-5-5" }, usage: { id: 5 } });
    await events(await ask({ question: "Hi", depth: "deep" }));
    expect(h.reserve.mock.calls[0][0].model).toBe("claude-opus-5-5");
    expect(h.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { model: "claude-opus-5-5" } });
    expect(h.ask.mock.calls[0][0]).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh", maxCalls: 21 });
  });
  it("a Deep question keeps the model the owner chose; an unknown depth is Standard", async () => {
    h.model = "claude-sonnet-5-5";
    h.reserve.mockResolvedValue({ conversation: { id: 4, title: "Chat", model: "claude-sonnet-5-5" }, usage: { id: 5 } });
    await events(await ask({ question: "Why?", depth: "deep" }));
    expect(h.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: expect.anything() }) }));
    expect(h.ask.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "xhigh", maxCalls: 21 });
    await events(await ask({ question: "Why?", depth: "ultra" }));
    expect(h.ask.mock.calls[1][0]).toMatchObject({ effort: "medium", maxCalls: 14 });
  });
  it("folds the old look-ups of a long chat before the model reads it, and keeps the timing", async () => {
    const big = JSON.stringify({ data: { rows: Array.from({ length: 300 }, (_, i) => [i]) }, source: { id: "r1" } });
    const turn = (q: string, id: string) => [
      { role: "user", content: [{ type: "text", text: q }] },
      { role: "assistant", content: [{ type: "tool_use", id, name: "query_database", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: big }] },
      { role: "assistant", content: [{ type: "text", text: "Ten." }] },
    ];
    h.find.mockResolvedValue({ id: 4, title: "Chat", model: "claude-opus-5-5", messages: [...turn("One?", "a"), ...turn("Two?", "b"), ...turn("Three?", "c")] });
    const sent = await events(await ask({ conversationId: 4, question: "Four?" }));
    const history = h.ask.mock.calls[0][0].history;
    expect(history[2].content[0].content).toContain("omitted");
    expect(history[6].content[0].content).toBe(big);
    expect(history[10].content[0].content).toBe(big);
    expect(sent.at(-1)).toMatchObject({ type: "done", totalMs: 3100 });
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ firstTokenMs: 420, totalMs: 3100 }) }));
    // the person's Stop reaches the model
    expect(h.ask.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
  it("hands the tools the what-if this chat keeps, and tells the model — never to someone the what-ifs are closed to", async () => {
    const kept = { workFridays: true, queue: ["A|TN"] };
    h.find.mockResolvedValue({ id: 4, title: "Chat", model: "claude-opus-5-5", scenario: kept, messages: [] });
    await events(await ask({ conversationId: 4, question: "And one more welder?" }));
    expect(h.ask.mock.calls[0][0].ctx.working).toEqual({ scenario: kept });
    expect(h.messages.mock.calls[0][1]).toContain("This chat keeps a working what-if scenario");
    h.hidden.add("simulate");
    await events(await ask({ conversationId: 4, question: "And one more welder?" }));
    expect(h.ask.mock.calls[1][0].ctx.working).toEqual({ scenario: null });
    expect(h.messages.mock.calls[1][1]).not.toContain("working what-if");
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
