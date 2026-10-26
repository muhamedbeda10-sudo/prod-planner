"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCarryLine } from "@/components/LineContext";
import { traceHref } from "@/lib/domain/links";
import type { ProductLine } from "@/lib/domain/lines";
import { Search } from "lucide-react";

/** Jump box: type any MO or BOM and trace it directly (no need to arrive from
 *  a link). A small toggle picks whether the text is a code (BOM) or an order
 *  (MO); BOM is the default. */
export function TraceSearch({ initial = "", initialMode = "bom", line }: { initial?: string; initialMode?: "bom" | "mo"; line?: ProductLine }) {
  const router = useRouter();
  // a code is searched on the line the page is tracing (`line`, else the one
  // its address names); an order opens on its own
  const carry = useCarryLine();
  const [q, setQ] = useState(initial);
  const [mode, setMode] = useState<"bom" | "mo">(initialMode);
  const go = () => {
    const v = q.trim();
    if (v) router.push(mode === "mo" ? traceHref({ mo: v }) : line ? traceHref({ bom: v, line }) : carry(traceHref({ bom: v })));
  };
  return (
    <div className="flex items-center gap-1.5">
      <div className="inline-flex rounded-md border overflow-hidden text-xs font-bold">
        {(["bom", "mo"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-2.5 py-1.5 transition-colors ${mode === m ? "bg-brand-fill text-white" : "bg-surface text-muted hover:text-foreground"}`}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder={mode === "bom" ? "Trace a code (BOM)…" : "Trace an order (MO)…"}
          className="pl-8 pr-3 py-1.5 text-sm w-48 sm:w-60 border rounded-md bg-surface"
        />
      </div>
      <button type="button" onClick={go} className="btn btn-primary btn-sm" disabled={!q.trim()}>
        Trace
      </button>
    </div>
  );
}
