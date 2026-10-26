import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getLvWorklist } from "@/lib/server/lvWorklist";
import { lvDeptPermKey, type LvStage } from "@/lib/domain/lv";
import { factoryToday, toISODate } from "@/lib/domain/dates";
import { LvWorklist } from "@/components/LvWorklist";
import { PrintHeader } from "@/components/PrintHeader";

// The LV panels' worklist page for one stage — what the four worklist routes
// render when the panels are on screen (?line=LV; punching and bending always). A server component so the four
// pages share one loader and one permission rule.

export async function LvWorklistPage({ stage }: { stage: LvStage }) {
  // the factory's day (Cairo), as the transformer worklists date their rows
  const today = factoryToday();
  const todayISO = toISODate(today);
  const [data, user] = await Promise.all([getLvWorklist(stage), getCurrentUser()]);
  const canEdit = !!user && hasPerm(user, lvDeptPermKey(stage));
  return (
    <>
      <PrintHeader title={`${stage} Worklist — LV Panels`} date={formatDate(today)} />
      {/* the department and its line are picked in the Floor tab's menu: the
          page has no row of stages and no line switch */}
      <PageHead title={`${stage} Worklist`} sub={`LV Panels · ${formatDate(today)}`} />
      <LvWorklist data={data} canEdit={canEdit} todayISO={todayISO} />
    </>
  );
}
