import { jobSheetLabel, type ManualJobView } from "@/lib/domain/manualJob";

// A sheet job on a machine line: the sheet (what the technician sets the
// machine for), the sheets left on this machine and how far the job is, then
// every project's part the sheets carry. Plain markup, so the board
// (client), the floor and the printed machine sheet (server) draw it alike.

export function SheetJobLine({ job, left, size = "sm" }: {
  job: Pick<ManualJobView, "id" | "title" | "qty" | "doneQty" | "parts" | "thicknessMm" | "material" | "sheetSize" | "note">;
  /** The sheets on THIS machine still to cut. */
  left: number;
  size?: "sm" | "print";
}) {
  const print = size === "print";
  return (
    <span className={`inline-flex min-w-0 flex-col gap-0.5 ${print ? "text-sm" : ""}`}>
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-extrabold tabnum">🧾 {jobSheetLabel(job)}</span>
        <span className="tabnum font-extrabold text-brand whitespace-nowrap" title={`${left} sheet(s) of this job on this machine still to cut`}>{left} sh</span>
        <span className="text-[11px] text-muted tabnum whitespace-nowrap" title="Sheets of the whole job cut so far">{job.doneQty}/{job.qty} cut</span>
        {job.title.trim() && <span className="text-[11px] text-muted truncate">{job.title}</span>}
        <span className="text-[10px] text-muted tabnum">#{job.id}</span>
      </span>
      {job.parts.length > 0 && (
        <span className={`flex flex-wrap gap-1 ${print ? "text-xs" : "text-[11px]"}`}>
          {job.parts.map((p) => (
            <span key={p.id} className="pill pill-muted tabnum" title={`${p.pcs !== null ? `${p.pcs} piece(s) of ` : ""}${p.part}${p.bom ? ` for ${p.bom}` : ""} on these sheets`}>
              {p.bom && <b>{p.bom}</b>} {p.item} {p.part}{p.pcs !== null && ` ×${p.pcs}`}
            </span>
          ))}
        </span>
      )}
      {print && job.note && <span className="text-xs text-muted">{job.note}</span>}
    </span>
  );
}
