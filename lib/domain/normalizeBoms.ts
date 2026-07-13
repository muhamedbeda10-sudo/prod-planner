// BOM normalization — pure port of modBoms.NormalizeBoms classification.
//
// Given the set of known BOM codes (from Plan Orders), classify any entered code:
//   known     — exact match (green/none)
//   corrected — unknown, but exactly one known code shares its prefix -> auto-correct
//   ambiguous — unknown, several known codes share its prefix -> needs review (red)
//   unknown   — no known code shares its prefix -> needs review (red)
//
// The spec applies this AT ENTRY TIME: a single candidate auto-corrects with a
// visible badge; unknown/ambiguous codes are flagged/blocked instead of silently
// "fixed" later.

import { bomPrefix } from "./bom";

export type BomStatus = "known" | "corrected" | "ambiguous" | "unknown";

export interface BomClassification {
  input: string;
  clean: string; // trimmed, CR/LF stripped
  status: BomStatus;
  corrected?: string; // the code to use when status === "corrected"
  candidates: string[]; // matches sharing the prefix (for ambiguous)
  message: string;
}

export interface BomClassifier {
  (raw: string): BomClassification;
  knownBoms: string[];
}

export function buildBomClassifier(knownBoms: Iterable<string>): BomClassifier {
  const known = new Set<string>();
  const prefixMap = new Map<string, Set<string>>();
  for (const b0 of knownBoms) {
    const b = String(b0 ?? "").trim();
    if (!b) continue;
    known.add(b);
    const p = bomPrefix(b);
    if (!prefixMap.has(p)) prefixMap.set(p, new Set());
    prefixMap.get(p)!.add(b);
  }

  const fn = ((raw: string): BomClassification => {
    const clean = String(raw ?? "")
      .replace(/[\r\n]/g, "")
      .trim();
    if (clean === "") {
      return { input: raw, clean, status: "unknown", candidates: [], message: "Enter a BOM code" };
    }
    if (known.has(clean)) {
      return { input: raw, clean, status: "known", candidates: [], message: "" };
    }
    const p = bomPrefix(clean);
    const cands = [...(prefixMap.get(p) ?? [])];
    if (cands.length === 1) {
      return {
        input: raw,
        clean,
        status: "corrected",
        corrected: cands[0],
        candidates: cands,
        message: `Auto-corrected from: ${clean}`,
      };
    }
    if (cands.length === 0) {
      return { input: raw, clean, status: "unknown", candidates: [], message: "Code not found in any plan" };
    }
    return {
      input: raw,
      clean,
      status: "ambiguous",
      candidates: cands,
      message: `Ambiguous prefix — matches: ${cands.join(", ")}`,
    };
  }) as BomClassifier;
  fn.knownBoms = [...known].sort();
  return fn;
}
