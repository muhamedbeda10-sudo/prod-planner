import { describe, expect, it } from "vitest";
import { MAX_JOB_PARTS, editedJobQty, jobName, jobSheetKey, jobsBySheet, manualDescription, manualMaterial, partNameSuggestions, partRowsOf, partsText, readJobParts } from "./manualJob";

describe("editedJobQty — a new count of pieces wanted on a manual job", () => {
  it("is refused below what is done, or when it is not whole pieces above 0", () => {
    expect(editedJobQty(5, 4)).toEqual({ ok: false, error: expect.stringContaining("5 piece(s) are done already") });
    expect(editedJobQty(0, 0)).toEqual({ ok: false, error: expect.stringContaining("above 0") });
    expect(editedJobQty(0, 2.5)).toEqual({ ok: false, error: expect.stringContaining("whole number") });
    expect(editedJobQty(0, Number.NaN)).toMatchObject({ ok: false });
  });

  it("finishes the job when it equals what is done, and leaves it open above that", () => {
    expect(editedJobQty(5, 5)).toEqual({ ok: true, finished: true });
    expect(editedJobQty(5, 6)).toEqual({ ok: true, finished: false });
    expect(editedJobQty(0, 1)).toEqual({ ok: true, finished: false });
  });
});

describe("editedJobQty — a sheet job's sheets", () => {
  it("speaks in sheets cut", () => {
    expect(editedJobQty(4, 3, true)).toEqual({ ok: false, error: expect.stringContaining("4 sheet(s) are cut already") });
    expect(editedJobQty(0, 0, true)).toEqual({ ok: false, error: "Sheets must be a whole number above 0." });
    expect(editedJobQty(4, 4, true)).toEqual({ ok: true, finished: true });
  });
});

describe("readJobParts — the parts on a sheet job's sheets", () => {
  it("reads each part as typed: the BOM trimmed, the component upper-cased, the part's spaces folded", () => {
    expect(readJobParts([{ bom: " B1 ", item: "tn", part: " Side   wall ", pcs: 8 }, { bom: "", item: "", part: "Bracket", pcs: "2" }])).toEqual({
      ok: true,
      parts: [{ bom: "B1", item: "TN", part: "Side wall", pcs: 8 }, { bom: "", item: "", part: "Bracket", pcs: 2 }],
    });
  });

  it("needs at least one part, each named, with whole pieces and a known component — and the same part once", () => {
    expect(readJobParts([])).toMatchObject({ ok: false, error: expect.stringContaining("at least one") });
    expect(readJobParts("x")).toMatchObject({ ok: false });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "", pcs: 1 }])).toMatchObject({ ok: false, error: expect.stringContaining("name the part") });
    expect(readJobParts([{ bom: "B1", item: "XX", part: "Bottom", pcs: 1 }])).toMatchObject({ ok: false, error: expect.stringContaining("component must be one of") });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: 0 }])).toMatchObject({ ok: false, error: expect.stringContaining("whole number above 0") });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: 1.5 }])).toMatchObject({ ok: false });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: 1 }, { bom: "b1", item: "tn", part: "bottom", pcs: 2 }])).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
    expect(readJobParts(Array.from({ length: MAX_JOB_PARTS + 1 }, (_, i) => ({ bom: "B1", item: "TN", part: `P${i}`, pcs: 1 })))).toMatchObject({ ok: false, error: expect.stringContaining(`At most ${MAX_JOB_PARTS}`) });
  });
});

describe("a sheet job on the board", () => {
  const job = { title: "", bom: "", item: "", bySheet: true, thicknessMm: 3, material: "Steel", sheetSize: "1250*2500", sheets: null, qty: 10,
    parts: [{ id: 1, bom: "B1", item: "TN", part: "Bottom", pcs: 4 }, { id: 2, bom: "", item: "", part: "Bracket", pcs: 2 }] };

  it("is named by its sheet unless it was given a name, and the board writes its sheet and parts", () => {
    expect(jobSheetKey(job)).toBe("3|Steel|1250*2500");
    expect(jobName(job)).toBe("3 mm MS 1250×2500");
    expect(jobName({ ...job, title: " Nest 14 " })).toBe("Nest 14");
    expect(partsText(job.parts)).toBe("B1 TN Bottom ×4 · Bracket ×2");
    expect(manualDescription(job)).toBe("🧾 3 mm MS 1250×2500 — B1 TN Bottom ×4 · Bracket ×2");
    expect(manualDescription({ ...job, title: "Nest 14", parts: [] })).toBe("🧾 3 mm MS 1250×2500 · Nest 14");
    // a job in pieces reads as it always did
    expect(manualDescription({ ...job, bySheet: false, title: "Lugs", bom: "B1", item: "Lug" })).toBe("✋ Lugs · BOM B1 · Lug");
  });

  it("is one sheet a unit — the card and the printed sheet count its sheets", () => {
    expect(manualMaterial(job)?.specs[0]).toMatchObject({ thicknessMm: 3, material: "Steel", perUnit: 1 });
    expect(manualMaterial({ ...job, bySheet: false, sheets: 5 })?.specs[0].perUnit).toBe(0.5);
    expect(manualMaterial({ ...job, thicknessMm: null })).toBeNull();
  });

  it("only the fabrication board counts its jobs in sheets", () => {
    expect(jobsBySheet("Cut")).toBe(true);
    for (const d of ["Welding", "Painting", "ShotBlast"]) expect(jobsBySheet(d)).toBe(false);
  });

  it("offers the part names typed before, most used first, one spelling each", () => {
    const parts = (names: string[]) => ({ parts: names.map((part, id) => ({ id, bom: "", item: "", part, pcs: 1 })) });
    expect(partNameSuggestions([parts(["Bottom", "Side wall"]), parts(["side wall", "Skirt base"]), parts(["  "])])).toEqual(["Side wall", "Bottom", "Skirt base"]);
  });
});

describe("a part's pieces are optional", () => {
  it("reads a blank or missing count as not given, and still checks one that is given", () => {
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: "" }, { bom: "B1", item: "TN", part: "Side wall", pcs: null }, { bom: "B1", item: "TN", part: "Skirt base" }])).toEqual({
      ok: true,
      parts: [
        { bom: "B1", item: "TN", part: "Bottom", pcs: null },
        { bom: "B1", item: "TN", part: "Side wall", pcs: null },
        { bom: "B1", item: "TN", part: "Skirt base", pcs: null },
      ],
    });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: " 4 " }])).toEqual({ ok: true, parts: [{ bom: "B1", item: "TN", part: "Bottom", pcs: 4 }] });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: "0" }])).toMatchObject({ ok: false, error: expect.stringContaining("or left empty") });
    expect(readJobParts([{ bom: "B1", item: "TN", part: "Bottom", pcs: "abc" }])).toMatchObject({ ok: false });
  });

  it("writes a part without its count as just its name", () => {
    expect(partsText([{ bom: "B1", item: "TN", part: "Bottom", pcs: null }, { bom: "B2", item: "TN", part: "Side wall", pcs: 8 }])).toBe("B1 TN Bottom · B2 TN Side wall ×8");
  });
});

describe("partRowsOf — the part rows as the form holds them", () => {
  it("zips the columns back into rows, dropping a row left wholly empty", () => {
    expect(partRowsOf({
      bom: [" B1 ", "", "", "B2"],
      item: ["TN", "TN", "", "CB"],
      part: ["Bottom", "", "", " Cable box "],
      pcs: ["4", "", "", ""],
    })).toEqual([
      { bom: "B1", item: "TN", part: "Bottom", pcs: "4" },
      { bom: "B2", item: "CB", part: "Cable box", pcs: null },
    ]);
  });

  it("keeps a row with only a count or only a project, for the check to name what it lacks", () => {
    expect(partRowsOf({ bom: ["B1", ""], item: ["", ""], part: ["", ""], pcs: ["", "3"] })).toEqual([
      { bom: "B1", item: "", part: "", pcs: null },
      { bom: "", item: "", part: "", pcs: "3" },
    ]);
  });
});
