import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { HolidayManager } from "@/components/HolidayManager";
import { toISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const holidays = await prisma.holiday.findMany({ orderBy: { date: "asc" } });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Factory Calendar"
        sub="Non-working days besides Fridays — holidays and planned shutdowns carry no production target, so efficiency stays honest"
      />
      <HolidayManager rows={holidays.map((h) => ({ id: h.id, date: toISODate(h.date), name: h.name }))} />
    </div>
  );
}
