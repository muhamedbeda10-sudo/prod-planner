import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's tools load when a question needs them (lib/server/ai/agent.ts):
// two are in the model's context from the first request, the rest wait for
// the API's tool search — without breaking a chat from before, a chat whose
// person has lost a tool since, or a turn the API pauses. Against a stubbed SDK.

const h = vi.hoisted(() => ({ stream: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/ai/changes", () => ({ handleWriteCall: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class BadRequestError extends APIError {}
  class Anthropic {
    beta = { messages: { stream: h.stream } };
    static APIError = APIError;
    static BadRequestError = BadRequestError;
    static AuthenticationError = class extends APIError {};
    static PermissionDeniedError = class extends APIError {};
    static RateLimitError = class extends APIError {};
  }
  return { default: Anthropic };
});

import type { User } from "@prisma/client";
import { ask, type AiMessageParam } from "@/lib/server/ai/agent";
import type { AiTool } from "@/lib/server/ai/tools/types";

const ctx = { user: { id: 1, name: "Sara" } as User, hidden: new Set<string>(), now: new Date(), todayISO: "2026-10-12", conversationId: 5, automationId: null };

const tool = (name: string, o: Partial<AiTool> = {}): AiTool =>
  ({ kind: "read", name, title: name, description: `The ${name} tool, described.`, schema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ ok: true, text: "[]" }), ...o }) as AiTool;
const TOOLS = [tool("query_database", { loaded: true }), tool("get_machine_board", { loaded: true }), tool("create_nest_run"), tool("record_output")];

type Block = Record<string, unknown>;
/** One call to the model: its blocks and why it stopped, and the stream events it fires. */
const reply = (content: Block[], stop = "end_turn", events: Block[] = []) => ({
  on: (name: string, f: (e: Block) => void) => {
    if (name === "streamEvent") for (const e of events) f(e);
  },
  finalMessage: async () => ({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }),
});

const question: AiMessageParam[] = [{ role: "user", content: [{ type: "text", text: "Put CF and TC of M1 on one sheet" }] }, { role: "system", content: "context" }];
const run = (o: Partial<Parameters<typeof ask>[0]> = {}) =>
  ask({ apiKey: "k", model: "claude-opus-5-5", history: [], question, tools: TOOLS, ctx, settings: { actionsPaused: false }, events: { status: () => {}, text: () => {} }, ...o });

const sentTools = (call = 0) => h.stream.mock.calls[call][0].tools as Block[];
const deferred = (call = 0) => sentTools(call).filter((t) => t.defer_loading).map((t) => t.name);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the tools a question starts with", () => {
  it("are the two always loaded and the search; the rest wait for it", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }]));
    await run();
    expect(sentTools()[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    expect(deferred()).toEqual(["create_nest_run", "record_output"]);
    // a deferred definition never carries a cache mark — the API refuses it
    expect(sentTools().some((t) => t.defer_loading && t.cache_control)).toBe(false);
  });

  it("need no search when every tool is loaded", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }]));
    await run({ tools: TOOLS.slice(0, 2) });
    expect(sentTools().map((t) => t.name)).toEqual(["query_database", "get_machine_board"]);
  });

  it("say what is happening while the model searches", async () => {
    const status = vi.fn();
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }], "end_turn", [{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25" } }]));
    await run({ events: { status, text: () => {} } });
    expect(status).toHaveBeenCalledWith("Finding the tools for it");
  });
});

describe("a chat already under way", () => {
  const searched = (names: string[]): AiMessageParam => ({
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "nest run" } },
      { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "tool_search_tool_search_result", tool_references: names.map((n) => ({ type: "tool_reference", tool_name: n })) } },
      { type: "tool_use", id: "toolu_1", name: names[0], input: {} },
    ],
  } as AiMessageParam);
  const result: AiMessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] };
  const done: AiMessageParam = { role: "assistant", content: [{ type: "text", text: "Prepared." }] };

  it("from before the search keeps the tools it called loaded — its calls are read against them", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }]));
    const old: AiMessageParam[] = [
      { role: "user", content: [{ type: "text", text: "Record it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_0", name: "record_output", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "ok" }] },
      done,
    ];
    await run({ history: old });
    expect(deferred()).toEqual(["create_nest_run"]);
  });

  it("keeps a tool its search found deferred — the API loads it from the find", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }]));
    await run({ history: [{ role: "user", content: [{ type: "text", text: "Nest them" }] }, searched(["create_nest_run"]), result, done] });
    expect(deferred()).toEqual(["create_nest_run", "record_output"]);
  });

  it("drops a find of a tool the person no longer has, and keeps the chat as it was", async () => {
    h.stream.mockReturnValue(reply([{ type: "text", text: "Done." }]));
    const history: AiMessageParam[] = [{ role: "user", content: [{ type: "text", text: "Nest them" }] }, searched(["create_nest_run", "delete_nest_run"]), result, done];
    const kept = JSON.stringify(history);
    await run({ history });
    const sent = h.stream.mock.calls[0][0].messages as AiMessageParam[];
    const find = (sent[1].content as unknown as Block[])[1] as { content: { tool_references: { tool_name: string }[] } };
    expect(find.content.tool_references.map((r) => r.tool_name)).toEqual(["create_nest_run"]);
    // the other messages go as they were, and the kept chat is untouched
    expect(sent[0]).toBe(history[0]);
    expect(JSON.stringify(history)).toBe(kept);
  });
});

describe("a paused turn", () => {
  it("is sent back as it is and the model carries on — both halves kept", async () => {
    const text = vi.fn();
    h.stream
      .mockReturnValueOnce(reply([{ type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "nest run" } }], "pause_turn"))
      .mockReturnValueOnce(reply([{ type: "text", text: "Found it." }]));
    const r = await run({ events: { status: () => {}, text } });
    expect(h.stream).toHaveBeenCalledTimes(2);
    const second = h.stream.mock.calls[1][0].messages as AiMessageParam[];
    expect(second[second.length - 1]).toEqual({ role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "nest run" } }] });
    expect(r.added.map((m) => m.role)).toEqual(["user", "system", "assistant", "assistant"]);
    expect(r.error).toBeUndefined();
  });
});
