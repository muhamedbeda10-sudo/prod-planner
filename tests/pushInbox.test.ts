import { beforeEach, describe, expect, it, vi } from "vitest";

// Web Push and the inbox (lib/server/push.ts, lib/server/inbox.ts): the key
// pair made once and kept encrypted, devices that are gone dropped, only the
// real push services posted to, and an inbox row for every active person
// with a push on top.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      pushKeys: { findUnique: fn(), create: fn(), deleteMany: fn() },
      pushSubscription: { findMany: fn(), update: fn(), deleteMany: fn() },
      aiInboxItem: { create: fn(), update: fn() },
      user: { findFirst: fn(), findMany: fn() },
      $transaction: fn(),
    },
    webpush: { generateVAPIDKeys: fn(), sendNotification: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("web-push", () => ({ default: h.webpush }));

import { encryptSecret } from "@/lib/server/ai/secret";
import { pushEndpointOk, pushPublicKey, pushTo, readSubscription } from "@/lib/server/push";
import { deliverToInbox } from "@/lib/server/inbox";
import { inboxPreview } from "@/lib/domain/inbox";

const device = (id: number, o: Record<string, unknown> = {}) => ({ id, userId: 1, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "p", auth: "a", failures: 0, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL ??= "postgresql://x:y@localhost:5432/z";
  delete process.env.PUSH_SUBJECT;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  h.prisma.pushKeys.findUnique.mockResolvedValue({ id: 1, publicKey: "PUB", privateKeyEnc: encryptSecret("PRIV") });
  h.prisma.user.findFirst.mockResolvedValue({ email: "owner@atc.example" });
  h.prisma.pushSubscription.update.mockResolvedValue({});
  h.prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
  h.prisma.$transaction.mockResolvedValue([]);
});

describe("the key pair", () => {
  it("is made once, kept with the private half encrypted", async () => {
    h.prisma.pushKeys.findUnique.mockResolvedValueOnce(null);
    h.webpush.generateVAPIDKeys.mockReturnValue({ publicKey: "NEWPUB", privateKey: "NEWPRIV" });
    expect(await pushPublicKey()).toBe("NEWPUB");
    const stored = h.prisma.pushKeys.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ id: 1, publicKey: "NEWPUB" });
    expect(stored.privateKeyEnc).toMatch(/^v1:/);
    expect(stored.privateKeyEnc).not.toContain("NEWPRIV");
  });

  it("unreadable, it is replaced — and every device, subscribed under the old key, has to turn notifications on again", async () => {
    h.prisma.pushKeys.findUnique.mockResolvedValueOnce({ id: 1, publicKey: "OLD", privateKeyEnc: "v1:garbage" });
    h.webpush.generateVAPIDKeys.mockReturnValue({ publicKey: "NEWPUB", privateKey: "NEWPRIV" });
    expect(await pushPublicKey()).toBe("NEWPUB");
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({});
  });
});

describe("a device", () => {
  it("is accepted only from a real push service, with keys that look like keys", () => {
    expect(pushEndpointOk("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(pushEndpointOk("https://web.push.apple.com/QGh")).toBe(true);
    expect(pushEndpointOk("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(pushEndpointOk("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true);
    expect(pushEndpointOk("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(pushEndpointOk("https://evil.example/googleapis.com")).toBe(false);
    expect(pushEndpointOk("https://169.254.169.254/latest")).toBe(false);
    const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
    expect(readSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...keys });
    expect(readSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { ...keys, auth: "<script>" } })).toBeNull();
    expect(readSubscription({ endpoint: "https://intranet.local/x", keys })).toBeNull();
  });
});

describe("a push", () => {
  it("goes to every device of the person, signed with the app's key; gone devices are dropped, failing ones counted", async () => {
    h.prisma.pushSubscription.findMany.mockResolvedValue([device(1), device(2), device(3)]);
    h.webpush.sendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }));
    const r = await pushTo(1, { title: "Late welding", body: "3 orders", url: "/inbox?item=9" });
    expect(r).toEqual({ sent: 1, failed: 2 });
    const [sub, payload, opts] = h.webpush.sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: "p", auth: "a" } });
    expect(JSON.parse(payload)).toEqual({ title: "Late welding", body: "3 orders", url: "/inbox?item=9", tag: null });
    expect(opts.vapidDetails).toEqual({ subject: "mailto:owner@atc.example", publicKey: "PUB", privateKey: "PRIV" });
    expect(h.prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 2 } });
    expect(h.prisma.pushSubscription.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { failures: { increment: 1 } } });
  });

  it("drops a device that keeps failing", async () => {
    h.prisma.pushSubscription.findMany.mockResolvedValue([device(4, { failures: 9 })]);
    h.webpush.sendNotification.mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 500 }));
    await pushTo(1, { title: "t", body: "b", url: "/inbox" });
    expect(h.prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 4 } });
  });

  it("with no device does nothing at all", async () => {
    h.prisma.pushSubscription.findMany.mockResolvedValue([]);
    expect(await pushTo(1, { title: "t", body: "b", url: "/" })).toEqual({ sent: 0, failed: 0 });
    expect(h.prisma.pushKeys.findUnique).not.toHaveBeenCalled();
  });
});

describe("the inbox", () => {
  it("gets a row for every active person, pushed as a short line, marked when a push went", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    h.prisma.aiInboxItem.create.mockResolvedValue({ id: 31 });
    h.prisma.pushSubscription.findMany.mockResolvedValue([device(1)]);
    h.webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
    const ids = await deliverToInbox([
      { userId: 1, kind: "report", title: "Daily welding", body: "## Today\n| MO | Qty |\n|---|---|\n| 4471 | 3 |\n```chart\n{}\n```", automationId: 5 },
      { userId: 2, kind: "message", title: "Ignored", body: "inactive account" },
    ]);
    expect(ids).toEqual([31]);
    expect(h.prisma.aiInboxItem.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.webpush.sendNotification.mock.calls[0][1])).toMatchObject({ title: "Daily welding", body: "Today MO Qty 4471 3", url: "/inbox?item=31", tag: "inbox-31" });
    expect(h.prisma.aiInboxItem.update).toHaveBeenCalledWith({ where: { id: 31 }, data: { pushedAt: expect.any(Date) } });
  });

  it("reads a Markdown body as one plain line", () => {
    expect(inboxPreview("**3 orders** are late — see [the tracker](/tracker).")).toBe("3 orders are late — see the tracker.");
    expect(inboxPreview("x".repeat(300), 20)).toHaveLength(20);
  });
});
