import { after } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { tickSecretOk } from "@/lib/server/automations/scheduler";
import { runDueAutomations } from "@/lib/server/automations/runner";

// The automations' clock ticks here (lib/server/automations/scheduler.ts):
// every minute from the database's own scheduler, with its secret — or, when
// that is not set up, from a page open in the app (a signed-in person), at
// most once a minute for the whole plant. It answers at once and runs what is
// due after the answer, within the route's time limit; what does not fit
// waits for the next tick.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One tick a minute: the first caller in a minute takes it. */
async function claimMinute(now: Date): Promise<boolean> {
  const r = await prisma.aiSettings.updateMany({
    where: { id: 1, OR: [{ lastTickAt: null }, { lastTickAt: { lt: new Date(now.getTime() - 55_000) } }] },
    data: { lastTickAt: now },
  });
  return r.count === 1;
}

/** Whether pages still need to tick: no scheduler, and something to run. A
 *  page told no asks again only rarely. */
async function pagesNeeded(): Promise<boolean> {
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { tickSecretHash: true } });
  if (s?.tickSecretHash) return false;
  return (await prisma.automation.count({ where: { enabled: true, deletedAt: null } })) > 0;
}

export async function POST(request: Request) {
  const fromScheduler = await tickSecretOk(request.headers.get("authorization"));
  if (!fromScheduler && !(await getCurrentUser())) return Response.json({ error: "Not allowed." }, { status: 401 });
  const pages = fromScheduler ? undefined : await pagesNeeded();
  const now = new Date();
  if (!(await claimMinute(now))) return Response.json({ ok: true, ran: false, ...(pages === undefined ? {} : { pages }) }, { status: 202 });
  // leave room inside the time limit for the run in hand to finish
  const deadline = now.getTime() + (maxDuration - 60) * 1000;
  after(async () => {
    try {
      await runDueAutomations({ now, deadline });
    } catch (e) {
      console.error("automations: the tick failed", e);
    }
  });
  return Response.json({ ok: true, ran: true, ...(pages === undefined ? {} : { pages }) }, { status: 202 });
}
