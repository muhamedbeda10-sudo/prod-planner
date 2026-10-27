import { ClipboardCheck, FileText, Lightbulb, MessageSquare } from "lucide-react";
import type { InboxKind } from "@/lib/domain/inbox";

// How each kind of inbox item looks — its icon and colours — shared by the
// inbox's list and the popups on every page (kept apart from the list, whose
// Markdown and charts every page would otherwise carry).

export const INBOX_KIND_LOOK: Record<InboxKind, { icon: typeof FileText; tone: string; tile: string }> = {
  report: { icon: FileText, tone: "pill-info", tile: "bg-info-bg text-info-fg" },
  message: { icon: MessageSquare, tone: "pill-warn", tile: "bg-warn-bg text-warn-fg" },
  suggestion: { icon: Lightbulb, tone: "pill-ok", tile: "bg-ok-bg text-ok-fg" },
  task: { icon: ClipboardCheck, tone: "pill-muted", tile: "bg-surface-3 text-muted" },
};
