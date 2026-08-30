"use client";

import type { WorkerDTO } from "@/lib/server/workers";

// The "who did this?" dropdown, shared by welding, the leak test and painting.
// When the list is empty it says so instead of rendering an unusable select —
// that is the admin's cue to fill in Admin → Workers.

export function TankWorkerSelect({
  workers,
  value,
  onChange,
  disabled,
  placeholder = "Who did it?",
  className = "",
  emptyHint = "No names on file — the admin adds them under Production Workers.",
}: {
  workers: WorkerDTO[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  emptyHint?: string;
}) {
  if (workers.length === 0) {
    return <span className="text-[11px] text-bad-fg whitespace-normal">{emptyHint}</span>;
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`border rounded-md px-1.5 py-1 text-xs font-semibold bg-surface ${className}`}
      title={placeholder}
    >
      <option value="">{placeholder}</option>
      {workers.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
