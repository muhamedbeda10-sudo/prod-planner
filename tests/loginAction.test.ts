import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- module mocks ----
// vi.mock is hoisted above the file, so any variable a factory references must
// be created with vi.hoisted (also hoisted) to avoid a TDZ error.
const { findUnique, redirect, createSession, failures, request } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  // failed sign-ins: count() answers how many lie in the window
  failures: { count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  // what the request claims about where it came from; tests change it per attempt
  request: { forwardedFor: "41.33.1.2" as string | null },
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
  headers: async () => ({ get: (n: string) => (n === "x-forwarded-for" ? request.forwardedFor : null) }),
}));

import { loginAction } from "@/app/login/actions";
import { hashPassword } from "@/lib/server/auth";
import { MAX_FAILURES_PER_ACCOUNT } from "@/lib/domain/loginThrottle";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// Most tests run as if behind a trusted proxy (Vercel), where the forwarded
// address is real; the untrusted case is exercised explicitly below.
const envBefore = { VERCEL: process.env.VERCEL, TRUST_PROXY: process.env.TRUST_PROXY };
function trustProxy(on: boolean) {
  delete process.env.VERCEL;
  if (on) process.env.TRUST_PROXY = "1";
  else delete process.env.TRUST_PROXY;
}
afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  trustProxy(true);
  request.forwardedFor = "41.33.1.2";
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

  it("never counts one account from everywhere — only per account and place, and per place", async () => {
    findUnique.mockResolvedValue(null);
    await loginAction(form({ email: "real@example.com", password: "guess" }));
    expect(failures.count).toHaveBeenCalledTimes(2);
    expect(failures.count).not.toHaveBeenCalledWith({ where: { email: "real@example.com", at: { gte: expect.any(Date) } } });
  });

  it("counts an over-long email under the same key its failures are kept under", async () => {
    findUnique.mockResolvedValue(null);
    const long = `${"a".repeat(250)}@example.com`;
    await loginAction(form({ email: long, password: "guess" }));
    const key = long.slice(0, 200);
    expect(failures.create).toHaveBeenCalledWith({ data: { email: key, ip: "41.33.1.2" } });
    expect(failures.count).toHaveBeenCalledWith({ where: { email: key, ip: "41.33.1.2", at: { gte: expect.any(Date) } } });
  });

  it("normalizes the email (trim + lowercase) before the lookup", async () => {
    findUnique.mockResolvedValue(null);
    await loginAction(form({ email: "  MixedCase@Example.COM  ", password: "x" }));
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "mixedcase@example.com" } });
  });
});

// Failures kept in memory so count() answers like the database would: the
// throttle then depends on which bucket each attempt really landed in.
function rememberFailures() {
  const rows: { email: string; ip: string; at: Date }[] = [];
  failures.create.mockImplementation(async ({ data }: { data: { email: string; ip: string } }) => {
    rows.push({ ...data, at: new Date() });
    return data;
  });
  failures.count.mockImplementation(
    async ({ where }: { where: { email?: string; ip?: string; at: { gte: Date } } }) =>
      rows.filter(
        (r) => (where.email === undefined || r.email === where.email) && (where.ip === undefined || r.ip === where.ip) && r.at >= where.at.gte,
      ).length,
  );
  return rows;
}

describe("loginAction against a guesser who changes his address", () => {
  it("behind a trusted proxy, counts each real address on its own — a stranger cannot lock the account for everyone", async () => {
    const rows = rememberFailures();
    findUnique.mockResolvedValue(null);
    for (let i = 0; i < 30; i++) {
      request.forwardedFor = `10.0.${Math.floor(i / 256)}.${i % 256}`;
      const res = await loginAction(form({ email: "target@example.com", password: `guess-${i}` }));
      expect(res.error).toBe("Wrong email or password.");
    }
    expect(new Set(rows.map((r) => r.ip)).size).toBe(30);
    // the owner, from their own address, still gets in
    request.forwardedFor = "41.33.1.2";
    findUnique.mockResolvedValue({ id: 1, email: "target@example.com", passwordHash: hashPassword("right-pw"), active: true });
    await expect(loginAction(form({ email: "target@example.com", password: "right-pw" }))).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("on Vercel, trusts the forwarded address with no TRUST_PROXY set", async () => {
    trustProxy(false);
    process.env.VERCEL = "1"; // restored by afterEach
    findUnique.mockResolvedValue(null);
    request.forwardedFor = "10.9.8.7, 172.16.0.1";
    await loginAction(form({ email: "target@example.com", password: "guess" }));
    expect(failures.create).toHaveBeenCalledWith({ data: { email: "target@example.com", ip: "10.9.8.7" } });
    expect(failures.count).toHaveBeenCalledWith({ where: { ip: "10.9.8.7", at: { gte: expect.any(Date) } } });
  });

  it("without a trusted proxy, ignores the typed address so every attempt shares one bucket", async () => {
    trustProxy(false);
    const rows = rememberFailures();
    findUnique.mockResolvedValue(null);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) {
      request.forwardedFor = `10.0.0.${i}`;
      const res = await loginAction(form({ email: "target@example.com", password: `guess-${i}` }));
      expect(res.error).toBe("Wrong email or password.");
    }
    expect(rows.every((r) => r.ip === "unknown")).toBe(true);

    request.forwardedFor = "10.0.0.99";
    const res = await loginAction(form({ email: "target@example.com", password: "one-more" }));
    expect(res.error).toMatch(/Too many wrong passwords/);
    expect(findUnique).toHaveBeenCalledTimes(MAX_FAILURES_PER_ACCOUNT);
  });

  it("without a trusted proxy, a colleague elsewhere still cannot be locked out by a few guesses", async () => {
    trustProxy(false);
    rememberFailures();
    findUnique.mockResolvedValue(null);
    await loginAction(form({ email: "target@example.com", password: "guess" }));
    findUnique.mockResolvedValue({ id: 1, email: "target@example.com", passwordHash: hashPassword("right-pw"), active: true });
    await expect(loginAction(form({ email: "target@example.com", password: "right-pw" }))).rejects.toThrow("NEXT_REDIRECT:/");
    expect(failures.deleteMany).toHaveBeenCalledWith({ where: { email: "target@example.com", ip: "unknown" } });
  });
});
