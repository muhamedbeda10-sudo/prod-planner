"use client";

import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { toneFor } from "@/lib/domain/tones";

// The small shared pieces every screen is built from: an empty state, a
// switch, a row of tabs, a settings row and a section card. One look for
// each, so the assistant's tabs, its settings and (later) the rest of the
// app read as one product. Styles live in globals.css under the same names.

type Icon = ComponentType<LucideProps>;
/** An icon as a component, or already rendered — a server component cannot
 *  hand a client component a function, so it passes the element instead. */
type IconProp = Icon | ReactElement;
const drawIcon = (icon: IconProp, size: number) => (isValidElement(icon) ? icon : (() => { const I = icon as Icon; return <I size={size} aria-hidden />; })());

/** Nothing here yet — an icon, a line that says so, and what to do about it. */
export function EmptyState({ icon, title, hint, action, compact = false }: { icon: IconProp; title: ReactNode; hint?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty ${compact ? "empty-compact" : ""}`}>
      <span className="empty-icon">{drawIcon(icon, compact ? 18 : 22)}</span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** On / off. */
export function Switch({ on, onChange, disabled, label, size = "md" }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`switch ${size === "sm" ? "switch-sm" : ""} ${on ? "switch-on" : ""}`}
    >
      <span className="switch-knob" />
    </button>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon?: Icon;
  count?: number;
}

/** A row of tabs under a line, the open one underlined in the brand green.
 *  `iconsOnly` names only the open tab (the docked panel is narrow). */
export function Tabs({ items, value, onChange, label, iconsOnly = false, fill = false, className = "", end }: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  iconsOnly?: boolean;
  /** The tabs share the row's width (a narrow window's few tabs). */
  fill?: boolean;
  className?: string;
  /** What sits at the end of the row (buttons). */
  end?: ReactNode;
}) {
  return (
    <div className={`tab-strip flex items-center gap-1 ${className}`}>
      <div role="tablist" aria-label={label} className={`no-scrollbar flex items-center min-w-0 ${fill ? "flex-1" : ""}`}>
        {items.map((t) => {
          const on = t.id === value;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.id)} title={t.label} className={`tab ${on ? "tab-active" : ""} ${iconsOnly && !on ? "tab-icon" : ""} ${fill ? "flex-1 justify-center" : ""}`}>
              {t.icon && <t.icon size={15} aria-hidden />}
              <span className={iconsOnly && !on ? "sr-only" : ""}>{t.label}</span>
              {t.count !== undefined && t.count > 0 && <span className="tab-count">{t.count > 99 ? "99+" : t.count}</span>}
            </button>
          );
        })}
      </div>
      {end && <div className="ms-auto flex items-center gap-0.5 shrink-0 ps-2">{end}</div>}
    </div>
  );
}

/** One setting: what it is and what it does on the left, its control on
 *  the right (below it on a phone, or always with `stack`). */
export function SettingRow({ title, hint, children, stack = false, align = "center" }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; stack?: boolean; align?: "center" | "start" }) {
  return (
    <div className={`setting-row ${stack ? "setting-row-stack" : ""} ${align === "start" ? "items-start" : ""}`}>
      <div className="min-w-0">
        <div className="setting-title">{title}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      {children !== undefined && <div className="setting-control">{children}</div>}
    </div>
  );
}

/** A card with a titled head: an icon, the title, a line under it, and
 *  whatever sits at the end of the head (a pill, a button). */
export function SectionCard({ icon, title, description, end, children, className = "", padded = true }: {
  icon?: IconProp;
  title: ReactNode;
  description?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`section-card ${className}`}>
      <header className="section-head" title={typeof description === "string" ? description : undefined}>
        {/* a tile in the card's own colour, steady across visits */}
        {icon && <span className={`section-icon tone-tile ${toneFor(typeof title === "string" ? title : "")}`}>{drawIcon(icon, 16)}</span>}
        {/* the title keeps room to read; actions that do not fit beside it
            (a phone) move under it instead of squeezing it to a word a line */}
        <div className="min-w-0 flex-[1_1_12rem]">
          <h3 className="section-title">{title}</h3>
          {description && <p className="section-desc">{description}</p>}
        </div>
        {end && <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">{end}</div>}
      </header>
      <div className={padded ? "px-4 pb-4 md:px-5 md:pb-5" : ""}>{children}</div>
    </section>
  );
}

/** What an action answered, under its control. */
export function Note({ msg, className = "" }: { msg: { ok: boolean; text: string } | null; className?: string }) {
  if (!msg) return null;
  return <p className={`text-xs font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"} ${className}`} role="status">{msg.text}</p>;
}

/** A card in the bottom-left corner that offers one thing — desktop alerts, a
 *  new version — with an icon, a line, what it means and its buttons. The
 *  caller picks the layer (`z-*`) and says what the card is to a screen reader:
 *  a dialog that asks, or a status (read out as it appears). */
export function CornerCard({ icon, title, children, actions, className = "", role, label }: {
  icon: IconProp;
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  className?: string;
  role: "dialog" | "status";
  label?: string;
}) {
  return (
    <div
      role={role}
      aria-label={label}
      className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] left-4 flex w-[min(360px,calc(100vw-2rem))] gap-3 rounded-xl border border-l-4 border-l-brand bg-surface p-3 text-foreground shadow-xl animate-[navdrop_0.2s_ease-out] motion-reduce:animate-none no-print ${className}`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-fill text-white">{drawIcon(icon, 17)}</span>
      <div className="min-w-0 flex-1">
        <b className="text-sm">{title}</b>
        <p className="mt-0.5 text-sm text-muted">{children}</p>
        <div className="mt-2 flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
