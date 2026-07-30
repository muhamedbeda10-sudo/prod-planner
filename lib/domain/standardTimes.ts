// GENERATED from "Final Timings 3rd industrial" (TANK sheet) — do not edit by
// hand; regenerate with scripts/gen-standard-times.py <timings.xlsx>.
//
// Standard MAN-HOURS for one transformer tank, by KVA class:
//   • TIER_HOURS   — hours per STAGE per tank (Cut = laser + bending + fin
//     folding, straight from the sheet's SUMMARY 2 work centres)
//   • TIER_ITEM_HOURS — hours per PIECE of each base component. The sheet only
//     publishes two marginals (per-item fab/finishing totals in SUMMARY 1, and
//     per-work-centre totals in SUMMARY 2), so the per-item×stage cells are a
//     rank-1 allocation of those marginals: an item's fab hours split between
//     Cut and Welding in the tier's cut:weld ratio, and its finishing hours
//     earned whole at its finishing stage (Shot Blast for the paint-exempt
//     core, Painting otherwise). Every row and column sum reconciles with the
//     sheet exactly — only the interior split is inferred.
//   • FG_TIER      — the sheet's own product table: FG code → KVA class. This
//     is the authority; the numeric KVA is only a fallback, because the sheet
//     maps in-between sizes to classes inconsistently (250→200 but 400→500).
//   • The 4000 class has stage totals but no per-item split in the sheet — it
//     borrows the 3000 class's SHARES scaled to its own totals.
//   • AR and MB have NO standard times in the sheet; entries for them weigh 0
//     hours until engineering supplies figures.

import { isPaintExempt, type Item } from "./constants";

export interface TierStageHours { cut: number; weld: number; shb: number; paint: number }
export interface ItemStdHours { cut: number; weld: number; finish: number }

export const KVA_TIERS = [100, 200, 300, 500, 1000, 1500, 2000, 2500, 3000, 4000] as const;

/** Hours per TANK per stage, by KVA class. */
export const TIER_HOURS: Record<number, TierStageHours> = {
  100: { cut: 5.634, weld: 10.3, shb: 1.31, paint: 5.26 },
  200: { cut: 5.634, weld: 11.3, shb: 1.31, paint: 5.26 },
  300: { cut: 6.29, weld: 14.0, shb: 1.31, paint: 5.26 },
  500: { cut: 8.34, weld: 19.5, shb: 1.61, paint: 8.17 },
  1000: { cut: 8.34, weld: 21.0, shb: 1.61, paint: 8.17 },
  1500: { cut: 8.34, weld: 23.0, shb: 1.61, paint: 8.17 },
  2000: { cut: 12.94, weld: 25.68, shb: 2.23, paint: 8.17 },
  2500: { cut: 13.924, weld: 28.9, shb: 2.23, paint: 8.83 },
  3000: { cut: 15.105, weld: 32.754999999999995, shb: 2.23, paint: 8.83 },
  4000: { cut: 15.105, weld: 35.8, shb: 2.23, paint: 8.83 },
};

/** Hours per PIECE per base component, by KVA class (see header note). */
export const TIER_ITEM_HOURS: Record<number, Record<string, ItemStdHours>> = {
  100: { CF: { cut: 0.7564, weld: 1.3828, finish: 0.1299 }, TC: { cut: 1.2724, weld: 2.3262, finish: 0.2998 }, TN: { cut: 3.0043, weld: 5.4925, finish: 5.8955 }, CB: { cut: 0.6009, weld: 1.0985, finish: 0.2448 } },
  200: { CF: { cut: 0.7117, weld: 1.4275, finish: 0.1299 }, TC: { cut: 1.1973, weld: 2.4014, finish: 0.2998 }, TN: { cut: 3.1596, weld: 6.3371, finish: 5.8955 }, CB: { cut: 0.5654, weld: 1.134, finish: 0.2448 } },
  300: { CF: { cut: 0.665, weld: 1.4802, finish: 0.1299 }, TC: { cut: 1.1188, weld: 2.4901, finish: 0.2998 }, TN: { cut: 3.9779, weld: 8.8538, finish: 5.8955 }, CB: { cut: 0.5283, weld: 1.1759, finish: 0.2448 } },
  500: { CF: { cut: 0.671, weld: 1.569, finish: 0.1299 }, TC: { cut: 1.1983, weld: 2.8017, finish: 0.3298 }, TN: { cut: 5.8716, weld: 13.7284, finish: 8.9954 }, CB: { cut: 0.5991, weld: 1.4009, finish: 0.3248 } },
  1000: { CF: { cut: 0.6389, weld: 1.6088, finish: 0.1299 }, TC: { cut: 1.1409, weld: 2.8728, finish: 0.3298 }, TN: { cut: 5.9897, weld: 15.0821, finish: 8.9954 }, CB: { cut: 0.5705, weld: 1.4364, finish: 0.3248 } },
  1500: { CF: { cut: 0.598, weld: 1.6492, finish: 0.1299 }, TC: { cut: 1.0679, weld: 2.9449, finish: 0.3298 }, TN: { cut: 6.1402, weld: 16.9334, finish: 8.9954 }, CB: { cut: 0.5339, weld: 1.4725, finish: 0.3248 } },
  2000: { CF: { cut: 0.842, weld: 1.671, finish: 0.2256 }, TC: { cut: 1.5661, weld: 3.1081, finish: 0.6814 }, TN: { cut: 9.7673, weld: 19.3837, finish: 9.023 }, CB: { cut: 0.7645, weld: 1.5173, finish: 0.47 } },
  2500: { CF: { cut: 0.8129, weld: 1.6873, finish: 0.2399 }, TC: { cut: 1.5121, weld: 3.1384, finish: 0.7247 }, TN: { cut: 10.8609, weld: 22.5423, finish: 9.5957 }, CB: { cut: 0.7381, weld: 1.5321, finish: 0.4998 } },
  3000: { CF: { cut: 0.789, weld: 1.711, finish: 0.2399 }, TC: { cut: 1.4676, weld: 3.1824, finish: 0.7247 }, TN: { cut: 12.132, weld: 26.308, finish: 9.5957 }, CB: { cut: 0.7164, weld: 1.5536, finish: 0.4998 } },
  4000: { CF: { cut: 0.789, weld: 1.87, finish: 0.2399 }, TC: { cut: 1.4676, weld: 3.4783, finish: 0.7247 }, TN: { cut: 12.132, weld: 28.7537, finish: 9.5957 }, CB: { cut: 0.7164, weld: 1.698, finish: 0.4998 } },
};

/** FG code (normalized: uppercase, alphanumerics only) → KVA class. */
export const FG_TIER: Record<string, number> = {
  "FG10003": 1500,
  "FG10003M11": 1500,
  "FG10004": 1500,
  "FG10005": 1500,
  "FG10007": 1000,
  "FG10008": 1500,
  "FG10009": 1000,
  "FG10010": 300,
  "FG10011": 300,
  "FG10012": 1500,
  "FG10013": 1500,
  "FG10014": 300,
  "FG10015": 500,
  "FG10016": 1000,
  "FG10017": 500,
  "FG10018": 500,
  "FG10019": 1000,
  "FG11001": 1000,
  "FG11002": 1500,
  "FG12001": 100,
  "FG12002": 100,
  "FG12003": 100,
  "FG12004": 200,
  "FG12005": 200,
  "FG12006": 300,
  "FG12007": 300,
  "FG12008": 300,
  "FG12009": 200,
  "FG12010": 200,
  "FG12011": 100,
  "FG12012": 200,
  "FG12013": 200,
  "FG12014": 100,
  "FG12015": 300,
  "FG34001": 300,
  "FG34002": 500,
  "FG40003": 500,
  "FG40005": 2000,
  "FG40008": 200,
  "FG40009": 500,
  "FG40011": 2000,
  "FG40015": 1000,
  "FG44001": 100,
  "FG44002": 200,
  "FG44003": 300,
  "FG44004": 500,
  "FG44005": 1000,
  "FG46005": 1000,
  "FG47002": 100,
  "FG47003": 500,
  "FG60002": 200,
  "FG60007": 500,
  "FG60008": 200,
  "FG60009": 100,
  "FG60012": 100,
  "FG60013": 200,
  "FG60014": 200,
  "FG60015": 500,
  "FG60018": 200,
  "FG60021": 200,
  "FG63001M11": 500,
  "FG63007": 500,
  "FG63008": 300,
  "FG64001": 3000,
  "FG64002": 300,
  "FG64006": 100,
  "FG64009": 100,
  "FG64010": 200,
  "FG64015": 3000,
  "FG64016": 3000,
  "FG64017": 200,
  "FG64020": 200,
  "FG64021": 200,
  "FG65001M11": 100,
  "FG70001": 100,
  "FG70002": 300,
  "FG70005": 100,
  "FG70006": 300,
  "FG71002M11": 300,
  "FG71005": 1000,
  "FG71006": 1500,
  "FG71007M11": 2500,
  "FG71008": 2000,
  "FG71009M11": 500,
  "FG71010M11": 1500,
  "FG71016": 200,
  "FG71017": 2000,
  "FG71018": 500,
  "FG71019": 4000,
  "FG71020": 1500,
  "FG71021": 500,
  "FG71022": 100,
  "FG71023": 200,
  "FG71024": 500,
  "FG71025": 1000,
  "FG71026": 1000,
  "FG71027": 2000,
  "FG71028": 500,
  "FG71029": 2000,
  "FG71030": 100,
  "FG71031": 1000,
  "FG71032": 1500,
  "FG71033": 500,
  "FG71034": 1000,
  "FG71035": 200,
  "FG71037": 200,
  "FG71038": 300,
  "FG71039": 200,
  "FG71040": 500,
  "FG71041": 200,
  "FG71042": 300,
  "FG72001": 100,
  "FG73001": 200,
  "FG73002": 300,
  "FG73003": 100,
  "FG73004": 300,
  "FG73005": 500,
  "FG73006": 200,
  "FG77003": 1500,
  "FG77005": 1000,
  "FG77006": 1000,
  "FG77012": 100,
  "FG77013": 200,
  "FG77014": 100,
  "FG77015": 100,
  "FG77016": 200,
  "FG77017": 200,
  "FG77018": 200,
  "FG77024": 4000,
  "FG78001M11": 4000,
  "FG78003M11": 500,
  "FG78005": 2000,
  "FG78005M12": 2000,
  "FG78006": 2500,
  "FG78007": 2500,
  "FG78008": 3000,
  "FG78009": 4000,
  "FG78010": 4000,
  "FG78011": 4000,
  "FG78012": 3000,
  "FG78013": 3000,
  "FG78014": 2500,
  "FG78015": 3000,
  "FG78016": 3000,
  "FG78017": 2500,
  "FG78018": 1500,
  "FG78019": 2000,
  "FG79001M11": 2000,
  "FG79002M11": 3000,
  "FG79003M11": 3000,
  "FG80001": 200,
  "FG81001": 200,
  "FG81003": 100,
  "FGPAS161303C00U00": 1500,
  "FGPAS181203C01U00": 2000,
  "FGPAS191203C00U00": 2500,
  "FGSAD091203L00X00": 500,
  "FGSAD141203L00X00": 1000,
  "FGSAS091203L00X00": 500,
  "FGSAS141203L00X00": 1000,
  "FGSAS141303L00X00": 1000,
  "FGSAS161203L00X00": 1500,
  "FGT10S1B2": 1000,
  "FGT10S2A1": 1000,
  "FGT10S3B2": 1000,
  "FGT16S1A2": 1500,
  "FGT1S2A2": 100,
  "FGT1S2C2": 100,
  "FGT1S2D1": 100,
  "FGT20S1A1": 2000,
  "FGT3S1B1": 300,
  "FGT4S1A1": 500,
  "FGT5S1B2": 500,
  "FGT5S2B4": 500,
  "FGT5S3B1": 500,
  "FGT63S1A1": 500,
  "TX14001": 500,
  "TX14002": 1000,
  "TX14003": 1500,
  "TX14004": 500,
  "TX14005": 1000,
  "TX14006": 1500,
  "TX14007": 500,
  "TX14008": 1000,
  "TX14010": 500,
  "TX14011": 1000,
  "TX15001": 1000,
  "TX17001": 300,
  "TX17002": 500,
  "TX17003": 1000,
  "TX17004": 1500,
  "TX40002": 500,
  "TX44004": 500,
  "TX44005": 1000,
  "TX75001": 1000,
  "TX76002M11": 2500,
  "TX76003M11": 1000,
  "TX77004M11": 500,
  "TX77007": 1500,
  "TX77008": 500,
  "TX77009": 500,
  "TX77010": 1000,
  "TX77011": 100,
  "TX77013": 200,
  "TX77017": 200,
  "TX77019": 500,
  "TX77020": 1500,
  "TX77023": 500,
  "TX77025": 2000,
  "TX81002M11": 200,
  "TX81003M11": 100,
  "TX81004": 100,
  "TXT10S2E1": 1000,
  "TXT15S2E1": 1500,
};

const normFg = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Nearest KVA class for a numeric KVA (ties go DOWN — matches the sheet's
 *  bias for in-between sizes more often than rounding up would). */
export function nearestTier(kva: number): number {
  let best: number = KVA_TIERS[0];
  for (const t of KVA_TIERS) {
    if (Math.abs(t - kva) < Math.abs(best - kva)) best = t;
  }
  return best;
}

/** Resolve an order to its KVA class: the sheet's own FG map first (exact,
 *  then without a trailing M-revision), the numeric KVA as fallback. */
export function tierForOrder(order: { fgCode?: string | null; kva?: string | null }): number | null {
  if (order.fgCode) {
    const key = normFg(order.fgCode);
    if (FG_TIER[key] !== undefined) return FG_TIER[key];
    const base = key.replace(/M\d+$/, "");
    if (base !== key && FG_TIER[base] !== undefined) return FG_TIER[base];
  }
  const kva = Number(String(order.kva ?? "").replace(/[^0-9.]/g, ""));
  if (Number.isFinite(kva) && kva > 0) return nearestTier(kva);
  return null;
}

/** Standard hours ONE PIECE of `item` earns when `dept` records it — 0 when
 *  the sheet has no figure (AR/MB, or a dept outside the production chain). */
export function stdHoursFor(dept: string, item: string, tier: number | null): number {
  if (tier === null) return 0;
  const per = TIER_ITEM_HOURS[tier]?.[item];
  if (!per) return 0; // AR / MB — no standard times in the sheet
  if (dept === "Cut") return per.cut;
  if (dept === "Welding") return per.weld;
  // finishing: the paint-exempt core earns its hours at Shot Blast, everything
  // else at Painting — the opposite pairing earns nothing (and the ledger
  // never records it anyway)
  if (dept === "ShotBlast") return isPaintExempt(item as Item) ? per.finish : 0;
  if (dept === "Painting") return isPaintExempt(item as Item) ? 0 : per.finish;
  return 0; // Delivered and anything else — not a production stage
}
