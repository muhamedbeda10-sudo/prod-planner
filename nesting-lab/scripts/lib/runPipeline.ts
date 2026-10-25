// Nest → verify → export (in memory) → write the files. The sample runner and
// the CLI share this; the UI calls the same exportRun without the writes.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nest, type NestOptions } from "../../src/engine/nesting/nest";
import type { NestPartInput, NestResult, NestSettings } from "../../src/engine/nesting/types";
import { verifyLayout } from "../../src/engine/nesting/verify";
import { exportRun } from "../../src/engine/export/exportRun";
import type { RunReport } from "../../src/engine/export/report";
import type { MachinesFile } from "../../src/engine/machines/types";

export interface PipelineOutput {
  result: NestResult;
  report: RunReport;
  files: string[];
}

export interface PipelineOptions extends Omit<NestOptions, "onProgress"> {
  /** zero every timing in the report so a re-run writes byte-identical files */
  scrubTimings?: boolean;
}

export function runPipeline(parts: NestPartInput[], settings: NestSettings, outDir: string, machines: MachinesFile | null, log: (s: string) => void = () => {}, opts: PipelineOptions = {}): PipelineOutput {
  mkdirSync(outDir, { recursive: true });
  const { scrubTimings, ...nestOpts } = opts;
  const result = nest(parts, settings, { ...nestOpts, onProgress: (p) => log(`  ${p.message} (${p.placed}/${p.total})`) });
  const tv = performance.now();
  const verification = verifyLayout(parts, result);
  const verifyMs = performance.now() - tv;
  const out = exportRun(parts, result, verification, machines, { timings: { verifyMs } });
  if (scrubTimings) {
    const rep = out.report;
    rep.timings = { totalMs: 0, verifyMs: 0, exportMs: 0 };
    rep.stats = { ...rep.stats, nfpMs: 0, booleanMs: 0 };
    rep.strategiesTried = rep.strategiesTried.map((t) => ({ ...t, ms: 0 }));
    const json = out.files.find((f) => f.profileId === "json-report");
    if (json) json.text = JSON.stringify(rep, null, 2);
  }
  const files: string[] = [];
  for (const f of out.files) {
    const full = join(outDir, f.fileName);
    writeFileSync(full, f.text);
    files.push(full);
  }
  return { result, report: out.report, files };
}
