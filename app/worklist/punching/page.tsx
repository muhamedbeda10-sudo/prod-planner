import { pinLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";
import { guardTab } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// The panels' first stage. A transformer has no punching worklist, so this
// page always shows the panels.
export default async function PunchingWorklistPage() {
  await guardTab("/worklist/punching");
  await pinLine("LV", "/worklist/punching");
  return <LvWorklistPage stage="Punching" />;
}
