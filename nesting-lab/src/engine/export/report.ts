// The run report: everything needed to audit or reproduce a nesting.

import type { NestPartInput, NestResult } from "../nesting/types";
import type { VerifyReport } from "../nesting/verify";
import type { RoundTripReport } from "./roundtrip";
import type { MachineAssessment } from "../machines/types";
import { geometryHash } from "./hash";
import { loopArea, loopBBox, loopPerimeter } from "../geometry/polygon";

export interface ExportedFile {
  fileName: string;
  profileId: string;
  bytes: number;
  sheetIndex?: number;
}

export interface RunReport {
  schema: "nesting-lab/report/1";
  runId: string;
  engineVersion: string;
  createdAt: string;
  settings: NestResult["settings"];
  parts: {
    id: string;
    label: string;
    bom?: string;
    partNo?: string;
    name?: string;
    quantity: number;
    placed: number;
    widthMm: number;
    heightMm: number;
    grossAreaMm2: number;
    netAreaMm2: number;
    perimeterMm: number;
    holes: number;
    geometryHash: string;
    source?: NestPartInput["source"];
  }[];
  sheets: NestResult["sheets"];
  unplaced: NestResult["unplaced"];
  chosenStrategy: NestResult["chosenStrategy"];
  strategiesTried: NestResult["strategiesTried"];
  stats: NestResult["stats"];
  timings: NestResult["timings"] & { verifyMs?: number; exportMs?: number };
  notes: string[];
  verification: VerifyReport | null;
  roundTrip: { sheetIndex: number; fileName: string; report: RoundTripReport }[];
  machines: { compatibility: string; code: string; name: string; rank: number; reasons: string[]; toConfirm: string[]; exportProfile: string | null }[] | null;
  exports: ExportedFile[];
}

export function buildReport(input: { parts: NestPartInput[]; result: NestResult; verification: VerifyReport | null; roundTrip: RunReport["roundTrip"]; machines: MachineAssessment[] | null; exports: ExportedFile[]; timings?: { verifyMs?: number; exportMs?: number } }): RunReport {
  const { parts, result } = input;
  return {
    schema: "nesting-lab/report/1",
    runId: result.runId,
    engineVersion: result.engineVersion,
    createdAt: result.createdAt,
    settings: result.settings,
    parts: parts.map((p) => {
      const b = loopBBox(p.outer);
      const gross = Math.abs(loopArea(p.outer));
      const summary = result.parts.find((x) => x.id === p.id);
      return {
        id: p.id,
        label: p.label,
        bom: p.bom,
        partNo: p.partNo,
        name: p.name,
        quantity: p.quantity,
        placed: summary?.placed ?? 0,
        widthMm: b.maxX - b.minX,
        heightMm: b.maxY - b.minY,
        grossAreaMm2: gross,
        netAreaMm2: gross - p.holes.reduce((s, h) => s + Math.abs(loopArea(h)), 0),
        perimeterMm: loopPerimeter(p.outer),
        holes: p.holes.length,
        geometryHash: geometryHash(p.outer, p.holes),
        source: p.source,
      };
    }),
    sheets: result.sheets,
    unplaced: result.unplaced,
    chosenStrategy: result.chosenStrategy,
    strategiesTried: result.strategiesTried,
    stats: result.stats,
    timings: { ...result.timings, ...input.timings },
    notes: result.notes,
    verification: input.verification,
    roundTrip: input.roundTrip,
    machines: input.machines ? input.machines.map((m) => ({ compatibility: m.compatibility, code: m.machine.code, name: m.machine.name, rank: m.rank, reasons: m.reasons, toConfirm: m.toConfirm, exportProfile: m.exportProfile })) : null,
    exports: input.exports,
  };
}
