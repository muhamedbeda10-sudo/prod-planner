"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importHandoverAction } from "@/app/handover/actions";
import type { HandoverImportResult } from "@/lib/server/importHandover";

export function HandoverImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<HandoverImportResult | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setRes(null);
    startTransition(async () => {
      const r = await importHandoverAction(fd);
      setRes(r);
      if (r.ok) {
        router.refresh();
        inputRef.current?.form?.reset();
      }
    });
  }

  return (
    <details className="bg-surface border rounded-xl p-4" open>
      <summary className="font-bold cursor-pointer select-none">
        📥 Import handover from Excel <span className="explain text-xs text-muted font-normal">(adds new rows only — re-uploading the same file won&apos;t duplicate)</span>
      </summary>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-3">
        <input ref={inputRef} name="file" type="file" accept=".xlsx,.xlsm,.xls" required
          className="border rounded-md px-2 py-2 bg-surface text-sm w-full max-w-full sm:w-auto" />
        <button type="submit" disabled={pending} className="bg-brand-fill text-white font-bold rounded-md px-5 py-2 disabled:opacity-50">
          {pending ? "Importing…" : "Import & merge"}
        </button>
        <span className="explain text-xs text-muted">Columns (by header name): Date · DEPT · BOM · MO (optional) · Item · QTY · Week — data starts on row 2</span>
      </form>

      {res && !res.ok && (
        <div className="mt-3 space-y-2">
          <div className="bg-bad-bg text-bad-fg rounded-md px-3 py-2 text-sm font-semibold">
            {res.error}
            {res.invalid ? <> — {res.invalid} row(s) rejected:</> : null}
          </div>
          {res.issues && res.issues.length > 0 && (
            <ul className="bg-bad-bg/50 text-bad-fg rounded-md px-3 py-2 text-xs list-disc ml-5 space-y-0.5">
              {res.issues.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          )}
        </div>
      )}
      {res && res.ok && (
        <div className="mt-3 space-y-2">
          <div className="bg-ok-bg text-ok-fg rounded-md px-3 py-2 text-sm font-semibold">
            Added: <b>{res.added}</b> new · already present (skipped): <b>{res.skippedExisting}</b>
            {res.corrected ? <> · BOM corrected: <b>{res.corrected}</b></> : null}
            {res.invalid ? <> · invalid: <b>{res.invalid}</b></> : null}
          </div>
          {res.unknownBoms && res.unknownBoms.length > 0 && (
            <div className="bg-warn-bg text-warn-fg rounded-md px-3 py-2 text-xs">
              Unknown codes imported as-is — no order in the registry carries them: {res.unknownBoms.join(", ")}
            </div>
          )}
          {res.issues && res.issues.length > 0 && (
            <details className="text-xs text-muted">
              <summary>Skipped rows ({res.issues.length})</summary>
              <ul className="list-disc ml-5 mt-1">{res.issues.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </details>
  );
}
