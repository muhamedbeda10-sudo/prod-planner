"use client";

import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";

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
export function EmptyState({ icon, title, hint, action, compact = false }: { icon: IconProp; title: string; hint?: ReactNode; action?: ReactNode; compact?: boolean }) {
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
export function Tabs({ items, value, onChange, label, iconsOnly = false, className = "", end }: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  iconsOnly?: boolean;
  className?: string;
  /** What sits at the end of the row (buttons). */
  end?: ReactNode;
}) {
  return (
    <div className={`tab-strip flex items-center gap-1 ${className}`}>
      <div role="tablist" aria-label={label} className="no-scrollbar flex items-center min-w-0">
        {items.map((t) => {
          const on = t.id === value;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.id)} title={t.label} className={`tab ${on ? "tab-active" : ""} ${iconsOnly && !on ? "tab-icon" : ""}`}>
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
      <header className="section-head">
        {icon && <span className="section-icon">{drawIcon(icon, 16)}</span>}
        <div className="min-w-0 flex-1">
          <h3 className="section-title">{title}</h3>
          {description && <p className="section-desc">{description}</p>}
        </div>
        {end && <div className="flex items-center gap-2 shrink-0">{end}</div>}
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
