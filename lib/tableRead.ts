"use client";

import { tableHeaders } from "@/lib/aiTarget";
import { type ScreenTable } from "@/lib/domain/tableExport";

// A table read off the page as it shows now — for "Export to Excel with AI"
// (components/TableAiExport): its column names from its head, and every row
// it shows, its filters and sort applied. Plain DOM reading, no figures of
// its own: what a cell shows is what goes in the file.

/** A cell's text as the screen shows it: a field by its value, a ticked box
 *  as ✓, what is hidden from a screen reader (an icon, a hint's "?") left out,
 *  and its parts apart ("Owner you", not "Owneryou" — a badge is its own). */
function shownText(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (!(n instanceof Element) || n.getAttribute("aria-hidden") === "true" || n.matches("script, style, template")) return;
    if (n instanceof HTMLInputElement) {
      if (n.type === "checkbox" || n.type === "radio") out += n.checked ? " ✓ " : " ";
      else if (n.type !== "hidden" && n.type !== "button" && n.type !== "submit" && n.type !== "file") out += ` ${n.value} `;
      return;
    }
    if (n instanceof HTMLSelectElement) {
      out += ` ${n.selectedOptions[0]?.text ?? ""} `;
      return;
    }
    if (n instanceof HTMLTextAreaElement) {
      out += ` ${n.value} `;
      return;
    }
    out += " ";
    for (const c of Array.from(n.childNodes)) walk(c);
    out += " ";
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

/** A header cell's name: a sheet header's full name (its label is the short
 *  one), else what it shows. The band over the headers names no column. */
function headName(c: HTMLTableCellElement): string {
  if (c.parentElement?.classList.contains("dt-band")) return "";
  return (c.classList.contains("dt-th") && c.getAttribute("aria-label")) || shownText(c);
}

/** A row the screen hides (a filter's, a folded group's), or one that is no
 *  data (an add-a-row line). */
const skipped = (tr: HTMLTableRowElement) => tr.hidden || tr.getClientRects().length === 0 || tr.matches(".no-print, [data-ai-skip]");

/** The table as it shows now. A row that is one cell across the table is a
 *  group's heading: it goes in a Group column on the rows under it. A cell
 *  spanning rows (a merged order) is repeated on each, so the sheet filters
 *  right. `cut`: rows past `max` were not read. */
export function readScreenTable(table: HTMLTableElement, max: number): { table: ScreenTable; cut: boolean } {
  let head = table.tHead ? Array.from(table.tHead.rows) : [];
  const all = Array.from(table.rows).filter((tr) => !head.includes(tr));
  // no <thead>: a first row of header cells is the head
  if (head.length === 0 && all[0] && Array.from(all[0].cells).every((c) => c.tagName === "TH")) head = [all.shift()!];
  const { names } = tableHeaders(table, headName, head);
  const width = all.slice(0, 50).reduce((w, tr) => Math.max(w, Array.from(tr.cells).reduce((n, c) => n + Math.max(1, c.colSpan), 0)), names.length);

  const rows: string[][] = [];
  const groups: string[] = [];
  let group = "";
  let hasGroups = false;
  // a cell spanning rows, carried down column by column: its text and the
  // rows it still covers (a hidden row among them counts too)
  const carry = new Map<number, { text: string; left: number }>();
  const tick = () => {
    for (const [at, c] of carry) if (--c.left <= 0) carry.delete(at);
  };
  let cut = false;
  for (const tr of all) {
    // a footer's Total is no row of data: the assistant adds one when asked
    if (tr.parentElement?.tagName === "TFOOT") continue;
    if (skipped(tr)) {
      tick();
      continue;
    }
    const cells = Array.from(tr.cells);
    if (width > 2 && cells.length === 1 && cells[0].colSpan >= width - 1) {
      group = shownText(cells[0]);
      if (group) hasGroups = true;
      carry.clear();
      continue;
    }
    if (rows.length >= max) {
      cut = true;
      break;
    }
    const row: string[] = [];
    const covered = new Set(carry.keys());
    for (const at of covered) row[at] = carry.get(at)!.text;
    let col = 0;
    for (const c of cells) {
      while (covered.has(col)) col++;
      const t = shownText(c);
      const span = Math.max(1, c.colSpan);
      for (let dc = 0; dc < span; dc++) {
        row[col + dc] = dc === 0 ? t : "";
        if (c.rowSpan > 1) carry.set(col + dc, { text: dc === 0 ? t : "", left: c.rowSpan });
      }
      col += span;
    }
    tick();
    rows.push(Array.from({ length: Math.max(width, row.length) }, (_, i) => row[i] ?? ""));
    groups.push(group);
  }
  if (!hasGroups) return { table: { columns: names, rows }, cut };
  return { table: { columns: ["Group", ...names], rows: rows.map((r, i) => [groups[i], ...r]) }, cut };
}
