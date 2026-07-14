import Image from "next/image";

/** Paper header for the worklists — invisible on screen, printed on the PDF:
 *  company logo, which department sheet this is, and the day it was issued. */
export function PrintHeader({ title, date }: { title: string; date: string }) {
  return (
    <div className="print-only mb-4">
      <div className="flex items-center justify-between border-b-2 border-foreground pb-3">
        {/* priority = eager load: the header is display-none on screen, so a
            lazy image would never load and the print would come out blank */}
        <Image src="/brand/atc-logo-horizontal.svg" alt="Arabian Transformers Co." width={220} height={26} priority />
        <div className="text-right">
          <div className="text-xl font-extrabold">{title}</div>
          <div className="text-sm tabnum">📅 {date}</div>
        </div>
      </div>
    </div>
  );
}
