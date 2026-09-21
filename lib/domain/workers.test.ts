import { describe, expect, it } from "vitest";
import { parseWorkerSections, serializeWorkerDepts } from "./workers";

describe("worker sections", () => {
  it("reads the plant's section codes and drops anything unknown", () => {
    expect(parseWorkerSections("LaserCutTX, Fins,Oven,WeldingLV")).toEqual(["LaserCutTX", "Fins", "WeldingLV"]);
  });
  it("reads a bare department stored before the sections existed as its first section", () => {
    expect(parseWorkerSections("Cut,Welding,Painting,ShotBlast,LeakTest,Quality")).toEqual(["LaserCutTX", "WeldingTX", "PaintingTX", "ShotBlast"]);
  });
  it("serializes in the fixed section order", () => {
    expect(serializeWorkerDepts(["ShotBlast", "Fins", "LaserCutTX", "nonsense"])).toBe("LaserCutTX,Fins,ShotBlast");
  });
});
