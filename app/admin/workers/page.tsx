import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getAllWorkers } from "@/lib/server/workers";
import { WorkersManager } from "./WorkersManager";

export const metadata = { title: "Workers — ATC" };
export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  await guardTab("/admin/workers");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasPerm(me, "workers.manage")) redirect("/");

  const workers = await getAllWorkers();

  return <WorkersManager workers={workers} />;
}
