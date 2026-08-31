"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TANK_STATUS_LABEL, type TankStatus } from "@/lib/domain/tanks";
import { clearTankRecords } from "./actions";

// The clean slate after a trial run.
//
// The barcode tab can only remove tanks that reached painting; anything still
// at welding, waiting for the leak test or sent back for repair is invisible
// there. This reaches all of them.
//
// The two buttons are NOT the same button with a different warning. Keeping the
// quantities says the welding and painting really happened and the plan's
// numbers are right — only the serials go. Taking them says the work was test
// data that should never have counted. Getting that wrong quietly changes the
// plant's production figures, so both are spelled out rather than hidden behind
// one "delete" with a checkbox.

export function ClearTankRecords({
  total,
  byStatus,
}: {
  total: number;
  byStatus: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function clear(mode: "keep-quantities" | "with-quantities") {
    const tail =
      mode === "keep-quantities"
        ? "The daily log is NOT touched — the welding and painting stay recorded, and the plan's numbers do not move."
        : "Every tank ALSO takes its quantity back off the daily log. The welding and painting rows lose it, and the plan's numbers WILL drop.";
    if (
      !window.confirm(
        `Delete all ${total} tank record(s)?\n\n${tail}\n\n` +
          "Serials start again from 1 for every BOM.\n\nThis cannot be undone."
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("mode", mode);
    setMsg(null);
    startTransition(async () => {
      const res = await clearTankRecords(fd);
      if (res.ok) {
        setMsg({ ok: true, text: `${res.deleted ?? 0} tank record(s) deleted. Serials start from 1 again.` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Failed to clear." });
      }
    });
  }

  return (
    <div className="border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-extrabold">🧹 Tank records</h2>
        <p className="text-sm text-muted mt-1">
          Wipes the per-piece layer and lets serials start from 1 again — the clean slate after a trial
          run. This is also the only way to remove tanks the Barcode tab cannot show, because it only
          lists tanks that reached painting.
        </p>
      </div>

      {total === 0 ? (
        <p className="text-sm text-muted border-t pt-3">There are no tank records — nothing to clear.</p>
      ) : (
        <>
          <div className="border-t pt-3">
            <div className="text-sm font-bold mb-1.5">{total} tank record(s) on file</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(byStatus).map(([status, n]) => (
                <span key={status} className="pill pill-muted">
                  {TANK_STATUS_LABEL[status as TankStatus] ?? status}: {n}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 border-t pt-3">
            <div className="space-y-2">
              <div className="text-sm font-bold">Keep the quantities</div>
              <p className="text-xs text-muted">
                The tanks really were welded and painted, so the daily log stays exactly as it is and the
                plan&apos;s numbers do not move. Only the serials and their history go.
                <br />
                <b>This is what a trial run wants.</b>
              </p>
              <button
                type="button"
                onClick={() => clear("keep-quantities")}
                disabled={pending}
                className="btn btn-sm"
              >
                {pending ? "Working…" : "Delete serials, keep the log"}
              </button>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-bold text-bad-fg">Take the quantities too</div>
              <p className="text-xs text-muted">
                Every tank also takes its quantity back off the daily log, as if the work was never
                recorded. The welding and painting rows lose it and the plan&apos;s numbers will drop.
                <br />
                <b>Only for test data that should never have counted.</b>
              </p>
              <button
                type="button"
                onClick={() => clear("with-quantities")}
                disabled={pending}
                className="btn btn-sm text-bad-fg"
              >
                {pending ? "Working…" : "Delete tanks and their quantities"}
              </button>
            </div>
          </div>
        </>
      )}

      {msg && (
        <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>
      )}
    </div>
  );
}
