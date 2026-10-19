// The workers list's stored shape: a CSV of section codes. Pure, so the
// parse and the serialize can be tested without a database.

import { LEGACY_SECTION, WORKER_SECTIONS, isWorkerSection, sectionDept, type WorkerDept, type WorkerSection } from "./tanks";

/** Parse the stored CSV of sections, dropping anything unknown; a bare
 *  department stored before the sections existed reads as its first section. */
export function parseWorkerSections(csv: string | null | undefined): WorkerSection[] {
  const seen = new Set<string>();
  const out: WorkerSection[] = [];
  for (const raw of String(csv ?? "").split(",")) {
    const d = raw.trim();
    const code = isWorkerSection(d) ? d : LEGACY_SECTION[d];
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/** Serialize a chosen set of sections back to the stored CSV, in the fixed
 *  order of WORKER_SECTIONS so the value is stable however the form was ticked. */
export function serializeWorkerDepts(sections: Iterable<string>): string {
  const chosen = new Set([...sections].map((d) => d.trim()));
  return WORKER_SECTIONS.filter((s) => chosen.has(s.code)).map((s) => s.code).join(",");
}

/** The departments a worker's sections record on — what the dropdowns and the
 *  shift log ask for — each once, in the order of the sections. */
export function workerDepts(sections: readonly WorkerSection[]): WorkerDept[] {
  return [...new Set(sections.map(sectionDept))];
}
