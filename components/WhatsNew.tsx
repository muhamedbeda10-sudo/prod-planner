"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Modal } from "@/components/Modal";
import { saveUserPref } from "@/app/prefs/actions";
import { WHATS_NEW, unseenCount } from "@/lib/domain/whatsNew";
import { formatDate } from "@/lib/domain/format";

/** ✨ What's new — the bar's button, with the count of entries this person
 *  has not opened the list on yet. Opening it marks them all seen (on the
 *  account, so it holds on any computer). */
export function WhatsNew({ seen }: { seen: string | null }) {
  const [open, setOpen] = useState(false);
  const [seenId, setSeenId] = useState(seen);
  const count = unseenCount(seenId);
  const show = () => {
    setOpen(true);
    const newest = WHATS_NEW[0]?.id;
    if (newest && newest !== seenId) {
      setSeenId(newest);
      void saveUserPref("whatsnew:seen", newest);
    }
  };
  const fresh = new Set(WHATS_NEW.slice(0, unseenCount(seen)).map((e) => e.id));
  return (
    <>
      <button
        type="button"
        onClick={show}
        className="nav-tab nav-tab-icon relative flex items-center"
        aria-label={count > 0 ? `What's new — ${count} new` : "What's new"}
        title={count > 0 ? `What's new — ${count} new` : "What's new in the app"}
      >
        <Sparkles size={18} />
        {count > 0 && <span className="count-badge count-badge-alert absolute -top-1 -end-1">{count}</span>}
      </button>
      {open && (
        <Modal title="✨ What's new" sub="What changed in the app, newest first." onClose={() => setOpen(false)} width="max-w-2xl">
          <ol className="space-y-3 max-h-[65vh] overflow-y-auto pe-1">
            {WHATS_NEW.map((e) => (
              <li key={e.id} className={`rounded-lg border px-3 py-2.5 ${fresh.has(e.id) ? "border-brand/50 bg-brand-light/30" : ""}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-bold">{e.title}</span>
                  {fresh.has(e.id) && <span className="pill pill-ok text-[10px]">new</span>}
                  <span className="ms-auto text-xs text-muted tabnum">{formatDate(e.dateISO)}</span>
                </div>
                <div className="text-xs text-muted mt-0.5">{e.where}</div>
                <p className="text-sm mt-1">{e.body}</p>
                {e.href && <Link href={e.href} onClick={() => setOpen(false)} className="text-xs font-semibold text-accent hover:underline">Open →</Link>}
              </li>
            ))}
          </ol>
        </Modal>
      )}
    </>
  );
}
