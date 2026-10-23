# Production-control assistant

The assistant supports decisions using the app's live data and existing tools. It can review the plan, read output and holds, investigate machine load and material readiness, compare scenarios, and prepare permitted changes. Recommendations depend on the freshness and completeness of the underlying records.

## Practical daily use

| When | Example request | Review before acting |
| --- | --- | --- |
| Start of shift | «اعملي مراجعة بداية اليوم للخط المختار واقترح أهم 3 أولويات بالأسباب» | Actual output, remaining quantities, holds, readiness and machine load; any missing data |
| On the monthly tracker | «لخص الخطة حسب الفلاتر اللي قدامي، بالإنجاز والمتبقي ومصادر الأرقام» | Scope, units and source snapshots |
| A constraint changes | «قارن الوضع الحالي بسيناريو تعطل الماكينة دي للوردية دي» with the machine and shift | Simulator assumptions, baseline and impact; apply only the chosen scenario |
| End of day | «قارن الفعلي بالخطة، ووضح المتبقي وأولويات بكرة ونواقص البيانات» | Matching periods, units and recorded production |
| Weekly review | «قارن إنتاج آخر 7 أيام بالفترة اللي قبلها واقترح تحسين قابل للقياس» | Comparable workdays, product mix and capacity changes |
| Follow-up | «راجع آخر الإجراءات اللي اتفقنا عليها على البيانات الحالية» | Refreshed facts; conversation history alone is not a task register |

These are on-demand reviews. Existing automation tools can prepare schedules only after the exact timing, scope and recipients are specified. This update creates no schedules or outgoing messages. Tasks, run-order changes and production records still use the app's existing permission and approval rules.

## Monthly tracker calculations

`get_tracker_summary` shares filtering and card calculations with the UI. `usePageFilters=true` reads the open monthly tracker's captured filters; explicit tool filters override them. Other pages, a weekly tracker, or a different line cannot silently supply monthly page scope. The selected line is the default; explicit line and filters support a broader question.

TR totals count complete transformer sets; component cards count pieces, reduce in-house targets by OSP, ignore excluded/ineligible parts, and finish CF at shot blast. LV totals finish at painting and show Punching, Bending, Welding and Painting. TR defaults to all statuses, LV to open, matching the screens. Totals cover all matching orders; the attention list is separately bounded and ordered by hold, urgency, then remaining quantity. A progress bottleneck is not evidence of lateness or a root cause. Due-date and capacity questions need other tools and recorded constraints.

## Verifiable sources

Successful chat reads emit a dated source card and return the model an exact citation anchor. The answer is instructed to cite numerical paragraphs/tables. A source card shows the saved result used for the answer and links supplied by the tool or its relevant screens. Sources survive reopening the conversation. Large snapshot previews stop at 16,000 characters; record links show current data, which can differ from the historical snapshot. Summary attention records and `get_orders` provide line-specific Trace links; not every tool has individual record links.

Citations improve auditability, but do not independently prove that every sentence the model generates is correct. Verify consequential decisions against the source and assumptions.

## Reference benchmark

Run `npm run ai:eval` for 18 deterministic reference cases using a synthetic factory. These cover TR/LV defaults, months and carryover, search, holds, completion, urgency, LV product/family filters, OSP, excluded components and empty results. CI runs this suite on every update. Expected totals are fixed reference values, not calculated by the implementation being tested. Standard unit tests additionally cover scope, permissions, source persistence and line-specific navigation.

The offline report explicitly leaves model accuracy and cost unset. Calculation tests do not measure a language model's answers.

An optional live run uses the actual agent, prompt, input validation, read-only summary tool and source protocol, with synthetic loaders and no database/write access:

```sh
AI_EVAL_LIVE=1 npm run ai:eval
```

Supply `ANTHROPIC_API_KEY` securely in the process environment. Never commit it. Optional settings: `AI_EVAL_MODEL` (an app-supported model), `AI_EVAL_LIMIT` (1–6, default 3), `AI_EVAL_BUDGET_USD` (default 1), and `AI_EVAL_REPORT` (default `/tmp/prod-planner-ai-evaluation.json`). The budget stops subsequent questions after the estimate reaches the limit; it is not a hard provider spending cap. Each question permits up to three model calls and a 60-second deadline.

The live score checks reference totals, use of the read tool and an exact source citation, and records question latency and estimated token cost. It does not benchmark production database latency, all agent tools or unrestricted natural-language quality. Costs use the app's price table, not a provider invoice. Failures produce a failing test with the per-question report; no synthetic data is written to production.

## Useful next capabilities

1. **Material and readiness exceptions:** combine missing nesting, material shortages, holds and aging queues into a reviewed action list with owners and due dates. Establish reliable material and hold records first.
2. **Capacity and delivery risk:** compare due dates with available shifts, standard times, calendars and machine rules; show the baseline and alternative simulations before changing the plan.
3. **Improvement tracking:** agree a KPI, baseline, target and review period for each intervention; compare the outcome with the baseline while accounting for product mix and calendar changes.
4. **Approved recurring reviews:** after choosing timing and recipients, configure a morning report and an end-of-day follow-up using existing automations; monitor their actual execution and failures.
5. **Broader evaluation:** add anonymized, reviewed shop-floor questions about capacity, material, holds and action permissions, with expected sources and clear acceptance criteria.

These are proposed next steps, not capabilities activated by this release. Integrations and clean records remain necessary; the assistant cannot replace missing factory measurements or engineering judgement.
