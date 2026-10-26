"use client";

import { useEffect, useRef } from "react";
import type { AiTarget } from "@/lib/domain/aiExplain";

// What "Ask AI" explains: the thing under the pointer, read off the page. A
// card that knows more about itself than it shows (a chart's numbers, the
// note on how it is counted) registers that here with `useAiTarget`; the
// rest is read from the page as it stands — a table row by its column
// headers, anything else by its own text. A server-rendered card says the
// same in attributes: data-ai-title, and data-ai-about for its note. Plain DOM reading, no figures of
// its own: the question built from it (lib/domain/aiExplain) asks the
// assistant to check them.

type Registered = Omit<AiTarget, "within" | "column" | "fields">;

const registry = new WeakMap<Element, Registered>();

/** Put on a card's outer element: right-click anywhere in it explains the
 *  card, with what `info` carries beyond its visible text. */
export function useAiTarget<T extends HTMLElement>(info: Registered) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    registry.set(el, info);
    return () => { registry.delete(el); };
  });
  return ref;
}

const text = (el: Element | null | undefined) => (el instanceof HTMLElement ? el.innerText : el?.textContent ?? "").replace(/\s+/g, " ").trim();
const firstLine = (s: string) => s.split(/\n+/).map((l) => l.trim()).find(Boolean) ?? "";

/** The nearest card that says what it is: one made with `useAiTarget` (a
 *  chart, a tile — explained whole), or a section marked in attributes (a
 *  board — whose own cards and rows are explained one by one, in it). */
function registeredAbove(el: Element): { el: Element; info: Registered; section: boolean } | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const info = registry.get(n);
    if (info) return { el: n, info, section: false };
    const title = n.getAttribute("data-ai-title");
    if (title) return { el: n, info: { kind: "figure", title, about: n.getAttribute("data-ai-about") ?? undefined }, section: true };
  }
  return null;
}

/** A table's column names, by cell position: each column's lowest header
 *  cell, a group's name before its own ("Welding · Done") — header rows laid
 *  out as the browser does, cells spanning rows and columns taken in. */
function headers(table: HTMLTableElement): { names: string[]; colOf: Map<Element, number> } {
  const rows = table.tHead ? Array.from(table.tHead.rows) : [];
  const grid: string[][] = rows.map(() => []);
  const colOf = new Map<Element, number>();
  rows.forEach((tr, r) => {
    let col = 0;
    for (const c of Array.from(tr.cells)) {
      while (grid[r][col] !== undefined) col++;
      colOf.set(c, col);
      const name = text(c);
      for (let dr = 0; dr < Math.max(1, c.rowSpan) && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < Math.max(1, c.colSpan); dc++) grid[r + dr][col + dc] = name;
      }
      col += Math.max(1, c.colSpan);
    }
  });
  const width = Math.max(0, ...grid.map((g) => g.length));
  const names = Array.from({ length: width }, (_, col) => {
    const parts: string[] = [];
    for (const g of grid) {
      const n = g[col];
      if (n && parts.at(-1) !== n) parts.push(n);
    }
    return parts.join(" · ");
  });
  return { names, colOf };
}

/** The cell of a row at a column position, spans counted. */
function cellAt(tr: HTMLTableRowElement, col: number): HTMLTableCellElement | null {
  let at = 0;
  for (const c of Array.from(tr.cells)) {
    const span = Math.max(1, c.colSpan);
    if (col < at + span) return c;
    at += span;
  }
  return null;
}

/** A column's first values, one a line. */
function columnValues(table: HTMLTableElement, col: number, max = 25): string {
  const out: string[] = [];
  for (const body of Array.from(table.tBodies)) {
    for (const tr of Array.from(body.rows)) {
      const v = text(cellAt(tr, col));
      if (v) out.push(v);
      if (out.length >= max) return out.join("\n");
    }
  }
  return out.join("\n");
}

/** The name of the card or block a table sits in: a registered card's
 *  title, else the nearest heading above it inside its section. */
function nameAround(el: Element): string | undefined {
  const reg = registeredAbove(el);
  if (reg) return reg.info.title;
  const box = el.closest("section, [role=dialog], article");
  const h = box?.querySelector("h2, h3, h4, [role=heading]");
  return h ? text(h) || undefined : undefined;
}

/** The blocks an item reads as one: a list entry, a card, a form's field. */
const BLOCK = "li, button, a[href], label, dt, dd, [role=button], [role=row], [role=listitem], fieldset, details, section, article, [role=dialog]";
/** A block, or a card drawn as one (a bordered, rounded box). */
const isBlock = (n: Element) => n.matches(BLOCK) || (n.classList.contains("border") && /\brounded/.test(n.getAttribute("class") ?? ""));
/** Further up than this the "item" is the page itself. */
const MAX_ITEM_TEXT = 1500;

/** What a right-click at `el` is about — null where there is nothing to
 *  explain (the assistant's own window, an open menu). */
export function readAiTarget(el: Element | null): AiTarget | null {
  if (!el || el.closest(".ai-pop, [role=menu], [data-ai-skip]")) return null;
  const reg = registeredAbove(el);

  // a table: its header names the column, its row the record
  const cell = el.closest<HTMLTableCellElement>("td, th");
  const tr = cell?.closest<HTMLTableRowElement>("tr");
  const table = tr?.closest<HTMLTableElement>("table");
  if (cell && tr && table && (!reg || reg.el.contains(table))) {
    const { names, colOf } = headers(table);
    const within = nameAround(table);
    // the card the table is in says how it is counted
    const about = reg?.info.about;
    let col = 0;
    for (const c of Array.from(tr.cells)) {
      if (c === cell) break;
      col += Math.max(1, c.colSpan);
    }
    if (tr.parentElement?.tagName === "THEAD") {
      const at = colOf.get(cell) ?? col;
      return { kind: "column", title: (cell.colSpan > 1 ? text(cell) : names[at]) || text(cell) || "Column", within, about, text: columnValues(table, at) };
    }
    const fields: [string, string][] = [];
    let at = 0;
    for (const c of Array.from(tr.cells)) {
      const v = text(c);
      if (v) fields.push([names[at] ?? "", v]);
      at += Math.max(1, c.colSpan);
    }
    const title = fields.find(([, v]) => v.length > 1)?.[1] ?? "Row";
    return { kind: "row", title, within, about, column: names[col] || undefined, fields };
  }

  // a card or entry inside a marked section: that one, read in the section's light
  if (reg?.section) {
    for (let n: Element | null = el; n && n !== reg.el; n = n.parentElement) {
      if (!isBlock(n)) continue;
      const t = n instanceof HTMLElement ? n.innerText.trim() : "";
      if (t.length >= 2 && t.length <= MAX_ITEM_TEXT) return { kind: "item", title: firstLine(t).slice(0, 160), within: reg.info.title, about: reg.info.about, text: t };
    }
  }

  if (reg) {
    const shown = reg.el instanceof HTMLElement ? reg.el.innerText : "";
    return { ...reg.info, text: reg.info.text ?? shown };
  }

  // anything else: the smallest block around it with something to say
  for (let n: Element | null = el.closest(BLOCK) ?? el; n && n !== document.body; n = n.parentElement) {
    if (n.tagName === "MAIN" || n.tagName === "NAV" || n.tagName === "HEADER") break;
    const t = n instanceof HTMLElement ? n.innerText.trim() : "";
    if (t.length > MAX_ITEM_TEXT) break;
    if (t.length >= 2) return { kind: "item", title: firstLine(t).slice(0, 160), within: nameAround(n), text: t };
  }
  const page = pageName();
  return page ? { kind: "page", title: page } : null;
}

/** The page's name — the screen-reader heading every page carries. */
export function pageName(): string {
  const h = document.querySelector("main h1");
  return h?.textContent?.replace(/\s+/g, " ").trim() || document.title;
}
