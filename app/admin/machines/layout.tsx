import { redirect } from "next/navigation";
import { isMachinePlanningOn } from "@/lib/server/data";

// Rides on machine planning (Admin → Settings) with the worklists: one switch
// turns them all on and off. Off, this page is not part of the app.
export default async function MachinePlanningOnlyLayout({ children }: { children: React.ReactNode }) {
  if (!(await isMachinePlanningOn())) redirect("/admin/settings");
  return children;
}
