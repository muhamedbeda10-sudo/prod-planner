import { describe, it, expect, vi } from "vitest";
import type { User } from "@prisma/client";

// auth.ts pulls in server-only, next/headers and the Prisma client at module
// load. None are needed by the pure crypto / permission helpers under test, so
// stub them out to keep these unit tests hermetic (no cookie store, no DB).
// `server-only` throws unless bundled under React's react-server condition,
// which vitest does not set — so it must be mocked away.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { hashPassword, verifyPassword, hasPerm, canEditDept, userPerms } from "@/lib/server/auth";

function mkUser(over: Partial<User> = {}): User {
  return {
    id: 1,
    email: "user@example.com",
    name: "Test User",
    passwordHash: "",
    isAdmin: false,
    perms: "",
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as User;
}

describe("password hashing (scrypt, stored as salt:hash hex)", () => {
  it("round-trips the correct password", () => {
    const stored = hashPassword("s3cret-pw");
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // 16-byte salt : 64-byte hash
    expect(verifyPassword("s3cret-pw", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("right-password");
    expect(verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("is salted — the same password hashes to a different value each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored values instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false); // no separator
    expect(verifyPassword("x", "onlysalt")).toBe(false); // missing hash
    expect(verifyPassword("x", "salt:")).toBe(false); // empty hash
  });
});

describe("permission checks", () => {
  it("an admin follows their ticks like everyone else", () => {
    const admin = mkUser({ isAdmin: true, perms: "cut.edit" });
    expect(hasPerm(admin, "cut.edit")).toBe(true);
    // unticked: not allowed, admin or not
    expect(hasPerm(admin, "tracker.delivered")).toBe(false);
    expect(canEditDept(admin, "Welding")).toBe(false);
  });

  it("a key outside the catalog (nothing to tick) stays admin-only", () => {
    expect(hasPerm(mkUser({ isAdmin: true, perms: "" }), "not.a.key")).toBe(true);
    expect(hasPerm(mkUser({ perms: "cut.edit" }), "not.a.key")).toBe(false);
  });

  it("a non-admin is gated strictly by their perms CSV", () => {
    const u = mkUser({ perms: "cut.edit,tracker.weld" });
    expect(hasPerm(u, "cut.edit")).toBe(true);
    expect(hasPerm(u, "tracker.weld")).toBe(true);
    expect(hasPerm(u, "painting.edit")).toBe(false);
  });

  it("canEditDept maps a dept to its <dept>.edit key", () => {
    const u = mkUser({ perms: "welding.edit" });
    expect(canEditDept(u, "Welding")).toBe(true); // welding.edit
    expect(canEditDept(u, "Cut")).toBe(false); // needs cut.edit
  });

  it("userPerms drops unknown keys", () => {
    const set = userPerms(mkUser({ perms: "cut.edit,bogus.key" }));
    expect(set.has("cut.edit")).toBe(true);
    expect(set.has("bogus.key")).toBe(false);
  });

  it("userPerms expands the retired tracker.edit key to its successors", () => {
    const set = userPerms(mkUser({ perms: "tracker.edit" }));
    expect(set.has("tracker.status")).toBe(true);
    expect(set.has("tracker.components")).toBe(true);
    expect(set.has("tracker.qty")).toBe(true);
  });
});
