import "server-only";
import { prisma } from "@/lib/db";

// A department's machine queues as one snapshot — what the assistant's
// approval card compares before a board-wide change, and what its undo puts
// back (restoreMachineQueues in app/worklist/machineActions.ts).

/** One row of a department's machine queues, as a snapshot keeps it. */
export interface QueueRowSnapshot {
  bom: string;
  mo: string;
  item: string;
  machineId: number;
  rank: number;
  running: boolean;
  qty: number | null;
  sheet: string;
  sheetDone: number;
}

/** The queues exactly as they stand, in a fixed order so two reads compare. */
export async function readQueueSnapshot(dept: string): Promise<QueueRowSnapshot[]> {
  const rows = await prisma.worklistMachine.findMany({ where: { dept }, orderBy: [{ machineId: "asc" }, { rank: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty, sheet: r.sheet, sheetDone: r.sheetDone }));
}
