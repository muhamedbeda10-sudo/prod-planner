import type { ReactNode } from "react";
import { productColor } from "@/lib/domain/productColors";

/** The tones a badge can carry — status meanings only; the brand green is not
 *  one of them (it marks actions and the active tab, not states). */
export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<BadgeTone, string> = {
  success: "pill-ok",
  warning: "pill-warn",
  danger: "pill-bad",
  info: "pill-info",
  neutral: "pill-muted",
};

/**
 * The one badge: a single line, 20px tall, never wrapping or stacking. A long
 * label is cut with an ellipsis and its full text goes in the title. An icon,
 * when given, sits before the label — a status never rests on colour alone.
 */
export function Badge({
  tone = "neutral",
  icon,
  title,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`pill ${TONE_CLASS[tone]} max-w-full ${className}`} title={title}>
      {icon && <span className="shrink-0 inline-flex" aria-hidden>{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The workflow statuses the app shows, and the tone each one reads in. A
 *  status not listed reads neutral. Display only — what counts as done is the
 *  domain's (lib/domain/odoo.ts statusTone), not this table's. */
export const WORKFLOW_TONE: Record<string, BadgeTone> = {
  "mo to be close": "warning",
  "mo to be closed": "warning",
  pending: "warning",
  done: "success",
  closed: "neutral",
  open: "info",
  "not closed": "danger",
  urgent: "danger",
  blocked: "danger",
  cancelled: "neutral",
  canceled: "neutral",
  "n/a": "neutral",
};

export function workflowTone(status: string | null | undefined): BadgeTone {
  return WORKFLOW_TONE[String(status ?? "").trim().toLowerCase()] ?? "neutral";
}

/** A workflow status as its badge, in its tone. */
export function StatusBadge({ status, title, className }: { status: string; title?: string; className?: string }) {
  return (
    <Badge tone={workflowTone(status)} title={title ?? status} className={className}>
      {status}
    </Badge>
  );
}

/** A product's colour key: the swatch every page draws beside its name. */
export function ProductSwatch({ product, className = "" }: { product: string; className?: string }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-[3px] shrink-0 ${className}`} style={{ background: productColor(product) }} aria-hidden />;
}
