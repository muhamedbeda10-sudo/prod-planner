"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyBomCorrection, proposeReallocations, decideMove } from "@/app/boms/actions";
import type { BomReviewRow } from "@/lib/server/boms";

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  known: { label: "Known", cls: "pill-ok" },
  corrected: { label: "Auto-correct", cls: "pill-ok" },
  ambiguous: { label: "Ambiguous", cls: "pill-warn" },
  unknown: { label: "Unknown", cls: "pill-bad" },
};

export function BomReviewTable({ rows }: { rows: BomReviewRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sel, setSel] = useState<Record<string, string>>({});

  function apply(from: string, to: string) {
    if (!to) return;
    const fd = new FormData();
    fd.set("from", from);
    fd.set("to", to);
    startTransition(async () => {
      await applyBomCorrection(fd);
      router.refresh();
    });
  }

  const needsReview = rows.filter((r) => r.status !== "known");

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {rows.length} distinct codes in the handover log — {needsReview.length} need review.
      </p>
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Code</th><th className="p-2 text-center">Records</th>
              <th className="p-2">Status</th><th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {needsReview.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-ok-fg font-semibold">All codes are known ✓</td></tr>
            )}
            {needsReview.map((r) => (
              <tr key={r.bom} className="border-t">
                <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                <td className="p-2 text-center tabnum">{r.count}</td>
                <td className="p-2">
                  <span className={`pill ${STATUS_LABEL[r.status].cls}`}>{STATUS_LABEL[r.status].label}</span>
                  {r.message && <div className="text-xs text-muted mt-1">{r.message}</div>}
                </td>
                <td className="p-2">
                  {r.status === "corrected" && (
                    <button onClick={() => apply(r.bom, r.corrected!)} disabled={pending}
                      className="bg-ok-fg text-white rounded px-3 py-1 text-xs font-bold">
                      Fix → {r.corrected}
                    </button>
                  )}
                  {r.status === "ambiguous" && (
                    <div className="flex gap-2">
                      <select className="border rounded px-2 py-1 text-xs" value={sel[r.bom] ?? ""} onChange={(e) => setSel({ ...sel, [r.bom]: e.target.value })}>
                        <option value="">Choose…</option>
                        {r.candidates.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button onClick={() => apply(r.bom, sel[r.bom] ?? "")} disabled={pending || !sel[r.bom]}
                        className="bg-brand text-white rounded px-3 py-1 text-xs font-bold disabled:opacity-40">Apply</button>
                    </div>
                  )}
                  {r.status === "unknown" && <span className="text-xs text-muted">Review manually</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface MoveView {
  id: number; dept: string; item: string; fromBom: string; toBom: string; qty: number; status: string; reason: string;
}

export function ReallocPanel({ planNo, moves }: { planNo: number; moves: MoveView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [info, setInfo] = useState("");

  function propose() {
    const fd = new FormData();
    fd.set("planNo", String(planNo));
    startTransition(async () => {
      const res = await proposeReallocations(fd);
      setInfo(res.info ?? res.error ?? "");
      router.refresh();
    });
  }
  function decide(id: number, decision: "approved" | "rejected") {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("decision", decision);
    startTransition(async () => {
      await decideMove(fd);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button onClick={propose} disabled={pending} className="bg-brand text-white rounded-md px-4 py-1.5 text-sm font-bold">
          Compute excess-reallocation proposals
        </button>
        {info && <span className="text-sm text-muted">{info}</span>}
      </div>
      <p className="text-xs text-muted">
        Reallocation moves excess-over-target to a same-family sibling with a deficit — as an explicit, approvable transaction. Original entries stay unchanged.
      </p>
      {moves.length > 0 && (
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">Dept</th><th className="p-2 text-center">Item</th>
                <th className="p-2">From</th><th className="p-2">To</th>
                <th className="p-2 text-center">Qty</th><th className="p-2">Status</th><th className="p-2 no-print"></th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2">{m.dept}</td>
                  <td className="p-2 text-center font-bold">{m.item}</td>
                  <td className="p-2 font-bold">{m.fromBom}</td>
                  <td className="p-2 font-bold">{m.toBom}</td>
                  <td className="p-2 text-center font-bold tabnum">{m.qty}</td>
                  <td className="p-2">
                    <span className={`pill ${m.status === "approved" ? "pill-ok" : m.status === "rejected" ? "pill-bad" : "pill-warn"}`}>
                      {m.status === "approved" ? "Approved" : m.status === "rejected" ? "Rejected" : "Proposed"}
                    </span>
                  </td>
                  <td className="p-2 no-print whitespace-nowrap">
                    {m.status === "proposed" && (
                      <>
                        <button onClick={() => decide(m.id, "approved")} disabled={pending} className="text-ok-fg text-xs font-bold px-2">Approve</button>
                        <button onClick={() => decide(m.id, "rejected")} disabled={pending} className="text-bad-fg text-xs font-bold px-2">Reject</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
