// Fraction cell — the worklists' two-number language:
//   Done column:  finished / whole order
//   Due column:   still-open / that day's plan (counts down to 0 as output is recorded)
export function Frac({
  num,
  den,
  color, // numerator color (CSS value); green automatically when the fraction is complete
}: {
  num: number;
  den: number | null | undefined;
  color?: string;
}) {
  const complete = den !== null && den !== undefined && den > 0 && num >= den;
  const c = color ?? (complete ? "var(--ok-fg)" : undefined);
  return (
    <span className="tabnum whitespace-nowrap">
      <b className="text-[15px]" style={c ? { color: c } : undefined}>{num}</b>
      {den !== null && den !== undefined && <span className="text-muted text-xs"> / {den}</span>}
    </span>
  );
}
