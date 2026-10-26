"use client";

// A question handed to the assistant from somewhere else on the page (a
// cockpit decision's "Ask the assistant"): kept here until the chat takes
// it — the chat may not be made yet (the window loads the first time it
// opens), or may be answering — and announced to a chat already there. The
// chat takes it into a new chat (so no what-if kept in an older one colours
// the answer) and puts it in its box for the person to send: nothing is
// spent until they do.

const EVENT = "ai:ask";
let pending: string | null = null;

export function handToAssistant(question: string) {
  pending = question;
  window.dispatchEvent(new Event(EVENT));
}

/** The question waiting for the chat, taken (once). */
export function takeHandedQuestion(): string | null {
  const q = pending;
  pending = null;
  return q;
}

/** Told when a question is handed over; returns the unsubscribe. */
export function onHandedQuestion(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
