import { useMemo, useState } from "react";
import type { RunState } from "./state";
import type { MachinesFile } from "../engine/machines/types";
import { EXPORT_PROFILES } from "../engine/export/postprocessors";
import { cutListFileName, exportRun, reportFileName, sheetFileName, type ExportedRun } from "../engine/export/exportRun";
import { partDxf } from "../engine/export/sheetExport";
import { download, int, mm } from "./format";

interface Props {
  run: RunState;
  machines: MachinesFile;
}

export function ExportPanel({ run, machines }: Props) {
  const r = run.result;
  const parts = run.parts;
  const [built, setBuilt] = useState<ExportedRun | null>(null);
  const stem = useMemo(() => (r ? `${r.runId.replace(/[^a-z0-9-]/gi, "")}-` : "nest-"), [r]);
  if (!r) {
    return (
      <div className="card">
        <p>Run a nesting first; the exports are produced from its result.</p>
        <ProfilesTable />
      </div>
    );
  }
  // every artifact is produced once per run, read back and compared, then offered for download
  const cur = built && built.report.runId === r.runId ? built : null;
  const ensure = (): ExportedRun => {
    if (cur) return cur;
    const out = exportRun(parts, r, run.verification, machines, { stem });
    setBuilt(out);
    return out;
  };
  const dl = (fileName: string) => {
    const f = ensure().files.find((x) => x.fileName === fileName);
    if (f) download(f.fileName, f.text, f.mediaType);
  };
  const files = cur?.files ?? null;
  const rtFor = (sheetIndex: number) => cur?.roundTrip.find((x) => x.sheetIndex === sheetIndex)?.report;
  const sheetName = (i: number, ext: string) => sheetFileName(stem, i, ext);
  return (
    <div>
      {run.verification && !run.verification.ok && (
        <div className="note bad" role="alert">
          The layout failed verification — exports are available for inspection only, not for cutting.
        </div>
      )}
      <div className="card">
        <h2>Sheets</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <button onClick={() => ensure()}>Build every file and read the DXFs back</button>
          <button
            onClick={() => {
              for (const f of ensure().files) if (f.profileId === "dxf-r2000-mm") download(f.fileName, f.text, f.mediaType);
            }}
          >
            Download all sheet DXFs
          </button>
          <button onClick={() => dl(cutListFileName(stem))}>Cut list (CSV)</button>
          <button onClick={() => dl(reportFileName(stem))}>Run report (JSON)</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Sheet</th>
                <th className="num">Parts</th>
                <th>DXF (R2000, mm)</th>
                <th>SVG</th>
                <th>Read-back check</th>
              </tr>
            </thead>
            <tbody>
              {r.sheets.map((sh) => {
                const rt = rtFor(sh.index);
                return (
                  <tr key={sh.index}>
                    <td>{sh.index + 1}</td>
                    <td className="num">{sh.placements.length}</td>
                    <td>
                      <button className="small" onClick={() => dl(sheetName(sh.index, ".dxf"))}>
                        {sheetName(sh.index, ".dxf")}
                      </button>
                    </td>
                    <td>
                      <button className="small" onClick={() => dl(sheetName(sh.index, ".svg"))}>
                        {sheetName(sh.index, ".svg")}
                      </button>
                    </td>
                    <td className="small">
                      {rt ? (
                        <>
                          <span className={`badge ${rt.ok ? "ok" : "bad"}`}>{rt.ok ? "identical" : "MISMATCH"}</span> {rt.matched}/{rt.piecesExpected} parts found, {rt.holesFound}/{rt.holesExpected} holes, units {rt.unitsStated ? `stated (${rt.insunits})` : "missing"}, max box Δ {rt.maxBBoxDeltaMm.toExponential(1)} mm, max area Δ {rt.maxAreaDeltaMm2.toExponential(1)} mm²
                          {rt.mismatches.length > 0 && (
                            <ul className="plain err">
                              {rt.mismatches.map((m, i) => (
                                <li key={i}>{m}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <span className="muted">not built yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {files && <p className="small muted">{files.length} files built: {files.map((f) => f.fileName).join(", ")}.</p>}
        <p className="small muted">Origin at the sheet&apos;s bottom-left corner, X along the width ({r.settings.sheet.widthMm} mm), Y along the height ({r.settings.sheet.heightMm} mm). Layers SHEET / CUT_INNER / CUT_OUTER / MARK / LABEL; inner contours before outer. Open the file in your CAD/CAM and check the extents read {int(r.settings.sheet.widthMm)} × {int(r.settings.sheet.heightMm)} mm.</p>
      </div>
      <div className="card">
        <h2>Part library</h2>
        <div className="row">
          {parts.map((p) => (
            <button key={p.id} className="small" onClick={() => download(`${p.label.replace(/[^A-Za-z0-9_-]+/g, "_")}.dxf`, partDxf(p), "application/dxf")}>
              {p.label}.dxf <span className="muted">({mm(p.outer.segs.length, 0)} segs)</span>
            </button>
          ))}
        </div>
        <p className="small muted">One DXF per part type, bbox at the origin, holes and marks included — what a drawing library would store next to the original file and its version.</p>
      </div>
      <ProfilesTable />
    </div>
  );
}

function ProfilesTable() {
  return (
    <div className="card">
      <h2>Export profiles</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Specification / what is missing</th>
            </tr>
          </thead>
          <tbody>
            {EXPORT_PROFILES.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b> <span className="mono muted">{p.id}</span>
                </td>
                <td>{p.kind}</td>
                <td>{p.configured ? <span className="badge ok">configured, verified</span> : <span className="badge bad">not configured</span>}</td>
                <td className="small">
                  <ul className="plain">
                    {(p.configured ? p.spec : p.missing ?? []).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">A machine program is produced only from a documented controller format and a known-good sample from that machine. Renaming a DXF is not support.</p>
    </div>
  );
}
