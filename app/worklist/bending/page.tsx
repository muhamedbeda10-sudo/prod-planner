import { redirect } from "next/navigation";
import { getActiveLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";
import { guardTab } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// The panels' second stage. With the transformers on screen this route is
// the fabrication worklist's.
export default async function BendingWorklistPage() {
  await guardTab("/worklist/bending");
  if ((await getActiveLine()) !== "LV") redirect("/worklist/cut");
  return <LvWorklistPage stage="Bending" />;
}
