import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoll } from "./poll";

// The loop with fake timers and a stand-in for the page's visibility — no
// browser needed: the loop touches only visibilityState, the visibility
// event and the window's timers.

let visibility: "visible" | "hidden";
let onVis: (() => void) | undefined;
const doc = {
  get visibilityState() {
    return visibility;
  },
  addEventListener: vi.fn((_: string, f: () => void) => {
    onVis = f;
  }),
  removeEventListener: vi.fn(),
};
const setVisibility = (v: typeof visibility) => {
  visibility = v;
  onVis?.();
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  onVis = undefined;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const pace = { visibleMs: 30_000, hiddenMs: 120_000 };

describe("a page's poll loop", () => {
  it("asks after the first wait, then at the visible pace", async () => {
    const ask = vi.fn(async () => {});
    startPoll(ask, pace, 1_200);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(ask).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("slows to the hidden pace out of sight, counted from the last ask", async () => {
    const ask = vi.fn(async () => {});
    startPoll(ask, pace);
    await vi.advanceTimersByTimeAsync(0); // the first ask
    await vi.advanceTimersByTimeAsync(5_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(114_999); // 120 s after the ask, not after hiding
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("asks nothing out of sight when told so, and catches up at once on a stale return", async () => {
    const ask = vi.fn(async () => {});
    startPoll(ask, { visibleMs: 5_000, hiddenMs: null });
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(ask).toHaveBeenCalledTimes(1);
    setVisibility("visible"); // the last answer is an hour old
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000); // and the loop is back
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("does not ask twice on a quick switch away and back, and keeps its cadence", async () => {
    const ask = vi.fn(async () => {});
    startPoll(ask, pace);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000); // 30 s after the first ask, not 30 s after the return
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("never overlaps two asks: a return during a slow ask waits for it", async () => {
    let finish!: () => void;
    const ask = vi.fn(() => new Promise<void>((r) => (finish = r)));
    startPoll(ask, pace);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000); // in flight longer than the pace
    setVisibility("hidden");
    setVisibility("visible");
    expect(ask).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2); // the pace was already up, so the next ask follows at once
  });

  it("keeps going when an ask fails", async () => {
    const ask = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    startPoll(ask, pace);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("stops for good, an ask in flight included, and lets go of the visibility event", async () => {
    let finish!: () => void;
    const ask = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = startPoll(ask, pace);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(doc.removeEventListener).toHaveBeenCalledWith("visibilitychange", onVis);
    setVisibility("visible"); // a late event after stop must not wake it
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
