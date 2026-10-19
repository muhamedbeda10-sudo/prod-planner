import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- module mocks ----
// vi.mock is hoisted above the file, so any variable a factory references must
// be created with vi.hoisted (also hoisted) to avoid a TDZ error.
const { findUnique, redirect, createSession, failures } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  // failed sign-ins: count() answers how many lie in the window
  failures: { count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  // redirect() throws in Next (a control-flow signal); mirror that so we can
  // assert the success path actually reaches it.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  createSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique }, loginFailure: failures, $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops) },
}));
vi.mock("next/navigation", () => ({ redirect }));
// keep the real crypto helpers, but stub the session/cookie writers
vi.mock("@/lib/server/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/server/auth")>();
  return { ...actual, createSession, destroySession: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: async () => ({ get: (n: string) => (n === "x-forwarded-for" ? "41.33.1.2" : null) }),
}));

import { loginAction } from "@/app/login/actions";
import { hashPassword } from "@/lib/server/auth";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  findUnique.mockReset();
  createSession.mockReset();
  redirect.mockClear();
  failures.count.mockReset().mockResolvedValue(0);
  failures.create.mockReset().mockResolvedValue({});
  failures.deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("loginAction", () => {
  it("asks for both fields when either is missing", async () => {
    const res = await loginAction(form({ email: "", password: "" }));
    expect(res).toEqual({ ok: false, error: "Enter your email and password." });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("gives the same generic error for an unknown email (no user enumeration)", async () => {
    findUnique.mockResolvedValue(null);
    const res = await loginAction(form({ email: "nope@example.com", password: "whatever" }));
    expect(res).toEqual({ ok: false, error: "Wrong email or password." });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects a wrong password with the same generic error", async () => {
    findUnique.mockResolvedValue({
      id: 7,
      email: "real@example.com",
      passwordHash: hashPassword("correct-horse"),
      active: true,
    });
    const res = await loginAction(form({ email: "real@example.com", password: "wrong" }));
    expect(res).toEqual({ ok: false, error: "Wrong email or password." });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("blocks a deactivated account even with the right password", async () => {
    findUnique.mockResolvedValue({
      id: 8,
      email: "gone@example.com",
      passwordHash: hashPassword("right-pw"),
      active: false,
    });
    const res = await loginAction(form({ email: "gone@example.com", password: "right-pw" }));
    expect(res).toEqual({ ok: false, error: "This account is deactivated — ask the admin." });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a session and redirects home on valid credentials", async () => {
    findUnique.mockResolvedValue({
      id: 42,
      email: "ok@example.com",
      passwordHash: hashPassword("let-me-in"),
      active: true,
    });
    // redirect throws by design — the action never returns on success
    await expect(loginAction(form({ email: "ok@example.com", password: "let-me-in" }))).rejects.toThrow(
      "NEXT_REDIRECT:/",
    );
    expect(createSession).toHaveBeenCalledWith(42);
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("counts a wrong password against the account and the address", async () => {
    findUnique.mockResolvedValue(null);
    await loginAction(form({ email: "Real@Example.com", password: "guess" }));
    expect(failures.create).toHaveBeenCalledWith({ data: { email: "real@example.com", ip: "41.33.1.2" } });
  });

  it("waits after too many wrong passwords, before checking any password", async () => {
    failures.count.mockResolvedValue(8);
    findUnique.mockResolvedValue({ id: 42, email: "ok@example.com", passwordHash: hashPassword("let-me-in"), active: true });
    const res = await loginAction(form({ email: "ok@example.com", password: "let-me-in" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Too many wrong passwords/);
    expect(findUnique).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("forgives the account's failures from that address once it signs in", async () => {
    failures.count.mockResolvedValue(3);
    findUnique.mockResolvedValue({ id: 42, email: "ok@example.com", passwordHash: hashPassword("let-me-in"), active: true });
    await expect(loginAction(form({ email: "ok@example.com", password: "let-me-in" }))).rejects.toThrow("NEXT_REDIRECT:/");
    expect(failures.deleteMany).toHaveBeenCalledWith({ where: { email: "ok@example.com", ip: "41.33.1.2" } });
  });

  it("normalizes the email (trim + lowercase) before the lookup", async () => {
    findUnique.mockResolvedValue(null);
    await loginAction(form({ email: "  MixedCase@Example.COM  ", password: "x" }));
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "mixedcase@example.com" } });
  });
});
