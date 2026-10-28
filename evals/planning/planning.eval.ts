import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { User } from "@prisma/client";

vi.mock("server-only", () => ({}));
// Only the data loaders are replaced. Live mode runs the actual app agent,
// prompt, model protocol, input validation and summary tool.
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: () => { throw Error("Live database reads are forbidden in this benchmark"); } }));
vi.mock("@/lib/server/lvTracker", () => ({ getLvTracker: () => { throw Error("Live database reads are forbidden in this benchmark"); } }));
vi.mock("@/lib/server/line", () => ({ withLine: (_line: string, run: () => unknown) => run() }));
vi.mock("@/lib/server/ai/changes", () => ({ handleWriteCall: () => { throw Error("Writes are forbidden in this benchmark"); } }));

import { ask, questionMessages } from "@/lib/server/ai/agent";
import { trackerSummaryTool } from "@/lib/server/ai/tools/planning";
import { AI_MODELS, DEFAULT_AI_MODEL, costUsd, questionContext } from "@/lib/domain/ai";
import { aiPageNote } from "@/lib/domain/aiScreen";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { OUTSOURCED, PANELS, PLANNING_CASES, TRANSFORMERS, type PlanningCase } from "./fixtures";

const offline: { id: string; passed: boolean; calculationMs: number; expected: PlanningCase["expected"] }[] = [];
const live: { id: string; numericCorrect: boolean; readToolUsed: boolean; latencyMs: number; estimatedCostUsd: number; error: boolean; answer: string }[] = [];
const fixtureTool = (test: PlanningCase) => trackerSummaryTool({ tr: async () => test.outsourced ? OUTSOURCED : TRANSFORMERS, lv: async () => PANELS });
const context = (test: PlanningCase): ToolCtx => ({
  user: { id: 1, name: "Reference planner" } as User, hidden: new Set(), now: new Date("2026-10-24T08:00:00Z"),
  todayISO: "2026-10-24", conversationId: 1, automationId: null, line: test.line,
  page: { path: "/tracker", filters: { ...test.filters } },
});

describe("production-planning reference calculations — synthetic data", () => {
  it.each(PLANNING_CASES)("$id — $question", async (test) => {
    const start = performance.now();
    const result = await fixtureTool(test).run({ usePageFilters: true }, context(test));
    const data = JSON.parse(result.text);
    const passed = result.ok && Object.entries(test.expected).every(([key, value]) => data.totals[key] === value) && (test.cards ?? []).every((card) => data.components.some((actual: { it: string; need: number; done: number }) => actual.it === card.it && actual.need === card.need && actual.done === card.done));
    offline.push({ id: test.id, passed, calculationMs: performance.now() - start, expected: test.expected });
    expect(result.ok).toBe(true);
    expect(data.totals).toMatchObject(test.expected);
    for (const card of test.cards ?? []) expect(data.components.find((actual: { it: string }) => actual.it === card.it)).toMatchObject(card);
    expect(result.links?.every((link) => link.href.startsWith("/") && !link.href.startsWith("//"))).toBe(true);
  });
});

it.runIf(process.env.AI_EVAL_LIVE === "1")("measures model accuracy, latency and estimated cost on the same reference cases", async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Error("Live evaluation requires ANTHROPIC_API_KEY in the process environment. Enter it securely; never commit it.");
  const model = process.env.AI_EVAL_MODEL ?? DEFAULT_AI_MODEL;
  if (!AI_MODELS.some((m) => m.id === model)) throw Error("Choose a supported AI_EVAL_MODEL from the app's model settings.");
  const limit = Math.max(1, Math.min(6, Number(process.env.AI_EVAL_LIMIT) || 3));
  const budget = Math.max(0.01, Number(process.env.AI_EVAL_BUDGET_USD) || 1);
  let spent = 0;
  for (const test of PLANNING_CASES.slice(0, limit)) {
    if (spent >= budget) break; // stop BETWEEN questions; this is not a provider hard cap
    const ctx = context(test);
    const tool = { ...fixtureTool(test), loaded: true as const };
    const question = `${test.question}\nUse the current monthly tracker filters. End with a JSON code block containing only numeric orders, required, complete and remaining. ${aiPageNote(ctx.page!)}`;
    const start = performance.now();
    const result = await ask({ apiKey, model, effort: "low", history: [], tools: [tool], ctx,
      question: questionMessages(question, questionContext({ askedBy: ctx.user.name, now: ctx.now, areas: [], canDelete: false, noconfirm: false, paused: true, notes: [], line: test.line })),
      settings: { actionsPaused: true }, maxCalls: 3, timeoutMs: 60_000,
      events: { status: () => {}, text: () => {} },
    });
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse([...result.text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? "{}"); } catch { /* invalid structured answer fails the score */ }
    const estimatedCostUsd = costUsd(model, result.tokens);
    spent += estimatedCostUsd;
    live.push({ id: test.id,
      numericCorrect: !result.error && Object.entries(test.expected).every(([key, value]) => parsed[key] === value),
      readToolUsed: result.queries > 0,
      latencyMs: performance.now() - start, estimatedCostUsd, error: !!result.error, answer: result.text,
    });
  }
  expect(live.length).toBeGreaterThan(0);
  for (const result of live) expect(result, `Model evaluation failed for ${result.id}`).toMatchObject({ numericCorrect: true, readToolUsed: true, error: false });
});

afterAll(async () => {
  const report = process.env.AI_EVAL_REPORT ?? "/tmp/prod-planner-ai-evaluation.json";
  const output = {
    dataset: "synthetic-production-planning-v1", at: new Date().toISOString(),
    mode: live.length ? "offline-and-live-model" : "offline-calculations-only",
    model: live.length ? process.env.AI_EVAL_MODEL ?? DEFAULT_AI_MODEL : null,
    offline, live,
    modelAccuracy: live.length ? live.filter((r) => r.numericCorrect && r.readToolUsed && !r.error).length / live.length : null,
    estimatedCostUsd: live.length ? live.reduce((sum, r) => sum + r.estimatedCostUsd, 0) : null,
    note: "Offline checks validate calculations, not model quality. Live runs use synthetic data and only a read-only tracker tool; latency excludes the production database and other tools. Cost is an estimate from the app's price table, not an invoice. Budget is checked between questions.",
  };
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify(output, null, 2));
  console.log(`Planning evaluation report saved: ${report}`);
});
