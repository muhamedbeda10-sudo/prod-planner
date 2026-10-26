import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getLvWorklist } from "@/lib/server/lvWorklist";
import { LV_WORKLISTS, lvDeptPermKey, type LvStage } from "@/lib/domain/lv";
import { factoryToday, toISODate } from "@/lib/domain/dates";
import { LvWorklist } from "@/components/LvWorklist";
import { PrintHeader } from "@/components/PrintHeader";
import { ViewTabs } from "@/components/ViewTabs";
import { LineSwitch } from "@/components/LineSwitch";
import { hrefWithLine } from "@/lib/domain/lines";

// The LV panels' worklist page for one stage — what the four worklist routes
// render when the panels are on screen (?line=LV; punching and bending always). A server component so the four
// pages share one loader and one permission rule.

export async function LvWorklistPage({ stage }: { stage: LvStage }) {
  // the factory's day (Cairo), as the transformer worklists date their rows
  const today = factoryToday();
  const todayISO = toISODate(today);
  const [data, user] = await Promise.all([getLvWorklist(stage), getCurrentUser()]);
  const canEdit = !!user && hasPerm(user, lvDeptPermKey(stage));
  // welding and painting are both lines' stages, one route each: their page
  // switches line; punching and bending are the panels' alone
  const shared = stage === "Welding" || stage === "Painting";
  return (
    <>
      <PrintHeader title={`${stage} Worklist — LV Panels`} date={formatDate(today)} />
      <PageHead
        title={`${stage} Worklist`} sub={shared ? formatDate(today) : `LV Panels · ${formatDate(today)}`}
        views={<ViewTabs views={LV_WORKLISTS.map((w) => ({ href: hrefWithLine(w.href, "LV"), label: w.label, title: `${w.label} — what the panels owe this stage` }))} current={LV_WORKLISTS.find((w) => w.stage === stage)!.href} label="LV stage" />}
      >
        {shared && <LineSwitch />}
      </PageHead>
      <LvWorklist data={data} canEdit={canEdit} todayISO={todayISO} />
    </>
  );
}
