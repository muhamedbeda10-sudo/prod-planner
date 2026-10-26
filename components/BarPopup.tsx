"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Modal } from "@/components/Modal";

// A page bar's icon button that opens a popup — for what a page has to say
// beside its figures (what is worth a look, how far the data goes), so the
// page itself carries only the figures. The icon takes the tone of the worst
// news inside, the badge how many; the same pattern as the Interventions
// button (CockpitDecisions).

const TONE = { bad: "text-bad-fg", warn: "text-warn-fg", info: "text-info-fg", ok: "text-ok-fg" } as const;

export function BarPopup({ icon: Icon, label, title, sub, tone, count, width = "max-w-3xl", children }: {
  icon: LucideIcon;
  /** The button's word. */
  label: string;
  /** The popup's heading. */
  title: string;
  sub?: string;
  tone: keyof typeof TONE;
  /** How many items inside need a look; nothing shown at 0. */
  count?: number;
  width?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const aria = count ? `${label}: ${count} to look at` : label;
  return (
    <>
      <button type="button" className="no-print btn btn-secondary btn-sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={aria} title={aria}>
        <Icon size={14} className={TONE[tone]} aria-hidden />
        {/* the icon alone on a phone, so the bar keeps one row */}
        <span className="hidden sm:inline">{label}</span>
        {count ? <span className={`count-badge ${tone === "bad" ? "count-badge-alert" : "count-badge-warn"}`} aria-hidden>{count > 99 ? "99+" : count}</span> : null}
      </button>
      {open && (
        <Modal title={title} sub={sub} onClose={() => setOpen(false)} width={width} focusField={false}>
          {children}
        </Modal>
      )}
    </>
  );
}
