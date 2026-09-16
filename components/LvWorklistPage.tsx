import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getLvWorklist } from "@/lib/server/lvWorklist";
import { LV_WORKLISTS, lvDeptPermKey, type LvStage } from "@/lib/domain/lv";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { LvWorklist } from "@/components/LvWorklist";
import { PrintHeader } from "@/components/PrintHeader";
import { ViewTabs } from "@/components/ViewTabs";

// The LV panels' worklist page for one stage — what the four worklist routes
// render when the panels are on screen. A server component so the four
// pages share one loader and one permission rule.

export async function LvWorklistPage({ stage }: { stage: LvStage }) {
  const today = new Date();
  const [data, user] = await Promise.all([getLvWorklist(stage), getCurrentUser()]);
  const canEdit = !!user && hasPerm(user, lvDeptPermKey(stage));
  return (
    <>
      <PrintHeader title={`${stage} Worklist — LV Panels`} date={toDisplayDate(today)} />
      <div className="mb-4 flex flex-wrap items-center gap-3 no-print">
        <ViewTabs views={LV_WORKLISTS.map((w) => ({ href: w.href, label: w.label, title: `${w.label} — what the panels owe this stage` }))} current={LV_WORKLISTS.find((w) => w.stage === stage)!.href} label="LV stage" />
        <span className="text-xs text-muted">LV panels · {toDisplayDate(today)}</span>
      </div>
      <LvWorklist data={data} canEdit={canEdit} todayISO={toISODate(today)} />
    </>
  );
}
