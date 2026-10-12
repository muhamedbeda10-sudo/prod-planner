import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getAllMachines } from "@/lib/server/machines";
import { getMachineItemTimes } from "@/lib/server/machineTimes";
import { getMeasuredRates } from "@/lib/server/machineRates";
import { getStdData } from "@/lib/server/standardTimes";
import { itemHoursFor } from "@/lib/domain/stdEngine";
import { centerShares, routeFor } from "@/lib/domain/shifts";
import { ITEMS } from "@/lib/domain/constants";
import { PageHead } from "@/components/ui";
import { SectionCard } from "@/components/primitives";
import { Timer } from "lucide-react";
import { TimesGrid } from "./TimesGrid";

export const metadata = { title: "Times per machine — ATC" };
export const dynamic = "force-dynamic";

/** The class the estimates on this page are shown for: a mid-size tank, so a
 *  typed figure has something of the right order to be compared against. */
const SHOWN_TIER = 1000;

export default async function MachineTimesPage() {
  await guardTab("/admin/machine-times");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasPerm(me, "machines.manage")) redirect("/");

  const [machines, times, std, measured] = await Promise.all([getAllMachines(), getMachineItemTimes(), getStdData(), getMeasuredRates()]);

  // what the standard times say a piece costs at each machine's work centre —
  // the stage's hours for a mid-size tank, split over the centres the item
  // routes through, so the planner can see what he is overriding
  const per = itemHoursFor(std, SHOWN_TIER);
  const estimates: Record<number, Record<string, number>> = {};
  for (const m of machines) {
    const row: Record<string, number> = {};
    for (const item of ITEMS) {
      const p = per[item];
      if (!p) continue;
      const stage = m.dept === "Cut" ? p.cut : m.dept === "Welding" ? p.weld : m.dept === "ShotBlast" ? p.shb : p.paint;
      if (!(stage > 0)) continue;
      const shares = centerShares(m.dept, item);
      // a machine off the item's route stands in for the route's first centre
      const route = routeFor(m.dept, item);
      const share = shares[m.center] ?? shares[route[0]] ?? 1;
      row[item] = stage * share;
    }
    estimates[m.id] = row;
  }

  return (
    <div className="space-y-4">
      <PageHead
        title="Times per machine"
        sub="What one piece of each item really takes on each machine"
        actions={<Link href="/admin/machines" className="btn btn-sm btn-secondary">Machines &amp; lines →</Link>}
      />
      <SectionCard
        icon={<Timer size={16} aria-hidden />}
        title="Hours a piece, by machine"
        description={
          <>
            A figure here outranks the standard time for that machine: its queue on the board is priced with it, and ⚡ Plan schedules the
            work with it. An empty cell keeps the estimate — the placeholder, for a {SHOWN_TIER} kVA tank.
          </>
        }
        padded={false}
      >
        <details className="px-4 md:px-5 pb-3 text-sm">
          <summary className="filter-label cursor-pointer select-none hover:text-foreground">How these figures are used</summary>
          <div className="mt-2 space-y-2 text-muted max-w-4xl">
            <p>
              The estimate is the stage&apos;s standard hours split over the work centres the item routes through, and it follows the tank&apos;s
              kVA class; a figure you type is flat for every size. So a 6 kW laser and a punch stop being planned as the same machine.
            </p>
            <p>
              <b className="text-foreground">Measured</b> under a cell is what the floor actually did since {measured.fromISO}: the pieces that
              machine finished (a ✓ on its card is the only record that carries the machine) against the man-hours the shift log put on it,
              a day&apos;s hours split between the items it ran. Click it to take it as the figure.{" "}
              {measured.totalPcs > 0
                ? `${Math.round((measured.attributedPcs / measured.totalPcs) * 100)}% of what was recorded in that window carries a machine — the rest was recorded off a table and cannot be measured.`
                : "Nothing has been recorded in that window yet."}
            </p>
          </div>
        </details>
        <Suspense fallback={<p className="text-sm text-muted px-4 py-3">Loading…</p>}>
          <TimesGrid machines={machines} times={times} estimates={estimates} measured={measured.byMachine} canEdit={hasPerm(me, "machines.manage")} />
        </Suspense>
      </SectionCard>
    </div>
  );
}
