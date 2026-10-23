import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ lock: vi.fn(), count: vi.fn(), conversation: vi.fn(), usage: vi.fn(), transaction: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: h.transaction } }));
import { reserveChatTurn } from "@/lib/server/ai/chatReservation";

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation((fn) => fn({ $queryRaw: h.lock, aiUsage: { count: h.count, create: h.usage }, aiConversation: { create: h.conversation } }));
  h.count.mockResolvedValue(0);
  h.conversation.mockResolvedValue({ id: 10, title: "Question", model: "model" });
  h.usage.mockResolvedValue({ id: 20 });
});
const input = { userId: 5, question: "Question", model: "model", existing: null, now: new Date("2026-10-24T10:00:00Z"), runningWindowMs: 330_000 };

describe("reserving an AI question", () => {
  it("locks this user before checking and reserving usage in the same transaction", async () => {
    expect(await reserveChatTurn(input)).toMatchObject({ conversation: { id: 10 }, usage: { id: 20 } });
    expect(h.lock.mock.calls[0][1]).toBe(5);
    expect(h.lock.mock.invocationCallOrder[0]).toBeLessThan(h.count.mock.invocationCallOrder[0]);
    expect(h.count.mock.invocationCallOrder[0]).toBeLessThan(h.usage.mock.invocationCallOrder[0]);
  });
  it("does not create another conversation or usage record while one is running", async () => {
    h.count.mockResolvedValue(1);
    expect(await reserveChatTurn(input)).toBeNull();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });
  it("preserves the existing chat's model", async () => {
    await reserveChatTurn({ ...input, existing: { id: 4, title: "Old chat", model: "old-model" } });
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ conversationId: 4, model: "old-model" }) });
  });
});
