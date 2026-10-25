import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankMachines } from "./select";
import type { MachinesFile } from "./types";
import { suggestFromFileName } from "../dxf/fileName";

const file = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "config", "machines.local.json"), "utf8")) as MachinesFile;
const job = { material: "Steel", thicknessMm: 5, sheetWidthMm: 1220, sheetHeightMm: 2440, sheets: 2 };

describe("machine ranking", () => {
  it("never offers tube, roll-blank, fins or bending for a flat nesting", () => {
    const r = rankMachines(job, file);
    for (const code of ["B4-18", "B4-16", "B5-02", "BND-1"]) expect(r.find((a) => a.machine.code === code)?.compatibility).toBe("incompatible");
  });
  it("leaves lasers unconfirmed while their bed and thickness are unknown, punches conditional", () => {
    const r = rankMachines(job, file);
    const laser = r.find((a) => a.machine.code === "B4-09")!;
    expect(laser.compatibility).toBe("unconfirmed");
    expect(laser.toConfirm.join(" ")).toMatch(/bed size/);
    expect(laser.exportProfile).toBe("dxf-r2000-mm");
    const punch = r.find((a) => a.machine.code === "B4-06")!;
    expect(punch.compatibility).toBe("unconfirmed"); // punching is conditional, and its bed is unknown
    expect(punch.reasons.join(" ")).toMatch(/tooling/);
  });
  it("becomes compatible once the floor confirms the facts, and rules and queues reorder", () => {
    const f: MachinesFile = JSON.parse(JSON.stringify(file));
    for (const m of f.machines) if (m.process === "laser-flat") {
      m.processSource = "confirmed";
      m.bedMm = { width: 1500, height: 3000 };
      m.thicknessMm = { min: 1, max: 20 };
      m.materials = ["Steel", "Stainless steel"];
    }
    f.queue.hoursAhead = { "B4-09": 40, "B4-12": 5 };
    f.rules.items = [{ machineCode: "B4-10", effect: "never", maxThicknessMm: 6, note: "the 3 kW never takes 5 mm and up" }];
    const r = rankMachines(job, f);
    expect(r[0].machine.code).toBe("B4-12");
    expect(r[0].compatibility).toBe("compatible");
    expect(r.find((a) => a.machine.code === "B4-10")?.compatibility).toBe("incompatible");
    const small = rankMachines({ ...job, sheetWidthMm: 2000, sheetHeightMm: 6000 }, f);
    expect(small.find((a) => a.machine.code === "B4-09")?.compatibility).toBe("incompatible");
  });
});

describe("file name hints", () => {
  it("suggests BOM, thickness and units but never decides", () => {
    expect(suggestFromFileName("12005E14M13-5mm-50U-Result1-1.dxf")).toEqual({ bom: "12005E14M13", thicknessMm: 5, units: 50, looksLikeNestingResult: true });
    expect(suggestFromFileName("12003E14M13 - 93-Result1-1.dxf")).toEqual({ bom: "12003E14M13", thicknessMm: null, units: null, looksLikeNestingResult: true });
    expect(suggestFromFileName("bracket.dxf")).toEqual({ bom: null, thicknessMm: null, units: null, looksLikeNestingResult: false });
  });
});
