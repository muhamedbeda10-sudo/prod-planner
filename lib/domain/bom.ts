// BOM family grouping — exact port of modShared.BomGroup / GroupKey / BomPrefix.
//
// IMPORTANT nuance (verified against the workbook's own Plan Tracker output):
//   * BomGroup MERGES codes that share base + M-number:
//       12011E13M12, 12011E14M12, 12011E16M12  ->  key "12011|M12"
//     and returns the FIRST such code found in Plan Orders as the representative.
//   * modCut / modWeld / modReport use BomGroup (so they MERGE).
//   * modTracker.ShowPlan groups by the RAW bom and never calls BomGroup, so the
//     Plan Tracker shows those three as THREE separate rows. We replicate both.

/** modShared.GroupKey: base number + M number, e.g. 12011E13M12 -> "12011|M12". */
export function groupKey(bomUpper: string): string {
  const m = /^(.+?)E\d+(M\d+)$/.exec(bomUpper);
  return m ? `${m[1]}|${m[2]}` : bomUpper;
}

/** modShared.BomPrefix: everything before the first "E<digit>", e.g.
 *  12011E13M12 -> "12011"; used for fuzzy prefix matching in NormalizeBoms. */
export function bomPrefix(s: string): string {
  const u = s.toUpperCase();
  const m = /^(.*?)E\d/.exec(u);
  return m ? m[1] : u;
}

export type BomGrouper = (bom: string) => string;

/**
 * Build a BomGroup function whose representative map is seeded from the ordered
 * list of Plan Orders BOM codes (first occurrence per group key wins), exactly
 * like modShared.EnsureRepMap.
 */
export function makeBomGrouper(planOrderBoms: Iterable<string>): BomGrouper {
  const rep = new Map<string, string>();
  for (const raw of planOrderBoms) {
    const b = String(raw ?? "").trim().toUpperCase();
    if (!b) continue;
    const k = groupKey(b);
    if (!rep.has(k)) rep.set(k, b);
  }
  return (bom: string) => {
    const u = String(bom ?? "").trim().toUpperCase();
    if (u === "") return u;
    const k = groupKey(u);
    return rep.get(k) ?? u;
  };
}
