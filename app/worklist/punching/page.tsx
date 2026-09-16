import { redirect } from "next/navigation";
import { getActiveLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";

export const dynamic = "force-dynamic";

// The panels' first stage. A transformer has no punching worklist — with the
// transformers on screen this route is the fabrication worklist's.
export default async function PunchingWorklistPage() {
  if ((await getActiveLine()) !== "LV") redirect("/worklist/cut");
  return <LvWorklistPage stage="Punching" />;
}
