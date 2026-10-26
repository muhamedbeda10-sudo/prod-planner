"use client";

// A question handed to the assistant from somewhere else on the page (a
// cockpit decision's "Ask the assistant", a right-click's "Ask AI"): kept
// here until the chat takes it — the chat may not be made yet (the window
// loads the first time it opens), or may be answering — and announced to a
// chat already there. The chat takes it into a new chat (so no what-if kept
// in an older one colours the answer). A plain hand-over is put in the box
// for the person to send: nothing is spent until they do. One handed with
// `explain` — the person picked "Ask AI" itself — is sent as it is taken, to
// explain only: the reading tools alone (the chat route's readOnly).

const EVENT = "ai:ask";

export interface HandedQuestion {
  question: string;
  explain: boolean;
}

let pending: HandedQuestion | null = null;

export function handToAssistant(question: string, opts: { explain?: boolean } = {}) {
  pending = { question, explain: !!opts.explain };
  window.dispatchEvent(new Event(EVENT));
}

/** The question waiting for the chat, taken (once). */
export function takeHandedQuestion(): HandedQuestion | null {
  const q = pending;
  pending = null;
  return q;
}

/** Told when a question is handed over; returns the unsubscribe. */
export function onHandedQuestion(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
