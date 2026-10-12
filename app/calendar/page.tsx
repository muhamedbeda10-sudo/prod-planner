import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { prisma } from "@/lib/db";
import { HolidayManager } from "@/components/HolidayManager";
import { toISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  await guardTab("/calendar");
  // admin-only page: invisible in the nav for others, and a direct URL bounces
  const me = await getCurrentUser();
  if (!me?.isAdmin) redirect("/");

  const holidays = await prisma.holiday.findMany({ orderBy: { date: "asc" } });
  return (
    <HolidayManager rows={holidays.map((h) => ({ id: h.id, date: toISODate(h.date), name: h.name }))} />
  );
}
