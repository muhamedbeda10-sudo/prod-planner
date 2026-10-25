import { useMemo, useRef, useState } from "react";
import type { NestPartInput, NestResult, SheetLayout } from "../engine/nesting/types";
import { placedGeometry } from "../engine/nesting/placement";
import { loopPath, segsPath, colorForIndex } from "../engine/export/svg";
import type { Violation } from "../engine/nesting/verify";
import { mm } from "./format";

interface Props {
  result: NestResult;
  sheet: SheetLayout;
  parts: NestPartInput[];
  violations: Violation[];
  showLabels: boolean;
  showHoles: boolean;
}

export function SheetView({ result, sheet, parts, violations, showLabels, showHoles }: Props) {
  const s = result.settings;
  const W = s.sheet.widthMm;
  const H = s.sheet.heightMm;
  const pad = Math.max(W, H) * 0.03;
  const fitView = { x: -pad, y: -pad, w: W + 2 * pad, h: H + 2 * pad };
  const [view, setView] = useState(fitView);
  /** zoom about the centre by factor f (< 1 zooms in) */
  const zoom = (f: number) => setView((v) => ({ x: v.x + (v.w * (1 - f)) / 2, y: v.y + (v.h * (1 - f)) / 2, w: v.w * f, h: v.h * f }));
  const viewScale = (r: DOMRect) => Math.max(view.w / r.width, view.h / r.height);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const idx = useMemo(() => new Map(parts.map((p, i) => [p.id, i])), [parts]);
  const byId = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
  const bad = useMemo(() => {
    const set = new Set<string>();
    for (const v of violations) {
      if (v.sheet !== sheet.index) continue;
      if (v.a) set.add(`${v.a.partId}#${v.a.instance}`);
      if (v.b) set.add(`${v.b.partId}#${v.b.instance}`);
    }
    return set;
  }, [violations, sheet.index]);
  const items = useMemo(
    () =>
      sheet.placements.map((pl) => {
        const part = byId.get(pl.partId)!;
        const g = placedGeometry(part, pl);
        let d = loopPath(g.outer);
        if (showHoles) for (const h of g.holes) d += loopPath(h);
        const marks = g.marks.length ? segsPath(g.marks) : "";
        return { pl, part, d, marks, key: `${pl.partId}#${pl.instance}` };
      }),
    [sheet, byId, showHoles],
  );
  const toSvgPoint = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const scale = viewScale(r);
    return { x: view.x + (e.clientX - r.left) * scale, y: view.y + (e.clientY - r.top) * scale, scale };
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const p = toSvgPoint(e);
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    // zoom about the cursor; p is in flipped-y space (svg y down)
    setView((v) => ({ x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f }));
  };
  const stroke = Math.max(W, H) / 1000;
  const hovered = items.find((i) => i.key === hover);
  return (
    <div>
      <div
        className="sheetview"
        tabIndex={0}
        aria-label="Sheet preview: arrow keys pan, plus and minus zoom, 0 fits"
        onKeyDown={(e) => {
          const step = 0.1;
          if (e.key === "ArrowLeft") setView((v) => ({ ...v, x: v.x - v.w * step }));
          else if (e.key === "ArrowRight") setView((v) => ({ ...v, x: v.x + v.w * step }));
          else if (e.key === "ArrowUp") setView((v) => ({ ...v, y: v.y - v.h * step }));
          else if (e.key === "ArrowDown") setView((v) => ({ ...v, y: v.y + v.h * step }));
          else if (e.key === "+" || e.key === "=") zoom(0.8);
          else if (e.key === "-") zoom(1.25);
          else if (e.key === "0") setView(fitView);
          else return;
          e.preventDefault();
        }}
        onWheel={onWheel}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          const scale = viewScale(svgRef.current!.getBoundingClientRect());
          setView((v) => ({ ...v, x: drag.current!.vx - (e.clientX - drag.current!.x) * scale, y: drag.current!.vy - (e.clientY - drag.current!.y) * scale }));
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Sheet ${sheet.index + 1} layout`}>
          <g transform={`translate(0 ${H}) scale(1,-1)`}>
            <rect x={0} y={0} width={W} height={H} fill="var(--surface)" stroke="var(--text)" strokeWidth={stroke * 1.5} />
            {s.marginMm > 0 && <rect x={s.marginMm} y={s.marginMm} width={W - 2 * s.marginMm} height={H - 2 * s.marginMm} fill="none" stroke="var(--muted)" strokeDasharray={`${W / 80} ${W / 80}`} strokeWidth={stroke} />}
            {s.noGoZones.map((z, i) => (
              <rect key={i} x={z.x} y={z.y} width={z.w} height={z.h} fill="var(--zone-fill)" fillOpacity={0.35} stroke="var(--zone-stroke)" strokeWidth={stroke} />
            ))}
            {items.map((it) => {
              const color = bad.has(it.key) ? "var(--bad-fg)" : colorForIndex(idx.get(it.pl.partId) ?? 0);
              const isHover = hover === it.key;
              return (
                <g key={it.key} onMouseEnter={() => setHover(it.key)} onMouseLeave={() => setHover(null)}>
                  <path d={it.d} fill={color} fillOpacity={isHover ? 0.6 : 0.35} fillRule="evenodd" stroke={color} strokeWidth={isHover ? stroke * 2.5 : stroke} strokeLinejoin="round">
                    <title>
                      {it.part.label} #{it.pl.instance + 1} — {it.part.name ?? ""} — at {mm(it.pl.x)}, {mm(it.pl.y)} rot {it.pl.rotationDeg}°{it.pl.mirrored ? " mirrored" : ""}
                    </title>
                  </path>
                  {it.marks && <path d={it.marks} fill="none" stroke="var(--mark)" strokeWidth={stroke} />}
                </g>
              );
            })}
          </g>
          {showLabels &&
            items.map((it) => {
              const b = it.pl.bbox;
              const cx = (b.minX + b.maxX) / 2;
              const cy = H - (b.minY + b.maxY) / 2;
              const size = Math.max(view.w / 90, Math.min(24, Math.min(b.maxX - b.minX, b.maxY - b.minY) / 5));
              return (
                <text key={it.key} x={cx} y={cy} fontSize={size} textAnchor="middle" dominantBaseline="middle" fill="var(--text)" style={{ pointerEvents: "none" }}>
                  {it.part.label} #{it.pl.instance + 1}
                </text>
              );
            })}
        </svg>
        <div className="hud">
          <button className="small" onClick={() => setView(fitView)}>
            fit
          </button>
          <button className="small" aria-label="Zoom in" onClick={() => zoom(0.8)}>
            +
          </button>
          <button className="small" aria-label="Zoom out" onClick={() => zoom(1.25)}>
            −
          </button>
        </div>
      </div>
      <div className="small muted" style={{ marginTop: 4 }} aria-live="polite">
        Wheel to zoom, drag to pan; with the view focused, arrow keys pan and + / − / 0 zoom or fit. {hovered ? <b>{hovered.part.label} #{hovered.pl.instance + 1}: {hovered.part.name} at x {mm(hovered.pl.x)} y {mm(hovered.pl.y)}, rotation {hovered.pl.rotationDeg}°{hovered.pl.mirrored ? ", mirrored" : ""}; BOM {hovered.part.bom ?? "—"}; source {hovered.part.source?.file}</b> : "Hover a part for its details."}
      </div>
    </div>
  );
}
