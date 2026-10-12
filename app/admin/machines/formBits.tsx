"use client";

import { useState, useTransition } from "react";

// What the machines page's forms share: the input style, a server action run
// in a transition with its answer kept for display, and that answer's line.

export const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";

export interface ActionMsg {
  ok: boolean;
  text: string;
}

export function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionMsg | null>(null);
  function run(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
      if (res.ok) after?.();
    });
  }
  return { pending, msg, run };
}

export function Msg({ msg }: { msg: ActionMsg | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}
