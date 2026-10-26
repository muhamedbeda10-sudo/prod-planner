"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { DateSlicer } from "@/components/DateSlicer";
import { slicerPresets, type PresetKey, type SlicerPreset } from "@/lib/domain/dateSlicer";

// The date slicer for a page that keeps its period in the URL. Each page has
// always written its dates its own way; `encoding` says which:
//   fromTo   ?from=&to=            (the dashboards; `defaultRange` clears them)
//   odooDay  ?day=D | A..B | all   (the ODOO log)
//   odooDash ?range=preset | custom&from=&to=   (the ODOO dashboard)
//   day      ?day=D                (one day: the shift log)

type Encoding = "fromTo" | "odooDay" | "odooDash" | "day";

const ODOO_DASH_CODE: Partial<Record<string, string>> = { today: "today", yesterday: "yesterday", last7: "7d", last30: "30d", last90: "90d", thisMonth: "month" };

export function UrlDateSlicer({
  encoding, mode = "range", from, to, min, max, today, presets, allLabel, marks, label, defaultRange, start, end,
}: {
  encoding: Encoding;
  mode?: "range" | "day";
  from: string | null;
  to: string | null;
  min: string;
  max: string;
  /** The factory's today, from the server — the quick filters count from it. */
  today: string;
  presets: PresetKey[];
  allLabel?: string;
  marks?: readonly string[];
  label?: string;
  /** The page's own default period, first among the quick filters: picking
   *  it clears the dates from the URL, so the page is back to itself. */
  defaultRange?: { label: string; from: string; to: string };
  /** The page's own controls on the slicer's row (see DateSlicer). */
  start?: React.ReactNode;
  end?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const list: SlicerPreset[] = useMemo(() => {
    const own = slicerPresets(presets, today, min);
    if (!defaultRange) return own;
    return [{ key: "default", label: defaultRange.label, from: defaultRange.from, to: defaultRange.to }, ...own.filter((p) => !(p.from === defaultRange.from && p.to === defaultRange.to))];
  }, [presets, today, min, defaultRange]);

  const go = (f: string | null, t: string | null) => {
    const p = new URLSearchParams(params.toString());
    const isDefault = !!defaultRange && f === defaultRange.from && t === defaultRange.to;
    switch (encoding) {
      case "fromTo":
        p.delete("w");
        if (f && t && !isDefault) { p.set("from", f); p.set("to", t); } else { p.delete("from"); p.delete("to"); }
        break;
      case "odooDay":
        p.set("day", !f || !t ? "all" : f === t ? f : `${f}..${t}`);
        break;
      case "odooDash": {
        const code = f && t ? list.find((x) => x.from === f && x.to === t && ODOO_DASH_CODE[x.key])?.key : null;
        if (!f || !t) { p.set("range", "all"); p.delete("from"); p.delete("to"); }
        else if (code) { p.set("range", ODOO_DASH_CODE[code]!); p.delete("from"); p.delete("to"); }
        else { p.set("range", "custom"); p.set("from", f); p.set("to", t); }
        break;
      }
      case "day":
        if (f) p.set("day", f);
        break;
    }
    router.push(`${pathname}?${p}`);
  };

  return (
    <DateSlicer
      mode={mode} from={from} to={mode === "day" ? from : to} min={min} max={max}
      presets={list} allLabel={allLabel} marks={marks} label={label} onChange={go}
      start={start} end={end}
    />
  );
}
