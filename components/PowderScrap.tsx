"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { CAT, ChartCard, DeltaChip, Legend, StatTile, fmt, pct } from "@/components/charts/kit";
import { PowderTrendChart } from "@/components/LazyCharts";
import { ActionMsg as Msg, useConsumableAction as useAction } from "@/components/consumablesUi";
import { monthLong, monthShort } from "@/lib/domain/consumableMonthly";
import { POWDER_DEPARTMENTS, SCRAP_LIMITS, type PowderFigures } from "@/lib/domain/powderScrap";
import { sectionLabel } from "@/lib/domain/tanks";
import type { PowderView, ScrapEntryView } from "@/lib/server/powderScrap";
import { createPowderScrap, deletePowderScrap, updatePowderScrap } from "@/app/consumables/powderActions";
import { Modal } from "@/components/Modal";

// POWDER SCRAP: the painting lines' powder scrap, weighed in kg, against the
// powder the store handed out to them — the month's scrap rate per section
// and together, the month before, six months of trend, and the weighings.

const F = "px-2.5 py-2 text-sm font-semibold";
const WITHDRAWN = CAT[0];
const SCRAP = "var(--bad-fg)";
const RATE = "var(--foreground)";

const rateText = (f: { rate: number | null }) => (f.rate === null ? "—" : pct(f.rate, 1));
/** The change in the rate, in percentage points — a rate's own change. */
function RateChange({ now, prev, prevMonth }: { now: PowderFigures; prev: PowderFigures; prevMonth: string }) {
  if (now.rate === null || prev.rate === null) return null;
  const pts = Math.round((now.rate - prev.rate) * 1000) / 10;
  return <DeltaChip value={pts} unit=" pts" up="bad" title={`${monthShort(prevMonth)}: ${pct(prev.rate, 1)}`} />;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function ScrapFields({ entry, today, earliest, disabled }: { entry?: ScrapEntryView; today: string; earliest: string; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Painting section">
        <select name="department" defaultValue={entry?.department ?? ""} required disabled={disabled} className={`${F} w-full`}>
          <option value="" disabled>Pick the section…</option>
          {POWDER_DEPARTMENTS.map((d) => <option key={d} value={d}>{sectionLabel(d)}</option>)}
        </select>
      </Field>
      <Field label="Weighed on">
        <input type="date" name="day" defaultValue={entry?.dayISO ?? today} max={today} min={earliest} required disabled={disabled} className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field label="Scrap (kg)">
        <input name="kg" type="number" inputMode="decimal" step="0.001" min="0.001" max={SCRAP_LIMITS.kgMax} defaultValue={entry?.kg ?? ""} required disabled={disabled} placeholder="0" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field label="Notes (optional)">
        <input type="text" name="notes" defaultValue={entry?.notes ?? ""} maxLength={SCRAP_LIMITS.notes} disabled={disabled} autoComplete="off" placeholder="e.g. colour change, contaminated batch" className={`${F} w-full`} />
      </Field>
    </div>
  );
}

function Foot({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-3 mt-1 border-t">{children}</div>;
}

/** Recording a weighing, in a popup. */
function RecordScrapDialog({ today, earliest, onClose, onSaved }: { today: string; earliest: string; onClose: () => void; onSaved: () => void }) {
  const add = useAction();
  return (
    <Modal title="➕ Record powder scrap" sub="Scrap weighed against the powder drawn" onClose={onClose} busy={add.pending} width="max-w-xl">
      <form
        className="space-y-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          add.run(createPowderScrap, new FormData(ev.currentTarget), "Saved.", onSaved);
        }}
      >
        <ScrapFields today={today} earliest={earliest} disabled={add.pending} />
        <Msg msg={add.msg && !add.msg.ok ? add.msg : null} />
        <Foot>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={add.pending}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={add.pending}>{add.pending ? "Saving…" : "Record"}</button>
        </Foot>
      </form>
    </Modal>
  );
}

function ScrapRow({ e, isAdmin, today, earliest, showActions }: { e: ScrapEntryView; isAdmin: boolean; today: string; earliest: string; showActions: boolean }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const act = useAction();
  const [y, m, d] = e.dayISO.split("-");
  return (
    <Fragment>
      <tr className="border-t align-top">
        <td className="p-2 ltr tabnum whitespace-nowrap">{`${d}/${m}/${y}`}</td>
        <td className="p-2">{e.departmentLabel}</td>
        <td className="p-2 text-end ltr tabnum font-extrabold">{fmt(e.kg)}</td>
        <td className="p-2 text-muted">{e.notes ?? ""}</td>
        <td className="p-2 text-xs text-muted whitespace-nowrap">
          {e.recordedBy} · {e.recordedAtLabel}
          {e.edited && (isAdmin && e.revisions.length > 0 ? (
            <button type="button" className="pill pill-warn ml-1 cursor-pointer" aria-expanded={history} onClick={() => setHistory((v) => !v)} title={`Last changed by ${e.edited.by} at ${e.edited.atLabel}`}>
              edited{e.revisions.length > 1 ? ` ×${e.revisions.length}` : ""}
            </button>
          ) : (
            <span className="pill pill-warn ml-1" title={`Last changed by ${e.edited.by} at ${e.edited.atLabel}`}>edited</span>
          ))}
        </td>
        {showActions && (
          <td className="p-2 whitespace-nowrap no-print">
            {e.canEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={act.pending}>Edit</button>}
            {isAdmin && (
              <button
                type="button" className="btn btn-sm btn-danger ml-1" disabled={act.pending}
                onClick={() => {
                  if (!confirm(`Delete this weighing?\n\n${e.kg} kg · ${e.departmentLabel} · ${d}/${m}/${y}`)) return;
                  const fd = new FormData();
                  fd.set("id", String(e.id));
                  fd.set("version", e.version);
                  act.run(deletePowderScrap, fd, "Deleted.");
                }}
              >
                Delete
              </button>
            )}
            {!editing && <Msg msg={act.msg && !act.msg.ok ? act.msg : null} />}
          </td>
        )}
      </tr>
      {history && isAdmin && (
        <tr className="bg-surface-2">
          <td colSpan={showActions ? 6 : 5} className="p-2 text-xs">
            <div className="font-bold text-muted uppercase tracking-wide mb-1">History — newest first</div>
            <ul className="space-y-0.5">
              {e.revisions.map((r) => (
                <li key={r.id}>
                  <b>{r.action === "delete" ? "Deleted" : r.action === "restore" ? "Brought back" : "Edited"}</b> by {r.by} · {r.atLabel} — {r.changes.length ? r.changes.join("; ") : r.before}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
      {editing && e.canEdit && (
        <Modal title="Correct a weighing" sub={`Recorded ${e.recordedAtLabel} by ${e.recordedBy}. The weighing as it is now is kept for the admin.`} onClose={() => setEditing(false)} busy={act.pending} width="max-w-xl">
          <form
            className="space-y-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              const fd = new FormData(ev.currentTarget);
              fd.set("id", String(e.id));
              fd.set("version", e.version);
              act.run(updatePowderScrap, fd, "Saved.", () => setEditing(false));
            }}
          >
            <ScrapFields entry={e} today={today} earliest={earliest} disabled={act.pending} />
            <Msg msg={act.msg && !act.msg.ok ? act.msg : null} />
            <Foot>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={act.pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={act.pending}>{act.pending ? "Saving…" : "Save"}</button>
            </Foot>
          </form>
        </Modal>
      )}
    </Fragment>
  );
}

type TrendKey = "all" | (typeof POWDER_DEPARTMENTS)[number];

export function PowderScrap({ r, canRecord, isAdmin, today, earliest }: { r: PowderView; canRecord: boolean; isAdmin: boolean; today: string; earliest: string }) {
  const router = useRouter();
  const [trendOf, setTrendOf] = useState<TrendKey>("all");
  const [recording, setRecording] = useState(false);
  const [saved, setSaved] = useState(false);
  const idx = r.months.indexOf(r.month);
  const older = idx >= 0 && idx < r.months.length - 1 ? r.months[idx + 1] : undefined;
  const newer = idx > 0 ? r.months[idx - 1] : undefined;
  const hrefOf = (m: string) => `/consumables?view=powder&month=${m}`;

  const series = trendOf === "all" ? r.total.trend : r.departments.find((d) => d.department === trendOf)!.trend;
  const t = r.total;
  const withdrawnChange = t.prev.withdrawn > 0 ? Math.round(((t.withdrawn - t.prev.withdrawn) / t.prev.withdrawn) * 100) : null;
  const showActions = isAdmin || r.entries.some((e) => e.canEdit);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        {older ? <Link href={hrefOf(older)} className="btn btn-secondary btn-sm" aria-label="Previous month">◀</Link> : <span className="btn btn-secondary btn-sm opacity-40">◀</span>}
        <select value={r.month} onChange={(e) => router.push(hrefOf(e.target.value))} aria-label="Month" className="px-2 py-1.5 text-sm font-bold">
          {r.months.map((m) => <option key={m} value={m}>{monthLong(m)}</option>)}
        </select>
        {newer ? <Link href={hrefOf(newer)} className="btn btn-secondary btn-sm" aria-label="Next month">▶</Link> : <span className="btn btn-secondary btn-sm opacity-40">▶</span>}
        {canRecord && <button type="button" className="btn btn-primary" onClick={() => { setSaved(false); setRecording(true); }}>➕ Record scrap</button>}
        {saved && <span className="text-sm font-semibold text-ok-fg" role="status">✓ Saved.</span>}
      </div>

      {canRecord && recording && <RecordScrapDialog today={today} earliest={earliest} onClose={() => setRecording(false)} onSaved={() => { setRecording(false); setSaved(true); }} />}

      <div className="flex flex-wrap gap-3">
        <StatTile hero label={`Scrap rate · ${monthShort(r.month)}`} value={rateText(t)} about="Scrap ÷ powder drawn in the month. Powder is the hand-outs of items named “…Powder…”, in kg." delta={<RateChange now={t} prev={t.prev} prevMonth={r.prevMonth} />} spark={t.trend.map((x) => (x.rate ?? 0) * 100)} />
        <StatTile
          label="Powder drawn" value={`${fmt(t.withdrawn)} kg`} about="Hand-outs of items named “…Powder…” in the month, in kg."
          delta={withdrawnChange === null ? undefined : <DeltaChip value={withdrawnChange} unit="%" title={`${monthShort(r.prevMonth)}: ${fmt(t.prev.withdrawn)} kg`} />}
        />
        <StatTile label="Scrap" value={`${fmt(t.scrap)} kg`} sub={`${r.entries.length} weighing${r.entries.length === 1 ? "" : "s"}`} />
        <StatTile label="Net used" value={`${fmt(t.net)} kg`} about={t.net < 0 ? "Powder drawn − scrap; below zero, more was scrapped than drawn (earlier stock)." : "Powder drawn − scrap."} />
      </div>

      {(r.notKg.length > 0 || r.elsewhere.length > 0) && (
        <div className="border rounded-lg p-2 text-xs bg-[var(--warn-bg)] text-warn-fg space-y-0.5" role="note">
          {r.notKg.length > 0 && <div>Not in kg, left out of the rate: {r.notKg.map((x) => `${x.item} — ${fmt(x.qty)} ${x.uom}`).join(" · ")}. Set the item&apos;s unit to KG on the Limits view to count it.</div>}
          {r.elsewhere.length > 0 && <div>Powder handed out to other departments this month (not set against the painting scrap): {r.elsewhere.map((x) => `${x.label} ${fmt(x.qty)} kg`).join(" · ")}.</div>}
        </div>
      )}

      <section className="bg-surface border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand-fill text-white text-left">
                <th className="p-2">Section</th>
                <th className="p-2 text-end">Drawn (kg)</th>
                <th className="p-2 text-end">Scrap (kg)</th>
                <th className="p-2 text-end">Net used (kg)</th>
                <th className="p-2 text-end">Scrap rate</th>
                <th className="p-2">vs {monthShort(r.prevMonth)}</th>
              </tr>
            </thead>
            <tbody>
              {r.departments.map((d) => (
                <tr key={d.department} className="border-t">
                  <td className="p-2 font-semibold">{d.label}</td>
                  <td className="p-2 text-end tabnum">{fmt(d.withdrawn)}</td>
                  <td className="p-2 text-end tabnum">{fmt(d.scrap)}</td>
                  <td className="p-2 text-end tabnum">{fmt(d.net)}</td>
                  <td className="p-2 text-end tabnum font-extrabold">{rateText(d)}</td>
                  <td className="p-2"><RateChange now={d} prev={d.prev} prevMonth={r.prevMonth} /></td>
                </tr>
              ))}
              <tr className="border-t bg-surface-2 font-bold">
                <td className="p-2">Both sections</td>
                <td className="p-2 text-end tabnum">{fmt(t.withdrawn)}</td>
                <td className="p-2 text-end tabnum">{fmt(t.scrap)}</td>
                <td className="p-2 text-end tabnum">{fmt(t.net)}</td>
                <td className="p-2 text-end tabnum font-extrabold">{rateText(t)}</td>
                <td className="p-2"><RateChange now={t} prev={t.prev} prevMonth={r.prevMonth} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <ChartCard
        title="The last six months"
        about="Powder drawn and scrapped (kg, bars) and the scrap rate (line)"
        right={
          <nav className="seg" aria-label="Section">
            {(["all", ...POWDER_DEPARTMENTS] as TrendKey[]).map((k) => (
              <button key={k} type="button" className={trendOf === k ? "on" : ""} onClick={() => setTrendOf(k)}>{k === "all" ? "Both" : sectionLabel(k)}</button>
            ))}
          </nav>
        }
        data={series.map((x) => ({ Month: monthLong(x.month), "Drawn (kg)": x.withdrawn, "Scrap (kg)": x.scrap, "Net used (kg)": x.net, "Scrap rate": x.rate === null ? "—" : pct(x.rate, 1) }))}
      >
        <div className="viz" style={{ height: 260 }}>
          <PowderTrendChart series={series} color={{ withdrawn: WITHDRAWN, scrap: SCRAP, rate: RATE }} />
        </div>
        <div className="mt-2"><Legend items={[{ label: "Powder drawn", color: WITHDRAWN }, { label: "Scrap", color: SCRAP }, { label: "Scrap rate", color: RATE, line: true }]} /></div>
      </ChartCard>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <section className="bg-surface border rounded-xl overflow-hidden lg:col-span-3">
          <h2 className="font-bold px-3 pt-3">Weighings · {monthLong(r.month)}</h2>
          {r.entries.length === 0 ? (
            <p className="text-sm text-muted p-3">No powder scrap recorded in {monthLong(r.month)}.</p>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-muted uppercase tracking-wide">
                    <th className="p-2">Day</th>
                    <th className="p-2">Section</th>
                    <th className="p-2 text-end">Kg</th>
                    <th className="p-2">Notes</th>
                    <th className="p-2">Recorded</th>
                    {showActions && <th className="p-2 no-print">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.entries.map((e) => <ScrapRow key={e.id} e={e} isAdmin={isAdmin} today={today} earliest={earliest} showActions={showActions} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="bg-surface border rounded-xl overflow-hidden lg:col-span-2">
          <h2 className="font-bold px-3 pt-3">Powder drawn · {monthLong(r.month)}</h2>
          {r.items.length === 0 ? (
            <p className="text-sm text-muted p-3">No powder handed out to the painting sections in {monthLong(r.month)}. Powder counts when its catalogue item (or the typed item) is named “…Powder…”.</p>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-muted uppercase tracking-wide">
                    <th className="p-2">Item</th>
                    <th className="p-2">Section</th>
                    <th className="p-2 text-end">Hand-outs</th>
                    <th className="p-2 text-end">Kg</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={`${i.item}|${i.department}`} className="border-t">
                      <td className="p-2 font-semibold">{i.item}</td>
                      <td className="p-2">{sectionLabel(i.department)}</td>
                      <td className="p-2 text-end tabnum">{i.handOuts}</td>
                      <td className="p-2 text-end tabnum font-extrabold">{fmt(i.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
