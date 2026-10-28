import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialClient } from "@/components/MaterialClient";
import type { MaterialLineView } from "@/lib/domain/material";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/material" }));
vi.mock("@/app/prefs/actions", () => ({ saveUserPref: vi.fn() }));
vi.mock("@/app/material/actions", () => ({ importMaterialAction: vi.fn() }));

const line = (over: Partial<MaterialLineView>): MaterialLineView => ({
  id: 1, month: "", bom: "10017E11M11", mo: "SF01/MO/100", units: 10, partCode: "FB-022", partName: "TANK", materialCode: "T-SSS-5MM",
  material: "Steel", thicknessMm: 5, sheetSize: "1220*2440", sheetsPerUnit: 1, sheetsUsed: 11, producedQty: null, note: null,
  soi: "S01035-1", mtr: "MTR-7", weightKg: 117, utilization: 0.82, actualWeightKg: 1287, producedAuto: null, producedUsed: null, remainingUnits: null,
  forJob: 10, difference: -1, actualPerUnit: 1.1, forProduced: null, updatedISO: "2026-10-01", recordedBy: null,
  planMonths: ["October 2026", "September 2026"], planMatch: "soi", ...over,
});

const render = (props: Partial<Parameters<typeof MaterialClient>[0]>) =>
  renderToStaticMarkup(createElement(MaterialClient, { lines: [line({})], canImport: false, ...props }));

describe("MaterialClient", () => {
  it("shows the plan month on the line, the run band and the strip of what the lines add up to", () => {
    const html = render({ lines: [line({ id: 1 }), line({ id: 2, mo: "SF01/MO/101", planMonths: [], planMatch: null, difference: 0.5, sheetsUsed: 9.5, actualWeightKg: 1111.5 })] });
    expect(html).toContain("Plan month");
    expect(html).toContain("October 2026");
    expect(html).toContain("+1");
    expect(html).toContain("Not in a plan");
    for (const run of ["Order", "Job", "Part", "Sheet", "Per unit", "For the job"]) expect(html).toContain(`>${run}<`);
    expect(html).toContain("kpi-strip");
    expect(html).toContain("1 line over the BOM");
  });
  it("leaves out the columns the person switched off and pins the identifiers that stay", () => {
    const html = render({ prefs: { "material:cols": "v1|soi,bom,units,plan,partCode,material,thk,size,bomJob,actualJob,diff" } });
    expect(html).not.toContain("MTR #");
    expect(html).not.toContain("Part name");
    expect(html).not.toContain("Odoo / unit");
    // SOI is the first pinned column now, MO after it
    expect(html).toMatch(/--stick-left:0rem;--stick-w:6.75rem/);
    expect(html).toMatch(/--stick-left:6.75rem;--stick-w:16rem/);
  });
  it("gives the panels' sheet its own columns, Plan month among them", () => {
    const html = render({ product: "LV", lines: [line({ partName: "LSS", remainingUnits: 4, producedUsed: 6, forProduced: 6.6 })] });
    expect(html).toContain("Remaining");
    expect(html).toContain("Plan month");
    expect(html).not.toContain("Group by SOI");
  });
});
