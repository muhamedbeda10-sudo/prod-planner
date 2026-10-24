import { describe, it, expect } from "vitest";
import {
  aiDecision, aiEffort, aiVisible, blockedTableIn, blockedTablesFor, conversationTitle, costUsd, displayTurns, formatRows, jsonSafe, monthStart, prepareSql, questionContext, readerUrl, usdText, type AiGate,
} from "./ai";

const gate = (o: Partial<AiGate>): AiGate => ({
  isOwner: false, hasKey: true, enabled: true, access: { enabled: true, monthlyUsd: 0 }, userSpent: 0, plantSpent: 0, plantCap: 0, ...o,
});

describe("aiEffort", () => {
  it("takes the five levels and falls back to medium", () => {
    expect(["low", "max", "xhigh"].map(aiEffort)).toEqual(["low", "max", "xhigh"]);
    expect([aiEffort("turbo"), aiEffort(null), aiEffort("")]).toEqual(["medium", "medium", "medium"]);
  });
});

describe("costUsd / usdText", () => {
  it("prices every kind of token on the model's rates", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per million
    expect(costUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 200_000 })).toBeCloseTo(4 + 2 + 0.4 + 1, 6);
    expect(costUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.6, 6);
    // an unknown model is priced as the default one, never as free
    expect(costUsd("nope", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(4);
  });
  it("keeps the cents that matter", () => {
    expect([usdText(0), usdText(0.0042), usdText(0.42), usdText(12.5)]).toEqual(["$0", "$0.0042", "$0.420", "$12.50"]);
  });
  it("counts the month from the 1st, UTC", () => {
    expect(monthStart(new Date("2026-10-10T22:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("aiDecision / aiVisible", () => {
  it("needs a key, the switch and the person's tick", () => {
    expect(aiDecision(gate({ hasKey: false }))).toEqual({ ok: false, reason: "noKey" });
    expect(aiDecision(gate({ enabled: false }))).toEqual({ ok: false, reason: "off" });
    expect(aiDecision(gate({ access: null }))).toEqual({ ok: false, reason: "noAccess" });
    expect(aiDecision(gate({ access: { enabled: false, monthlyUsd: 5 } }))).toEqual({ ok: false, reason: "noAccess" });
    expect(aiDecision(gate({}))).toEqual({ ok: true });
  });
  it("stops a person at their own allowance and everyone at the plant's cap", () => {
    expect(aiDecision(gate({ access: { enabled: true, monthlyUsd: 5 }, userSpent: 5 }))).toEqual({ ok: false, reason: "userCap" });
    expect(aiDecision(gate({ access: { enabled: true, monthlyUsd: 5 }, userSpent: 4.99 }))).toEqual({ ok: true });
    expect(aiDecision(gate({ plantCap: 20, plantSpent: 20 }))).toEqual({ ok: false, reason: "plantCap" });
  });
  it("holds the caps of the day, the person's before the plant's", () => {
    expect(aiDecision(gate({ access: { enabled: true, monthlyUsd: 0, dailyUsd: 2 }, userSpentToday: 2 }))).toEqual({ ok: false, reason: "userDayCap" });
    expect(aiDecision(gate({ access: { enabled: true, monthlyUsd: 0, dailyUsd: 2 }, userSpentToday: 1.99 }))).toEqual({ ok: true });
    expect(aiDecision(gate({ plantDayCap: 5, plantSpentToday: 5 }))).toEqual({ ok: false, reason: "plantDayCap" });
    expect(aiDecision(gate({ isOwner: true, plantDayCap: 5, plantSpentToday: 6 }))).toEqual({ ok: false, reason: "plantDayCap" });
    // the owner holds no allowance of their own, by the day either
    expect(aiDecision(gate({ isOwner: true, access: { enabled: false, monthlyUsd: 0, dailyUsd: 1 }, userSpentToday: 3 }))).toEqual({ ok: true });
  });
  it("the owner needs no tick or switch, but the plant's cap holds for them too", () => {
    expect(aiDecision(gate({ isOwner: true, enabled: false, access: null }))).toEqual({ ok: true });
    expect(aiDecision(gate({ isOwner: true, plantCap: 10, plantSpent: 12 }))).toEqual({ ok: false, reason: "plantCap" });
  });
  it("shows the button to the owner always, to others only when open to them", () => {
    expect(aiVisible({ isOwner: true, hasKey: false, enabled: false, access: null })).toBe(true);
    expect(aiVisible({ isOwner: false, hasKey: false, enabled: true, access: { enabled: true, monthlyUsd: 0 } })).toBe(false);
    expect(aiVisible({ isOwner: false, hasKey: true, enabled: false, access: { enabled: true, monthlyUsd: 0 } })).toBe(false);
    expect(aiVisible({ isOwner: false, hasKey: true, enabled: true, access: { enabled: true, monthlyUsd: 0 } })).toBe(true);
  });
});

describe("prepareSql", () => {
  it("wraps one query so it stays a query and stops at the limit", () => {
    const r = prepareSql(`SELECT "mo" FROM "MasterOrder";`, 200);
    expect(r).toEqual({ sql: `SELECT * FROM (\nSELECT "mo" FROM "MasterOrder"\n) AS ai_q LIMIT 201` });
    expect("sql" in prepareSql("  -- late ones\n with x as (select 1) select * from x")).toBe(true);
    expect("sql" in prepareSql("/* c */ SELECT 1")).toBe(true);
  });
  it("refuses anything that is not a single SELECT", () => {
    for (const bad of ["", "   ", "DELETE FROM \"User\"", "update x set y = 1", "SELECT 1; DROP TABLE x", "-- only a comment", "SET ROLE postgres", "RESET ROLE"]) {
      expect("error" in prepareSql(bad)).toBe(true);
    }
  });
});

describe("formatRows / jsonSafe", () => {
  it("sends columns once and each row as a list", () => {
    const t = JSON.parse(formatRows([{ mo: "MO1", qty: BigInt(3), at: new Date("2026-10-01T00:00:00Z") }]));
    expect(t).toEqual({ columns: ["mo", "qty", "at"], rowCount: 1, rows: [["MO1", 3, "2026-10-01T00:00:00.000Z"]] });
  });
  it("says when it was cut at the row limit or for size", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i, text: "x".repeat(50) }));
    const cut = JSON.parse(formatRows(rows, 3));
    expect([cut.rowCount, cut.truncated, cut.rows.length]).toEqual([3, true, 3]);
    expect(cut.note).toMatch(/More than 3 rows/);
    const small = JSON.parse(formatRows(rows, 200, 200));
    expect(small.truncated).toBe(true);
    expect(small.rows.length).toBeLessThan(5);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(200);
  });
  it("turns decimals and huge bigints into something JSON carries", () => {
    expect(jsonSafe({ toNumber: () => 1.5 })).toBe(1.5);
    expect(jsonSafe(BigInt(2) ** BigInt(70))).toBe((BigInt(2) ** BigInt(70)).toString());
    expect(jsonSafe(Number.NaN)).toBe("NaN");
  });
});

describe("readerUrl", () => {
  it("logs in as ai_reader on the same pooler, project suffix kept", () => {
    const u = new URL(readerUrl("postgresql://postgres.abc123:secret@aws-0-eu.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5", "pw0123"));
    expect([u.username, u.password, u.host, u.pathname]).toEqual(["ai_reader.abc123", "pw0123", "aws-0-eu.pooler.supabase.com:6543", "/postgres"]);
    expect(u.searchParams.get("pgbouncer")).toBe("true");
    expect(u.searchParams.get("connection_limit")).toBe("1");
  });
  it("a direct connection's plain user becomes ai_reader", () => {
    expect(new URL(readerUrl("postgresql://postgres:x@localhost:5432/atc", "p")).username).toBe("ai_reader");
  });
});

describe("conversationTitle / displayTurns", () => {
  it("names a chat after the first line of its question", () => {
    expect(conversationTitle("  إيه الأوردرات المتأخرة؟\nوكمان…")).toBe("إيه الأوردرات المتأخرة؟");
    expect(conversationTitle("x".repeat(80))).toHaveLength(58);
  });
  it("reads the kept API messages back as questions and answers", () => {
    const turns = displayTurns([
      { role: "user", content: [{ type: "text", text: "(Asked by M on …)" }, { type: "text", text: "Late orders?" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "query_database", input: { purpose: "Late orders", sql: "select 1" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "There are **3**." }] },
      { role: "user", content: [{ type: "text", text: "(ctx)" }, { type: "text", text: "Which?" }] },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "Late orders?", lookups: [] },
      { role: "assistant", text: "There are **3**.", lookups: ["Late orders"] },
      { role: "user", text: "Which?", lookups: [] },
    ]);
  });
});

describe("the chat with changes in it", () => {
  it("skips the app's context messages and shows prepared changes as cards", () => {
    const turns = displayTurns(
      [
        { role: "user", content: [{ type: "text", text: "Hold MO 7" }] },
        { role: "system", content: "Asked by Sara on …" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "get_orders", input: { mos: ["7"] } },
            { type: "tool_use", id: "t2", name: "query_database", input: { purpose: "Open orders", sql: "SELECT 1" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
        { role: "assistant", content: [{ type: "text", text: "Ready." }, { type: "tool_use", id: "t3", name: "set_order_hold", input: { mos: ["7"] } }] },
      ],
      { get_orders: "Reading the orders", query_database: "Looking it up" },
    );
    expect(turns).toEqual([
      { role: "user", text: "Hold MO 7", lookups: [] },
      { role: "assistant", text: "Ready.", lookups: ["Reading the orders", "Open orders"], actionIds: ["t3"] },
    ]);
  });
});

describe("questionContext", () => {
  const now = new Date("2026-10-12T05:30:00Z");
  it("says what the assistant may change, and what became of earlier changes", () => {
    const t = questionContext({ askedBy: "Sara", now, areas: ["tracker", "machines"], canDelete: false, noconfirm: false, paused: false, notes: ["Change #3 was rejected."] });
    expect(t).toContain("Asked by Sara on Monday, 12 October 2026");
    expect(t).toContain("08:30");
    expect(t).toContain("the Plan Tracker and the Daily log; the machines and their distribution");
    expect(t).toContain("No deletions.");
    expect(t).toContain("Every change waits for the person's approval.");
    expect(t).toContain("- Change #3 was rejected.");
  });
  it("says so when the owner paused the changes, or none were given", () => {
    expect(questionContext({ askedBy: "S", now, areas: ["tracker"], canDelete: true, noconfirm: true, paused: true, notes: [] })).toContain("paused");
    expect(questionContext({ askedBy: "S", now, areas: [], canDelete: false, noconfirm: false, paused: false, notes: [] })).toContain("only read and advise");
  });
  it("says when the What-if Simulator is open beside the chat — and the assistant can change it even with the changes paused", () => {
    const open = questionContext({ askedBy: "S", now, areas: [], canDelete: false, noconfirm: false, paused: true, notes: [], simulatorOpen: true });
    expect(open).toContain("open beside this chat: show_on_simulator changes what it shows, at once and with no card");
    expect(questionContext({ askedBy: "S", now, areas: [], canDelete: false, noconfirm: false, paused: false, notes: [] })).not.toContain("Simulator");
  });
});

describe("hidden screens close their tables to the assistant", () => {
  it("finds a closed table a query names, quoted as it must be", () => {
    const blocked = blockedTablesFor(new Set(["odoo", "calendar"]));
    expect(blocked).toEqual(["OdooEntry", "OdooNote"]);
    expect(blockedTableIn(`SELECT count(*) FROM "OdooEntry"`, blocked)).toBe("OdooEntry");
    expect(blockedTableIn(`SELECT count(*) FROM "MasterOrder"`, blocked)).toBeNull();
  });
  it("closes the shift log's tables with Shifts — the machine stops and the cockpit's stored trend among them", () => {
    const blocked = blockedTablesFor(new Set(["shifts"]));
    expect(blockedTableIn(`SELECT date, data FROM "KpiSnapshot"`, blocked)).toBe("KpiSnapshot");
    expect(blockedTableIn(`SELECT sum(hours) FROM "MachineDowntime"`, blocked)).toBe("MachineDowntime");
    expect(blockedTableIn(`SELECT * FROM "Machine"`, blocked)).toBeNull();
  });
  it("refuses the functions that run a query given as text while anything is closed", () => {
    const blocked = blockedTablesFor(new Set(["odoo"]));
    expect(blockedTableIn(`SELECT query_to_xml('select * from "Odoo' || 'Entry"', true, false, '')`, blocked)).not.toBeNull();
    expect(blockedTableIn(`SELECT query_to_xml('select 1', true, false, '')`, [])).toBeNull();
    expect(blockedTableIn(`SELECT * FROM U&"\\004FdooEntry"`, blocked)).not.toBeNull();
    expect(blockedTableIn(`SELECT * FROM u&"\\004FdooEntry"`, blocked)).not.toBeNull();
    expect(blockedTableIn(`SELECT * FROM U&"\\004FdooEntry"`, [])).toBeNull();
  });
});
