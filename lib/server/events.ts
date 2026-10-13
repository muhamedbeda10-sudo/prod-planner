import "server-only";
import { after } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import type { AppEventType, AppEventView } from "@/lib/domain/appEvents";

// What happened in the app, recorded by the action that did it — once it is
// done, never inside a transaction that could still be rolled back — with who
// did it (the person, marked "(AI)" when the assistant did it for them).
// The "on event" automations it matches fire right after the answer has gone
// back to the person, so their click never waits on them. Recording never
// fails the action: what was done stays done.

export interface EmitInput {
  type: AppEventType;
  /** What it is about — an MO, a tank, a task — when there is one thing. */
  subject?: string | null;
  /** The sentence, without who: "Closed SF01/MO/06326". */
  summary: string;
  data?: Prisma.InputJsonObject;
  /** A task's event: its giver and its people — the only ones it may reach. */
  participants?: number[];
}

const SUMMARY_MAX = 500;
const SUBJECT_MAX = 200;

/** A list of things as a short subject: the first few, then how many more. */
export function listed(items: readonly string[], max = 3): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export async function emitEvent(e: EmitInput): Promise<void> {
  try {
    const me = await getCurrentUser();
    const row = await prisma.appEvent.create({
      data: {
        type: e.type,
        actorId: me?.id ?? null,
        actorName: me?.name ?? "The app",
        subject: e.subject ? e.subject.slice(0, SUBJECT_MAX) : null,
        summary: e.summary.slice(0, SUMMARY_MAX),
        data: { ...(e.data ?? {}), ...(e.participants ? { participants: e.participants } : {}) },
      },
    });
    const view: AppEventView = {
      id: row.id, type: e.type, at: row.at.toISOString(), actorId: row.actorId, actorName: row.actorName,
      subject: row.subject, summary: row.summary, participants: e.participants,
    };
    const fire = async () => {
      try {
        // loaded here, not at the top: the runner reaches the assistant's
        // tools, which reach the very actions that record events
        const { runEventAutomations } = await import("@/lib/server/automations/runner");
        await runEventAutomations(view);
      } catch (err) {
        console.error(`events: the automations on event ${row.id} failed`, err);
      }
    };
    try {
      after(fire);
    } catch {
      // outside a request (a script, the assistant's own runs): now
      await fire();
    }
  } catch (err) {
    console.error(`events: could not record ${e.type}`, err);
  }
}
