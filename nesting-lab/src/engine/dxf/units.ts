// $INSUNITS codes (DXF reference, header variables). 0 means the file does not
// say — the caller MUST pick a unit explicitly; nothing here assumes millimetres.

export type UnitName = "unitless" | "in" | "ft" | "mi" | "mm" | "cm" | "m" | "km" | "µin" | "mil" | "yd" | "Å" | "nm" | "µm" | "dm" | "dam" | "hm" | "Gm" | "au" | "ly" | "pc" | "unknown";

export interface UnitInfo {
  code: number;
  name: UnitName;
  /** millimetres per drawing unit; null when unknown or unitless */
  toMm: number | null;
}

const TABLE: Record<number, { name: UnitName; toMm: number | null }> = {
  0: { name: "unitless", toMm: null },
  1: { name: "in", toMm: 25.4 },
  2: { name: "ft", toMm: 304.8 },
  3: { name: "mi", toMm: 1_609_344 },
  4: { name: "mm", toMm: 1 },
  5: { name: "cm", toMm: 10 },
  6: { name: "m", toMm: 1000 },
  7: { name: "km", toMm: 1_000_000 },
  8: { name: "µin", toMm: 25.4e-6 },
  9: { name: "mil", toMm: 0.0254 },
  10: { name: "yd", toMm: 914.4 },
  11: { name: "Å", toMm: 1e-7 },
  12: { name: "nm", toMm: 1e-6 },
  13: { name: "µm", toMm: 1e-3 },
  14: { name: "dm", toMm: 100 },
  15: { name: "dam", toMm: 10_000 },
  16: { name: "hm", toMm: 100_000 },
  17: { name: "Gm", toMm: 1e12 },
  18: { name: "au", toMm: 1.495978707e14 },
  19: { name: "ly", toMm: 9.4607e18 },
  20: { name: "pc", toMm: 3.0857e19 },
};

export function unitInfo(code: number | null | undefined): UnitInfo {
  if (code === null || code === undefined) return { code: 0, name: "unitless", toMm: null };
  const t = TABLE[code];
  if (!t) return { code, name: "unknown", toMm: null };
  return { code, name: t.name, toMm: t.toMm };
}

/** The units a user may choose for a unitless file. */
export const SELECTABLE_UNITS = ["mm", "cm", "m", "in"] as const;
export type SelectableUnit = (typeof SELECTABLE_UNITS)[number];

export function factorForSelectable(u: SelectableUnit): number {
  switch (u) {
    case "mm":
      return 1;
    case "cm":
      return 10;
    case "m":
      return 1000;
    case "in":
      return 25.4;
  }
}

export const INSUNITS_MM = 4;
