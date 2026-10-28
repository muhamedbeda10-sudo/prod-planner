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
import { ask, questionMessages, rowsOf } from "@/lib/server/ai/agent";
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
  it("sends a read back to the model as the tool gave it, with no source wrapper or citation", async () => {
    read.mockResolvedValueOnce({ ok: true, text: '{"remaining":6}' });
    h.stream.mockReturnValueOnce(reply([use("read_1")], "tool_use")).mockReturnValueOnce(done());
    const result = await run({ events: { status: vi.fn(), text: vi.fn() } });
    const sent = JSON.stringify(result.added);
    expect(sent).toContain(JSON.stringify('{"remaining":6}'));
    expect(sent).not.toContain("ai-source-");
    expect(sent).not.toContain("citation");
  });
  it("runs the reads of one turn at the same time, and a write only after them", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    read.mockImplementation(async (input: { n?: number }) => {
      order.push(`start ${input.n}`);
      if (input.n === 1) await gate;
      order.push(`end ${input.n}`);
      return { ok: true, text: `Facts ${input.n}` };
    });
    h.write.mockImplementation(async () => { order.push("write"); return { text: "Prepared", isError: false }; });
    const useN = (id: string, n: number) => ({ type: "tool_use", id, name: "read_test", input: { n } });
    h.stream.mockReturnValueOnce(reply([useN("a", 1), useN("b", 2), use("c", "write_test")], "tool_use")).mockReturnValueOnce(done());
    const pending = run({ tools: [{ ...tools[0], schema: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false } }, tools[1]] });
    // the second read starts, and ends, while the first still waits
    await vi.waitFor(() => expect(order).toContain("end 2"));
    expect(order).toEqual(["start 1", "start 2", "end 2"]);
    release();
    const result = await pending;
    expect(order).toEqual(["start 1", "start 2", "end 2", "end 1", "write"]);
    expect((result.added[3].content as { tool_use_id: string; content: string }[]).map((b) => [b.tool_use_id, b.content])).toEqual([["a", "Facts 1"], ["b", "Facts 2"], ["c", "Prepared"]]);
  });
  it("runs a read that changes what the others start from alone, in the model's order", async () => {
    const order: string[] = [];
    const slow = (name: string, serial?: boolean): AiTool => ({
      kind: "read", name, title: name, description: name, schema: { type: "object", properties: {}, additionalProperties: false }, ...(serial ? { serial: true as const } : {}),
      run: async () => { order.push(`start ${name}`); await new Promise((r) => setTimeout(r, 5)); order.push(`end ${name}`); return { ok: true, text: name }; },
    });
    h.stream.mockReturnValueOnce(reply([use("a", "r1"), use("b", "keep"), use("c", "r2"), use("d", "r3")], "tool_use")).mockReturnValueOnce(done());
    await run({ tools: [slow("r1"), slow("keep", true), slow("r2"), slow("r3"), tools[1]] });
    expect(order).toEqual(["start r1", "end r1", "start keep", "end keep", "start r2", "start r3", "end r2", "end r3"]);
  });
  it("tells the chat each step with its timing and rows, and how long the answer took", async () => {
    const step = vi.fn();
    read.mockResolvedValueOnce({ ok: true, text: '{"columns":["mo"],"rowCount":3,"rows":[[1],[2],[3]]}' }).mockResolvedValueOnce({ ok: false, text: "Unavailable" });
    h.stream.mockReturnValueOnce(reply([use("a"), use("b", "write_test")], "tool_use")).mockReturnValueOnce(reply([use("c")], "tool_use")).mockReturnValueOnce(done());
    const result = await run({ events: { status: vi.fn(), text: vi.fn(), step } });
    expect(step.mock.calls.map(([s]) => s)).toEqual([
      { id: "a", kind: "read", text: "Read", state: "start" },
      { id: "a", kind: "read", text: "Read", state: "done", ms: expect.any(Number), rows: 3 },
      { id: "b", kind: "write", text: "Write", state: "start" },
      { id: "b", kind: "write", text: "Write", state: "done", ms: expect.any(Number) },
      { id: "c", kind: "read", text: "Read", state: "start" },
      { id: "c", kind: "read", text: "Read", state: "error", ms: expect.any(Number) },
    ]);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.firstTokenMs).toBeNull();
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
  it("shares one retry between duplicates of a failed read, and keeps a read that threw as a result", async () => {
    read.mockResolvedValueOnce({ ok: false, text: "Timed out" }).mockResolvedValueOnce({ ok: true, text: "Facts" });
    h.stream.mockReturnValueOnce(reply([use("a"), use("b"), use("c")], "tool_use")).mockReturnValueOnce(done());
    const result = await run();
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.queries).toBe(2);
    expect((result.added[3].content as { tool_use_id: string; content: string; is_error?: boolean }[]).map((b) => [b.tool_use_id, b.content, !!b.is_error])).toEqual([["a", "Timed out", true], ["b", "Facts", false], ["c", "Facts", false]]);
    read.mockClear().mockRejectedValueOnce(new Error("Connection reset"));
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use")).mockReturnValueOnce(done());
    expect((await run()).added[3].content).toEqual([expect.objectContaining({ tool_use_id: "a", is_error: true, content: expect.stringContaining("Connection reset") })]);
  });
  it("measures the first word of the answer, and hands the text back without the follow-up block", async () => {
    const written = "Answer\n\n```followups\n[\"Why?\"]\n```";
    h.stream.mockReturnValueOnce(reply([{ type: "text", text: written }], "end_turn", written));
    const result = await run();
    expect(result.text).toBe("Answer");
    expect(result.firstTokenMs).toEqual(expect.any(Number));
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstTokenMs!);
  });
  it("keeps what was streamed when the person stops the answer, after the complete tool rounds", async () => {
    const controller = new AbortController();
    const text = vi.fn();
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use"))
      .mockReturnValueOnce({
        on: (event: string, fn: (t: string) => void) => { if (event === "text") { fn("Ten late so far"); controller.abort(); } },
        finalMessage: () => Promise.reject(new Error("aborted")),
      });
    const result = await run({ signal: controller.signal, events: { status: vi.fn(), text } });
    expect(result.error).toContain("stopped");
    expect(result.added.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "assistant"]);
    const last = result.added.at(-1)!.content as { type: string; text: string }[];
    expect(last.map((b) => b.text)).toEqual(["Ten late so far", expect.stringContaining("did not finish")]);
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

describe("rows in a result", () => {
  it("counts a query's rows, a list, and nothing for a sentence", () => {
    expect(rowsOf('{"columns":["a"],"rowCount":7,"rows":[]}')).toBe(7);
    expect(rowsOf('{"rows":[1,2]}')).toBe(2);
    expect(rowsOf("[1,2,3]")).toBe(3);
    expect(rowsOf("Nothing is late.")).toBeNull();
    expect(rowsOf("{not json")).toBeNull();
    expect(rowsOf({ rowCount: 4 })).toBe(4);
    expect(rowsOf([1])).toBe(1);
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
  it("reports a truncated textual answer as incomplete and keeps the text the person saw, with the note", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Partial" }], "max_tokens"));
    const r = await run();
    expect(r.error).toContain("incomplete");
    // the question stays, and the answer is the cut-off text plus the note — one assistant turn
    expect(r.added.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    const content = r.added[2].content as { type: string; text: string }[];
    expect(content.map((b) => b.text)).toEqual(["Partial", expect.stringContaining("This answer did not finish: The answer reached its length limit")]);
    expect(displayTurns(r.added as never).at(-1)).toMatchObject({ role: "assistant", text: expect.stringContaining("Partial") });
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
  it("answers with what it has once most of the time is spent, instead of running out", async () => {
    read.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 120)); return { ok: true, text: "Facts" }; });
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use")).mockReturnValueOnce(done());
    const result = await run({ timeoutMs: 150 });
    expect(result.error).toBeUndefined();
    expect(h.stream).toHaveBeenCalledTimes(2);
    // the second call may only answer, and is told why
    expect(h.stream.mock.calls[1][0].tool_choice).toEqual({ type: "none" });
    const sent = h.stream.mock.calls[1][0].messages;
    expect(JSON.stringify(sent.at(-1).content)).toContain("nearly up");
    expect(JSON.stringify(result.added)).toContain("nearly up");
  });
  it("never runs a late write when the final call should only answer", async () => {
    h.stream.mockReturnValueOnce(reply([use("a")], "tool_use")).mockReturnValueOnce(reply([use("b", "write_test")], "tool_use"));
    expect((await run({ maxCalls: 2 })).error).toContain("work limit");
    expect(h.write).not.toHaveBeenCalled();
  });
});
