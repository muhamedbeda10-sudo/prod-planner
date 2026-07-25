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

export function Ring({ pct, size = 40 }: { pct: number | null; size?: number }) {
  const f = pct === null ? 0 : Math.max(0, Math.min(1, pct));
  const color = ringColor(pct);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className="shrink-0" role="img" aria-label={pct === null ? "no data" : `${Math.round(f * 100)} percent`}>
      <circle cx="20" cy="20" r={R} fill="none" stroke="var(--border)" strokeWidth="4" />
      {pct !== null && (
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="4"
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
        // sized in viewBox units against the ring's inner hole (~27 wide), so the
        // widest value "100%" still clears the stroke at any rendered size
        style={{ fontSize: 9.5, fill: pct === null ? "var(--muted)" : color }}
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
    // a fixed width so the cards tile evenly however many there are — the row
    // centres them rather than stretching them to fill
    <div className="bg-surface border rounded-xl px-2.5 py-1.5 flex items-center gap-2 w-[9.5rem]">
      <Ring pct={pct} />
      <div className="min-w-0 leading-tight">
        <div className="text-xs font-extrabold">{label}</div>
        <div className="text-sm font-extrabold tabnum">
          {done}
          <span className="text-muted font-bold text-xs"> / {need}</span>
        </div>
        <div className="text-[10px] tabnum truncate" style={{ color: left > 0 ? "var(--warn-fg)" : "var(--ok-fg)" }} title={note}>
          {need === 0 ? "none required" : left > 0 ? `${left} left` : "complete"}
        </div>
      </div>
    </div>
  );
}
