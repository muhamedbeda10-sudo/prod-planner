// Produce every artifact of a run in memory: sheet DXFs (read back and
// compared), SVGs, the cut list, the machine ranking and the JSON report. The
// CLI writes the files; the UI offers them for download. No I/O here.

import type { NestPartInput, NestResult } from "../nesting/types";
import type { VerifyReport } from "../nesting/verify";
import type { MachinesFile } from "../machines/types";
import { jobFactsOf, rankMachines } from "../machines/select";
import { sheetDxf } from "./sheetExport";
import { sheetSvg } from "./svg";
import { cutListCsv } from "./csv";
import { verifyDxfRoundTrip } from "./roundtrip";
import { buildReport, type ExportedFile, type RunReport } from "./report";

export interface RunArtifact {
  fileName: string;
  profileId: string;
  mediaType: string;
  text: string;
  sheetIndex?: number;
}

export interface ExportedRun {
  files: RunArtifact[];
  roundTrip: RunReport["roundTrip"];
  report: RunReport;
}

export const sheetFileName = (stem: string, sheetIndex: number, ext: string) => `${stem}sheet-${String(sheetIndex + 1).padStart(2, "0")}${ext}`;

export function exportRun(parts: NestPartInput[], result: NestResult, verification: VerifyReport | null, machines: MachinesFile | null, opts: { stem?: string; timings?: { verifyMs?: number; exportMs?: number } } = {}): ExportedRun {
  const t0 = performance.now();
  const stem = opts.stem ?? "";
  const files: RunArtifact[] = [];
  const roundTrip: RunReport["roundTrip"] = [];
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  for (const sh of result.sheets) {
    const dxf = sheetDxf(result, sh, parts);
    const dxfName = sheetFileName(stem, sh.index, ".dxf");
    files.push({ fileName: dxfName, profileId: "dxf-r2000-mm", mediaType: "application/dxf", text: dxf, sheetIndex: sh.index });
    files.push({ fileName: sheetFileName(stem, sh.index, ".svg"), profileId: "svg-preview", mediaType: "image/svg+xml", text: sheetSvg(result, sh, parts), sheetIndex: sh.index });
    roundTrip.push({ sheetIndex: sh.index, fileName: dxfName, report: verifyDxfRoundTrip(dxf, result, sh, parts) });
  }
  files.push({ fileName: `${stem}cutlist.csv`, profileId: "csv-cutlist", mediaType: "text/csv", text: cutListCsv(result, parts) });
  const ranking = machines ? rankMachines(jobFactsOf(result.settings, result.sheets.length), machines) : null;
  const exports: ExportedFile[] = files.map((f) => ({ fileName: f.fileName, profileId: f.profileId, bytes: bytes(f.text), sheetIndex: f.sheetIndex }));
  const reportName = `${stem}report.json`;
  exports.push({ fileName: reportName, profileId: "json-report", bytes: 0 });
  const report = buildReport({ parts, result, verification, roundTrip, machines: ranking, exports, timings: { ...opts.timings, exportMs: opts.timings?.exportMs ?? performance.now() - t0 } });
  files.push({ fileName: reportName, profileId: "json-report", mediaType: "application/json", text: JSON.stringify(report, null, 2) });
  return { files, roundTrip, report };
}
