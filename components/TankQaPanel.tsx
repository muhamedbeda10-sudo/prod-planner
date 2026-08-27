"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WorkerDTO } from "@/lib/server/workers";
import { recordTankQa } from "@/app/tanks/actions";
import { TankWorkerSelect } from "@/components/TankWorkerSelect";

// Quality's half of the tank page: scan the sticker, read what the tank went
// through, then sign it off. "Not OK" always needs a note — that note is the
// only thing anyone downstream has to go on.

export function TankQaPanel({
  serial,
  inspectors,
  last,
}: {
  serial: string;
  inspectors: WorkerDTO[];
  last: { result: "ok" | "not-ok"; by: string | null; dateISO: string; note: string | null } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<"ok" | "not-ok" | "">("");
  const [worker, setWorker] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  function submit() {
    if (!result) {
      setMsg("قول النتيجة: تمام ولا مش تمام.");
      return;
    }
    if (result === "not-ok" && !note.trim()) {
      setMsg("اكتب المشكلة اللى شوفتها.");
      return;
    }
    const fd = new FormData();
    fd.set("serial", serial);
    fd.set("result", result);
    if (worker) fd.set("workerId", worker);
    fd.set("note", note.trim());
    setMsg("");
    startTransition(async () => {
      const res = await recordTankQa(fd);
      if (res.ok) {
        setResult("");
        setNote("");
        router.refresh();
      } else {
        setMsg(res.error ?? "فشل الحفظ");
      }
    });
  }

  return (
    <div className="border rounded-xl p-4 space-y-3">
      <h2 className="text-sm font-extrabold">🔍 فحص الجودة</h2>

      {last && (
        <div className={`pill ${last.result === "ok" ? "pill-ok" : "pill-bad"}`}>
          آخر فحص: {last.result === "ok" ? "تمام" : "مش تمام"} · {last.dateISO}
          {last.by ? ` · ${last.by}` : ""}
        </div>
      )}
      {last?.note && <p className="text-sm">{last.note}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setResult("ok")}
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-xs font-bold border ${result === "ok" ? "bg-ok-fg text-white border-transparent" : "hover:bg-ok-bg"}`}
        >
          ✓ تمام
        </button>
        <button
          type="button"
          onClick={() => setResult("not-ok")}
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-xs font-bold border ${result === "not-ok" ? "bg-bad-fg text-white border-transparent" : "text-bad-fg hover:bg-bad-bg"}`}
        >
          ✗ مش تمام
        </button>
        <TankWorkerSelect
          workers={inspectors}
          value={worker}
          onChange={setWorker}
          disabled={pending}
          placeholder="مين اللى فحص؟ (اختياري)"
          className="min-w-44"
          emptyHint=""
        />
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={result === "not-ok" ? "المشكلة إيه؟ (إجباري)" : "ملاحظة (اختياري)"}
        className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
        disabled={pending}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md px-4 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? "بيحفظ…" : "سجّل الفحص"}
        </button>
        {msg && <span className="text-[11px] text-bad-fg">{msg}</span>}
      </div>
    </div>
  );
}
