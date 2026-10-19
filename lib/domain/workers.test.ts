import { describe, expect, it } from "vitest";
import { parseWorkerSections, serializeWorkerDepts, workerDepts } from "./workers";

describe("worker sections", () => {
  it("reads the plant's section codes and drops anything unknown", () => {
    expect(parseWorkerSections("LaserCutTX, Fins,Oven,WeldingLV")).toEqual(["LaserCutTX", "Fins", "WeldingLV"]);
  });
  it("reads a bare department stored before the sections existed as its first section", () => {
    expect(parseWorkerSections("Cut,Welding,Painting,ShotBlast")).toEqual(["LaserCutTX", "WeldingTX", "PaintingTX", "ShotBlast"]);
  });
  it("keeps the leak testers and the quality inspectors under the codes already stored", () => {
    expect(parseWorkerSections("LeakTest")).toEqual(["LeakTest"]);
    expect(parseWorkerSections("WeldingTX,Quality,LeakTest")).toEqual(["WeldingTX", "Quality", "LeakTest"]);
  });
  it("serializes in the fixed section order", () => {
    expect(serializeWorkerDepts(["ShotBlast", "Fins", "LaserCutTX", "nonsense"])).toBe("LaserCutTX,Fins,ShotBlast");
    expect(serializeWorkerDepts(["Quality", "PaintingTX", "LeakTest", "WeldingTX"])).toBe("WeldingTX,LeakTest,PaintingTX,Quality");
  });
});

describe("worker departments", () => {
  it("credits a leak tester in LeakTest and an inspector in Quality", () => {
    expect(workerDepts(parseWorkerSections("LeakTest"))).toEqual(["LeakTest"]);
    expect(workerDepts(parseWorkerSections("Quality"))).toEqual(["Quality"]);
    expect(workerDepts(parseWorkerSections("WeldingTX,LeakTest"))).toEqual(["Welding", "LeakTest"]);
  });
  it("lists a department once however many of its sections are ticked", () => {
    expect(workerDepts(parseWorkerSections("LaserCutTX,BendingTX,Fins"))).toEqual(["Cut"]);
  });
});
