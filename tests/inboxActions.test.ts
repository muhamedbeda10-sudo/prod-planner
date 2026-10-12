import { beforeEach, describe, expect, it, vi } from "vitest";

// A person's inbox actions (app/inbox/actions.ts): a message sent through the
// assistant — who may, to whom, how many — and taking it back, only one's own.

const h = vi.hoisted(() => ({
  prisma: { user: { findMany: vi.fn() }, aiInboxItem: { count: vi.fn(), deleteMany: vi.fn() } },
  me: null as null | { id: number; name: string },
  allowed: true,
  deliver: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: async () => h.me,
  requirePerm: async () => (h.allowed && h.me ? { user: h.me } : { error: "You do not have permission for this action — ask the admin." }),
}));
vi.mock("@/lib/server/push", () => ({ pushPublicKey: vi.fn(), readSubscription: vi.fn() }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliver, unreadInboxCount: vi.fn() }));

import { retractInboxMessages, sendInboxMessage } from "@/app/inbox/actions";

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const msg = { to: "9,10", title: "Tanks", body: "Start the 1000 kVA tanks first." };

beforeEach(() => {
  vi.clearAllMocks();
  h.me = { id: 7, name: "Sara (AI)" };
  h.allowed = true;
  h.prisma.user.findMany.mockResolvedValue([{ id: 9 }, { id: 10 }]);
  h.prisma.aiInboxItem.count.mockResolvedValue(0);
  h.deliver.mockResolvedValue([31, 32]);
});

describe("sendInboxMessage", () => {
  it("needs AI — automations, and goes to active people only, as from the sender", async () => {
    h.allowed = false;
    expect(await sendInboxMessage(form(msg))).toMatchObject({ ok: false });
    h.allowed = true;
    expect(await sendInboxMessage(form(msg))).toEqual({ ok: true, ids: [31, 32] });
    expect(h.deliver.mock.calls[0][0]).toEqual([
      { userId: 9, kind: "message", title: "Tanks", body: msg.body, fromName: "Sara (AI)", fromUserId: 7 },
      { userId: 10, kind: "message", title: "Tanks", body: msg.body, fromName: "Sara (AI)", fromUserId: 7 },
    ]);
    h.prisma.user.findMany.mockResolvedValue([{ id: 9 }]);
    expect(await sendInboxMessage(form(msg))).toEqual({ ok: false, error: "One of them is not an active user." });
  });

  it("will not reach phones more than sixty times an hour for one sender", async () => {
    h.prisma.aiInboxItem.count.mockResolvedValue(59);
    expect(await sendInboxMessage(form(msg))).toMatchObject({ ok: false, error: expect.stringContaining("60 messages in an hour") });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses an empty or oversized message", async () => {
    expect(await sendInboxMessage(form({ ...msg, title: " " }))).toMatchObject({ ok: false });
    expect(await sendInboxMessage(form({ ...msg, body: "x".repeat(4001) }))).toMatchObject({ ok: false });
    expect(await sendInboxMessage(form({ ...msg, to: "" }))).toMatchObject({ ok: false });
  });
});

describe("retractInboxMessages", () => {
  it("takes back only messages the sender sent by hand", async () => {
    h.prisma.aiInboxItem.deleteMany.mockResolvedValue({ count: 2 });
    expect(await retractInboxMessages([31, 32])).toEqual({ ok: true });
    expect(h.prisma.aiInboxItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [31, 32] }, kind: "message", automationId: null, fromUserId: 7 } });
  });
});
