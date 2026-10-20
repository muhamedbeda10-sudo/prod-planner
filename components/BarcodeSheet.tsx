"use client";

import { useMemo, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TankDTO } from "@/lib/server/tanks";
import { QrSvg } from "@/components/QrSvg";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { tankPath, tankQrPayload } from "@/lib/domain/tanks";
import { deleteTanks } from "@/app/tanks/actions";

// Every tank that finished all its stages, waiting for its sticker.
//
// The sticker carries a QR that opens the tank's page — quality scans it and
// reads live data (which SO and MO, every stage with its date and the person
// who did it) instead of whatever was true the day it was printed. The serial
// and the order are also printed as text, so the sticker still says something
// useful to someone without a phone.
//
// Printing goes two ways on purpose: tick a batch and get an A4 sheet of
// stickers to cut, or print one when a single sticker has come off a tank.

function Sticker({ tank, baseUrl }: { tank: TankDTO; baseUrl: string }) {
  return (
    <div className="sticker border-2 border-black rounded-lg p-2 flex gap-2 items-center bg-white text-black">
      <QrSvg value={tankQrPayload(baseUrl, tank.serial)} size={78} title={tank.serial} />
      <div className="min-w-0 leading-tight ltr text-left">
        <div className="font-extrabold text-[13px] tabnum tracking-wide">{tank.serial}</div>
        <div className="text-[10px] font-semibold truncate">MO {tank.mo}</div>
        {tank.so && <div className="text-[10px] truncate">SO {tank.so}</div>}
        <div className="text-[10px] truncate">
          BOM {tank.bom}
          {tank.kva ? ` · ${tank.kva}` : ""}
        </div>
        {/* the welder's stamp is punched into this tank — printing it lets
            anyone check the label against the steel without a phone */}
        {tank.weldedStamp && <div className="text-[10px] font-semibold truncate">Stamp {tank.weldedStamp}</div>}
        <div className="text-[9px] mt-0.5">ATC — Arabian Transformers</div>
      </div>
    </div>
  );
}

export function BarcodeSheet({
  tanks,
  baseUrl,
  isAdmin = false,
}: {
  tanks: TankDTO[];
  baseUrl: string;
  /** Removing a tank takes quantity off two departments' ledgers and cannot be
   *  undone, so only an admin is offered it. */
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [mo, setMo] = useState("");
  const [qa, setQa] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // set when a print was asked for; an effect opens the dialog only AFTER the
  // paper block has rendered the right stickers, then clears itself
  const [printing, setPrinting] = useState<{ single: string | null } | null>(null);

  const mos = useMemo(() => [...new Set(tanks.map((t) => t.mo))].sort(), [tanks]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return tanks.filter((t) => {
      if (needle && !`${t.serial} ${t.mo} ${t.bom} ${t.so ?? ""} ${t.customer ?? ""}`.toUpperCase().includes(needle)) return false;
      if (mo && t.mo !== mo) return false;
      if (qa === "done" && !t.qaResult) return false;
      if (qa === "pending" && t.qaResult) return false;
      if (qa === "failed" && t.qaResult !== "not-ok") return false;
      return true;
    });
  }, [tanks, q, mo, qa]);

  const toggle = (serial: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(serial)) n.delete(serial);
      else n.add(serial);
      return n;
    });

  const allPicked = filtered.length > 0 && filtered.every((t) => picked.has(t.serial));
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(filtered.map((t) => t.serial)));

  // What goes on paper: one sticker when that row's button was used, the
  // ticked selection otherwise — which is also what a plain Ctrl+P prints.
  const toPrint = printing?.single
    ? tanks.filter((t) => t.serial === printing.single)
    : filtered.filter((t) => picked.has(t.serial));

  // Render the right stickers BEFORE the dialog opens: window.print() blocks,
  // so a normal state update would still be queued when the paper is captured.
  function print(single: string | null) {
    flushSync(() => setPrinting({ single }));
    window.print();
    setPrinting(null);
  }

  function remove(serials: string[], what: string) {
    if (serials.length === 0) return;
    if (
      !window.confirm(
        `Remove ${what} from the records?\n\n` +
          "The tank, its whole history, and the quantity it added to the daily log all go. " +
          "The welding and painting rows it belongs to lose that quantity, and any row left at zero is deleted.\n\n" +
          "This cannot be undone."
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("serials", serials.join(","));
    setMsg("");
    startTransition(async () => {
      const res = await deleteTanks(fd);
      if (res.ok) {
        setPicked((s) => {
          const n = new Set(s);
          for (const x of serials) n.delete(x);
          return n;
        });
        router.refresh();
      } else {
        setMsg(res.error ?? "Failed to remove");
      }
    });
  }

  return (
    <>
      <FilterBar
        count={filtered.length}
        total={tanks.length}
        onReset={() => { setQ(""); setMo(""); setQa(""); }}
        hasActive={!!(q || mo || qa)}
      >
        <SearchBox value={q} onChange={setQ} placeholder="Search serial / MO / SO…" />
        <SelectFilter label="MO" value={mo} onChange={setMo} options={mos.map((m) => ({ value: m, label: m }))} />
        <SelectFilter
          label="Quality"
          value={qa}
          onChange={setQa}
          options={[
            { value: "pending", label: "Not checked yet" },
            { value: "done", label: "Checked" },
            { value: "failed", label: "Not OK" },
          ]}
        />
        <button type="button" onClick={toggleAll} className="btn btn-sm" disabled={filtered.length === 0}>
          {allPicked ? "Clear selection" : `Select all (${filtered.length})`}
        </button>
        <button
          type="button"
          onClick={() => print(null)}
          disabled={picked.size === 0}
          className="btn btn-primary btn-sm"
        >
          🖨 Print sheet ({picked.size})
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => remove([...picked], `${picked.size} tank(s)`)}
            disabled={pending || picked.size === 0}
            className="btn btn-sm text-bad-fg"
            title="Remove the selected tanks and take their quantity back off the daily log"
          >
            🗑 Remove ({picked.size})
          </button>
        )}
        {msg && <span className="text-[11px] text-bad-fg whitespace-normal">{msg}</span>}
      </FilterBar>

      {/* ---- the screen list ---- */}
      <div className="no-print bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2 w-8" />
              <th className="p-2">Serial</th>
              <th className="p-2">MO</th>
              <th className="p-2">SO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Painted on</th>
              <th className="p-2 text-center">Quality</th>
              <th className="p-2 text-center">Print</th>
              {isAdmin && <th className="p-2 text-center">Remove</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 10 : 9} className="p-4 text-center text-muted">
                  {tanks.length === 0
                    ? "No tank has finished every stage yet — a tank arrives here after painting."
                    : "No tanks match the filters."}
                </td>
              </tr>
            )}
            {filtered.map((t, i) => (
              <tr key={t.serial} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={picked.has(t.serial)}
                    onChange={() => toggle(t.serial)}
                  />
                </td>
                <td className="p-2 whitespace-nowrap">
                  <Link href={tankPath(t.serial)} className="ltr font-extrabold tabnum hover:underline">
                    {t.serial}
                  </Link>
                </td>
                <td className="p-2 text-xs font-semibold whitespace-nowrap">{t.mo}</td>
                <td className="p-2 text-xs whitespace-nowrap">{t.so ?? "—"}</td>
                <td className="p-2 font-bold whitespace-nowrap">{t.bom}</td>
                <td className="p-2 text-xs whitespace-nowrap">{t.customer ?? "—"}</td>
                <td className="p-2 text-xs tabnum whitespace-nowrap">
                  {t.paintedISO ?? "—"}
                  {t.paintedBy ? <span className="text-muted"> · {t.paintedBy}</span> : null}
                </td>
                <td className="p-2 text-center whitespace-nowrap">
                  {t.qaResult ? (
                    <span className={`pill ${t.qaResult === "ok" ? "pill-ok" : "pill-bad"}`}>
                      {t.qaResult === "ok" ? "OK" : "Not OK"}
                    </span>
                  ) : (
                    <span className="pill pill-muted">Pending</span>
                  )}
                </td>
                <td className="p-2 text-center">
                  <button type="button" onClick={() => print(t.serial)} className="btn btn-sm">
                    🖨 Sticker
                  </button>
                </td>
                {isAdmin && (
                  <td className="p-2 text-center">
                    <button
                      type="button"
                      onClick={() => remove([t.serial], t.serial)}
                      disabled={pending}
                      className="btn btn-sm text-bad-fg"
                      title="Remove this tank and take its quantity back off the daily log"
                    >
                      🗑
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---- the paper ---- */}
      <div className="print-only">
        <div className="sticker-sheet">
          {toPrint.map((t) => (
            <Sticker key={t.serial} tank={t} baseUrl={baseUrl} />
          ))}
        </div>
      </div>
    </>
  );
}
