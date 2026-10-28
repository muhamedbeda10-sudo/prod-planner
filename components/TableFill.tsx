"use client";

import { useEffect } from "react";

// A table scrolls inside its own frame, which app/globals.css caps at a share
// of the screen. Where the frame is the page's last block — the table a page
// is about — that cap stopped it short of the window's bottom edge. This lets
// that one frame down to the bottom instead (--fill-h), so the page fits the
// window and the table runs to its foot. A frame with less room than that
// (charts or cards above it, more blocks under it) keeps the cap and the page
// scrolls, as before; so does one that sets its own max-h-*, sits in another
// scroller or a dialog. Only the last frame is ever let down: the room of one
// above it would hang on the height of the one below.

/** Less room than this share of the window: keep the cap. */
const MIN_SHARE = 0.5;
const FRAME = "div.overflow-x-auto";

function scrollsInside(el: HTMLElement, main: HTMLElement): boolean {
  for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.position === "fixed" || /auto|scroll/.test(s.overflowY)) return true;
  }
  return false;
}

/** React has taken the element over. A page streams in and hydrates after the
 *  layout does: touching its server-rendered markup before then is a
 *  hydration mismatch, so such a frame waits for the next pass. */
const hydrated = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"));

/** Sizes the page's last frame; true when it is still waiting to be hydrated. */
function fit(main: HTMLElement, force: boolean): boolean {
  const frames = [...main.querySelectorAll<HTMLElement>(FRAME)].filter((el) => el.querySelector(":scope > table"));
  const last = frames.findLast((el) => el.offsetParent !== null && !/(^|\s|:)max-h-/.test(el.className) && !scrollsInside(el, main));
  if (last && !force && !hydrated(last)) return true;
  for (const el of frames) if (el !== last) el.style.removeProperty("--fill-h");
  if (!last) return false;

  // where the page's content ends — main itself stretches to the window when
  // the page is short, so its own bottom would only measure the stretch
  let contentBottom = main.getBoundingClientRect().top;
  for (const c of main.children) {
    // fixed windows (the assistant, the inbox) and hidden blocks have no offsetParent
    if (c instanceof HTMLElement && c.offsetParent !== null) contentBottom = Math.max(contentBottom, c.getBoundingClientRect().bottom);
  }
  const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
  const r = last.getBoundingClientRect();
  // with the page scrolled to its top: the window under the frame's top,
  // less whatever the page carries below it
  const room = window.innerHeight - (r.top + window.scrollY) - (contentBottom - r.bottom) - padBottom;
  if (room >= window.innerHeight * MIN_SHARE) last.style.setProperty("--fill-h", `${Math.floor(room)}px`);
  else last.style.removeProperty("--fill-h");
  return false;
}

/** A change that can bring or take a table: not a cell typed in, nor
 *  anything in the assistant's or the inbox's window. */
function movesTables(records: MutationRecord[]): boolean {
  return records.some((m) => {
    if (m.target instanceof Element && m.target.closest(".ai-pop")) return false;
    return [...m.addedNodes, ...m.removedNodes].some((n) => n instanceof Element && (n.matches(FRAME) || !!n.querySelector(FRAME)));
  });
}

const RETRY_MS = 250;
/** A frame still not hydrated after this many passes is left as it is. */
const RETRIES = 40;

/** Mounted once in the layout, inside <main>; renders nothing. */
export function TableFill() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    // <main> is hydrated before this runs; were React to stop marking what it
    // owns, nothing would ever count as hydrated — so then nothing waits
    const force = !hydrated(main);
    let frame = 0;
    let retry = 0;
    let retries = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!fit(main, force)) retries = 0;
        // hydrating changes nothing the observers below would see
        else if (!retry && retries < RETRIES) {
          retries++;
          retry = window.setTimeout(() => { retry = 0; schedule(); }, RETRY_MS);
        }
      });
    };
    schedule();
    // the page's content changing size (a filter bar wrapping, a new page),
    // a table coming or going and the window resizing all move the room left
    const resize = new ResizeObserver(schedule);
    resize.observe(main);
    const mutate = new MutationObserver((records) => { if (movesTables(records)) schedule(); });
    mutate.observe(main, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      resize.disconnect();
      mutate.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return null;
}
