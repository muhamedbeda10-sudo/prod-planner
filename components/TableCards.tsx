"use client";

import { useEffect } from "react";

// On a phone a list table (`table.table-cards`) reads as cards: each row a
// card, each cell its column's name over its value (app/globals.css). The
// names come from the table's own header, written onto the cells as
// `data-label` — so a table opts in with the class alone, and a row added,
// re-sorted or filtered is labelled as it lands. Wider screens keep the table.

const TABLES = "main table.table-cards";

/** React has taken the element over — touching server-rendered markup before
 *  then is a hydration mismatch, so such a table waits for the next pass. */
const hydrated = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"));

/** Each column's name: the lowest header cell over it, its group's name in
 *  front when the group says more than the cell ("CF · Fab"). */
function columnNames(table: HTMLTableElement): string[] {
  const names: string[] = [];
  const rows = table.tHead ? [...table.tHead.rows] : [];
  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells) {
      const text = (cell.getAttribute("aria-label") ?? cell.textContent ?? "").replace(/\s+/g, " ").trim();
      for (let k = 0; k < cell.colSpan; k++) {
        const above = names[col + k];
        names[col + k] = above && text && above !== text && cell.colSpan === 1 && rows.length > 1 ? `${above} · ${text}` : text || above || "";
      }
      col += cell.colSpan;
    }
  }
  return names;
}

function label(table: HTMLTableElement) {
  const names = columnNames(table);
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      let col = 0;
      for (const cell of row.cells) {
        const name = cell.colSpan > 1 ? "" : names[col] ?? "";
        if (cell.getAttribute("data-label") !== name) cell.setAttribute("data-label", name);
        col += cell.colSpan;
      }
    }
  }
}

/** Mounted once in the layout, inside <main>; renders nothing. */
export function TableCards() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    let frame = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      frame = 0;
      let waiting = false;
      for (const t of main.querySelectorAll<HTMLTableElement>(TABLES)) {
        if (hydrated(t)) label(t);
        else waiting = true;
      }
      // a page hydrates after the layout, and hydrating moves no node: look again
      clearTimeout(retry);
      if (waiting) retry = setTimeout(run, 250);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    run();
    // a row's own attribute writes are not watched — only rows and text coming and going
    const mo = new MutationObserver(schedule);
    mo.observe(main, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); if (frame) cancelAnimationFrame(frame); clearTimeout(retry); };
  }, []);
  return null;
}
