import { beforeEach, describe, expect, it, vi } from "vitest";

// The automations' clock: the database's scheduler set up through Supabase's
// pg_cron and pg_net with its secret in Vault, the secret checked on every
// tick, and the tick route — the scheduler's, or a page's at most once a
// minute — answering at once and running what is due after the answer.

const h = vi.hoisted(() => ({
  prisma: {
    aiSettings: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    automation: { count: vi.fn() },
    task: { count: vi.fn() },
    user: { count: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
  me: null as unknown,
  after: [] as (() => Promise<void>)[],
  runDue: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => h.me }));
vi.mock("next/server", () => ({ after: (f: () => Promise<void>) => h.after.push(f) }));
vi.mock("@/lib/server/automations/runner", () => ({ runDueAutomations: h.runDue }));
vi.mock("@/lib/server/automations/review", () => ({ REVIEW_KEY: "ai.suggestions" }));

import { removeScheduler, schedulerStatus, setupScheduler, sha256, tickSecretOk, tickUrlFor } from "@/lib/server/automations/scheduler";
import { POST } from "@/app/api/automations/tick/route";

const SECRET = "A".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  h.after.length = 0;
  h.me = null;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  h.prisma.aiSettings.findUnique.mockResolvedValue({ tickSecretHash: sha256(SECRET) });
  h.prisma.aiSettings.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.$queryRawUnsafe.mockResolvedValue([]);
  h.prisma.$executeRawUnsafe.mockResolvedValue(0);
  h.prisma.automation.count.mockResolvedValue(1);
  h.prisma.task.count.mockResolvedValue(0);
  h.prisma.user.count.mockResolvedValue(0);
});

describe("the tick's secret", () => {
  it("is the one whose hash the app keeps, sent as a bearer token", async () => {
    expect(await tickSecretOk(`Bearer ${SECRET}`)).toBe(true);
    expect(await tickSecretOk(`Bearer ${"B".repeat(43)}`)).toBe(false);
    expect(await tickSecretOk(SECRET)).toBe(false);
    expect(await tickSecretOk(null)).toBe(false);
    h.prisma.aiSettings.findUnique.mockResolvedValue({ tickSecretHash: "" });
    expect(await tickSecretOk(`Bearer ${SECRET}`)).toBe(false);
  });
});

describe("the tick's address", () => {
  it("is the production domain when the deployment knows it, else the https address in use", () => {
    expect(tickUrlFor("my-preview.vercel.app", "https")).toBe("https://my-preview.vercel.app/api/automations/tick");
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "prod-planner.vercel.app";
    expect(tickUrlFor("my-preview.vercel.app", "https")).toBe("https://prod-planner.vercel.app/api/automations/tick");
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(tickUrlFor("localhost:3000", "http")).toBeNull();
    expect(tickUrlFor("evil.com/x?", "https")).toBeNull();
  });
});

describe("setting the scheduler up", () => {
  it("enables the extensions, keeps the secret in Vault, schedules the ticks through the day and the night and the run log's clearing, and keeps only the secret's hash", async () => {
    expect(await setupScheduler("https://prod-planner.vercel.app/api/automations/tick")).toEqual({ ok: true });
    const statements = h.prisma.$executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(statements[0]).toBe("CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog");
    expect(statements[1]).toBe("CREATE EXTENSION IF NOT EXISTS pg_net");
    const vault = h.prisma.$executeRawUnsafe.mock.calls.filter((c) => String(c[0]).includes("vault.create_secret"));
    expect(vault.map((c) => c[2])).toEqual(["atc_automations_tick_secret", "atc_automations_tick_url"]);
    const secret = vault[0][1] as string;
    const schedules = h.prisma.$executeRawUnsafe.mock.calls.filter((c) => String(c[0]).includes("cron.schedule"));
    expect(schedules.map((c) => c[1])).toEqual(["atc-automations-tick", "atc-automations-tick-night", "atc-cron-cleanup"]);
    // every minute through the plant's day (UTC), a quarter hour at night, the run log cleared nightly
    expect(schedules[0][0]).toContain("'* 2-21 * * *'");
    expect(schedules[1][0]).toContain("'*/15 22,23,0,1 * * *'");
    expect(schedules[2][0]).toContain("'30 2 * * *'");
    expect(schedules[2][2]).toBe("DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'");
    // the tick jobs read the secret from Vault — it is not written into the job
    for (const tick of schedules.slice(0, 2)) {
      expect(tick[2]).toContain("vault.decrypted_secrets");
      expect(tick[2]).not.toContain(secret);
    }
    // stale jobs of every name go first, so a second set-up never doubles the clock
    const unscheduled = h.prisma.$executeRawUnsafe.mock.calls.filter((c) => String(c[0]).includes("cron.unschedule")).map((c) => c[1]);
    expect(unscheduled).toEqual(["atc-automations-tick", "atc-automations-tick-night", "atc-cron-cleanup"]);
    expect(statements.findLastIndex((s) => s.includes("cron.unschedule"))).toBeLessThan(statements.findIndex((s) => s.includes("cron.schedule")));
    expect(h.prisma.aiSettings.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { tickSecretHash: sha256(secret) } });
  });

  it("replaces a secret already in Vault rather than adding a second", async () => {
    h.prisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: "1f6b2f6e-0000-4000-8000-000000000001" }]).mockResolvedValueOnce([]);
    await setupScheduler("https://prod-planner.vercel.app/api/automations/tick");
    expect(h.prisma.$executeRawUnsafe.mock.calls.some((c) => String(c[0]).includes("vault.update_secret") && c[1] === "1f6b2f6e-0000-4000-8000-000000000001")).toBe(true);
  });

  it("says which step failed", async () => {
    h.prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error("ERROR: permission denied to create extension \"pg_cron\""));
    expect(await setupScheduler("https://x.vercel.app/api/automations/tick")).toEqual({ ok: false, error: "Failed while enabling pg_cron: permission denied to create extension \"pg_cron\"" });
    expect(h.prisma.aiSettings.update).not.toHaveBeenCalled();
  });

  it("removing it takes every job away and stops the secret at once", async () => {
    expect(await removeScheduler()).toEqual({ ok: true });
    const unscheduled = h.prisma.$executeRawUnsafe.mock.calls.filter((c) => String(c[0]).includes("cron.unschedule")).map((c) => c[1]);
    expect(unscheduled).toEqual(["atc-automations-tick", "atc-automations-tick-night", "atc-cron-cleanup"]);
    expect(h.prisma.aiSettings.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { tickSecretHash: "" } });
  });

  it("reports the clock on with the day job and the secret, out of date while set up by an earlier version, and the tick jobs' last runs", async () => {
    h.prisma.aiSettings.findUnique.mockResolvedValue({ tickSecretHash: sha256(SECRET), lastTickAt: new Date("2026-10-26T06:00:00Z") });
    // as this version sets it up
    h.prisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { jobname: "atc-cron-cleanup", schedule: "30 2 * * *" },
        { jobname: "atc-automations-tick-night", schedule: "*/15 22,23,0,1 * * *" },
        { jobname: "atc-automations-tick", schedule: "* 2-21 * * *" },
      ])
      .mockResolvedValueOnce([{ at: new Date("2026-10-26T06:00:00Z"), status: "succeeded", message: null }]);
    let s = await schedulerStatus();
    expect(s).toMatchObject({ scheduled: true, outdated: false, lastTickAt: "2026-10-26T06:00:00.000Z", error: null });
    expect(s.lastJobRuns).toEqual([{ at: "2026-10-26T06:00:00.000Z", status: "succeeded", message: null }]);
    expect(h.prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual(["atc-automations-tick", "atc-automations-tick-night", "atc-cron-cleanup"]);
    expect(h.prisma.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual(["atc-automations-tick", "atc-automations-tick-night"]);
    // as the earlier version set it up: one job, every minute
    h.prisma.$queryRawUnsafe.mockReset().mockResolvedValueOnce([{ jobname: "atc-automations-tick", schedule: "* * * * *" }]).mockResolvedValueOnce([]);
    s = await schedulerStatus();
    expect(s).toMatchObject({ scheduled: true, outdated: true });
    // the night job alone is no clock
    h.prisma.$queryRawUnsafe.mockReset().mockResolvedValueOnce([{ jobname: "atc-automations-tick-night", schedule: "*/15 22,23,0,1 * * *" }]).mockResolvedValueOnce([]);
    s = await schedulerStatus();
    expect(s).toMatchObject({ scheduled: false, outdated: false });
  });

  it("removing it stops the secret at once, even with no pg_cron at all", async () => {
    h.prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error("ERROR: schema \"cron\" does not exist"));
    expect(await removeScheduler()).toEqual({ ok: true });
    expect(h.prisma.aiSettings.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { tickSecretHash: "" } });
  });
});

describe("the tick route", () => {
  const post = (auth?: string) => POST(new Request("https://x/api/automations/tick", { method: "POST", headers: auth ? { authorization: auth } : {} }));

  it("refuses a caller with neither the secret nor a session", async () => {
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong-wrong-wrong-wrong-wrong")).status).toBe(401);
  });

  it("answers at once and runs what is due after the answer", async () => {
    const r = await post(`Bearer ${SECRET}`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true, ran: true });
    expect(h.runDue).not.toHaveBeenCalled();
    await h.after[0]();
    expect(h.runDue).toHaveBeenCalledWith({ now: expect.any(Date), deadline: expect.any(Number) });
  });

  it("takes one tick a minute for the whole plant — a page's included", async () => {
    h.me = { id: 4 };
    h.prisma.aiSettings.findUnique.mockResolvedValue({ tickSecretHash: "" });
    h.prisma.aiSettings.updateMany.mockResolvedValue({ count: 0 });
    expect(await (await post()).json()).toEqual({ ok: true, ran: false, pages: true });
    expect(h.after).toHaveLength(0);
  });

  it("tells pages they are not needed once the scheduler is on, or while no automation is on", async () => {
    h.me = { id: 4 };
    expect(await (await post()).json()).toMatchObject({ pages: false });
    h.prisma.aiSettings.findUnique.mockResolvedValue({ tickSecretHash: "" });
    h.prisma.automation.count.mockResolvedValue(0);
    expect(await (await post()).json()).toMatchObject({ pages: false });
    // …but a task's due day still to pass needs the pages
    h.prisma.task.count.mockResolvedValue(1);
    expect(await (await post()).json()).toMatchObject({ pages: true });
    h.prisma.task.count.mockResolvedValue(0);
    // …and so does someone's morning review
    h.prisma.user.count.mockResolvedValue(1);
    expect(await (await post()).json()).toMatchObject({ pages: true });
  });
});
