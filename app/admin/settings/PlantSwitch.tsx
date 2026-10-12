"use client";

import { useState, useTransition, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import type { LucideProps } from "lucide-react";
import { Note, SectionCard, SettingRow, Switch } from "@/components/primitives";

// One plant-wide switch as a card: what it is, its state, the switch — and,
// folded under it, exactly what changes on each side, so whoever flips it
// reads it here without going to find someone.

export function PlantSwitch({
  icon,
  title,
  description,
  rowTitle,
  rowHint,
  initialOn,
  action,
  confirmOff,
  onText,
  offText,
  whileOn,
  whileOff,
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  description: string;
  /** The switch's own line: what turning it on does, in one sentence. */
  rowTitle: string;
  rowHint: string;
  initialOn: boolean;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
  /** Asked before turning it off — a switch that changes what the floor does. */
  confirmOff?: string;
  onText: string;
  offText: string;
  whileOn: string[];
  whileOff: string[];
}) {
  const router = useRouter();
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function flip(next: boolean) {
    if (!next && confirmOff && !window.confirm(confirmOff)) return;
    const fd = new FormData();
    fd.set("on", String(next));
    setMsg(null);
    startTransition(async () => {
      const res = await action(fd);
      if (res.ok) {
        setOn(next);
        setMsg({ ok: true, text: next ? onText : offText });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Failed to save." });
      }
    });
  }

  return (
    <SectionCard icon={icon} title={title} description={description} end={<span className={`pill ${on ? "pill-ok" : "pill-muted"}`}>{on ? "On" : "Off"}</span>}>
      <SettingRow
        title={rowTitle}
        hint={
          <>
            {rowHint}
            <Note msg={msg} className="mt-1" />
          </>
        }
      >
        <span className={`text-xs font-bold ${on ? "text-ok-fg" : "text-muted"}`}>{pending ? "Saving…" : on ? "On" : "Off"}</span>
        <Switch on={on} disabled={pending} onChange={flip} label={title} />
      </SettingRow>
      <details className="mt-3 border-t pt-3 text-sm">
        <summary className="filter-label cursor-pointer select-none hover:text-foreground">What it changes</summary>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mt-3">
          <div>
            <div className="text-xs font-bold mb-1.5 text-ok-fg">While it is on</div>
            <ul className="text-muted space-y-1 list-disc ps-4">
              {whileOn.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
          <div>
            <div className="text-xs font-bold mb-1.5">While it is off</div>
            <ul className="text-muted space-y-1 list-disc ps-4">
              {whileOff.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        </div>
      </details>
    </SectionCard>
  );
}
