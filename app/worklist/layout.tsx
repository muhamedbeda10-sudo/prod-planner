import { redirect } from "next/navigation";
import { isMachinePlanningOn } from "@/lib/server/data";

// The worklists come and go with machine planning (Admin → Settings): one
// switch turns both on and both off. Off, every worklist page — and the
// machine sheets under it — sends the visitor to the plan tracker.
export default async function WorklistLayout({ children }: { children: React.ReactNode }) {
  if (!(await isMachinePlanningOn())) redirect("/tracker");
  return children;
}
