/** The SOI behind a row: its MO's, falling back to its BOM's when the row is
 *  BOM-level (the worklists group that way). */
export function soiOf(
  lookup: { byMo: Record<string, string>; byBom: Record<string, string> } | undefined,
  mo: string | null | undefined,
  bom?: string | null
): string | null {
  if (!lookup) return null;
  const m = (mo ?? "").trim();
  if (m && lookup.byMo[m]) return lookup.byMo[m];
  const b = (bom ?? "").trim();
  if (b && lookup.byBom[b]) return lookup.byBom[b];
  return null;
}
