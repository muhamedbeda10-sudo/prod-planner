import Link from "next/link";
import { holdLabel, type HeldOrderDTO } from "@/lib/domain/hold";

// ⏸️ The orders the planner paused, named once at the top of a worklist. They
// are in none of the lists below — that is the point of a hold — but a line
// that simply vanished would send people looking, so this says where it went
// and why. Released from the Plan Tracker (right-click the row).

export function HeldOrdersStrip({ rows }: { rows: HeldOrderDTO[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="no-print mb-4 rounded-xl border px-3.5 py-2 text-sm" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", borderColor: "color-mix(in srgb, var(--warn-fg) 30%, transparent)" }}>
      <summary className="cursor-pointer font-bold select-none">
        ⏸️ {rows.length} order{rows.length === 1 ? "" : "s"} on hold — not queued here
      </summary>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.mo} className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/trace?mo=${encodeURIComponent(r.mo)}`} className="font-bold text-xs hover:underline">{r.mo}</Link>
            <span className="font-semibold">{r.bom}</span>
            {r.description && <span className="text-xs opacity-80">{r.description}</span>}
            <span className="text-xs">— {holdLabel(r.hold).replace(/^On hold( — )?/, "") || "no reason given"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] opacity-80">Released from the Plan Tracker — right-click the order&apos;s row.</p>
    </details>
  );
}
