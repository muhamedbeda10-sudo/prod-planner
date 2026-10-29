"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TankDTO } from "@/lib/server/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { paintTanks, sendTankBackToWelding } from "@/app/tanks/actions";
import { TankWorkerPicker, NO_WORKER, type WorkerPick } from "@/components/TankWorkerPicker";

// Painting a tank is a per-piece job now: pick the tanks, pick the painter,
// save. Only tanks that PASSED the leak test are listed — that is the gate the
// new stage exists for, and it is why the plain quantity box is gone for tanks.
//
// "Select all" is the answer to painting a whole batch under one name without
// ticking twenty boxes; the individual ticks are there for the day two painters
// split the batch.

export function TankPaintPicker({
  tanks,
  painters,
  day,
  label,
  onDone,
}: {
  tanks: TankDTO[];
  painters: WorkerDTO[];
  day: string;
  /** What the panel is scoped to, e.g. "MO/35301-001 · TN". */
  label: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [worker, setWorker] = useState<WorkerPick>(NO_WORKER);
  const [msg, setMsg] = useState("");
  const [backFor, setBackFor] = useState<string | null>(null);

  const toggle = (serial: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(serial)) n.delete(serial);
      else n.add(serial);
      return n;
    });

  const allPicked = tanks.length > 0 && picked.size === tanks.length;
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(tanks.map((t) => t.serial)));

  function submit() {
    if (picked.size === 0) {
      setMsg("Pick the tanks that were painted.");
      return;
    }
    if (worker.id === null) {
      setMsg(worker.empId ? "No worker has that ID." : "Enter the ID of whoever painted them.");
      return;
    }
    const fd = new FormData();
    fd.set("serials", [...picked].join(","));
    fd.set("workerId", String(worker.id));
    fd.set("date", day);
    setMsg("");
    startTransition(async () => {
      const res = await paintTanks(fd);
      if (res.ok) {
        setPicked(new Set());
        onDone?.();
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to save");
      }
    });
  }

  function sendBack(serial: string, reason: string) {
    const fd = new FormData();
    fd.set("serial", serial);
    fd.set("reason", reason);
    setMsg("");
    startTransition(async () => {
      const res = await sendTankBackToWelding(fd);
      if (res.ok) {
        setBackFor(null);
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to save");
      }
    });
  }

  if (tanks.length === 0) {
    return (
      <div className="bg-surface border rounded-xl p-3 text-sm text-muted">
        No tank on {label} has passed the leak test yet. A tank cannot be painted until it does.
      </div>
    );
  }

  return (
    <div className="bg-surface border rounded-xl p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-extrabold">🛢 Tanks ready to paint — {label}</span>
        <button type="button" onClick={toggleAll} className="btn btn-secondary btn-sm" disabled={pending}>
          {allPicked ? "Clear selection" : `Select all (${tanks.length})`}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {tanks.map((t) => (
          <div key={t.serial} className="border rounded-lg px-2 py-1.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={picked.has(t.serial)}
                onChange={() => toggle(t.serial)}
                disabled={pending}
              />
              <code className="ltr font-bold tabnum text-sm">{t.serial}</code>
              <button
                type="button"
                onClick={() => { setBackFor(backFor === t.serial ? null : t.serial); setMsg(""); }}
                disabled={pending}
                className="ml-auto text-[11px] text-bad-fg hover:underline whitespace-nowrap"
                title="This tank is not sound — send it back to welding"
              >
                ↩ Send back
              </button>
            </label>
            <div className="text-[11px] text-muted mt-0.5">
              Passed {t.testedISO ?? "—"}
              {t.testedBy ? ` · ${t.testedBy}` : ""}
            </div>
            {backFor === t.serial && (
              <form
                className="mt-1.5 flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
                  if (!reason) { setMsg("Write the reason."); return; }
                  sendBack(t.serial, reason);
                }}
              >
                <input
                  name="reason"
                  required
                  placeholder="Why?"
                  className="flex-1 border rounded-md px-2 py-1 text-xs bg-surface"
                  disabled={pending}
                />
                <button type="submit" className="btn btn-secondary btn-sm text-bad-fg" disabled={pending}>
                  Send back
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
        <TankWorkerPicker
          workers={painters}
          value={worker}
          onChange={setWorker}
          disabled={pending}
          label="Painter ID"
          emptyHint="No painters on file — the admin adds them under Production Workers."
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending || painters.length === 0}
          className="btn btn-primary btn-sm"
        >
          {pending ? "Saving…" : picked.size ? `Record ${picked.size} painted` : "Record painted"}
        </button>
        {msg && <span className="text-[11px] text-bad-fg">{msg}</span>}
      </div>
    </div>
  );
}
