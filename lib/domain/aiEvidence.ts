export interface AiEvidence {
  id: string;
  title: string;
  recordedAt: string;
  links: { label: string; href: string }[];
  snapshot: string;
  truncated: boolean;
}

export const evidenceAnchor = (id: string) => `ai-source-${id}`;
export const isEvidenceAnchor = (href: string) => /^#ai-source-[A-Za-z0-9_-]{1,180}$/.test(href);
export const safeHref = (href: string) => href.startsWith("/") && !href.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(href) && href.length <= 500;
const MAX_SNAPSHOT = 16_000;

/** The wrapper is produced by the agent, never by the model or a database row. */
export function readEvidence(id: string, title: string, text: string, links: AiEvidence["links"], recordedAt = new Date().toISOString()) {
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* sentence results remain sentences */ }
  const source = {
    id, title: title.slice(0, 200), recordedAt,
    citation: `#${evidenceAnchor(id)}`,
    links: links.filter((link) => safeHref(link.href)).slice(0, 20),
  };
  const content = JSON.stringify({ data, source });
  const snapshot = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const evidence: AiEvidence = { id: source.id, title: source.title, recordedAt: source.recordedAt, links: source.links, snapshot: snapshot.slice(0, MAX_SNAPSHOT), truncated: snapshot.length > MAX_SNAPSHOT };
  return { content, evidence, data };
}

/** Restores the same source cards after reopening a kept conversation. */
export function evidenceFromContent(content: unknown, toolUseId: string): AiEvidence | null {
  if (typeof content !== "string" || content.length > 1_000_000) return null;
  try {
    const value = JSON.parse(content) as { source?: Partial<AiEvidence>; data?: unknown };
    const source = value.source;
    if (!source || source.id !== toolUseId || !/^[A-Za-z0-9_-]{1,180}$/.test(toolUseId) || typeof source.title !== "string" || typeof source.recordedAt !== "string" || !Number.isFinite(Date.parse(source.recordedAt))) return null;
    const links = Array.isArray(source.links) ? source.links.filter((link) => typeof link?.label === "string" && typeof link.href === "string" && safeHref(link.href)).slice(0, 20) : [];
    const snapshot = typeof value.data === "string" ? value.data : JSON.stringify(value.data, null, 2) ?? "";
    return { id: toolUseId, title: source.title.slice(0, 200), recordedAt: source.recordedAt, links, snapshot: snapshot.slice(0, MAX_SNAPSHOT), truncated: snapshot.length > MAX_SNAPSHOT };
  } catch { return null; }
}

export function isAiEvidence(raw: unknown): raw is AiEvidence {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as AiEvidence;
  return typeof e.id === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(e.id) && typeof e.title === "string" && e.title.length <= 200 && typeof e.recordedAt === "string" && Number.isFinite(Date.parse(e.recordedAt)) && typeof e.snapshot === "string" && e.snapshot.length <= MAX_SNAPSHOT && typeof e.truncated === "boolean" && Array.isArray(e.links) && e.links.length <= 20 && e.links.every((link) => typeof link?.label === "string" && typeof link.href === "string" && safeHref(link.href));
}
