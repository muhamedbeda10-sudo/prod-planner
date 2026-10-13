import { beforeEach, describe, expect, it, vi } from "vitest";

// A scenario the assistant shows on the person's Simulator travels from the
// tool's result to the chat as its own event, with the call it came from —
// the chat puts it on the screen or offers a button (components/AiChat.tsx).
// Against a stubbed SDK.

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
import type { AiTool, ReadResult } from "@/lib/server/ai/tools/types";

const ctx = { user: { id: 1, name: "Sara" } as User, hidden: new Set<string>(), now: new Date(), todayISO: "2026-10-12", conversationId: 5, automationId: null };
const scenario = { workersDelta: { Cut: 0, Welding: 2, ShotBlast: 0, Painting: 0 }, shiftHours: 11, workFridays: false, queue: ["A|TN"], splits: {}, holds: {}, downtimes: [] };

type Block = Record<string, unknown>;
const reply = (content: Block[], stop = "end_turn") => ({
  on: () => {},
  finalMessage: async () => ({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }),
});

const showTool = (result: ReadResult): AiTool =>
  ({ kind: "read", name: "show_on_simulator", title: "Putting it on the Simulator", description: "Shows it.", schema: { type: "object", properties: {}, additionalProperties: false }, run: async () => result }) as AiTool;

const question: AiMessageParam[] = [{ role: "user", content: [{ type: "text", text: "Two more welders on my screen" }] }, { role: "system", content: "context" }];

async function run(result: ReadResult) {
  const simulator = vi.fn();
  h.stream
    .mockReturnValueOnce(reply([{ type: "tool_use", id: "toolu_7", name: "show_on_simulator", input: {} }], "tool_use"))
    .mockReturnValueOnce(reply([{ type: "text", text: "It is on your Simulator." }]));
  const r = await ask({
    apiKey: "k", model: "claude-opus-5-5", history: [], question, tools: [showTool(result)], ctx,
    settings: { actionsPaused: false }, events: { status: () => {}, text: () => {}, simulator },
  });
  return { simulator, r };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a scenario for the person's Simulator", () => {
  it("goes to the chat with the call it came from, and the model reads the result as any other", async () => {
    const { simulator, r } = await run({ ok: true, text: "{\"screen\":\"On the person's Simulator now\"}", simulator: { scenario, label: "+2 Welding" } });
    expect(simulator).toHaveBeenCalledExactlyOnceWith({ toolUseId: "toolu_7", scenario, label: "+2 Welding" });
    const second = h.stream.mock.calls[1][0].messages as AiMessageParam[];
    expect(second[second.length - 1]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_7", content: "{\"screen\":\"On the person's Simulator now\"}" }] });
    expect(r.error).toBeUndefined();
  });

  it("never goes when the tool failed", async () => {
    const { simulator } = await run({ ok: false, text: "The scenario on the person's Simulator cannot be read.", simulator: { scenario, label: "+2 Welding" } });
    expect(simulator).not.toHaveBeenCalled();
  });
});
