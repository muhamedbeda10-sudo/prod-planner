import { describe, expect, it, vi } from "vitest";
import { readAiStream } from "@/lib/aiStream";

function stream(text: string, bytes = 3) {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < data.length; i += bytes) controller.enqueue(data.slice(i, i + bytes));
    controller.close();
  } });
}

describe("AI answer transport", () => {
  it("handles split Arabic, blank lines and a final event without a newline", async () => {
    const onEvent = vi.fn();
    const body = stream('\n{"type":"text","delta":"إنتاج النهارده"}\n{"type":"done","costUsd":0.01}', 1);
    await readAiStream(body, onEvent);
    expect(onEvent.mock.calls.map(([e]) => e)).toEqual([{ type: "text", delta: "إنتاج النهارده" }, { type: "done", costUsd: 0.01 }]);
    expect(body.locked).toBe(false);
  });
  it("does not call a disconnected partial answer complete", async () => {
    await expect(readAiStream(stream('{"type":"text","delta":"part"}\n'), vi.fn())).rejects.toThrow("before the answer finished");
  });
  it("rejects malformed events and releases the reader", async () => {
    const body = stream('{"delta":"wrong shape"}\n');
    await expect(readAiStream(body, vi.fn())).rejects.toThrow("could not be read");
    expect(body.locked).toBe(false);
  });
  it("passes a server's persistence failure to the UI", async () => {
    const onEvent = vi.fn();
    await readAiStream(stream('{"type":"done","error":"Could not save"}\n'), onEvent);
    expect(onEvent).toHaveBeenCalledWith({ type: "done", error: "Could not save" });
  });
  it("rejects contradictory events after completion", async () => {
    await expect(readAiStream(stream('{"type":"done"}\n{"type":"text","delta":"late"}\n'), vi.fn())).rejects.toThrow("after the answer finished");
  });
});
