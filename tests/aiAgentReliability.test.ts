import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ stream: vi.fn(), write: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/ai/changes", () => ({ handleWriteCall: h.write }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class Anthropic {
    beta = { messages: { stream: h.stream } };
    static APIError = APIError;
    static BadRequestError = class extends APIError {};
    static AuthenticationError = class extends APIError {};
    static PermissionDeniedError = class extends APIError {};
    static RateLimitError = class extends APIError {};
  }
  return { default: Anthropic };
});
import type { User } from "@prisma/client";
import { ask, questionMessages } from "@/lib/server/ai/agent";
import { displayTurns } from "@/lib/domain/ai";
import type { AiTool } from "@/lib/server/ai/tools/types";

const ctx = { user: { id: 1, name: "Sara" } as User, hidden: new Set<string>(), now: new Date(), todayISO: "2026-10-24", conversationId: 5, automationId: null };
const read = vi.fn();
const tools: AiTool[] = [
  { kind: "read", name: "read_test", title: "Read", description: "Read facts", cacheable: true, schema: { type: "object", properties: {}, additionalProperties: false }, run: read },
  { kind: "write", name: "write_test", title: "Write", description: "Prepare a change", area: "tracker", risk: "low", schema: { type: "object", properties: {}, additionalProperties: false }, describe: vi.fn(), execute: vi.fn() },
];
const use = (id: string, name = "read_test") => ({ type: "tool_use", id, name, input: {} });
const reply = (content: unknown[], stop = "end_turn", text = "", failure?: Error) => ({
  on: (event: string, fn: (text: string) => void) => { if (event === "text" && text) fn(text); },
  finalMessage: async () => { if (failure) throw failure; return { content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }; },
});
const done = () => reply([{ type: "text", text: "Answer" }]);
const run = (overrides: Partial<Parameters<typeof ask>[0]> = {}) => ask({
  apiKey: "test", model: "claude-opus-5-5", history: [], question: questionMessages("Question", "context"),
  tools, ctx, settings: { actionsPaused: false }, events: { status: vi.fn(), text: vi.fn() }, ...overrides,
});
beforeEach(() => {
  vi.resetAllMocks();
  read.mockResolvedValue({ ok: true, text: "Current facts" });
  h.write.mockResolvedValue({ text: "Prepared", isError: false });
});

describe("AI reads and writes", () => {
  it("keeps page hints separate from the person's displayed question", () => {
    const messages = questionMessages("السؤال", "context", undefined, [], { path: "/tracker", filters: { product: "USS" } });
    expect(displayTurns(messages)[0].text).toBe("السؤال");
    expect(JSON.stringify(messages[0].content)).toContain("untrusted display hints");
  });
  it("deduplicates identical successful reads within one tool batch with a result for every id", async () => {
    h.stream.mockReturnValueOnce(reply([use("a"), use("b")], "tool_use")).mockReturnValueOnce(done());
    const result = await run();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.queries).toBe(1);
    expect(result.added[3].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "Current facts" },
      { type: "tool_result", tool_use_id: "b", content: "Current facts" },
    ]);
  });
  it("streams and persists verified read sources while leaving failed reads uncited", async () => {
    const source = vi.fn();
    read.mockResolvedValueOnce({ ok: true, text: '{"remaining":6}', links: [{ label: "Order", href: "/trace?mo=A&line=LV" }, { label: "Hidden", href: "/odoo" }] })
      .mockResolvedValueOnce({ ok: false, text: "Unavailable" });
    h.stream.mockReturnValueOnce(reply([use("source_1")], "tool_use"))
      .mockReturnValueOnce(reply([use("source_2")], "tool_use")).mockReturnValueOnce(done());
    const result = await run({ ctx: { ...ctx, hidden: new Set(["odoo"]) }, events: { status: vi.fn(), text: vi.fn(), source } });
    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0][0]).toMatchObject({ id: "source_1", links: [{ label: "Order", href: "/trace?mo=A&line=LV" }] });
    expect(displayTurns(result.added).find((turn) => turn.role === "assistant")?.sources).toEqual([expect.objectContaining({ id: "source_1", snapshot: expect.stringContaining('"remaining": 6') })]);
    expect(JSON.stringify(result.added)).toContain("#ai-source-source_1");
    expect(JSON.stringify(result.added)).not.toContain("#ai-source-source_2");
  });
  it("reads again after a write, and never deduplicates writes", async () => {
    h.stream.mockReturnValueOnce(reply([use("a"), use("b", "write_test"), use("c"), use("d", "write_test")], "tool_use")).mockReturnValueOnce(done());
    await run();
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenCalledTimes(2);
  });
  it("refreshes the same read on a later model call", async () => {
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use")).mockReturnValueOnce(reply([use("b")], "tool_use")).mockReturnValueOnce(done());
    await run();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not cache failed reads or tools with live screen effects", async () => {
    read.mockResolvedValue({ ok: false, text: "Try again" });
    h.stream.mockReturnValueOnce(reply([use("a"), use("b")], "tool_use")).mockReturnValueOnce(done());
    await run();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockClear().mockResolvedValue({ ok: true, text: "Shown" });
    h.stream.mockReturnValueOnce(reply([use("a"), use("b")], "tool_use")).mockReturnValueOnce(done());
    await run({ tools: [{ ...tools[0], liveOnly: true }] });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not start a write after the signal was cancelled", async () => {
    const controller = new AbortController();
    read.mockImplementation(async () => { controller.abort(); return { ok: true, text: "Current" }; });
    h.stream.mockReturnValueOnce(reply([use("a"), use("b", "write_test")], "tool_use"));
    expect((await run({ signal: controller.signal })).error).toContain("stopped");
    expect(h.write).not.toHaveBeenCalled();
  });
  it("keeps prepared changes visible if a later model call fails", async () => {
    h.stream.mockReturnValueOnce(reply([use("change", "write_test")], "tool_use"))
      .mockImplementationOnce(() => { throw new Error("Connection lost"); });
    const result = await run();
    expect(result.error).toContain("Connection lost");
    expect(result.added[2].content).toEqual([use("change", "write_test")]);
    expect(result.added.at(-1)?.content).toEqual([expect.objectContaining({ text: expect.stringContaining("did not finish") })]);
    // A complete tool result is kept so the next question can continue safely.
    expect(result.added[3].content).toEqual([{ type: "tool_result", tool_use_id: "change", content: "Prepared" }]);
  });
  it("fills interrupted tool calls without rerunning a completed change", async () => {
    const controller = new AbortController();
    h.write.mockImplementationOnce(async () => { controller.abort(); return { text: "Prepared", isError: false }; });
    h.stream.mockReturnValueOnce(reply([use("first", "write_test"), use("second", "write_test")], "tool_use"));
    const result = await run({ signal: controller.signal });
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(result.added[3].content).toEqual([
      { type: "tool_result", tool_use_id: "first", content: "Prepared" },
      expect.objectContaining({ tool_use_id: "second", is_error: true, content: expect.stringContaining("Not run") }),
    ]);
  });
});

describe("failed and limited model calls", () => {
  it("retries malformed JSON before text, but stops after two retries", async () => {
    h.stream.mockImplementation(() => { throw new SyntaxError("bad JSON"); });
    expect((await run()).error).toContain("bad JSON");
    expect(h.stream).toHaveBeenCalledTimes(3);
  });
  it("does not replay a streamed answer when parsing subsequently fails", async () => {
    const text = vi.fn();
    h.stream.mockReturnValue(reply([], "end_turn", "A partial answer", new SyntaxError("bad JSON")));
    expect((await run({ events: { status: vi.fn(), text } })).error).toContain("bad JSON");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledExactlyOnceWith("A partial answer");
  });
  it("does not retry unrelated failures", async () => {
    h.stream.mockImplementation(() => { throw new Error("Unavailable attachment"); });
    expect((await run()).error).toContain("Unavailable attachment");
    expect(h.stream).toHaveBeenCalledTimes(1);
  });
  it("reports a truncated textual answer as incomplete", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Partial" }], "max_tokens"));
    expect((await run()).error).toContain("incomplete");
  });
  it("does not start the model for an already aborted request", async () => {
    const result = await run({ signal: AbortSignal.abort() });
    expect(result.error).toContain("stopped");
    expect(h.stream).not.toHaveBeenCalled();
  });
  it("passes a bounded deadline to the SDK and does not retry it", async () => {
    h.stream.mockImplementation((_args, { signal }: { signal: AbortSignal }) => ({
      on: () => {},
      finalMessage: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    }));
    expect((await run({ timeoutMs: 20 })).error).toContain("took too long");
    expect(h.stream).toHaveBeenCalledTimes(1);
  });
  it("never runs a late write when the final call should only answer", async () => {
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use")).mockReturnValueOnce(reply([use("b", "write_test")], "tool_use"));
    expect((await run({ maxCalls: 2 })).error).toContain("work limit");
    expect(h.write).not.toHaveBeenCalled();
  });
});
