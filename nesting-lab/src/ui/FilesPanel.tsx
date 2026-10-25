import { useState } from "react";
import type { LoadedFile, PartRow } from "./state";
import { defaultRow, fileShort, partKey } from "./state";
import { partIdOf } from "../engine/parts";
import { SELECTABLE_UNITS, type SelectableUnit } from "../engine/dxf/units";
import type { LayerRole } from "../engine/dxf/primitives";
import { PartThumb } from "./PartThumb";
import { colorForIndex } from "../engine/export/svg";
import { mm, ms, int } from "./format";

interface Props {
  files: LoadedFile[];
  rows: Record<string, PartRow>;
  onAdd: (files: FileList | File[]) => void;
  onUpdate: (id: string, patch: Partial<Pick<LoadedFile, "unit" | "layerRoles" | "thicknessMm" | "bom">>) => void;
  onRemove: (id: string) => void;
  onRows: (rows: Record<string, PartRow>) => void;
  onNext: () => void;
}

const KIND_LABEL: Record<string, string> = {
  "single-part": "Single part drawing",
  "multi-part": "Several parts (no sheet boundary)",
  "nesting-ready": "Finished nesting: sheet boundary with parts inside",
  "no-closed-geometry": "No closed cut geometry",
};

export function FilesPanel({ files, rows, onAdd, onUpdate, onRemove, onRows, onNext }: Props) {
  const [over, setOver] = useState(false);
  return (
    <div>
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onAdd(e.dataTransfer.files);
        }}
      >
        <p>Drop DXF files here, or</p>
        <label>
          <input type="file" accept=".dxf,.DXF" multiple className="visually-hidden" onChange={(e) => e.target.files && onAdd(e.target.files)} aria-label="Choose DXF files" />
          <span className="badge info filebtn">Choose files…</span>
        </label>
        <p className="small">ASCII DXF (R12 … R2018). The file never leaves this browser.</p>
      </div>
      {files.map((f, fi) => (
        <FileCard key={f.id} file={f} index={fi} rows={rows} onUpdate={onUpdate} onRemove={onRemove} onRows={onRows} />
      ))}
      {files.length > 0 && (
        <div className="row between">
          <span className="muted small">Next: sheet, material, spacing and rotations.</span>
          <button className="primary" onClick={onNext}>
            Continue to settings →
          </button>
        </div>
      )}
    </div>
  );
}

function FileCard({ file: f, index, rows, onUpdate, onRemove, onRows }: { file: LoadedFile; index: number; rows: Record<string, PartRow>; onUpdate: Props["onUpdate"]; onRemove: Props["onRemove"]; onRows: Props["onRows"] }) {
  const a = f.analysis;
  const cls = a?.classification ?? null;
  const groups = a?.parts?.groups ?? [];
  const rowOf = (gi: number): PartRow => rows[partKey(f.id, gi)] ?? defaultRow(f.id, gi, groups[gi].representative.depth, groups[gi].instances.length);
  const setRow = (gi: number, patch: Partial<PartRow>) => {
    const cur = rowOf(gi);
    onRows({ ...rows, [cur.key]: { ...cur, ...patch } });
  };
  const included = groups.reduce((n, _g, gi) => {
    const r = rowOf(gi);
    return n + (r.include ? r.qty : 0);
  }, 0);
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>
          <span className="badge muted" style={{ marginRight: 8 }}>{fileShort(index)}</span>
          {f.name} <span className="muted small">({int(f.bytes.length / 1024)} KB{a ? `, ${a.acadVersion ?? "no version"}` : ""})</span>
        </h2>
        <button className="small" onClick={() => onRemove(f.id)}>
          Remove
        </button>
      </div>
      {f.error && (
        <div className="note bad" role="alert">
          Cannot use this file: {f.error}
        </div>
      )}
      {a && (
        <>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <label className="field">
              Drawing unit {a.units.stated ? <span className="badge ok">stated: {a.units.name}</span> : <span className="badge warn">not stated ($INSUNITS = 0)</span>}
              <select value={f.unit ?? ""} onChange={(e) => onUpdate(f.id, { unit: (e.target.value || null) as SelectableUnit | null })} disabled={a.units.stated}>
                <option value="">{a.units.stated ? a.units.name : "— choose —"}</option>
                {SELECTABLE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Sheet thickness (mm)
              <input type="number" step="0.1" min="0" value={f.thicknessMm ?? ""} onChange={(e) => onUpdate(f.id, { thicknessMm: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <label className="field">
              BOM for this file
              <input type="text" value={f.bom} onChange={(e) => onUpdate(f.id, { bom: e.target.value })} placeholder="e.g. 12005E14M13" />
            </label>
            {(f.hints.bom || f.hints.thicknessMm || f.hints.units) && (
              <span className="small muted">
                From the file name (not applied): {f.hints.bom && <>BOM <b>{f.hints.bom}</b> </>}
                {f.hints.thicknessMm && <>thickness <b>{f.hints.thicknessMm} mm</b> </>}
                {f.hints.units && <>units <b>{f.hints.units}</b> </>}
                <button className="small" onClick={() => onUpdate(f.id, { bom: f.hints.bom ?? f.bom, thicknessMm: f.hints.thicknessMm ?? f.thicknessMm })}>
                  apply BOM/thickness
                </button>
              </span>
            )}
          </div>
          {a.needsUnit && (
            <div className="note warn">
              This file does not say whether its numbers are millimetres or inches. Its extents are {a.extents.stated ? `${mm(a.extents.stated.maxX - a.extents.stated.minX)} × ${mm(a.extents.stated.maxY - a.extents.stated.minY)}` : "unknown"} drawing units
              {a.extents.stated && Math.abs(a.extents.stated.maxX - a.extents.stated.minX - 1220) < 20 && Math.abs(a.extents.stated.maxY - a.extents.stated.minY - 2440) < 20 ? " — the size of a standard 1220 × 2440 mm sheet, so mm is likely, but choose it yourself." : "."} Choose the unit above to continue.
            </div>
          )}
          <div className="grid" style={{ marginTop: 8 }}>
            <div>
              <h3>Layers</h3>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Layer</th>
                      <th>Entities</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.layers.map((l) => (
                      <tr key={l.name}>
                        <td>
                          <span className="mono">{l.name}</span> {!l.defined && <span className="badge muted" title="Used by entities but missing from the LAYER table">undefined</span>}
                        </td>
                        <td className="small">{l.entities.map((e) => `${e.count} ${e.type}`).join(", ") || "—"}</td>
                        <td>
                          <select value={l.role} onChange={(e) => onUpdate(f.id, { layerRoles: { ...f.layerRoles, [l.name]: e.target.value as LayerRole } })}>
                            <option value="cut">cut</option>
                            <option value="mark">mark (engrave, not cut)</option>
                            <option value="ignore">ignore</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">Every layer is treated as cut geometry until you say otherwise — a layer is never dropped because of its name.</p>
            </div>
            <div>
              <h3>What the file contains</h3>
              <ul className="plain small">
                <li>Entities: {a.entityCounts.map((e) => `${e.count} ${e.type}`).join(", ")}</li>
                {a.extraction && a.extraction.insertsExpanded.length > 0 && <li>Blocks expanded: {a.extraction.insertsExpanded.map((b) => `${b.block} ×${b.count}`).join(", ")}</li>}
                {a.extraction && a.extraction.unsupported.length > 0 && <li className="err">Not usable as cut geometry: {a.extraction.unsupported.map((u) => `${u.count} × ${u.type} (layer ${u.layer})`).join(", ")}</li>}
                {a.extraction && a.extraction.annotations.length > 0 && <li>Annotation (not cut): {a.extraction.annotations.map((u) => `${u.count} × ${u.type}`).join(", ")}</li>}
                {a.extraction && a.extraction.ignoredByLayer.length > 0 && <li>Ignored by layer role: {a.extraction.ignoredByLayer.map((u) => `${u.count} × ${u.type} (${u.layer})`).join(", ")}</li>}
                {a.topology && (
                  <li>
                    Topology: {a.topology.edges} edges, {a.topology.faces} closed faces, {a.topology.openChains} open chains, {a.topology.splitsApplied} splits at shared edges, {a.topology.duplicatesRemoved} duplicates merged (snap {a.topology.snapTolMm} mm, largest gap closed {a.topology.maxGapClosed.toFixed(4)} mm)
                  </li>
                )}
                {a.extents.computed && <li>Cut geometry spans {mm(a.extents.computed.maxX - a.extents.computed.minX)} × {mm(a.extents.computed.maxY - a.extents.computed.minY)} mm</li>}
                <li>Analysis time {ms(a.timings.totalMs)}</li>
              </ul>
              {cls && (
                <div className={`note ${cls.kind === "no-closed-geometry" ? "bad" : ""}`}>
                  <b>{KIND_LABEL[cls.kind]}</b>
                  {cls.sheetSize && <> — sheet boundary {mm(cls.sheetSize.w)} × {mm(cls.sheetSize.h)} mm (not a part; the drawing&apos;s extents are not necessarily the stock sheet)</>}
                  <br />
                  {cls.pieces.length} pieces → {groups.length} part types{cls.ignoredFaces.length > 0 && <>; {cls.ignoredFaces.length} faces not taken as parts</>}
                </div>
              )}
              {a.warnings.length > 0 && (
                <ul className="plain small">
                  {a.warnings.map((w, i) => (
                    <li key={i} className={/not supported|does not state|smaller than the sheet thickness|Cannot|No closed/.test(w) ? "err" : ""}>
                      {w}
                    </li>
                  ))}
                </ul>
              )}
              {cls && cls.ignoredFaces.length > 0 && (
                <details className="small">
                  <summary>Faces not taken as parts ({cls.ignoredFaces.length})</summary>
                  <ul className="plain">
                    {cls.ignoredFaces.map((g, i) => (
                      <li key={i}>
                        {mm(g.bbox.maxX - g.bbox.minX)} × {mm(g.bbox.maxY - g.bbox.minY)} mm, {mm(g.area, 0)} mm² — {g.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
          {groups.length > 0 && (
            <>
              <h3>Part types ({groups.length}) — {included} parts selected for nesting</h3>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Use</th>
                      <th>Id</th>
                      <th>Shape</th>
                      <th className="num">W × H mm</th>
                      <th className="num">Area mm²</th>
                      <th className="num">Holes</th>
                      <th className="num">Found</th>
                      <th className="num">Qty to nest</th>
                      <th>Part no.</th>
                      <th>Name</th>
                      <th>BOM</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g, gi) => {
                      const r = rowOf(gi);
                      const p = g.representative;
                      return (
                        <tr key={gi} style={{ opacity: r.include ? 1 : 0.55 }}>
                          <td>
                            <input type="checkbox" checked={r.include} onChange={(e) => setRow(gi, { include: e.target.checked })} aria-label={`Use part type ${partIdOf(fileShort(index), gi)}`} />
                          </td>
                          <td className="mono">{partIdOf(fileShort(index), gi)}</td>
                          <td>
                            <PartThumb outer={p.outer.loop} holes={p.holes.map((h) => h.loop)} marks={p.marks} color={colorForIndex(gi)} />
                          </td>
                          <td className="num">
                            {mm(p.bbox.maxX - p.bbox.minX)} × {mm(p.bbox.maxY - p.bbox.minY)}
                          </td>
                          <td className="num">{int(p.area)}</td>
                          <td className="num">
                            {p.holes.length}
                            {p.marks.length > 0 && <span className="muted"> +{p.marks.length} marks</span>}
                          </td>
                          <td className="num">
                            {g.instances.length}
                            {g.mirrorOf !== null && (
                              <>
                                {" "}
                                <span className="badge info" title="A mirror image of another type: kept separate, because a left and a right part are different pieces to cut">
                                  mirror of {partIdOf(undefined, g.mirrorOf)}
                                </span>
                              </>
                            )}
                          </td>
                          <td className="num">
                            <input type="number" min="0" step="1" value={r.qty} onChange={(e) => setRow(gi, { qty: Number(e.target.value) })} style={{ width: "5em" }} aria-label="Quantity to nest" />
                          </td>
                          <td>
                            <input type="text" value={r.partNo} onChange={(e) => setRow(gi, { partNo: e.target.value })} style={{ width: "8em" }} placeholder="FB-022…" aria-label="Part number" />
                          </td>
                          <td>
                            <input type="text" value={r.name} onChange={(e) => setRow(gi, { name: e.target.value })} style={{ width: "9em" }} placeholder="Side wall…" aria-label="Part name" />
                          </td>
                          <td>
                            <input type="text" value={r.bom} onChange={(e) => setRow(gi, { bom: e.target.value })} style={{ width: "8em" }} placeholder={f.bom || "BOM"} aria-label="BOM" />
                          </td>
                          <td className="small">
                            {p.review.map((fl, i) => (
                              <div key={i} className="err">
                                {fl}
                              </div>
                            ))}
                            {p.flags.map((fl, i) => (
                              <div key={i} className="muted">
                                {fl}
                              </div>
                            ))}
                            <div className="muted">pieces {g.instances.map((x) => x.pieceId).join(", ")}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="small muted">&quot;Found&quot; is how many identical copies the file contains (exact rigid match, mirror images kept apart). Quantities are never read from the file name; type what the plan needs.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
