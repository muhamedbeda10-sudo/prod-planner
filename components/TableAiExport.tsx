"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { uploadAiFile } from "@/app/ai/actions";
import { useAiPanel } from "@/components/AiPanel";
import { Tooltip } from "@/components/Tooltip";
import { pageName, tableTitle } from "@/lib/aiTarget";
import { AI_FILE_LIMITS, fileSizeText } from "@/lib/domain/aiFiles";

// "Export to Excel with AI": every table on the page carries the assistant's
// mark at its top-right corner — kept in view while the table scrolls under
// the bar. A click sends the table as the screen shows it (filters and sort
// applied, lib/tableRead) to the assistant, as a CSV attached to a new chat;
// the assistant asks which columns go in the file (all, or which), then
// makes the Excel (make_excel's attached sheet). Nothing for someone without
// the assistant, nor on its own page; never in print.
//
// The marks are one layer, fixed to the window over the page, measured from
// the tables each frame something moves: a page's own components need know
// nothing of them. A mark something else covers (the bar, a dialog, a menu)
// is not shown. What reads and writes the table is fetched on the first
// click, so the pages carry only the marks.

/** What the mark does — its tooltip and its name for a screen reader. */
const LABEL = "Export this table to Excel with the AI assistant";

/** The mark's size and its inset from the table's corner, px. */
const SIZE = 24;
const INSET = 4;
/** A table smaller than this on screen carries no mark. */
const MIN_W = 160;
const MIN_H = 56;

interface Mark {
  id: number;
  top: number;
  left: number;
  /** In a dialog: the mark goes over it. */
  dialog: boolean;
}

/** The tables that may carry a mark: on the page or in a dialog, not the
 *  assistant's own (its answers' tables), not in a menu, not one inside another. */
function eligible(t: HTMLTableElement): boolean {
  return !t.closest(".ai-pop, [role=menu], [data-ai-skip]") && !t.parentElement?.closest("table") && t.rows.length > 1;
}

/** The box the table is seen in: its scroll frame, else the table itself. */
function frameOf(t: HTMLTableElement): Element {
  const p = t.parentElement;
  return p && p.matches(".overflow-x-auto, .overflow-auto, .dt") ? p : t;
}

/** The bar's foot: a mark never hides under it. */
function barBottom(): number {
  const bar = document.querySelector("body > header");
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

const ids = new WeakMap<HTMLTableElement, number>();
let nextId = 1;
const idOf = (t: HTMLTableElement) => {
  let id = ids.get(t);
  if (id === undefined) ids.set(t, (id = nextId++));
  return id;
};

/** Where each table's mark goes now. */
function measure(): { marks: Mark[]; tables: Map<number, HTMLTableElement> } {
  const marks: Mark[] = [];
  const tables = new Map<number, HTMLTableElement>();
  const floor = barBottom();
  // a dialog is drawn on the body, outside <main>
  for (const t of Array.from(document.querySelectorAll<HTMLTableElement>("main table, [role=dialog] table"))) {
    if (!eligible(t)) continue;
    const r = frameOf(t).getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) continue;
    const top = Math.max(r.top, floor) + INSET;
    const left = Math.min(r.right, document.documentElement.clientWidth) - SIZE - INSET;
    if (top + SIZE + INSET > Math.min(r.bottom, window.innerHeight) || left < r.left) continue;
    // something over the corner — the bar, a dialog, a menu, a sticky bar
    const hit = document.elementsFromPoint(left + SIZE / 2, top + SIZE / 2).find((e) => !e.closest("[data-table-ai]"));
    if (!hit || !frameOf(t).contains(hit)) continue;
    const id = idOf(t);
    tables.set(id, t);
    marks.push({ id, top: Math.round(top), left: Math.round(left), dialog: !!t.closest("[role=dialog]") });
  }
  return { marks, tables };
}

const same = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.top === b[i].top && m.left === b[i].left && m.dialog === b[i].dialog);

export function TableAiExport() {
  const ai = useAiPanel();
  const on = !!ai?.canAsk && !ai.aiPage;
  const [marks, setMarks] = useState<Mark[]>([]);
  const tables = useRef(new Map<number, HTMLTableElement>());
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!on || !main) return;
    document.documentElement.classList.add("table-ai-on");
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const m = measure();
        tables.current = m.tables;
        setMarks((cur) => (same(cur, m.marks) ? cur : m.marks));
      });
    };
    schedule();
    // a scroll anywhere (the page, a table's own frame), the window or the
    // page changing size, and tables, dialogs or menus coming or going — not
    // rows redrawn inside a table, nor the assistant writing its answer
    const resize = new ResizeObserver(schedule);
    resize.observe(main);
    const mutate = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Element) || !r.target.closest("table, .ai-pop, [data-table-ai]"))) schedule();
    });
    mutate.observe(document.body, { childList: true, subtree: true });
    // the assistant's chat scrolling as it writes moves no table
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest(".ai-pop"))) schedule();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutate.disconnect();
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", schedule);
      document.documentElement.classList.remove("table-ai-on");
    };
  }, [on]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);

  if (!on || !ai) return null;

  async function send(id: number) {
    const t = tables.current.get(id);
    if (!t || busy !== null || !ai) return;
    setNote(null);
    const [{ readScreenTable }, { TABLE_EXPORT_MAX_ROWS, tableCsv, tableExportQuestion, tableFileName, tidyTable }] = await Promise.all([import("@/lib/tableRead"), import("@/lib/domain/tableExport")]);
    const read = readScreenTable(t, TABLE_EXPORT_MAX_ROWS);
    if (read.cut) return setNote({ id, text: `This table shows more than ${TABLE_EXPORT_MAX_ROWS.toLocaleString("en-US")} rows — narrow it with the filters first.` });
    const table = tidyTable(read.table);
    if (table.rows.length === 0) return setNote({ id, text: "There is nothing in this table to export." });
    const title = tableTitle(t) || pageName();
    const file = new File([tableCsv(table)], tableFileName(title), { type: "text/csv" });
    if (file.size > AI_FILE_LIMITS.maxBytes) return setNote({ id, text: `This table comes to ${fileSizeText(file.size)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)}. Narrow it with the filters first.` });
    setBusy(id);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const r = await uploadAiFile(fd);
      if (!r.ok) return setNote({ id, text: r.error });
      ai.ask(tableExportQuestion({ title, page: pageName(), fileId: r.file.id, fileName: r.file.name, table }), { files: [r.file] });
    } catch {
      setNote({ id, text: "The table could not be sent to the assistant — try again." });
    } finally {
      setBusy(null);
    }
  }

  const noted = note && marks.find((m) => m.id === note.id);
  return (
    <div data-table-ai className="no-print">
      {/* the spot is fixed, so the tooltip measures the mark where it is */}
      {marks.map((m) => (
        <div key={m.id} className={`table-ai-spot ${m.dialog ? "table-ai-over" : ""}`} style={{ top: m.top, left: m.left }}>
          <Tooltip content={LABEL} side="bottom">
            <button
              type="button"
              className="table-ai"
              onClick={() => void send(m.id)}
              disabled={busy !== null}
              aria-busy={busy === m.id}
              aria-label={LABEL}
            >
              {busy === m.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Bot size={14} aria-hidden />}
            </button>
          </Tooltip>
        </div>
      ))}
      {noted && (
        <p className="tooltip table-ai-note" style={{ top: noted.top + SIZE + INSET, left: noted.left + SIZE }} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}
