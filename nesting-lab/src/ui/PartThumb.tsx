import type { Loop, Seg } from "../engine/geometry/types";
import { loopPath, segsPath } from "../engine/export/svg";
import { loopBBox } from "../engine/geometry/polygon";

export function PartThumb({ outer, holes, marks, color, size = 72 }: { outer: Loop; holes: Loop[]; marks?: Seg[]; color: string; size?: number }) {
  const b = loopBBox(outer);
  const w = b.maxX - b.minX || 1;
  const h = b.maxY - b.minY || 1;
  const pad = Math.max(w, h) * 0.06;
  let d = loopPath(outer);
  for (const hl of holes) d += loopPath(hl);
  return (
    <svg className="thumb" style={{ width: size, height: size * 0.75 }} viewBox={`${b.minX - pad} ${-(b.maxY + pad)} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g transform="scale(1,-1)">
        <path d={d} fill={color} fillOpacity={0.35} fillRule="evenodd" stroke={color} strokeWidth={Math.max(w, h) / 120} vectorEffect="non-scaling-stroke" />
        {marks && marks.length > 0 && <path d={segsPath(marks)} fill="none" stroke="var(--mark)" strokeWidth={Math.max(w, h) / 150} />}
      </g>
    </svg>
  );
}
