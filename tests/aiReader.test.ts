import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's own way into the database (lib/server/ai/reader.ts): every
// query runs in a transaction whose statement timeout is set LOCAL first, so a
// SELECT set_config(...) in an earlier query cannot have lifted it, and a
// query that fails comes back as words for the model, not as a crash.

const h = vi.hoisted(() => ({ tx: { $executeRawUnsafe: vi.fn(), $queryRawUnsafe: vi.fn() }, transaction: vi.fn(), settings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { aiSettings: { findUnique: h.settings } } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $transaction = h.transaction; $disconnect = async () => {}; } }));

import { runAiQuery } from "@/lib/server/ai/reader";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://app:pw@db.example/prod?schema=public";
  h.settings.mockResolvedValue({ dbPassword: "reader-pw" });
  h.transaction.mockImplementation(async (fn: (tx: typeof h.tx) => Promise<unknown>) => fn(h.tx));
  h.tx.$executeRawUnsafe.mockResolvedValue(0);
  h.tx.$queryRawUnsafe.mockResolvedValue([{ mo: "A", qty: 2 }]);
});

describe("runAiQuery", () => {
  it("sets the statement timeout LOCAL to the transaction before the query, and bounds the transaction itself", async () => {
    const r = await runAiQuery(`SELECT "mo", "qty" FROM "MasterOrder"`);
    expect(r.ok).toBe(true);
    expect(h.transaction.mock.calls[0][1]).toEqual({ timeout: 20_000, maxWait: 5_000 });
    expect(h.tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL statement_timeout = '15s'");
    expect(h.tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(h.tx.$queryRawUnsafe.mock.invocationCallOrder[0]);
    expect(h.tx.$queryRawUnsafe.mock.calls[0][0]).toContain("LIMIT 201");
  });
  it("hands a failed query back as words, and refuses what prepareSql refuses without touching the database", async () => {
    h.tx.$queryRawUnsafe.mockRejectedValue(new Error("relation \"Nope\" does not exist"));
    expect(await runAiQuery(`SELECT * FROM "Nope"`)).toMatchObject({ ok: false, rows: 0 });
    expect(await runAiQuery("SELECT set_config('statement_timeout', '0', false)")).toMatchObject({ ok: false });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
});
