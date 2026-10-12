import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent and the chat's photos (lib/server/ai/agent.ts): every call sends
// the files themselves (the expander's work), the turn kept is the one with
// the references, and a request the API refuses outright says so — so the
// chat can keep the question without the file it could not take. Against a
// stubbed SDK.

const h = vi.hoisted(() => ({ stream: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number;
    error: unknown;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.error = { error: { message } };
    }
  }
  class BadRequestError extends APIError {}
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class RateLimitError extends APIError {}
  class Anthropic {
    beta = { messages: { stream: h.stream } };
    static APIError = APIError;
    static BadRequestError = BadRequestError;
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static RateLimitError = RateLimitError;
  }
  return { default: Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import type { User } from "@prisma/client";
import { ask, questionMessages, type AiMessageParam } from "@/lib/server/ai/agent";

const ctx = { user: { id: 1, name: "Sara" } as User, hidden: new Set<string>(), now: new Date(), todayISO: "2026-10-12", conversationId: 5, automationId: null };
const REF = { type: "image", source: { type: "file", file_id: "aifile_12" } } as const;
const FILE = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } } as const;

/** What one call to the model answers. */
const answer = (text: string) => ({
  on: () => undefined,
  finalMessage: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
});

const expand = async (msgs: AiMessageParam[]) =>
  msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === "image" && b.source.type === "file" ? FILE : b)) } : m)) as AiMessageParam[];

const run = (o: Partial<Parameters<typeof ask>[0]> = {}) =>
  ask({
    apiKey: "k",
    model: "claude-opus-5-5",
    history: [],
    question: questionMessages("Take the welding figures off it", "context", undefined, [REF]),
    tools: [],
    ctx,
    settings: { actionsPaused: false },
    events: { status: () => {}, text: () => {} },
    expand,
    ...o,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the chat's photos", () => {
  it("go to the model as the files themselves, and are kept as references", async () => {
    h.stream.mockReturnValue(answer("Welding: 4 tanks."));
    const r = await run();
    const sent = h.stream.mock.calls[0][0].messages as AiMessageParam[];
    expect(sent[0].content).toEqual([FILE, { type: "text", text: "Take the welding figures off it" }]);
    expect(r.added[0].content).toEqual([REF, { type: "text", text: "Take the welding figures off it" }]);
    expect(r.error).toBeUndefined();
  });

  it("a request the API refuses outright is reported as such, the question kept", async () => {
    const refuse = () => {
      throw new (Anthropic as unknown as { BadRequestError: new (s: number, m: string) => Error }).BadRequestError(400, "Could not process image");
    };
    h.stream.mockImplementation(refuse);
    const r = await run();
    // the full request, then the plain one, then it gives up
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ badRequest: true, error: expect.stringContaining("Could not process image") });
    expect(r.added).toHaveLength(1);
    expect(r.added[0].role).toBe("user");
  });

  it("a refusal for any other reason does not say the request was bad", async () => {
    h.stream.mockImplementation(() => {
      throw new (Anthropic as unknown as { RateLimitError: new (s: number, m: string) => Error }).RateLimitError(429, "slow down");
    });
    const r = await run();
    expect(r.badRequest).toBeUndefined();
    expect(r.error).toContain("Too many requests");
  });
});
