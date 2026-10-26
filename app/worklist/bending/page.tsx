import { pinLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";
import { guardTab } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// The panels' second stage — always the panels'.
export default async function BendingWorklistPage() {
  await guardTab("/worklist/bending");
  await pinLine("/worklist/bending");
  return <LvWorklistPage stage="Bending" />;
}
