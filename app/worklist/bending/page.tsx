import { redirect } from "next/navigation";
import { getActiveLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";

export const dynamic = "force-dynamic";

// The panels' second stage. With the transformers on screen this route is
// the fabrication worklist's.
export default async function BendingWorklistPage() {
  if ((await getActiveLine()) !== "LV") redirect("/worklist/cut");
  return <LvWorklistPage stage="Bending" />;
}
