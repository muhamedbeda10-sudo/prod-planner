"use client";

import { useId, useMemo, useState } from "react";
import type { WorkerDTO } from "@/lib/server/workers";
import { normalizeEmpId } from "@/lib/domain/tanks";

// "Who did this?" — answered by TYPING THE BADGE NUMBER, never by hunting for a
// name in a long list. Names on the workforce sheet repeat, run to four words
// and are easy to mis-pick under a helmet; the number on the badge is short,
// unique and already in the man's hand.
//
// The confirmation is the whole point: the moment the number matches, his name
// appears next to the box. Nothing is saved on the strength of a number alone —
// the person recording it reads the name back first.
//
// Matching happens against the list the page already loaded, so it is instant
// with no round-trip. The server re-checks the same rules before writing, so a
// list that has gone stale (someone deactivated meanwhile) is still caught.

export interface WorkerPick {
  /** The database id the actions expect, or null while nothing valid is typed. */
  id: number | null;
  empId: string;
}

export function TankWorkerPicker({
  workers,
  value,
  onChange,
  disabled,
  label = "Worker ID",
  className = "",
  emptyHint = "No names on file — the admin adds them under Production Workers.",
}: {
  /** Active workers of this stage; the picker never matches outside them. */
  workers: WorkerDTO[];
  value: WorkerPick;
  onChange: (pick: WorkerPick) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  emptyHint?: string;
}) {
  const listId = useId();
  const [touched, setTouched] = useState(false);

  const byEmpId = useMemo(() => {
    const m = new Map<string, WorkerDTO>();
    for (const w of workers) m.set(normalizeEmpId(w.empId), w);
    return m;
  }, [workers]);

  const typed = normalizeEmpId(value.empId);
  const match = typed ? byEmpId.get(typed) ?? null : null;
  // only complain once they have actually typed something and moved on
  const unknown = touched && typed.length > 0 && !match;

  function handle(raw: string) {
    const empId = raw;
    const hit = byEmpId.get(normalizeEmpId(raw)) ?? null;
    onChange({ id: hit?.id ?? null, empId });
  }

  if (workers.length === 0) {
    return emptyHint ? <span className="text-[11px] text-bad-fg whitespace-normal">{emptyHint}</span> : null;
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        list={listId}
        value={value.empId}
        onChange={(e) => handle(e.target.value)}
        onBlur={() => setTouched(true)}
        disabled={disabled}
        placeholder={label}
        aria-label={label}
        title={label}
        className={`w-24 border rounded-md px-1.5 py-1 text-center font-bold tabnum ltr ${
          match ? "border-[var(--ok-fg)]" : unknown ? "border-[var(--bad-fg)]" : ""
        }`}
      />
      {/* typing a digit or two narrows the list — browsing stays possible
          without turning the control back into a name picker */}
      <datalist id={listId}>
        {workers.map((w) => (
          <option key={w.id} value={w.empId} label={`${w.empId} — ${w.name}`} />
        ))}
      </datalist>

      {match ? (
        <span
          className="pill pill-ok whitespace-nowrap max-w-52 overflow-hidden text-ellipsis"
          title={
            [match.name, match.jobTitle, match.stamp ? `stamp ${match.stamp}` : null]
              .filter(Boolean)
              .join(" · ")
          }
        >
          ✓ {match.name}
          {match.stamp ? ` · stamp ${match.stamp}` : ""}
        </span>
      ) : unknown ? (
        <span className="pill pill-bad whitespace-nowrap">✗ No worker with this ID</span>
      ) : (
        <span className="text-[11px] text-muted whitespace-nowrap">enter the ID</span>
      )}
    </span>
  );
}

/** The empty value — handy so callers do not repeat the shape. */
export const NO_WORKER: WorkerPick = { id: null, empId: "" };
