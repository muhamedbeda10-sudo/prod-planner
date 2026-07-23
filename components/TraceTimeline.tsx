"use client";

import { useMemo, useState } from "react";
import type { TraceEvent, TraceEventKind } from "@/lib/server/trace";
import { STAGE_COLOR, deptLabel } from "@/lib/domain/constants";

// colour for an event's marker: production stages use the shared per-stage
// palette; the non-stage events get their own tint
const kindColor = (e: TraceEvent): string => {
  if (e.kind === "return") return "var(--bad-fg)";
  if (e.kind === "note") return "var(--warn-fg)";
  if (e.kind === "realloc") return "#6b45a8";
  return (e.dept && STAGE_COLOR[e.dept]) || "var(--muted)";
};

const KIND_LABEL: Record<TraceEventKind, string> = {
  output: "Output", correction: "Corrections", return: "Returns", note: "Notes", realloc: "Moves",
};

export function TraceTimeline({ events, showMo }: { events: TraceEvent[]; showMo: boolean }) {
  const [kinds, setKinds] = useState<Set<TraceEventKind>>(new Set());
  const [item, setItem] = useState("");

  const kindsPresent = useMemo(() => {
    const s = new Set<TraceEventKind>();
    for (const e of events) s.add(e.kind);
    return (["output", "correction", "return", "note", "realloc"] as TraceEventKind[]).filter((k) => s.has(k));
  }, [events]);
  const itemsPresent = useMemo(() => [...new Set(events.map((e) => e.item).filter(Boolean))] as string[], [events]);

  const toggle = (k: TraceEventKind) =>
    setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const shown = events.filter((e) => (kinds.size === 0 || kinds.has(e.kind)) && (!item || e.item === item));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {kindsPresent.map((k) => {
          const on = kinds.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              className={`rounded-md border px-2.5 py-1 text-xs font-bold transition-colors ${on ? "bg-brand text-white border-brand" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
            >
              {KIND_LABEL[k]}
            </button>
          );
        })}
        {itemsPresent.length > 0 && (
          <select value={item} onChange={(e) => setItem(e.target.value)} className="border rounded-md px-2 py-1 text-xs font-semibold bg-surface ml-1">
            <option value="">All items</option>
            {itemsPresent.map((it) => <option key={it} value={it}>{it}</option>)}
          </select>
        )}
        <span className="text-xs text-muted ml-auto tabnum">{shown.length} event{shown.length === 1 ? "" : "s"}</span>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted">No events match the filter.</p>
      ) : (
        <ol className="relative border-l-2 border-border ml-2">
          {shown.map((e, i) => (
            <li key={i} className="relative pl-5 pb-4 last:pb-0">
              <span
                className="absolute -left-[7px] top-1 w-3 h-3 rounded-full border-2 border-surface"
                style={{ background: kindColor(e) }}
              />
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="text-xs text-muted tabnum w-20 shrink-0">{e.dateISO}</span>
                <EventBody e={e} showMo={showMo} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "bad" | "warn" | "muted"; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function EventBody({ e, showMo }: { e: TraceEvent; showMo: boolean }) {
  const moTag = showMo && e.mo ? <span className="text-[11px] text-muted">· {e.mo}</span> : null;
  if (e.kind === "output" || e.kind === "correction") {
    const neg = (e.qty ?? 0) < 0;
    return (
      <span className="flex flex-wrap items-baseline gap-1.5">
        <b className="tabnum" style={{ color: neg ? "var(--bad-fg)" : "var(--ok-fg)" }}>
          {neg ? "▼" : "▲"} {neg ? e.qty : `+${e.qty}`}
        </b>
        <b>{e.item}</b>
        <span className="text-muted">{deptLabel(e.dept ?? "")}</span>
        {neg && <Pill tone="bad">correction</Pill>}
        {e.corrected && <Pill tone="ok">fixed from {e.corrected}</Pill>}
        {e.by ? <span className="text-[11px] text-muted">by {e.by}</span> : null}
        {e.source && e.source !== "worklist" && e.source !== "tracker" && <span className="text-[11px] text-muted">({e.source})</span>}
        {moTag}
      </span>
    );
  }
  if (e.kind === "return") {
    return (
      <span className="flex flex-wrap items-baseline gap-1.5">
        <b className="tabnum text-bad-fg">↩ {e.qty}</b>
        <b>{e.item}</b>
        <span className="text-muted">{deptLabel(e.fromDept ?? "")} → {deptLabel(e.toDept ?? "")}</span>
        {e.status === "open" ? <Pill tone="warn">open</Pill> : <Pill tone="ok">re-delivered</Pill>}
        <span className="text-foreground">“{e.reason}”</span>
        {moTag}
      </span>
    );
  }
  if (e.kind === "note") {
    return (
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-1.5">
          <b>📝 {e.item}</b>
          <span className="text-muted">{deptLabel(e.dept ?? "")}</span>
          {e.status === "open" ? <Pill tone="warn">open</Pill> : <Pill tone="ok">resolved</Pill>}
          {moTag}
        </span>
        {e.text && <span className="text-foreground whitespace-pre-wrap">{e.text}</span>}
        {e.photos && e.photos.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {e.photos.map((p) => (
              <a key={p} href={p} target="_blank" rel="noreferrer" title="Open full size">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p} alt="note" className="h-16 w-16 object-cover rounded-md border" />
              </a>
            ))}
          </span>
        )}
      </span>
    );
  }
  // realloc
  return (
    <span className="flex flex-wrap items-baseline gap-1.5">
      <b className="tabnum" style={{ color: "#6b45a8" }}>⇄ {e.qty}</b>
      <b>{e.item}</b>
      <span className="text-muted">{deptLabel(e.dept ?? "")} · {e.fromBom} → {e.toBom}</span>
      <Pill tone={e.status === "approved" ? "ok" : e.status === "rejected" ? "bad" : "muted"}>{e.status}</Pill>
      {e.reason && <span className="text-foreground">“{e.reason}”</span>}
    </span>
  );
}
