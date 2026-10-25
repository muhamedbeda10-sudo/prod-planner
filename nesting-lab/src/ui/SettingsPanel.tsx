import type { SettingsForm } from "./state";
import type { NestPartInput, StrategySpec } from "../engine/nesting/types";
import { DEFAULT_STRATEGIES } from "../engine/nesting/nest";
import { int } from "./format";
import type { SkippedPart } from "../engine/parts";

interface Props {
  form: SettingsForm;
  onChange: (f: SettingsForm) => void;
  materials: { materials: { name: string }[]; sheetSizes: { label: string; widthMm: number; heightMm: number }[]; thicknessesMm: number[] };
  parts: NestPartInput[];
  skipped: SkippedPart[];
  errors: string[];
  onRun: () => void;
  running: boolean;
}

const ROTATIONS = [0, 45, 90, 135, 180, 225, 270, 315];

export function SettingsPanel({ form, onChange, materials, parts, skipped, errors, onRun, running }: Props) {
  const set = (patch: Partial<SettingsForm>) => onChange({ ...form, ...patch });
  const total = parts.reduce((n, p) => n + p.quantity, 0);
  const toggleRot = (r: number) => set({ rotations: form.rotations.includes(r) ? form.rotations.filter((x) => x !== r) : [...form.rotations, r].sort((a, b) => a - b) });
  const stratKey = (s: StrategySpec) => `${s.ordering}/${s.objective}`;
  const toggleStrat = (s: StrategySpec) => {
    const has = form.strategies.some((x) => stratKey(x) === stratKey(s));
    set({ strategies: has ? form.strategies.filter((x) => stratKey(x) !== stratKey(s)) : [...form.strategies, s] });
  };
  return (
    <div className="grid">
      <div className="card">
        <h2>Sheet and material</h2>
        <div className="toolbar">
          <label className="field">
            Sheet size
            <select
              value={form.sheetPreset}
              onChange={(e) => {
                const v = e.target.value;
                const p = materials.sheetSizes.find((s) => s.label === v);
                set(p ? { sheetPreset: v, widthMm: p.widthMm, heightMm: p.heightMm } : { sheetPreset: "custom" });
              }}
            >
              {materials.sheetSizes.map((s) => (
                <option key={s.label} value={s.label}>
                  {s.label}
                </option>
              ))}
              <option value="custom">custom</option>
            </select>
          </label>
          <label className="field">
            Width (mm)
            <input type="number" min="1" value={form.widthMm} onChange={(e) => set({ widthMm: Number(e.target.value), sheetPreset: "custom" })} />
          </label>
          <label className="field">
            Height (mm)
            <input type="number" min="1" value={form.heightMm} onChange={(e) => set({ heightMm: Number(e.target.value), sheetPreset: "custom" })} />
          </label>
          <label className="field">
            Sheets in stock
            <span className="row">
              <input type="number" min="1" value={form.quantity} disabled={form.unlimited} onChange={(e) => set({ quantity: Number(e.target.value) })} />
              <label className="check">
                <input type="checkbox" checked={form.unlimited} onChange={(e) => set({ unlimited: e.target.checked })} /> unlimited
              </label>
            </span>
          </label>
        </div>
        <div className="toolbar" style={{ marginTop: 8 }}>
          <label className="field">
            Material
            <select value={form.material} onChange={(e) => set({ material: e.target.value })}>
              {materials.materials.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Thickness (mm)
            <input type="number" min="0.1" step="0.1" list="thk" value={form.thicknessMm} onChange={(e) => set({ thicknessMm: Number(e.target.value) })} />
            <datalist id="thk">
              {materials.thicknessesMm.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
        </div>
        <p className="small muted">Materials, sheet sizes and the thickness list are copied from the planner&apos;s Material tab (config/materials.local.json); nothing is read from the database.</p>
      </div>
      <div className="card">
        <h2>Clearances and rotations</h2>
        <div className="toolbar">
          <label className="field">
            Part-to-part spacing (mm)
            <input type="number" min="0" step="0.5" value={form.spacingMm} onChange={(e) => set({ spacingMm: Number(e.target.value) })} />
          </label>
          <label className="field">
            Edge margin (mm)
            <input type="number" min="0" step="0.5" value={form.marginMm} onChange={(e) => set({ marginMm: Number(e.target.value) })} />
          </label>
          <label className="check" style={{ alignSelf: "center" }}>
            <input type="checkbox" checked={form.allowMirror} onChange={(e) => set({ allowMirror: e.target.checked })} /> allow mirrored parts
          </label>
        </div>
        <div className="note small">Spacing is the geometric gap between finished contours. It is <b>not</b> kerf compensation: the machine&apos;s program applies the kerf, once. If the laser&apos;s CAM adds its own part gap, set spacing here to the clearance you want on the sheet and let the CAM add nothing.</div>
        <h3>Allowed rotations</h3>
        <div className="row">
          {ROTATIONS.map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={form.rotations.includes(r)} onChange={() => toggleRot(r)} /> {r}°
            </label>
          ))}
        </div>
        <p className="small muted">With a grain direction, allow 0° and 180° only. Mirroring is off by default: a mirrored part is a different part unless the drawing says both hands are fine.</p>
      </div>
      <div className="card">
        <h2>No-go zones (clamps, damaged areas)</h2>
        {form.noGoZones.length === 0 && <p className="small muted">None. A zone is a rectangle in sheet coordinates (origin bottom-left); parts keep the edge margin away from it.</p>}
        {form.noGoZones.map((z, i) => (
          <div className="toolbar" key={i} style={{ marginBottom: 4 }}>
            <label className="field">
              Label
              <input type="text" value={z.label} style={{ width: "8em" }} onChange={(e) => set({ noGoZones: form.noGoZones.map((q, j) => (j === i ? { ...q, label: e.target.value } : q)) })} />
            </label>
            {(["x", "y", "w", "h"] as const).map((k) => (
              <label className="field" key={k}>
                {k} (mm)
                <input type="number" value={z[k]} onChange={(e) => set({ noGoZones: form.noGoZones.map((q, j) => (j === i ? { ...q, [k]: Number(e.target.value) } : q)) })} />
              </label>
            ))}
            <button className="small" onClick={() => set({ noGoZones: form.noGoZones.filter((_, j) => j !== i) })}>
              remove
            </button>
          </div>
        ))}
        <button className="small" onClick={() => set({ noGoZones: [...form.noGoZones, { x: 0, y: 0, w: 100, h: 50, label: `zone ${form.noGoZones.length + 1}` }] })}>
          + add zone
        </button>
      </div>
      <div className="card">
        <h2>Search</h2>
        <h3>Strategies to try (best is kept)</h3>
        {DEFAULT_STRATEGIES.map((s) => (
          <label key={stratKey(s)} className="check" style={{ marginRight: 12 }}>
            <input type="checkbox" checked={form.strategies.some((x) => stratKey(x) === stratKey(s))} onChange={() => toggleStrat(s)} /> {s.ordering} / {s.objective}
          </label>
        ))}
        <div className="toolbar" style={{ marginTop: 8 }}>
          <label className="field">
            Time budget (s)
            <input type="number" min="1" value={form.timeBudgetS} onChange={(e) => set({ timeBudgetS: Number(e.target.value) })} />
          </label>
          <label className="field">
            Arc tolerance (mm)
            <input type="number" min="0.01" step="0.05" value={form.sagittaMm} onChange={(e) => set({ sagittaMm: Number(e.target.value) })} />
          </label>
          <label className="field">
            Simplification (mm)
            <input type="number" min="0" step="0.01" value={form.simplifyTolMm} onChange={(e) => set({ simplifyTolMm: Number(e.target.value) })} />
          </label>
        </div>
        <p className="small muted">Best = fewest sheets, then the emptiest last sheet (largest remnant). The nesting polygons circumscribe the true arcs, so a smaller tolerance costs time but never safety; the verifier checks the exact contours regardless.</p>
      </div>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="row between">
          <div>
            <b>{int(total)}</b> parts of <b>{parts.length}</b> types will be nested.
            {skipped.length > 0 && <span className="muted small"> Left out: {skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}</span>}
          </div>
          <button className="primary" onClick={onRun} disabled={errors.length > 0 || running}>
            {running ? "Nesting…" : "Run nesting →"}
          </button>
        </div>
        {errors.length > 0 && (
          <ul className="plain small err" role="alert">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
