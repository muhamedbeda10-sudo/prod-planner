// Runs the nesting off the UI thread and reports progress.
import { nest } from "../engine/nesting/nest";
import { verifyLayout } from "../engine/nesting/verify";
import type { NestPartInput, NestSettings } from "../engine/nesting/types";

export interface WorkerRequest {
  parts: NestPartInput[];
  settings: NestSettings;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { parts, settings } = e.data;
  try {
    const result = nest(parts, settings, { onProgress: (p) => self.postMessage({ type: "progress", progress: p }) });
    const verification = verifyLayout(parts, result);
    self.postMessage({ type: "done", result, verification });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
