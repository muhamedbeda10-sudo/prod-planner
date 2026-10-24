import "server-only";
import { prisma } from "@/lib/db";
import { machineWorkCentre, type WorkCentre } from "@/lib/domain/shifts";

// The machine stops of a day, as the shift log records them: which machine,
// how long, and why — one of the plant's codes (lib/domain/downtime.ts).

export interface DowntimeRowDTO {
  id: number;
  machineId: number;
  machineCode: string;
  machineName: string;
  dept: string;
  centre: WorkCentre | null;
  hours: number;
  reasonCode: string | null;
  reason: string | null;
  recordedBy: string | null;
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
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function getDowntimeDay(dateISO: string): Promise<DowntimeDay> {
  const [rows, machines] = await Promise.all([
    prisma.machineDowntime.findMany({ where: { date: dayOf(dateISO) }, include: { machine: true }, orderBy: [{ createdAt: "asc" }] }),
    prisma.machine.findMany({ where: { active: true }, orderBy: [{ dept: "asc" }, { sortOrder: "asc" }, { code: "asc" }] }),
  ]);
  return {
    dateISO,
    rows: rows.map((r) => ({
      id: r.id, machineId: r.machineId, machineCode: r.machine.code, machineName: r.machine.name, dept: r.machine.dept,
      centre: machineWorkCentre(r.machine.dept, r.machine.center), hours: r.hours, reasonCode: r.reasonCode, reason: r.reason, recordedBy: r.recordedBy,
    })),
    machines: machines.map((m) => ({ id: m.id, code: m.code, name: m.name, dept: m.dept, centre: machineWorkCentre(m.dept, m.center), hoursPerDay: m.hoursPerDay })),
  };
}
