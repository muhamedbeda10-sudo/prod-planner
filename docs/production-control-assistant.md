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
2. **Extend capacity and delivery risk:** add an LV-specific flow model and individual-machine constraints beyond the TR station-level comparisons described below.
3. **Improvement tracking:** agree a KPI, baseline, target and review period for each intervention; compare the outcome with the baseline while accounting for product mix and calendar changes.
4. **Approved recurring reviews:** after choosing timing and recipients, configure a morning report and an end-of-day follow-up using existing automations; monitor their actual execution and failures.
5. **Broader evaluation:** add anonymized, reviewed shop-floor questions about capacity, material, holds and action permissions, with expected sources and clear acceptance criteria.

These remain proposed extensions; the comparison, stress-testing and readiness features implemented below use the current TR station model. Integrations and clean records remain necessary; the assistant cannot replace missing factory measurements or engineering judgement.

## Planning comparison, resilience and forecast readiness

The What-if Simulator now has **Compare alternatives & test disruptions**. Keep up to three named alternatives, adjust the ordinary simulator controls, and compare them with the current scenario and plant baseline. All rows are recomputed on the same input set; kept alternatives are local to the page and do not save or apply a run order. Load restores a kept alternative into the controls.

**Stress tests** compare up to three independent cases: entire-station outages over inclusive calendar dates, worker reductions for the full modeled horizon, or material arriving on a chosen date for an exact job. Each case applies separately to each alternative. Worker losses are added to its existing crew change; existing stoppages stay in place and a material stress never brings an existing later hold forward. A stoppage at one physical machine cannot be treated as a whole-station outage without explicitly accepting that assumption.

Results group components and split batches into MOs. Orders without due dates and orders blocked by a zero production rate remain separate from on-time/late counts. Clearance dates cover only the priced queue and stay unresolved while any of those orders is blocked. Resource effort is extra man-hours per working day, not currency or added overtime for the existing workforce. `shiftHours` affects only added/removed workers in this model.

A provisional resilience ordering minimises worst blocked orders, then worst late orders, then worst total calendar days of lateness, then normal extra man-hours/day. Each worst metric may come from a different independent case. Ties retain table order; the ranking does not claim probabilities, simultaneous disruptions, a globally optimal plan or a financial optimum. Unknown coverage, missing capacity/due dates, blocking readiness gaps or invalid trials withhold the ranking.

**Forecast readiness** identifies missing engineering times (including required components excluded from the queue), held orders, pending plan-quantity decisions, absent due dates, zero/volatile production rates, missing capacity and unpriced weekly-plan quantities. Zero engineering time for required work no longer produces a zero-duration forecast. Physical stock, nesting, individual machine constraints and customer commitments remain explicit checks outside this model; no confidence percentage is invented.

The assistant can run the same shared calculations through three read-only tools:

- `compare_scenarios`: one common start (plant, saved scenario or the current simulator) plus up to four labeled alternatives. Variants inherit the start independently. Optional queue optimization has a bounded search and reports whether it completed.
- `stress_test_plan`: plant baseline and up to four alternatives against up to three explicit independent disruptions. Without alternatives it includes the selected starting scenario.
- `get_simulation_readiness`: coverage, data gaps and assumptions from current live inputs.

These tools never write plant data, change the screen, send messages or create schedules. Ask the assistant to show a chosen variant using the existing screen tool when wanted; saving/applying continues through the existing permissions and approval cards. Successful reads retain their source snapshot and related record links.

This release uses the **TR fabrication model**, with combined shot blast/painting finishing. It does not forecast LV punching/bending; from an LV chat the tools require an explicit TR scope instead of silently mixing lines. Engineering rates and simulator loaders are fixed to TR even when the navigation toggle is LV.

Example requests:

- «قارن الخطة الحالية ببديل افتراضي فيه عاملين زيادة في اللحام، من نفس البيانات، ووضح فرق التأخير وساعات العمل».
- «اختبر الخطة على توقف قسم اللحام بالكامل يوم [التاريخ]، ووضح الأوامر المتأثرة».
- «راجع جاهزية توقعات المحولات ووضح البيانات اللي ناقصة قبل ما نعتمد على المواعيد».
