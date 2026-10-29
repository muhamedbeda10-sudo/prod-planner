import Image from "next/image";
import { PrintTitle } from "@/components/PrintTitle";

/** Paper header for every report the app prints — invisible on screen,
 *  printed on the PDF: the ATC logo on the left and the report's title on the
 *  right, over a green rule. It makes the printout a report: the company art
 *  along the foot of its pages, on paper of either orientation (globals.css
 *  @page report), fetched here with the logo so the print dialog finds both
 *  ready, and its title the PDF's file name. */
export function PrintHeader({ title }: { title: string }) {
  return (
    <div className="print-only report-head">
      {/* eager: the header is display-none on screen, so a lazy image would
          never load and the print would come out blank */}
      <Image src="/brand/atc-logo-stacked.svg" alt="Arabian Transformers Co." width={2060} height={1091} loading="eager" className="report-logo" />
      <div className="report-title">{title}</div>
      <Image src="/brand/report-banner.svg" alt="" width={1600} height={120} loading="eager" className="hidden" />
      <PrintTitle title={title} />
    </div>
  );
}

/** The filters that produced a printout, printed as one line under the header.
 *  A tracker sheet on the floor is otherwise ambiguous: 40 of 300 rows with no
 *  note of WHY looks like the whole plan. Falsy parts drop out. */
export function PrintScope({ parts }: { parts: (string | false | null | undefined)[] }) {
  const shown = parts.filter(Boolean) as string[];
  if (shown.length === 0) return null;
  return <div className="print-only mb-2 text-xs font-semibold">{shown.join("  ·  ")}</div>;
}
