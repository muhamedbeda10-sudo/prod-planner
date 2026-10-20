import { describe, expect, it } from "vitest";
import { IDLE_RELOAD_MS, RELOAD_GUARD_MS, newerVersion, updateStep, type UpdateMoment } from "./appVersion";

const at: UpdateMoment = { navigated: false, idleMs: 0, busy: false, sinceReloadMs: null };

describe("newerVersion", () => {
  it("names the server's version only when it differs from the page's own", () => {
    expect(newerVersion("dpl_a", { version: "dpl_b" })).toBe("dpl_b");
    expect(newerVersion("dpl_a", { version: "dpl_a" })).toBeNull();
  });

  it("ignores answers that are not a version — a login page, an error, an empty build", () => {
    expect(newerVersion("dpl_a", null)).toBeNull();
    expect(newerVersion("dpl_a", "<html>")).toBeNull();
    expect(newerVersion("dpl_a", {})).toBeNull();
    expect(newerVersion("dpl_a", { version: 3 })).toBeNull();
    expect(newerVersion("dpl_a", { version: "  " })).toBeNull();
  });

  it("never asks a page that does not know its own version to update", () => {
    expect(newerVersion("", { version: "dpl_b" })).toBeNull();
  });
});

describe("updateStep", () => {
  it("only offers the Reload while someone is using the page", () => {
    expect(updateStep(at)).toBe("offer");
    expect(updateStep({ ...at, idleMs: IDLE_RELOAD_MS - 1 })).toBe("offer");
  });

  it("reloads on the next page, or once nobody has touched it for a while", () => {
    expect(updateStep({ ...at, navigated: true })).toBe("reload");
    expect(updateStep({ ...at, idleMs: IDLE_RELOAD_MS })).toBe("reload");
  });

  it("never reloads under an open dialog or a box with something typed in it — not even on the next page", () => {
    expect(updateStep({ ...at, busy: true, idleMs: IDLE_RELOAD_MS * 3 })).toBe("offer");
    // the assistant's, chat and inbox panels stay open from page to page
    expect(updateStep({ ...at, busy: true, navigated: true })).toBe("offer");
  });

  it("does not reload again right after reloading for a version — only offers it", () => {
    expect(updateStep({ ...at, navigated: true, sinceReloadMs: RELOAD_GUARD_MS - 1 })).toBe("offer");
    expect(updateStep({ ...at, idleMs: IDLE_RELOAD_MS, sinceReloadMs: 0 })).toBe("offer");
    expect(updateStep({ ...at, idleMs: IDLE_RELOAD_MS, sinceReloadMs: RELOAD_GUARD_MS })).toBe("reload");
  });

  it("treats a reload time from the future (a clock set back) as no reload", () => {
    expect(updateStep({ ...at, navigated: true, sinceReloadMs: -5_000 })).toBe("reload");
  });
});
