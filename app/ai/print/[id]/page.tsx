import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { getCurrentUser } from "@/lib/server/auth";
import { printableSheet } from "@/lib/server/ai/files";
import { chatStatusFor } from "@/lib/server/ai/panel";
import { formatDateTime } from "@/lib/domain/format";
import { AutoPrint } from "@/components/AutoPrint";
import { TableFrame, Th } from "@/components/DataTable";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { PageHead } from "@/components/ui";

export const metadata = { title: "Print — ATC" };
export const dynamic = "force-dynamic";

/** The most rows a printout carries — past that, paper is the wrong medium. */
const PRINT_ROWS = 2000;

const isNumber = (s: string) => /^-?\d[\d,]*(\.\d+)?%?$/.test(s.trim());

// A sheet the assistant made, laid out for paper: the company header, the
// sheet as a table, and the print dialog opened on arrival. The person's own
// file only, as its download is.
export default async function AiPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!(await chatStatusFor(me)).visible) redirect("/");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const s = await printableSheet(me.id, id, PRINT_ROWS);
  if (!s) notFound();
  const title = s.name.replace(/\.xlsx$/i, "");
  const numeric = s.header.map((_, c) => s.rows.length > 0 && s.rows.every((r) => !r[c] || isNumber(r[c])));

  return (
    <div className="space-y-3">
      <AutoPrint />
      <PrintHeader title={title} subtitle={`${s.sheet} · ${s.total.toLocaleString("en-US")} rows`} date={formatDateTime(s.createdAt)} />
      <PageHead
        title={title}
        sub={`${s.total.toLocaleString("en-US")} rows`}
        actions={<>
          <a href={`/api/ai/files/${id}`} className="btn btn-secondary btn-sm"><Download size={14} aria-hidden /> Download Excel</a>
          <PrintButton />
        </>}
      >
        <span className="font-semibold">{title}</span>
        <span className="text-muted text-sm tabnum">{s.total.toLocaleString("en-US")} rows · made {formatDateTime(s.createdAt)}</span>
      </PageHead>
      {s.total > s.rows.length && (
        <p className="text-sm font-semibold text-warn-fg" role="status">This printout carries the first {s.rows.length.toLocaleString("en-US")} of {s.total.toLocaleString("en-US")} rows. Download the Excel file for all of them.</p>
      )}
      <TableFrame className="print-flow">
        <table className="w-full text-sm">
          <thead>
            <tr>{s.header.map((h, c) => <Th key={c} label={h} num={numeric[c]} />)}</tr>
          </thead>
          <tbody>
            {s.rows.map((r, i) => (
              <tr key={i} className="border-t">
                {s.header.map((_, c) => <td key={c} className={`px-2 py-1 ${numeric[c] ? "text-right tabnum" : ""}`}>{r[c] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}
