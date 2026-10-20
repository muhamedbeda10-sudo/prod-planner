"use client";

import { formatDate } from "@/lib/domain/format";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WorkerDTO } from "@/lib/server/workers";
import { recordTankQa } from "@/app/tanks/actions";
import { TankWorkerPicker, NO_WORKER, type WorkerPick } from "@/components/TankWorkerPicker";

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
  const [worker, setWorker] = useState<WorkerPick>(NO_WORKER);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  function submit() {
    if (!result) {
      setMsg("Say the verdict: OK, or not OK.");
      return;
    }
    if (result === "not-ok" && !note.trim()) {
      setMsg("Write what is wrong with it.");
      return;
    }
    // the inspector is optional, but a number that matches nobody is a typo
    if (worker.empId.trim() && worker.id === null) {
      setMsg("No worker has that ID — clear the box to sign it off under your own account.");
      return;
    }
    const fd = new FormData();
    fd.set("serial", serial);
    fd.set("result", result);
    if (worker.id !== null) fd.set("workerId", String(worker.id));
    fd.set("note", note.trim());
    setMsg("");
    startTransition(async () => {
      const res = await recordTankQa(fd);
      if (res.ok) {
        setResult("");
        setNote("");
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to save");
      }
    });
  }

  return (
    <div className="border rounded-xl p-4 space-y-3">
      <h2 className="text-sm font-extrabold">🔍 Quality check</h2>

      {last && (
        <div className={`pill ${last.result === "ok" ? "pill-ok" : "pill-bad"}`}>
          Last check: {last.result === "ok" ? "OK" : "Not OK"} · {formatDate(last.dateISO)}
          {last.by ? ` · ${last.by}` : ""}
        </div>
      )}
      {last?.note && <p className="text-sm">{last.note}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setResult("ok")}
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-xs font-bold border ${result === "ok" ? "bg-ok-fill text-white border-transparent" : "hover:bg-ok-bg"}`}
        >
          ✓ OK
        </button>
        <button
          type="button"
          onClick={() => setResult("not-ok")}
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-xs font-bold border ${result === "not-ok" ? "bg-bad-fg text-white border-transparent" : "text-bad-fg hover:bg-bad-bg"}`}
        >
          ✗ Not OK
        </button>
        <TankWorkerPicker
          workers={inspectors}
          value={worker}
          onChange={setWorker}
          disabled={pending}
          label="Inspector ID"
          emptyHint=""
        />
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={result === "not-ok" ? "What is wrong? (required)" : "Note (optional)"}
        className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
        disabled={pending}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md px-4 py-1.5 text-xs font-bold text-white bg-brand-fill hover:bg-brand-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Record the check"}
        </button>
        {msg && <span className="text-[11px] text-bad-fg">{msg}</span>}
      </div>
    </div>
  );
}
