import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";

export interface QueueNoteDTO {
  id: number;
  dept: string; // Welding | Painting — where it was raised
  text: string;
  photos: string[]; // public URL paths
  status: string; // open | resolved
  createdISO: string;
}

/** All queue-line notes keyed by bom|mo|item (newest first). Both worklists
 *  see every note for the line, whichever dept raised it. */
export const getQueueNotes = cache(async (): Promise<Record<string, QueueNoteDTO[]>> => {
  const notes = await prisma.queueNote.findMany({ orderBy: { id: "desc" } });
  const map: Record<string, QueueNoteDTO[]> = {};
  for (const n of notes) {
    const key = `${n.bom}|${n.mo ?? ""}|${n.item}`;
    (map[key] ??= []).push({
      id: n.id,
      dept: n.dept,
      text: n.text,
      photos: n.photos ? (JSON.parse(n.photos) as string[]) : [],
      status: n.status,
      createdISO: toISODate(n.createdAt),
    });
  }
  return map;
});
