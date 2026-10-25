// Hints read off a file name. They are SUGGESTIONS for the person to accept —
// a name like "12005E14M13-5mm-50U-Result1-1" looks like BOM 12005E14M13,
// 5 mm, 50 units, but nothing is applied until someone clicks.

export interface FileNameHints {
  bom: string | null;
  thicknessMm: number | null;
  units: number | null;
  /** the file looks like a nesting result (…Result…) rather than a part drawing */
  looksLikeNestingResult: boolean;
}

export function suggestFromFileName(name: string): FileNameHints {
  const stem = name.replace(/\.[^.]+$/, "");
  const bom = /\b(\d{5}[A-Z]\d{2}[A-Z]\d{2})\b/i.exec(stem)?.[1]?.toUpperCase() ?? null;
  const thk = /(\d+(?:[.,]\d+)?)\s*mm\b/i.exec(stem);
  const units = /\b(\d+)\s*U\b/i.exec(stem);
  return {
    bom,
    thicknessMm: thk ? Number(thk[1].replace(",", ".")) : null,
    units: units ? Number(units[1]) : null,
    looksLikeNestingResult: /result/i.test(stem),
  };
}
