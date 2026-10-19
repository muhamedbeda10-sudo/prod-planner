import { describe, it, expect } from "vitest";
import { MAX_FAILURES_PER_ACCOUNT, MAX_FAILURES_PER_ADDRESS, clientAddress, loginThrottled } from "./loginThrottle";

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
});

describe("clientAddress", () => {
  const from = (h: Record<string, string>) => (n: string) => h[n] ?? null;

  it("takes the first hop the platform forwarded", () => {
    expect(clientAddress(from({ "x-forwarded-for": "41.33.1.2, 10.0.0.1" }))).toBe("41.33.1.2");
  });

  it("falls back to x-real-ip, then to one shared bucket", () => {
    expect(clientAddress(from({ "x-real-ip": "41.33.1.9" }))).toBe("41.33.1.9");
    expect(clientAddress(from({}))).toBe("unknown");
  });
});
