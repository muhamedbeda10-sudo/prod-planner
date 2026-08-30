"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WorkerDTO } from "@/lib/server/workers";
import { assignTankWelder } from "@/app/tanks/actions";
import { TankWorkerSelect } from "@/components/TankWorkerSelect";

// What the welder sees the moment a batch is saved: the serials the app just
// minted, big enough to copy onto the steel, each with the name it was
// credited to. The batch is recorded under ONE welder — this is where a tank
// that someone else actually welded gets its own name.

export function TankSerialsPanel({
  serials,
  welders,
  batchWelder,
  onClose,
}: {
  serials: string[];
  welders: WorkerDTO[];
  /** The name the whole batch was saved under — shown as each tank's default. */
  batchWelder: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [changed, setChanged] = useState<Record<string, string>>({});

  function reassign(serial: string, workerId: string) {
    if (!workerId) return;
    const fd = new FormData();
    fd.set("serial", serial);
    fd.set("workerId", workerId);
    setMsg("");
    startTransition(async () => {
      const res = await assignTankWelder(fd);
      if (res.ok) {
        const name = welders.find((w) => String(w.id) === workerId)?.name ?? "";
        setChanged((s) => ({ ...s, [serial]: name }));
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to save");
      }
    });
  }

  return (
    <div className="bg-surface border-2 border-brand rounded-xl p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-extrabold">
          ✍️ Write these serials on the tanks ({serials.length})
        </span>
        <button type="button" onClick={onClose} className="ml-auto text-muted text-xs hover:underline">
          Done
        </button>
      </div>
      <p className="text-xs text-muted">
        All of them were recorded under <b>{batchWelder ?? "—"}</b>. If someone else welded one, change the name beside it.
      </p>

      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {serials.map((s) => (
          <div key={s} className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-brand-light/20">
            <code className="ltr font-extrabold tabnum text-sm tracking-wide">{s}</code>
            <span className="ml-auto flex items-center gap-1.5">
              {changed[s] && <span className="pill pill-ok text-[10px]">{changed[s]}</span>}
              <TankWorkerSelect
                workers={welders}
                value=""
                onChange={(v) => reassign(s, v)}
                disabled={pending}
                placeholder="Change welder"
                emptyHint=""
              />
            </span>
          </div>
        ))}
      </div>
      {msg && <div className="text-[11px] text-bad-fg">{msg}</div>}
    </div>
  );
}
