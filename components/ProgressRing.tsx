/* Progress rings — the summary cards on both Plan Tracker views.
   The ring is a plain SVG donut: radius 15.9155 gives a circumference of
   exactly 100, so the dash array IS the percentage and no maths leaks into the
   markup. Rotated -90° so it fills clockwise from twelve o'clock. */

const R = 15.9155; // circumference = 2πR = 100

/** Ring colour by how far along it is — red until half, amber, then ATC green
 *  on completion. Solid stroke colours, not the pale cell tints. */
function ringColor(pct: number | null): string {
  if (pct === null) return "var(--border-strong)";
  if (pct >= 1) return "var(--ok-fg)";
  if (pct >= 0.5) return "var(--warn-fg)";
  return "var(--bad-fg)";
}

export function Ring({ pct, size = 52 }: { pct: number | null; size?: number }) {
  const f = pct === null ? 0 : Math.max(0, Math.min(1, pct));
  const color = ringColor(pct);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className="shrink-0" role="img" aria-label={pct === null ? "no data" : `${Math.round(f * 100)} percent`}>
      <circle cx="20" cy="20" r={R} fill="none" stroke="var(--border)" strokeWidth="4.5" />
      {pct !== null && (
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeDasharray={`${f * 100} 100`}
          transform="rotate(-90 20 20)"
          className="transition-all duration-500"
        />
      )}
      <text
        x="20"
        y="20"
        textAnchor="middle"
        dominantBaseline="central"
        className="tabnum font-extrabold"
        style={{ fontSize: 11, fill: pct === null ? "var(--muted)" : color }}
      >
        {pct === null ? "—" : `${Math.round(f * 100)}%`}
      </text>
    </svg>
  );
}

/** One summary card: a ring, the done-of-required figure, and what is left.
 *  `note` names the stage the figures are measured at, so a card is never
 *  ambiguous about which department it is reporting. */
export function RingCard({
  label,
  note,
  done,
  need,
}: {
  label: string;
  note: string;
  done: number;
  need: number;
}) {
  const pct = need > 0 ? done / need : null;
  const left = Math.max(0, need - done);
  return (
    <div className="bg-surface border rounded-xl px-3 py-2 flex items-center gap-3">
      <Ring pct={pct} />
      <div className="min-w-0 leading-tight">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-extrabold">{label}</span>
          <span className="text-[10px] text-muted truncate">{note}</span>
        </div>
        <div className="text-lg font-extrabold tabnum">
          {done}
          <span className="text-muted font-bold text-sm"> / {need}</span>
        </div>
        <div className="text-[11px] tabnum" style={{ color: left > 0 ? "var(--warn-fg)" : "var(--ok-fg)" }}>
          {need === 0 ? "nothing required" : left > 0 ? `${left} left` : "complete"}
        </div>
      </div>
    </div>
  );
}
