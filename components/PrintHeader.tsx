import Image from "next/image";

/** Paper header for the worklists and the Plan Tracker — invisible on screen,
 *  printed on the PDF: company logo, which sheet this is, and the day it was
 *  issued. `subtitle` carries a second line (e.g. which weekly plan). */
export function PrintHeader({ title, subtitle, date }: { title: string; subtitle?: string; date: string }) {
  return (
    <div className="print-only mb-4">
      <div className="flex items-center justify-between border-b-2 border-foreground pb-3">
        {/* priority = eager load: the header is display-none on screen, so a
            lazy image would never load and the print would come out blank */}
        <Image src="/brand/atc-logo-horizontal.svg" alt="Arabian Transformers Co." width={220} height={26} priority />
        <div className="text-right">
          <div className="text-xl font-extrabold">{title}</div>
          {subtitle && <div className="text-sm font-bold">{subtitle}</div>}
          <div className="text-sm tabnum">📅 {date}</div>
        </div>
      </div>
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
