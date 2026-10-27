"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { PrintHeader } from "@/components/PrintHeader";
import { formatDateTime } from "@/lib/domain/format";

// One AI report or answer on paper — or a PDF through the print dialog —
// alone, under the company's header, its charts drawn as they are on screen.
// The sheet is laid out off screen first (a chart needs a width to draw at),
// then it is the only thing printed (globals.css: html.ai-printing), and it
// goes away when the dialog closes.

export function AiPrintButton({ title, subtitle, date, text, className = "" }: {
  title: string;
  subtitle?: string;
  /** The day it was issued — the moment it is printed when not given. */
  date?: string;
  text: string;
  className?: string;
}) {
  // the date the sheet carries while it is printing, null otherwise
  const [printing, setPrinting] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm btn-ghost no-print ${className}`}
        onClick={() => setPrinting(date ?? formatDateTime(new Date()))}
        disabled={printing !== null}
        title="Print it, or save it as a PDF, with the company header"
      >
        <Printer size={14} aria-hidden /> Print / PDF
      </button>
      {printing !== null && createPortal(<PrintSheet title={title} subtitle={subtitle} date={printing} text={text} onDone={() => setPrinting(null)} />, document.body)}
    </>
  );
}

/** Once what is about to print is drawn — its images (the logo) loaded and
 *  laid out — so the print dialog never freezes a half-drawn page. */
export async function drawn(root: ParentNode | null): Promise<void> {
  const imgs = [...(root?.querySelectorAll("img") ?? [])];
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 200));
}

function PrintSheet({ title, subtitle, date, text, onDone }: { title: string; subtitle?: string; date: string; text: string; onDone: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("ai-printing");
    let printed = false;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) done.current();
    };
    // the dialog closing — and, where a browser does not say so, the next
    // touch of the page after it
    const media = window.matchMedia("print");
    const onMedia = (e: MediaQueryListEvent) => {
      if (!e.matches && printed) finish();
    };
    const onTouch = () => {
      if (printed) finish();
    };
    window.addEventListener("afterprint", finish);
    media.addEventListener("change", onMedia);
    window.addEventListener("pointerdown", onTouch);
    window.addEventListener("keydown", onTouch);

    (async () => {
      await drawn(sheet.current);
      if (cancelled) return;
      printed = true;
      window.print();
    })();

    return () => {
      cancelled = true;
      html.classList.remove("ai-printing");
      window.removeEventListener("afterprint", finish);
      media.removeEventListener("change", onMedia);
      window.removeEventListener("pointerdown", onTouch);
      window.removeEventListener("keydown", onTouch);
    };
  }, []);

  return (
    <div ref={sheet} className="ai-print-sheet" aria-hidden>
      <PrintHeader title={title} subtitle={subtitle} date={date} />
      <AiMarkdown text={text} className="ai-answer" />
    </div>
  );
}
