import { beforeEach, describe, expect, it, vi } from "vitest";

// Signing out of this device (lib/signOut.ts): the browser's push
// subscription is dropped first, and the session ends whatever that answers —
// a device with no notifications, or a browser that refuses, still signs out.

const h = vi.hoisted(() => ({ turnPushOff: vi.fn(), logoutAction: vi.fn() }));

vi.mock("@/app/login/actions", () => ({ logoutAction: h.logoutAction }));
vi.mock("@/lib/pushClient", () => ({ turnPushOff: h.turnPushOff }));

import { signOut } from "@/lib/signOut";

beforeEach(() => {
  vi.clearAllMocks();
  h.logoutAction.mockResolvedValue(undefined);
});

describe("signOut", () => {
  it("turns push off first, then ends the session", async () => {
    h.turnPushOff.mockResolvedValue(undefined);
    await signOut();
    expect(h.turnPushOff).toHaveBeenCalledTimes(1);
    expect(h.logoutAction).toHaveBeenCalledTimes(1);
    expect(h.turnPushOff.mock.invocationCallOrder[0]).toBeLessThan(h.logoutAction.mock.invocationCallOrder[0]);
  });

  it("still ends the session when turning push off is refused", async () => {
    h.turnPushOff.mockRejectedValue(new Error("The browser refused"));
    await expect(signOut()).resolves.toBeUndefined();
    expect(h.logoutAction).toHaveBeenCalledTimes(1);
  });
});
