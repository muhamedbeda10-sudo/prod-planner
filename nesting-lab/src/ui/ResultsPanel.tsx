import { useState } from "react";
import type { RunState } from "./state";
import type { NestSettings } from "../engine/nesting/types";
import { SheetView } from "./SheetView";
import { colorForIndex } from "../engine/export/svg";
import { int, mm, ms, pct } from "./format";

interface Props {
  run: RunState;
  settings: NestSettings;
  onCancel: () => void;
  onRerun: () => void;
  canRun: boolean;
}

export function ResultsPanel({ run, settings, onCancel, onRerun, canRun }: Props) {
  const [sheetIdx, setSheetIdx] = useState(0);
  const [labels, setLabels] = useState(true);
  const [holes, setHoles] = useState(true);
  if (run.status === "idle") {
    return (
      <div className="card">
        <p>No nesting yet. Load files, check the settings and run.</p>
        <button className="primary" onClick={onRerun} disabled={!canRun}>
          Run nesting
        </button>
      </div>
    );
  }
  if (run.status === "running") {
    const p = run.progress;
    return (
      <div className="card" role="status" aria-live="polite">
        <p>
          <span className="spin" aria-hidden="true" /> Nesting… {p ? `${p.message} — ${p.placed}/${p.total} parts, ${p.sheets} sheet(s), strategy ${p.strategyIndex + 1}/${p.strategyCount}` : "preparing polygons"} ({ms(performance.now() - run.startedAt)})
        </p>
        <button onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  if (run.status === "error" || !run.result) {
    return (
      <div className="card">
        <div className="note bad" role="alert">
          Nesting failed: {run.error}
        </div>
        <button onClick={onRerun} disabled={!canRun}>
          Try again
        </button>
      </div>
    );
  }
  const r = run.result;
  const v = run.verification;
  const parts = run.parts;
  const sheet: (typeof r.sheets)[number] | undefined = r.sheets[Math.min(sheetIdx, r.sheets.length - 1)];
  const placed = r.sheets.reduce((n, s) => n + s.placements.length, 0);
  const unplaced = r.unplaced.reduce((n, u) => n + u.quantity, 0);
  const sheetArea = settings.sheet.widthMm * settings.sheet.heightMm;
  const avgUtil = r.sheets.length ? r.sheets.reduce((s, x) => s + x.grossPartArea, 0) / (sheetArea * r.sheets.length) : 0;
  return (
    <div>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{r.sheets.length}</div>
          <div className="l">sheets {settings.sheet.label} · {settings.sheet.material} {settings.sheet.thicknessMm} mm</div>
        </div>
        <div className="kpi">
          <div className="v">
            {int(placed)} <span className="muted small">/ {int(placed + unplaced)}</span>
          </div>
          <div className="l">parts placed</div>
        </div>
        <div className="kpi">
          <div className="v">{pct(avgUtil)}</div>
          <div className="l">utilization over all sheets</div>
        </div>
        <div className="kpi">
          <div className="v">{r.sheets.length ? pct(1 - r.sheets[r.sheets.length - 1].utilization) : "–"}</div>
          <div className="l">free on the last sheet</div>
        </div>
        <div className="kpi">
          <div className="v">{v ? (v.ok ? <span className="badge ok">verified</span> : <span className="badge bad">{v.violations.length} violations</span>) : "–"}</div>
          <div className="l">independent geometry check</div>
        </div>
        <div className="kpi">
          <div className="v">{ms(r.timings.totalMs)}</div>
          <div className="l">
            {r.chosenStrategy.ordering} / {r.chosenStrategy.objective}
          </div>
        </div>
      </div>
      {unplaced > 0 && (
        <div className="note warn">
          <b>{int(unplaced)} parts could not be placed:</b>
          <ul className="plain">
            {r.unplaced.map((u) => (
              <li key={u.partId}>
                {parts.find((p) => p.id === u.partId)?.label ?? u.partId} × {u.quantity} — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {v && !v.ok && (
        <div className="note bad" role="alert">
          <b>The verifier found problems — do not cut this layout:</b>
          <ul className="plain">
            {v.violations.slice(0, 20).map((x, i) => (
              <li key={i}>
                sheet {x.sheet + 1}: {x.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!sheet && (
        <div className="note bad" role="alert">
          No sheet was produced: nothing could be placed. The reasons are listed above; change the sheet, the rotations or the parts and run again.
        </div>
      )}
      {sheet && (
      <div className="card">
        <div className="row between">
          <div className="row">
            <label className="field">
              Sheet
              <select value={sheet.index} onChange={(e) => setSheetIdx(Number(e.target.value))}>
                {r.sheets.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.index + 1} / {r.sheets.length} — {s.placements.length} parts — {pct(s.utilization)}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> labels
            </label>
            <label className="check">
              <input type="checkbox" checked={holes} onChange={(e) => setHoles(e.target.checked)} /> holes
            </label>
          </div>
          <div className="small muted">
            Utilization {pct(sheet.utilization)} = Σ outer areas {int(sheet.grossPartArea)} mm² ÷ sheet {int(sheetArea)} mm² (net of holes: {pct(sheet.netPartArea / sheetArea)}). Used box {sheet.usedBBox ? `${mm(sheet.usedBBox.maxX - sheet.usedBBox.minX, 0)} × ${mm(sheet.usedBBox.maxY - sheet.usedBBox.minY, 0)} mm` : "—"}.
          </div>
        </div>
        <SheetView result={r} sheet={sheet} parts={parts} violations={v?.violations ?? []} showLabels={labels} showHoles={holes} />
        <div className="legend">
          {parts.map((p, i) => {
            const n = sheet.placements.filter((pl) => pl.partId === p.id).length;
            if (!n) return null;
            return (
              <span key={p.id} className="small">
                <span className="sw" style={{ background: colorForIndex(i) }} /> {p.label} × {n} {p.name && <span className="muted">({p.name})</span>}
              </span>
            );
          })}
        </div>
      </div>
      )}
      <div className="grid">
        <div className="card">
          <h2>Parts</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Part</th>
                  <th>BOM</th>
                  <th className="num">Wanted</th>
                  <th className="num">Placed</th>
                  <th className="num">Area mm²</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {r.parts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.label} {p.name && <span className="muted small">{p.name}</span>}
                    </td>
                    <td>{p.bom ?? "—"}</td>
                    <td className="num">{p.quantity}</td>
                    <td className={`num ${p.placed < p.quantity ? "err" : ""}`}>{p.placed}</td>
                    <td className="num">{int(p.grossArea)}</td>
                    <td className="small muted">
                      {p.source?.file} <span className="mono">{p.source?.geometryHash.slice(0, 8)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>Verification</h2>
          {v && (
            <>
              <p className={v.ok ? "ok" : "err"}>
                {v.ok ? "All checks passed." : `${v.violations.length} violation(s).`} {v.stats.placementsChecked} placements, {v.stats.pairsChecked} close pairs checked. Minimum clearance {v.stats.minClearanceMm === null ? "n/a (no two parts within range)" : `${mm(v.stats.minClearanceMm, 3)} mm`} (required {settings.spacingMm}); minimum edge distance {v.stats.minEdgeDistanceMm === null ? "n/a" : `${mm(v.stats.minEdgeDistanceMm, 3)} mm`} (required {settings.marginMm}).
              </p>
              <p className="small muted">Checks: no overlap, spacing, sheet bounds, no-go zones, quantities complete, placed contours identical to the source (area and perimeter). Done on polygons that circumscribe the true arcs with {v.tolerances.sagittaMm} mm tolerance; distances get {v.tolerances.distanceTolMm} mm slack. Written independently of the nesting core.</p>
            </>
          )}
          <h3>Strategies tried</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Ordering / objective</th>
                  <th className="num">Sheets</th>
                  <th className="num">Utilization</th>
                  <th className="num">Last sheet</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {r.strategiesTried.map((t, i) => (
                  <tr key={i} style={{ fontWeight: t.strategy.ordering === r.chosenStrategy.ordering && t.strategy.objective === r.chosenStrategy.objective ? 600 : 400 }}>
                    <td>
                      {t.strategy.ordering} / {t.strategy.objective}
                    </td>
                    <td className="num">{t.sheets}</td>
                    <td className="num">{pct(t.utilization)}</td>
                    <td className="num">{pct(t.lastSheetUtilization)}</td>
                    <td className="num">{ms(t.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            NFPs computed {int(r.stats.nfpComputed)} ({ms(r.stats.nfpMs)}), cache hits {int(r.stats.nfpCacheHits)}, candidate positions {int(r.stats.candidatesEvaluated)}, boolean ops {ms(r.stats.booleanMs)}. Run {r.runId}, {r.engineVersion}.
          </p>
          <ul className="plain small muted">
            {r.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
      <button onClick={onRerun} disabled={!canRun}>
        Run again with the current settings
      </button>
    </div>
  );
}
