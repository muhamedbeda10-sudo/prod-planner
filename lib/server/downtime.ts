import "server-only";
import { prisma } from "@/lib/db";
import { isWorkCentre, machineWorkCentre, type WorkCentre } from "@/lib/domain/shifts";
import { toISODate } from "@/lib/domain/dates";
import { downtimeHoursInRange, downtimeWindowWhere, elapsedStopHours } from "@/lib/domain/downtimePeriods";

// The machine stops of a day, as the shift log records them: which machine,
// how long, and why — one of the plant's codes (lib/domain/downtime.ts).

export interface DowntimeRowDTO {
  id: number;
  machineId: number | null;
  machineCode: string;
  machineName: string;
  dept: string;
  centre: WorkCentre | null;
  hours: number;
  reasonCode: string | null;
  reason: string | null;
  recordedBy: string | null;
  startTime?: string | null;
  endTime?: string | null;
  endsNextDay?: boolean;
  isOpen?: boolean;
  dateISO?: string;
  endDateISO?: string | null;
  storedHours?: number;
  dayHours?: number;
}

export interface DowntimeMachine {
  id: number;
  code: string;
  name: string;
  dept: string;
  centre: WorkCentre | null;
  hoursPerDay: number | null;
}

export interface DowntimeDay {
  dateISO: string;
  rows: DowntimeRowDTO[];
  /** The active machines a stop can be recorded on, by department and order. */
  machines: DowntimeMachine[];
  asOf?: string;
}

export async function getDowntimeDay(dateISO: string): Promise<DowntimeDay> {
  const now = new Date();
  const [rows, machines] = await Promise.all([
    prisma.machineDowntime.findMany({ where: downtimeWindowWhere(dateISO, dateISO), include: { machine: true }, orderBy: [{ isOpen: "desc" }, { createdAt: "asc" }] }),
    prisma.machine.findMany({ where: { active: true }, orderBy: [{ dept: "asc" }, { sortOrder: "asc" }, { code: "asc" }] }),
  ]);
  return {
    dateISO,
    asOf: now.toISOString(),
    rows: rows.map((r) => ({
      id: r.id, machineId: r.machineId, machineCode: r.machine?.code ?? r.customName ?? "Unlisted equipment", machineName: r.machine?.name ?? "Unlisted equipment", dept: r.machine?.dept ?? r.customDept ?? "",
      centre: r.machine ? machineWorkCentre(r.machine.dept, r.machine.center) : r.customCentre && isWorkCentre(r.customCentre) ? r.customCentre : null,
      hours: elapsedStopHours(r, now), storedHours: r.hours, dayHours: downtimeHoursInRange(r, dateISO, dateISO, now), reasonCode: r.reasonCode, reason: r.reason, recordedBy: r.recordedBy,
      startTime: r.startTime, endTime: r.endTime, endsNextDay: r.endsNextDay,
      isOpen: r.isOpen, dateISO: toISODate(r.date), endDateISO: r.endDate ? toISODate(r.endDate) : null,
    })),
    machines: machines.map((m) => ({ id: m.id, code: m.code, name: m.name, dept: m.dept, centre: machineWorkCentre(m.dept, m.center), hoursPerDay: m.hoursPerDay })),
  };
}
