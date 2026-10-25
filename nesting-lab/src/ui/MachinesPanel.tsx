import type { MachinesFile, MachineConfig } from "../engine/machines/types";
import type { NestResult, NestSettings } from "../engine/nesting/types";
import { jobFactsOf, rankMachines } from "../engine/machines/select";
import { EXPORT_PROFILES } from "../engine/export/postprocessors";

interface Props {
  machines: MachinesFile;
  onChange: (m: MachinesFile) => void;
  settings: NestSettings;
  result: NestResult | null;
}

export function MachinesPanel({ machines, onChange, settings, result }: Props) {
  const job = jobFactsOf(settings, result?.sheets.length ?? 0);
  const ranked = rankMachines(job, machines);
  const update = (code: string, patch: Partial<MachineConfig>) => onChange({ ...machines, machines: machines.machines.map((m) => (m.code === code ? { ...m, ...patch } : m)) });
  const setQueue = (code: string, hours: number | null) => {
    const q = { ...machines.queue.hoursAhead };
    if (hours === null) delete q[code];
    else q[code] = hours;
    onChange({ ...machines, queue: { hoursAhead: q } });
  };
  const badge = (c: string) => (c === "compatible" ? "ok" : c === "conditional" ? "info" : c === "unconfirmed" ? "warn" : "bad");
  return (
    <div>
      <div className="note">
        Job: <b>{job.sheets || "?"}</b> sheet(s) of {job.sheetWidthMm} × {job.sheetHeightMm} mm {job.material} {job.thicknessMm} mm. Machines come from <span className="mono">config/machines.local.json</span>, a read-only copy of the planner&apos;s list ({machines.source}). Edits here stay in this browser tab. <b>Nothing is queued on any machine.</b>
      </div>
      <div className="tablewrap card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Machine</th>
              <th>Fit</th>
              <th>Why</th>
              <th>To confirm with the floor</th>
              <th>Export</th>
              <th>Capabilities (local, editable)</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((a) => {
              const m = a.machine;
              return (
                <tr key={m.code}>
                  <td className="num">{a.rank}</td>
                  <td>
                    <b>{m.code}</b> {m.name}
                    <div className="small muted">
                      {m.dept} · {m.center} · {m.hoursPerDay ?? "?"} h/day
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${badge(a.compatibility)}`}>{a.compatibility}</span>
                    {a.preferred && <span className="badge ok">preferred</span>}
                  </td>
                  <td className="small">
                    <ul className="plain">
                      {a.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="small">
                    <ul className="plain">
                      {a.toConfirm.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="small">{a.exportProfile ? EXPORT_PROFILES.find((p) => p.id === a.exportProfile)?.name ?? a.exportProfile : "—"}</td>
                  <td>
                    {a.compatibility !== "incompatible" || m.center === "Cutting" ? (
                      <div className="toolbar small">
                        <label className="field">
                          process
                          <select value={m.process} onChange={(e) => update(m.code, { process: e.target.value as MachineConfig["process"], processSource: "confirmed" })}>
                            {["laser-flat", "punching", "laser-tube", "laser-roll-blank", "fin-folding", "bending", "other"].map((p) => (
                              <option key={p} value={p}>
                                {p}
                                {p === m.process && m.processSource !== "confirmed" ? " (unconfirmed)" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          bed W × H
                          <span className="row">
                            <input type="number" placeholder="?" value={m.bedMm?.width ?? ""} onChange={(e) => update(m.code, { bedMm: e.target.value === "" ? null : { width: Number(e.target.value), height: m.bedMm?.height ?? 0 } })} style={{ width: "5em" }} />
                            <input type="number" placeholder="?" value={m.bedMm?.height ?? ""} onChange={(e) => update(m.code, { bedMm: e.target.value === "" ? null : { width: m.bedMm?.width ?? 0, height: Number(e.target.value) } })} style={{ width: "5em" }} />
                          </span>
                        </label>
                        <label className="field">
                          thickness min–max
                          <span className="row">
                            <input type="number" placeholder="?" value={m.thicknessMm?.min ?? ""} onChange={(e) => update(m.code, { thicknessMm: e.target.value === "" ? null : { min: Number(e.target.value), max: m.thicknessMm?.max ?? 0 } })} style={{ width: "4em" }} />
                            <input type="number" placeholder="?" value={m.thicknessMm?.max ?? ""} onChange={(e) => update(m.code, { thicknessMm: e.target.value === "" ? null : { min: m.thicknessMm?.min ?? 0, max: Number(e.target.value) } })} style={{ width: "4em" }} />
                          </span>
                        </label>
                        <label className="field">
                          materials
                          <input type="text" placeholder="? (comma separated)" value={m.materials?.join(", ") ?? ""} onChange={(e) => update(m.code, { materials: e.target.value.trim() === "" ? null : e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} style={{ width: "11em" }} />
                        </label>
                        <label className="field">
                          queued hours
                          <input type="number" placeholder="?" value={machines.queue.hoursAhead[m.code] ?? ""} onChange={(e) => setQueue(m.code, e.target.value === "" ? null : Number(e.target.value))} style={{ width: "5em" }} />
                        </label>
                      </div>
                    ) : (
                      <span className="small muted">{m.notes}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>How the ranking works</h2>
        <ol className="plain small">
          <li>Compatibility first: a flat-sheet process (laser, or punching with its tooling caveat), an active Fabrication machine, a bed that takes the sheet, the thickness and material within its range, and the planner&apos;s only/never rules. A fact the app does not record is reported as &quot;to confirm&quot;, never assumed.</li>
          <li>Then the planner&apos;s &quot;prefer&quot; rules, then the shorter queue, then laser power, then the machine code.</li>
          <li>At integration the same decision runs on live data: Machine, MachineRule (lib/domain/machineRules.ts), WorklistMachine and ManualJob queues, hours a day and downtime.</li>
        </ol>
      </div>
    </div>
  );
}
