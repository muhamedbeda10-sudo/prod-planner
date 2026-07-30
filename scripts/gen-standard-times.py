#!/usr/bin/env python3
"""Generator: the engineering timings sheet -> lib/domain/standardTimes.ts

Reads the three tables on the TANK sheet and emits a checked-in TS module:
  SUMMARY 2  -> per-KVA-tier stage hours per tank (cut = laser+bending+fin folding)
  SUMMARY 1  -> per-KVA-tier per-item fab/finishing totals -> rank-1 split matrix
  PRODUCT    -> FG code -> tier map (validated: every row's values match a tier)
"""
import openpyxl, json, re, sys

# Usage:  python3 scripts/gen-standard-times.py path/to/Final_Timings.xlsx
# Regenerates lib/domain/standardTimes.ts when engineering updates the sheet;
# run the unit suite afterwards — it asserts the data still reconciles.
SRC = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: gen-standard-times.py <timings.xlsx>")
OUT = "lib/domain/standardTimes.ts"

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb["TANK"]
def cell(r, c): return ws.cell(row=r, column=c).value

# ---- SUMMARY 2 (rows 17-26): tier -> work-centre hours ----
tiers = {}
for r in range(17, 27):
    kva = cell(r, 1)
    if kva is None: continue
    laser, bend, fin, weld, shb, paint = (float(cell(r, c)) for c in range(2, 8))
    tiers[int(kva)] = dict(cut=round(laser + bend + fin, 4), weld=weld, shb=shb, paint=paint)

# ---- SUMMARY 1 (rows 4-13): tier -> per-item fab & finishing totals ----
ITEMS = ["CF", "TC", "TN", "CB"]
splits = {}
for r in range(4, 14):
    kva = cell(r, 1)
    if kva is None: continue
    kva = int(kva)
    tot_paint, tot_fab = float(cell(r, 3)), float(cell(r, 4))
    if tot_fab == 0: continue  # the 4000 row is unfinished in SUMMARY 1
    fab = {it: float(cell(r, 5 + i)) for i, it in enumerate(ITEMS)}
    fin = {it: float(cell(r, 9 + i)) for i, it in enumerate(ITEMS)}
    # sanity: the per-item totals reconcile with the row's own totals
    assert abs(sum(fab.values()) - tot_fab) < 0.02, (kva, sum(fab.values()), tot_fab)
    assert abs(sum(fin.values()) - tot_paint) < 0.02, (kva, sum(fin.values()), tot_paint)
    splits[kva] = dict(fab=fab, fin=fin)

# tier 4000 has stage totals but no item split -> borrow the 3000 SHARES
assert 4000 in tiers and 4000 not in splits and 3000 in splits

# ---- per-tier per-item matrix (rank-1: stage marginals x item marginals) ----
# hours(item, Cut)  = fabItem * cut/(cut+weld)
# hours(item, Weld) = fabItem * weld/(cut+weld)
# hours(item, Finish) = finItem   (earned at the item's finishing stage: SHB for
#                                  the paint-exempt core, Painting otherwise)
matrix = {}
for kva, t in tiers.items():
    src = splits.get(kva) or splits[3000]
    fab_total = sum(src["fab"].values())
    fin_total = sum(src["fin"].values())
    cw = t["cut"] + t["weld"]
    per = {}
    for it in ITEMS:
        fab_share = src["fab"][it] / fab_total
        fin_share = src["fin"][it] / fin_total
        per[it] = dict(
            cut=round(fab_share * cw * (t["cut"] / cw) if cw else 0, 4),
            weld=round(fab_share * cw * (t["weld"] / cw) if cw else 0, 4),
            finish=round(fin_share * (t["shb"] + t["paint"]), 4),
        )
    # reconcile: item sums return the tier's stage totals
    assert abs(sum(p["cut"] for p in per.values()) - t["cut"]) < 0.02
    assert abs(sum(p["weld"] for p in per.values()) - t["weld"]) < 0.02
    assert abs(sum(p["finish"] for p in per.values()) - (t["shb"] + t["paint"])) < 0.02
    matrix[kva] = per

# ---- PRODUCT table (rows 35-266): FG -> tier, validated ----
def norm(code): return re.sub(r"[^A-Z0-9]", "", str(code).upper())
fg_tier, conflicts, unmatched = {}, set(), []
for r in range(35, 267):
    fg = cell(r, 1)
    if not fg: continue
    vals = tuple(round(float(cell(r, c)), 3) for c in range(4, 10))  # 6 work centres
    hit = None
    for kva, t in tiers.items():
        # rebuild this tier's 6-tuple from SUMMARY 2 raw cells
        row2 = next(rr for rr in range(17, 27) if cell(rr, 1) == kva)
        tv = tuple(round(float(cell(row2, c)), 3) for c in range(2, 8))
        if vals == tv: hit = kva; break
    if hit is None:
        unmatched.append((fg, vals)); continue
    key = norm(fg)
    if key in fg_tier and fg_tier[key] != hit:
        conflicts.add(key)
    else:
        fg_tier[key] = hit
for k in conflicts: fg_tier.pop(k, None)

print(f"tiers={sorted(tiers)}  fg_map={len(fg_tier)}  conflicts={sorted(conflicts)}  unmatched={len(unmatched)}")
for u in unmatched[:5]: print("  UNMATCHED:", u)
if unmatched: sys.exit("product rows that match no tier — refusing to generate")

# ---- emit TS ----
def ts_num_map(d, indent):
    pad = " " * indent
    return "{\n" + "\n".join(f'{pad}  {k}: {json.dumps(v)},' for k, v in sorted(d.items())) + f"\n{pad}}}"

fg_lines = ",\n".join(f'  {json.dumps(k)}: {v}' for k, v in sorted(fg_tier.items()))
tier_lines = ",\n".join(
    f"  {kva}: {{ cut: {t['cut']}, weld: {t['weld']}, shb: {t['shb']}, paint: {t['paint']} }}"
    for kva, t in sorted(tiers.items()))
mat_lines = ",\n".join(
    "  %d: { %s }" % (kva, ", ".join(
        f"{it}: {{ cut: {p['cut']}, weld: {p['weld']}, finish: {p['finish']} }}"
        for it, p in per.items()))
    for kva, per in sorted(matrix.items()))

ts = f"""// GENERATED from "Final Timings 3rd industrial" (TANK sheet) — do not edit by
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

import {{ isPaintExempt, type Item }} from "./constants";

export interface TierStageHours {{ cut: number; weld: number; shb: number; paint: number }}
export interface ItemStdHours {{ cut: number; weld: number; finish: number }}

export const KVA_TIERS = [{", ".join(str(k) for k in sorted(tiers))}] as const;

/** Hours per TANK per stage, by KVA class. */
export const TIER_HOURS: Record<number, TierStageHours> = {{
{tier_lines},
}};

/** Hours per PIECE per base component, by KVA class (see header note). */
export const TIER_ITEM_HOURS: Record<number, Record<string, ItemStdHours>> = {{
{mat_lines},
}};

/** FG code (normalized: uppercase, alphanumerics only) → KVA class. */
export const FG_TIER: Record<string, number> = {{
{fg_lines},
}};

const normFg = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Nearest KVA class for a numeric KVA (ties go DOWN — matches the sheet's
 *  bias for in-between sizes more often than rounding up would). */
export function nearestTier(kva: number): number {{
  let best: number = KVA_TIERS[0];
  for (const t of KVA_TIERS) {{
    if (Math.abs(t - kva) < Math.abs(best - kva)) best = t;
  }}
  return best;
}}

/** Resolve an order to its KVA class: the sheet's own FG map first (exact,
 *  then without a trailing M-revision), the numeric KVA as fallback. */
export function tierForOrder(order: {{ fgCode?: string | null; kva?: string | null }}): number | null {{
  if (order.fgCode) {{
    const key = normFg(order.fgCode);
    if (FG_TIER[key] !== undefined) return FG_TIER[key];
    const base = key.replace(/M\\d+$/, "");
    if (base !== key && FG_TIER[base] !== undefined) return FG_TIER[base];
  }}
  const kva = Number(String(order.kva ?? "").replace(/[^0-9.]/g, ""));
  if (Number.isFinite(kva) && kva > 0) return nearestTier(kva);
  return null;
}}

/** Standard hours ONE PIECE of `item` earns when `dept` records it — 0 when
 *  the sheet has no figure (AR/MB, or a dept outside the production chain). */
export function stdHoursFor(dept: string, item: string, tier: number | null): number {{
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
}}
"""
open(OUT, "w").write(ts)
print("wrote", OUT)
