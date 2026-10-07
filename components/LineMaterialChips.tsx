import { sheetKeyLabel, sheetKeyOf, sheetSizeLabel, sheetsFor, thicknessLabel, type LineMaterial } from "@/lib/domain/machineMaterial";

// The sheet a machine line is cut from, beside the line — the thickness and
// material first (what the technician sets the machine for), then the sheet
// size and, where the line is being cut, the sheets its pieces take. Plain
// markup, so the board (client) and the printed machine sheet (server) both
// draw it the same way.

export function LineMaterialChips({ m, pcs, sheets, sheet = "", size = "sm" }: {
  m: LineMaterial | undefined;
  /** The pieces on THIS machine — the sheets scale to them. */
  pcs: number;
  /** Show the sheet count — the cutting step; a bend or a weld only needs the thickness. */
  sheets: boolean;
  /** The one sheet this machine cuts of the item ("" = every sheet). */
  sheet?: string;
  size?: "sm" | "print";
}) {
  const specs = sheet ? (m?.specs ?? []).filter((s) => sheetKeyOf(s) === sheet) : m?.specs ?? [];
  // a sheet the nesting no longer carries still says what it was
  if (sheet && specs.length === 0) return <span className={`pill pill-muted ${size === "print" ? "text-xs" : "text-[11px]"}`}>{sheetKeyLabel(sheet)}</span>;
  if (!m || specs.length === 0) return null;
  const cls = size === "print" ? "text-xs" : "text-[11px]";
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${cls}`}>
      {sheet && <span className="pill pill-muted text-[10px]" title="This machine cuts this one sheet of the item — the other sheets are on other machines or wait">1 of {m.specs.length} sheets</span>}
      {specs.map((s) => {
        const n = sheetsFor(s, pcs);
        return (
          <span
            key={`${s.material}|${s.thicknessMm}|${s.sheetSize}`}
            className="inline-flex items-baseline gap-1 whitespace-nowrap"
            title={`${s.material}${s.materialCode ? ` (${s.materialCode})` : ""}, ${s.thicknessMm} mm, sheet ${sheetSizeLabel(s.sheetSize)} — ${s.perUnit} sheet(s) a piece${s.actual ? " (actual nesting)" : " (BOM rate — not nested yet)"} · nesting ${m.month}`}
          >
            <b className="tabnum">{thicknessLabel(s)}</b>
            {s.sheetSize && <span className="text-muted tabnum">{sheetSizeLabel(s.sheetSize)}</span>}
            {sheets && <span className="tabnum font-bold">· {n} sh{s.actual ? "" : "*"}</span>}
          </span>
        );
      })}
    </span>
  );
}
