"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TankDTO } from "@/lib/server/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { recordLeakTest } from "@/app/tanks/actions";
import { TankWorkerPicker, NO_WORKER, type WorkerPick } from "@/components/TankWorkerPicker";
import { SearchBox, FilterBar } from "@/components/FilterControls";
import { PrintButton } from "@/components/PrintButton";
import { tankPath } from "@/lib/domain/tanks";

// The stage between welding and painting. Every welded tank lands here by its
// serial and leaves one of two ways: it passes and painting opens for it, or it
// needs repair and goes back to welding. Either way the tester's name is part
// of the record — that is half the reason the stage exists.
//
// The verdict is recorded on a SELECTION so a tester who has just done a rack
// of ten can pass them in one go; a tank that failed is recorded on its own,
// because the reason is what the welder will read.

export function LeakTestTable({
  tanks,
  testers,
  day,
  canEdit,
}: {
  tanks: TankDTO[];
  testers: WorkerDTO[];
  day: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [worker, setWorker] = useState<WorkerPick>(NO_WORKER);
  const [msg, setMsg] = useState("");
  const [failFor, setFailFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return tanks;
    return tanks.filter((t) => `${t.serial} ${t.mo} ${t.bom} ${t.so ?? ""}`.toUpperCase().includes(needle));
  }, [tanks, q]);

  const toggle = (serial: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(serial)) n.delete(serial);
      else n.add(serial);
      return n;
    });

  const allPicked = filtered.length > 0 && filtered.every((t) => picked.has(t.serial));
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(filtered.map((t) => t.serial)));

  function run(serials: string[], result: "pass" | "repair", note: string) {
    if (serials.length === 0) {
      setMsg("Pick the tanks first.");
      return;
    }
    if (worker.id === null) {
      setMsg(worker.empId ? "No worker has that ID." : "Enter the ID of whoever carried out the test.");
      return;
    }
    const fd = new FormData();
    fd.set("serials", serials.join(","));
    fd.set("result", result);
    fd.set("workerId", String(worker.id));
    fd.set("note", note);
    fd.set("date", day);
    setMsg("");
    startTransition(async () => {
      const res = await recordLeakTest(fd);
      if (res.ok) {
        setPicked((s) => {
          const n = new Set(s);
          for (const x of serials) n.delete(x);
          return n;
        });
        setFailFor(null);
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to save");
      }
    });
  }

  return (
    <div className="md:flex md:flex-col md:h-[calc(100vh-7rem)]">
      <FilterBar
        count={filtered.length}
        total={tanks.length}
        onReset={() => setQ("")}
        hasActive={!!q}
      >
        <SearchBox value={q} onChange={setQ} placeholder="Search serial / MO…" />
        {canEdit && (
          <div className="col-span-2 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={toggleAll} className="btn btn-sm" disabled={pending || filtered.length === 0}>
              {allPicked ? "Clear selection" : `Select all (${filtered.length})`}
            </button>
            <TankWorkerPicker
              workers={testers}
              value={worker}
              onChange={setWorker}
              disabled={pending}
              label="Tester ID"
              emptyHint="No leak testers on file — the admin adds them under Production Workers."
            />
            <button
              type="button"
              onClick={() => run([...picked], "pass", "")}
              disabled={pending || picked.size === 0 || testers.length === 0}
              className="rounded-md px-3 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
              title="The picked tanks passed and move on to painting"
            >
              ✓ Passed ({picked.size})
            </button>
            {msg && <span className="text-[11px] text-bad-fg whitespace-normal">{msg}</span>}
          </div>
        )}
        <PrintButton />
      </FilterBar>

      <div className="md:flex-1 md:min-h-0 md:overflow-auto">
        <div className="bg-surface border rounded-xl overflow-x-auto md:overflow-x-visible">
          <table className="w-full text-sm border-collapse">
            <thead className="md:sticky md:top-0 md:z-10">
              <tr className="bg-brand text-white text-left">
                {canEdit && <th className="p-2 w-8" />}
                <th className="p-2">Serial</th>
                <th className="p-2">MO</th>
                <th className="p-2">SO</th>
                <th className="p-2">BOM</th>
                <th className="p-2">KVA</th>
                <th className="p-2">Welded on</th>
                <th className="p-2" title="Name, and the stamp punched into the tank">Welder</th>
                <th className="p-2 text-center">Waiting</th>
                {canEdit && <th className="p-2 text-center w-40">Verdict</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 10 : 8} className="p-4 text-center text-muted">
                    {tanks.length === 0
                      ? "No tank is waiting for the leak test — the queue is clear."
                      : "No tanks match the search."}
                  </td>
                </tr>
              )}
              {filtered.map((t, i) => (
                <tr key={t.serial} className={i % 2 ? "bg-zebra" : ""}>
                  {canEdit && (
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={picked.has(t.serial)}
                        onChange={() => toggle(t.serial)}
                        disabled={pending}
                        className="accent-[var(--brand,#1b7a43)]"
                      />
                    </td>
                  )}
                  <td className="p-2 whitespace-nowrap">
                    <Link href={tankPath(t.serial)} className="ltr font-extrabold tabnum hover:underline">
                      {t.serial}
                    </Link>
                  </td>
                  <td className="p-2 text-xs font-semibold whitespace-nowrap">{t.mo}</td>
                  <td className="p-2 text-xs whitespace-nowrap">{t.so ?? "—"}</td>
                  <td className="p-2 font-bold whitespace-nowrap">{t.bom}</td>
                  <td className="p-2 text-xs text-muted whitespace-nowrap">{t.kva ?? "—"}</td>
                  <td className="p-2 text-xs tabnum whitespace-nowrap">{t.weldedISO}</td>
                  <td className="p-2 text-xs whitespace-nowrap">
                    {t.weldedBy ?? "—"}
                    {t.weldedStamp && <span className="pill pill-muted ml-1 ltr">{t.weldedStamp}</span>}
                  </td>
                  <td className="p-2 text-center whitespace-nowrap">
                    <span className={`pill ${t.ageDays > 6 ? "pill-bad" : t.ageDays > 2 ? "pill-warn" : "pill-ok"}`}>
                      ⏳ {t.ageDays === 0 ? "today" : `${t.ageDays}d`}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="p-2">
                      <div className="flex items-center gap-1.5 justify-center">
                        <button
                          type="button"
                          onClick={() => run([t.serial], "pass", "")}
                          disabled={pending || testers.length === 0}
                          className="rounded-md px-2 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                        >
                          ✓ Passed
                        </button>
                        <button
                          type="button"
                          onClick={() => { setFailFor(failFor === t.serial ? null : t.serial); setMsg(""); }}
                          disabled={pending}
                          className="rounded-md px-2 py-1 text-xs font-bold border text-bad-fg hover:bg-bad-bg"
                        >
                          ✗ Repair
                        </button>
                      </div>
                      {failFor === t.serial && (
                        <form
                          className="mt-1.5 flex items-center gap-1.5"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
                            if (!note) { setMsg("Write what is wrong."); return; }
                            run([t.serial], "repair", note);
                          }}
                        >
                          <input
                            name="note"
                            required
                            placeholder="Where is it leaking?"
                            className="flex-1 border rounded-md px-2 py-1 text-xs bg-surface"
                            disabled={pending}
                          />
                          <button type="submit" className="btn btn-sm text-bad-fg" disabled={pending}>
                            Send back
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
