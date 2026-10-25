// Export profiles. A profile is "configured" only when its specification is
// known and its output has been verified by reading it back. Machine programs
// (NC, controller-specific formats) are listed so the gap is visible — they
// are NOT produced by renaming a DXF.

export type ProfileKind = "geometry" | "preview" | "report" | "program";

export interface ExportProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  extension: string;
  units: "mm";
  configured: boolean;
  version: string;
  /** what the output contains and how it is laid out */
  spec: string[];
  /** what is still needed before this profile can be built */
  missing?: string[];
}

export const EXPORT_PROFILES: ExportProfile[] = [
  {
    id: "dxf-r2000-mm",
    name: "DXF R2000 (AC1015), millimetres",
    kind: "geometry",
    extension: ".dxf",
    units: "mm",
    configured: true,
    version: "1",
    spec: [
      "$INSUNITS = 4 (mm) stated in the header; origin at the sheet's bottom-left corner, X along the width, Y along the height.",
      "One file per sheet. Layers: SHEET (outline, colour 8), CUT_INNER (holes, colour 1), CUT_OUTER (outer contours, colour 7), MARK (marking geometry, colour 3), LABEL (part labels as TEXT, colour 4).",
      "Per part the inner contours are written before the outer contour (inside-out cutting order).",
      "Arcs are kept as LWPOLYLINE bulges and CIRCLE entities — no curve faceting.",
      "Verified by reading every exported file back with this parser and with an independent library (ezdxf) and comparing each part's area, perimeter and box with the source.",
    ],
  },
  {
    id: "dxf-r2000-mm-parts",
    name: "DXF R2000 — one file per part (library export)",
    kind: "geometry",
    extension: ".dxf",
    units: "mm",
    configured: true,
    version: "1",
    spec: ["Same conventions as the sheet DXF; the part's bbox min is at the origin."],
  },
  { id: "svg-preview", name: "SVG preview", kind: "preview", extension: ".svg", units: "mm", configured: true, version: "1", spec: ["One SVG per sheet with exact arcs, colours per part type and labels. For viewing, not for cutting."] },
  { id: "csv-cutlist", name: "Cut list (CSV)", kind: "report", extension: ".csv", units: "mm", configured: true, version: "1", spec: ["Parts per sheet, utilization per sheet, requested/placed/unplaced per part. UTF-8 with BOM for Excel."] },
  { id: "json-report", name: "Run report (JSON)", kind: "report", extension: ".json", units: "mm", configured: true, version: "1", spec: ["Inputs, settings, engine version, every placement, verification result and round-trip check — enough to reproduce or audit the run."] },
  {
    id: "laser-nc-generic",
    name: "Laser NC program (G-code)",
    kind: "program",
    extension: ".nc",
    units: "mm",
    configured: false,
    version: "—",
    spec: [],
    missing: ["The controller family of each laser (Bodor / GF: e.g. Cypcut/FSCUT, HypCut, Siemens…) and its program format specification.", "A known-good sample program cut on that machine, to compare against.", "The technology table: lead-in/lead-out, kerf, pierce, speed per material/thickness — these belong to the CAM, not to this nesting."],
  },
  {
    id: "punch-program",
    name: "Punching machine program",
    kind: "program",
    extension: "—",
    units: "mm",
    configured: false,
    version: "—",
    spec: [],
    missing: ["Punching is not a path: it needs the turret/tool library, station assignment and hit sequencing. The nesting geometry (DXF) can be imported into the punch CAM, but no program is produced here."],
  },
];

export function profileById(id: string): ExportProfile | undefined {
  return EXPORT_PROFILES.find((p) => p.id === id);
}
