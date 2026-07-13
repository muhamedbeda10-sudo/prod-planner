"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildBomClassifier } from "@/lib/domain/normalizeBoms";
import { ITEMS, DEPTS } from "@/lib/domain/constants";
import { addHandover, type ActionResult } from "@/app/handover/actions";

export function HandoverForm({
  knownBoms,
  defaultPlan,
  defaultDate,
  plans,
}: {
  knownBoms: string[];
  defaultPlan: number;
  defaultDate: string;
  plans: number[];
}) {
  const router = useRouter();
  const classify = useMemo(() => buildBomClassifier(knownBoms), [knownBoms]);
  const [bom, setBom] = useState("");
  const [dept, setDept] = useState<string>("Cut");
  const [item, setItem] = useState<string>("CF");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [planNo, setPlanNo] = useState(String(defaultPlan || plans[0] || ""));
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const cls = bom.trim() ? classify(bom) : null;
  const blocked = cls?.status === "ambiguous" || cls?.status === "unknown";
  const effectiveBom = cls?.status === "corrected" ? cls.corrected : cls?.clean;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const fd = new FormData();
    fd.set("date", date);
    fd.set("dept", dept);
    fd.set("bom", bom);
    fd.set("item", item);
    fd.set("qty", qty);
    fd.set("planNo", planNo);
    startTransition(async () => {
      const res = await addHandover(fd);
      setMsg(res);
      if (res.ok) {
        setBom("");
        setQty("");
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="bg-surface border rounded-xl p-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Field label="Date">
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded-md px-2 py-2" />
      </Field>

      <Field label="Department">
        <div className="flex gap-2">
          {DEPTS.map((d) => (
            <button type="button" key={d} onClick={() => setDept(d)}
              className={`flex-1 rounded-md px-3 py-2 font-bold text-sm border ${dept === d ? "bg-brand text-white border-brand" : "bg-surface"}`}>
              {d}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Plan">
        <select value={planNo} onChange={(e) => setPlanNo(e.target.value)} className="w-full border rounded-md px-2 py-2 font-bold">
          {plans.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>

      <Field label="BOM code" className="lg:col-span-2">
        <input
          list="known-boms"
          required
          value={bom}
          onChange={(e) => setBom(e.target.value)}
          placeholder="e.g. 12011E13M12"
          className={`w-full border rounded-md px-2 py-2 font-bold ${
            cls?.status === "known" || cls?.status === "corrected" ? "border-[color:var(--ok-fg)]" : blocked ? "border-[color:var(--bad-fg)]" : ""
          }`}
          autoComplete="off"
        />
        <datalist id="known-boms">
          {knownBoms.map((b) => <option key={b} value={b} />)}
        </datalist>
        {cls && (
          <div className="mt-1 text-xs">
            {cls.status === "known" && <span className="pill pill-ok">✓ Known</span>}
            {cls.status === "corrected" && <span className="pill pill-ok">✓ Auto-corrected → <b>{cls.corrected}</b></span>}
            {cls.status === "ambiguous" && <span className="pill pill-bad">? Ambiguous: {cls.candidates.join(", ")}</span>}
            {cls.status === "unknown" && <span className="pill pill-bad">✗ Unknown in any plan</span>}
          </div>
        )}
      </Field>

      <Field label="Component">
        <div className="flex gap-2">
          {ITEMS.map((it) => (
            <button type="button" key={it} onClick={() => setItem(it)}
              className={`flex-1 rounded-md px-2 py-2 font-bold text-sm border ${item === it ? "bg-accent text-white border-accent" : "bg-surface"}`}>
              {it}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Quantity">
        <input type="number" min={1} required value={qty} onChange={(e) => setQty(e.target.value)} className="w-full border rounded-md px-2 py-2 font-bold text-lg" />
      </Field>

      <div className="flex items-end lg:col-span-1">
        <button type="submit" disabled={pending || blocked} className="w-full bg-brand text-white font-extrabold rounded-md px-4 py-2.5 disabled:opacity-50">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>

      {msg && (
        <div className={`md:col-span-2 lg:col-span-3 rounded-md px-3 py-2 text-sm font-semibold ${msg.ok ? "bg-ok-bg text-ok-fg" : "bg-bad-bg text-bad-fg"}`}>
          {msg.ok ? `Saved ${effectiveBom ?? ""} successfully.` : msg.error}
        </div>
      )}
    </form>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-semibold text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
