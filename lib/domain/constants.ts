// Domain constants shared across the port of the VBA modules.

/** The four components; every transformer needs exactly one of each. Order matters
 *  (grid column order F..AC, and MinOf4 semantics). Mirrors modShared.ItemsArr. */
export const ITEMS = ["CF", "TC", "TN", "CB"] as const;
export type Item = (typeof ITEMS)[number];

export const DEPTS = ["Cut", "Welding", "Painting"] as const;
export type Dept = (typeof DEPTS)[number];

export function isItem(x: string): x is Item {
  return (ITEMS as readonly string[]).includes(x);
}

export function isDept(x: string): x is Dept {
  return (DEPTS as readonly string[]).includes(x);
}

/** Defaults matching Lists!J2:J5. */
export const DEFAULTS = {
  leadCut: 2,
  leadWeld: 1,
  capacityPerItem: 27,
  dailyTarget: 27,
} as const;
