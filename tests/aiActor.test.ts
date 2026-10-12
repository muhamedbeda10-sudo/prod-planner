import { describe, expect, it, vi } from "vitest";

// Inside runAsActor every action's "who is asking" is the person the
// assistant acts for, marked as the assistant; outside it, the session.

const h = vi.hoisted(() => ({ cookie: undefined as string | undefined, session: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { session: { findUnique: vi.fn(async () => h.session) } } }));

import type { User } from "@prisma/client";
import { getCurrentUser, requirePerm } from "@/lib/server/auth";
import { runAsActor } from "@/lib/server/actor";

const sara = { id: 7, name: "Sara", perms: "tracker.status", isAdmin: false, isOwner: false, active: true } as User;

describe("acting for someone", () => {
  it("answers getCurrentUser with the person, marked, and checks THEIR permissions", async () => {
    expect(await getCurrentUser()).toBeNull();
    await runAsActor(sara, "ai", async () => {
      expect((await getCurrentUser())?.name).toBe("Sara (AI)");
      expect((await requirePerm("tracker.status")).user?.id).toBe(7);
      expect((await requirePerm("tracker.qty")).error).toContain("permission");
    });
    await runAsActor(sara, "automation", async () => {
      expect((await getCurrentUser())?.name).toBe("Sara (AI automation)");
    });
    // and nothing is left behind once it returns
    expect(await getCurrentUser()).toBeNull();
  });
});
