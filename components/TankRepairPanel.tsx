"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TankDTO } from "@/lib/server/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { markTankRepaired } from "@/app/tanks/actions";
import { TankWorkerPicker, NO_WORKER, type WorkerPick } from "@/components/TankWorkerPicker";
import { tankPath } from "@/lib/domain/tanks";

// Tanks the leak test sent back. They sit on top of the welding worklist —
// ahead of new work, because a tank that failed is already counted as welded
// and is blocking a delivery. Confirming the repair puts it back in the
// leak-test queue for another go; nothing on the ledger moves either way.

export function TankRepairPanel({ tanks, welders }: { tanks: TankDTO[]; welders: WorkerDTO[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [worker, setWorker] = useState<Record<string, WorkerPick>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  if (tanks.length === 0) return null;

  function confirm(serial: string) {
    const w = worker[serial] ?? NO_WORKER;
    if (w.id === null) {
      setMsg((s) => ({
        ...s,
        [serial]: w.empId ? "No worker has that ID." : "Enter the ID of whoever repaired it.",
      }));
      return;
    }
    const fd = new FormData();
    fd.set("serial", serial);
    fd.set("workerId", String(w.id));
    setMsg((s) => ({ ...s, [serial]: "" }));
    startTransition(async () => {
      const res = await markTankRepaired(fd);
      if (res.ok) router.refresh();
      else setMsg((s) => ({ ...s, [serial]: res.error ?? "Failed to save" }));
    });
  }

  return (
    <section className="mb-6">
      <h2>🔧 Tanks sent back by the leak test ({tanks.length})</h2>
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bad-fg text-white text-left">
              <th className="p-2">Serial</th>
              <th className="p-2">MO</th>
              <th className="p-2">What is wrong</th>
              <th className="p-2">Failed on</th>
              <th className="p-2 text-center w-64">Mark repaired</th>
            </tr>
          </thead>
          <tbody>
            {tanks.map((t, i) => (
              <tr key={t.serial} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2 whitespace-nowrap">
                  <Link href={tankPath(t.serial)} className="ltr font-extrabold tabnum hover:underline">
                    {t.serial}
                  </Link>
                </td>
                <td className="p-2 text-xs font-semibold whitespace-nowrap">
                  {t.mo}
                  {t.weldedStamp && <span className="pill pill-muted ml-1 ltr" title="Welder stamp on this tank">{t.weldedStamp}</span>}
                </td>
                <td className="p-2 text-xs">{t.testNote ?? "—"}</td>
                <td className="p-2 text-xs tabnum whitespace-nowrap">
                  {t.testedISO ?? "—"}
                  {t.testedBy ? <span className="text-muted"> · {t.testedBy}</span> : null}
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-1.5 justify-center">
                    <TankWorkerPicker
                      workers={welders}
                      value={worker[t.serial] ?? NO_WORKER}
                      onChange={(v) => setWorker((s) => ({ ...s, [t.serial]: v }))}
                      disabled={pending}
                      label="Welder ID"
                      emptyHint="No welders on file."
                    />
                    <button
                      type="button"
                      onClick={() => confirm(t.serial)}
                      disabled={pending || welders.length === 0}
                      className="rounded-md px-2.5 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                    >
                      Repaired
                    </button>
                  </div>
                  {msg[t.serial] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[t.serial]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
