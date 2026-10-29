import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { getCurrentUser } from "@/lib/server/auth";
import { printableSheets, type PrintableSheet } from "@/lib/server/ai/files";
import { chatStatusFor } from "@/lib/server/ai/panel";
import { formatDateTime, formatNumber } from "@/lib/domain/format";
import { aiFileHref } from "@/lib/domain/links";
import { TOTAL_LABEL, isTotalRow } from "@/lib/domain/sheetLayout";
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

// A sheet the assistant made, laid out for paper: the company header, each
// sheet of the file as a table under its name (a file split by thickness
// prints every thickness), and the print dialog opened on arrival. The
// person's own file only, as its download is.
export default async function AiPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const [chat, f] = await Promise.all([chatStatusFor(me), printableSheets(me.id, id, PRINT_ROWS)]);
  if (!chat.visible) redirect("/");
  if (!f) notFound();
  // the file's own title when it has one, else its name
  const title = f.title[0] ?? f.name.replace(/\.xlsx$/i, "");
  const laid = f.sheets.map((s) => ({ s, ...footOf(s) }));
  // the rows the file holds — each sheet's Total row not counted, as the assistant's answer counts them
  const all = laid.reduce((n, l) => n + l.count, 0);
  const printed = laid.reduce((n, l) => n + l.body.length, 0);
  const total = formatNumber(all);
  const many = f.sheets.length > 1;
  const rowsText = `${many ? `${f.sheets.length} sheets · ` : ""}${total} rows`;
  const subtitle = [f.title[1], many ? null : f.sheets[0].sheet, rowsText].filter(Boolean).join(" · ");

  return (
    <div className="space-y-3">
      <AutoPrint />
      <PrintHeader title={title} subtitle={subtitle} date={formatDateTime(f.createdAt)} />
      <PageHead
        title={title}
        sub={`${total} rows`}
        actions={<>
          <a href={aiFileHref(id)} className="btn btn-secondary btn-sm"><Download size={14} aria-hidden /> Download Excel</a>
          <PrintButton />
        </>}
      >
        <span className="font-semibold">{title}</span>
        <span className="text-muted text-sm tabnum">{f.title[1] ? `${f.title[1]} · ` : ""}{rowsText} · made {formatDateTime(f.createdAt)}</span>
      </PageHead>
      {all > printed && (
        <p className="text-sm font-semibold text-warn-fg" role="status">This printout carries the first {formatNumber(printed)} of {total} rows. Download the Excel file for all of them.</p>
      )}
      {laid.filter((l) => l.s.rows.length > 0 || !many).map((l, i) => (
        <section key={l.s.sheet} className={i > 0 ? "space-y-1 pt-2" : "space-y-1"}>
          {many && <h2 className="font-bold">{l.s.sheet} <span className="text-muted text-sm font-semibold tabnum">{formatNumber(l.count)} rows</span></h2>}
          <SheetTable name={l.s.sheet} header={l.s.header} body={l.body} foot={l.foot} />
        </section>
      ))}
    </div>
  );
}

/** A sheet's closing Total row — its last, printed — apart from its rows, and the rows it closes. */
function footOf(s: PrintableSheet): { body: string[][]; foot: string[] | null; count: number } {
  const last = s.rows.at(-1);
  const foot = last && s.rows.length === s.total && isTotalRow(last) ? last : null;
  return { body: foot ? s.rows.slice(0, -1) : s.rows, foot, count: s.total - (foot ? 1 : 0) };
}

/** One sheet as a table, its Total row the table's foot. */
function SheetTable({ name, header, body, foot }: { name: string; header: string[]; body: string[][]; foot: string[] | null }) {
  const numeric = header.map((_, c) => body.length > 0 && body.every((r) => !r[c] || isNumber(r[c])));
  const cell = (c: number) => `px-2 py-1 ${numeric[c] ? "text-right tabnum" : ""}`;
  return (
    // a wide sheet takes the tracker's tighter paper steps
    <TableFrame className={`report-table print-flow print-fit ${header.length > 12 ? "print-tight" : ""}`}>
      <table className="w-full text-sm">
        <caption className="sr-only">{name}</caption>
        <thead>
          <tr>{header.map((h, c) => <Th key={c} label={h} num={numeric[c]} />)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-t">
              {header.map((_, c) => <td key={c} className={cell(c)}>{r[c] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr>
              {header.map((_, c) => (foot[c] === TOTAL_LABEL
                ? <th key={c} scope="row" className={`${cell(c)} text-left`}>{foot[c]}</th>
                : <td key={c} className={cell(c)}>{foot[c] ?? ""}</td>))}
            </tr>
          </tfoot>
        )}
      </table>
    </TableFrame>
  );
}
