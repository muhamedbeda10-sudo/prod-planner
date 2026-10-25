import { describe, it, expect } from "vitest";
import {
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_ADDRESS,
  clientAddress,
  loginThrottled,
} from "./loginThrottle";

describe("loginThrottled", () => {
  it("lets a few mistakes through", () => {
    expect(loginThrottled({ account: 0, address: 0 })).toBe(false);
    expect(loginThrottled({ account: MAX_FAILURES_PER_ACCOUNT - 1, address: MAX_FAILURES_PER_ADDRESS - 1 })).toBe(false);
  });

  it("waits once one account has too many failures from one place", () => {
    expect(loginThrottled({ account: MAX_FAILURES_PER_ACCOUNT, address: MAX_FAILURES_PER_ACCOUNT })).toBe(true);
  });

  it("waits once one place has too many failures across accounts", () => {
    expect(loginThrottled({ account: 1, address: MAX_FAILURES_PER_ADDRESS })).toBe(true);
  });

  it("never counts one account from everywhere — a stranger cannot keep a colleague locked out", () => {
    // one failure from each of many places: no single place reaches its cap
    expect(loginThrottled({ account: 1, address: 1 })).toBe(false);
  });
});

describe("clientAddress", () => {
  const from = (h: Record<string, string>) => (n: string) => h[n] ?? null;

  it("takes the first hop the proxy forwarded when the proxy is trusted", () => {
    expect(clientAddress(from({ "x-forwarded-for": "41.33.1.2, 10.0.0.1" }), { trustProxy: true })).toBe("41.33.1.2");
  });

  it("falls back to x-real-ip, then to one shared bucket", () => {
    expect(clientAddress(from({ "x-real-ip": "41.33.1.9" }), { trustProxy: true })).toBe("41.33.1.9");
    expect(clientAddress(from({}), { trustProxy: true })).toBe("unknown");
  });

  it("ignores the forwarding headers without a trusted proxy (the client can type them)", () => {
    expect(clientAddress(from({ "x-forwarded-for": "41.33.1.2" }), { trustProxy: false })).toBe("unknown");
    expect(clientAddress(from({ "x-real-ip": "41.33.1.9" }), { trustProxy: false })).toBe("unknown");
    expect(clientAddress(from({}), { trustProxy: false })).toBe("unknown");
  });
});
