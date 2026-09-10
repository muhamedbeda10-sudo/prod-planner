# نظام تخطيط ومتابعة الإنتاج — Transformer Production Planning & Tracking

A Next.js replacement for the `Production_Master_Excel.xlsm` VBA system. Arabic RTL UI,
English data values. The attached VBA modules (`modShared`/`modUtil`, `modBoms`, `modCut`,
`modWeld`, `modTracker`, `modReport`, `ImportWeek`) are the source of truth; their logic is
ported into pure, unit-tested TypeScript in `lib/domain/` and validated against the workbook.

## Stack
Next.js 16 (App Router) · TypeScript · Tailwind v4 · Prisma + SQLite · SheetJS · Recharts · Vitest.

## Setup
```bash
npm install
npx prisma migrate dev          # create dev.db
npm run seed -- "C:\path\to\Production_Master_Excel.xlsm"   # import plan 27 + handover log + settings
npm run dev                     # http://localhost:3000
npm run test:run                # unit tests (55)
```
`npm run seed` defaults to the workbook on the Desktop; pass a path to override. Seeding is
idempotent (wipes and reloads every table).

## Domain
Each transformer = 4 components (CF, TC, TN, CB). A complete transformer = MIN of the welded
components. Process flow Cut → Welding → Oven; **plan dates are OVEN dates**. Lead days: Cut =
oven−2, Welding = oven−1 (Lists!J2:J3). Daily capacity 27 per item per dept (Lists!J4).
"Done" everywhere = Welding output; Cut gates Welding.

## Features
1. **Weekly plan import** (`/import`) — grid parser from row 6, merged-BOM carry-down, `ParseBalance`
   (bidirectional digit/letter split, RC→TC), `targetQty = balance + gridSum` (or `requiredQty`),
   idempotent re-import, warnings (oversize / misaligned remark column / suspected double-count).
2. **Daily handover entry** (`/handover`) — fast RTL form, BOM autocomplete with **entry-time
   normalization** (green auto-correct badge, red block for unknown/ambiguous), editable audited log.
3. **BOM hygiene & excess reallocation** (`/boms`) — `NormalizeBoms` review queue; `ReallocateExcess`
   as **explicit reviewable `ReallocationMove` transactions** (approve/reject). Raw handover entries
   stay immutable (the VBA edited them silently — this app never does).
4. **Plan Tracker** (`/tracker`) — one row per BOM (MOs merged), per-item Cut/Weld, Complete = MIN,
   Remaining, Achievement %. Every number is click-through-traceable (`/trace`) to handover rows.
5. **Daily worklists** (`/worklist/cut`, `/worklist/welding`) — due/still/today-target with capacity
   allocation, overdue rollover, fill-up rows, Cut Alarm (Cut ready / Partial / NOT CUT YET).
6. **Daily report + Dashboard** (`/report`, `/`) — dept output, complete sets, efficiency/balance %,
   projects worked today, tracker snapshot, charts. Dashboard: achievement per item, dept output
   day/week, planned (oven−lead) vs welded.
7. **Material — nesting project tracker** (`/material`) — the planner's Nesting Project Tracker sheet, filed
   month by month, exactly its columns: BOM Ref · Quantity of Units · Part Code · Part Name · Codes · Material ·
   Thickness · Sheet Size · Sheets in BOM for one Unit / for Job · Actual Nesting for one Unit / for Job ·
   Difference · Notes. The tab adds two columns: units **produced** (typed) and the sheets those units really
   consumed at the job's actual rate (50 sheets nested for 30 units, 5 produced → 8.333). Import the sheet for a
   month (re-importing adds new lines and updates changed ones; the same BOM's tank and top-cover lines stay
   apart), filter by month and, within it, by part, material, thickness, sheet size, status (nested / not
   nested / with produced / over BOM) or a search across BOM, SOI, part, code and note — the totals follow
   the filter; edit any value inline, delete a whole month (confirmed by typing its name), export in the
   sheet's own headers.
8. **Odoo close-out log** (`/odoo`) — the office's daily sheet of Odoo manufacturing orders it tried to
   close: Date · SOI# · FG-CODE · Product · MO# · QTY · Status, plus Notes. Two people work a row: the
   clerk types it in (or imports the sheet — its first seven columns, the same MO on the same day
   updated, never doubled); the planner then moves the Status in place (Pending, Done, Blocked …) —
   moving it to Done stamps the moment, shown under the pill and exported as "Done at" — and
   keeps Notes on it — a list with time and author, each deletable on its own. A filter row (search across
   SOI, FG-CODE, MO, product and notes; product; status; with/without notes) sticks between visits, as
   does the day. Exports in the sheet's own headers. A row can also be **born from the daily log**: every
   painting record (and the core frame's shot blast) writes its own row here on the same day with the SOI,
   product and qty, MO left empty for the office to type in place — the FG-CODE is copied from the last row
   of the same SOI and product, or composed from the part code and the transformer's BOM and flagged
   "check FG-CODE" until someone confirms it. Such a row follows its log entry's edits and deletion only
   while nobody has touched it; a "Needs MO / Check FG-CODE" filter and a count in the day's summary keep
   them visible, and the export carries a Source column. **Click a row (or its 🧱 button)** for the material
   its qty consumes: the FG-CODE's prefix is the part (FB-022 = TANK) and the row's SOI names the
   transformer through the orders registry (S01259-4 → BOM 12011E16M13), so the popup lists the Material
   tab's lines for that part on that BOM — the FG-CODE's own suffix is tried only when the SOI's BOM has no
   line for the part, since a top cover's or core frame's code carries its drawing number, not the
   transformer's BOM. It shows code, material,
   thickness, sheet size, BOM and actual sheets per unit — scaled to the row's qty (editable for a partial
   close), with the actual number to book in Odoo one click from the clipboard, a copy of the whole
   table, and "Open in Material" already narrowed to the BOM. Each line shows the actual against the
   BOM (past ±15% amber, past ±30% red, with a banner counting the lines off), so a nesting far from
   its BOM is caught before it is booked. The row's own month is used when the
   tracker has it, else the newest month that does; a line not nested yet copies its BOM number and
   says so. A **Dashboard** view (Log · Dashboard switch) shows what was logged per day by
   product — a card per product (the sheet's six and any other product logged, by its own name)
   with its trend and change vs the previous period, stacked columns
   with every count written on, one small chart per product, totals, and logged vs closed per day —
   counted, by a **Closed day · Logged day** switch, on the day each row's status went to Done
   (the default: a row logged in August and closed in September is one of September's closings,
   under its product) or on the day it was logged — over today, yesterday, 7/30/90 days, this
   month, all time or a custom from/to, with the numbers as a table and an Excel export.

9. **Shift log** (`/shifts`) — the supervisors' page, one department and one day at a time: every worker
   registered for the department (Tools → Production Workers, now for Fabrication, Welding, Shot Blast and
   Painting too) with present / shift (9 h or 11 h) / overtime (+3 in one click) / the machine they were on /
   a note; the day's present count, man-hours against the stage's capacity, overtime and downtime up top;
   machine downtime with its reason; the last days recorded as a strip. A worker without a row counts as
   present on the 9-hour shift, so only the exceptions need touching; "Save day" writes every row and
   re-sums the department's man-hours into the figure the calibration and the plan's capacity check read
   (Admin → Standard Times shows it read-only now). Recording needs `shifts.<dept>`; viewing is free.
   **Machines & lines** (Tools → Machines, `machines.manage`): the plant's machines by department — code,
   name, work centre (every laser and punch is "Cutting"; fins, tubes, roll blank; a paint line or
   shot-blast cabinet is a "Line"), hours a day, retire / bring back — seeded from the fabrication list.

## Validation against the workbook
The pure logic is checked cell-for-cell against the workbook's own computed sheets:
- **Daily Report** dept output: **exact match** (Cut & Welding — complete sets, efficiency, balance).
- **Plan Tracker**: **35/39 rows match exactly**. The remaining 4 are **stale cached values in the
  workbook** — e.g. `14002E13M13` shows nonzero on the Plan Tracker sheet but has **zero** handover
  rows in the log (the sheet is a snapshot from an earlier handover state). Our compute produces the
  correct fresh values. See `scripts/validate-tracker.mjs` and `scripts/validate-report.mjs`.

## Key nuances faithfully replicated
- **`BomGroup` merges** same base + same M-number (`12011E13M12`/`E14`/`E16` → `12011|M12`) and is
  used by the **worklists, report, and reallocation** — but **NOT by the Plan Tracker**, which groups
  by RAW BOM. So those three codes are ONE row in a worklist and THREE rows in the tracker, exactly
  like the VBA. (`lib/domain/bom.ts`, `tracker.ts`)
- **Excel serial dates** convert correctly (46211 = 08/07/2026).
- **`ParseBalance`** splits digit↔letter in **both** directions (the spec's fix over the VBA).

## Notes / deviations
- **PDF**: the daily report is print-optimized (3 page-break sections) with a “طباعة / حفظ PDF”
  button (browser print-to-PDF). A dedicated server-side PDF route (`@react-pdf/renderer`) is a
  documented follow-up.
- **Reallocation** is an explicit approve/reject transaction layer rather than silent log mutation.

## Layout
- `lib/domain/*` — pure, unit-tested ports (no I/O). `*.test.ts` alongside.
- `lib/server/*` — Prisma-backed data access feeding the pure functions (`server-only`).
- `app/*` — RTL pages + server actions. `components/*` — shared UI + client widgets.
- `scripts/*` — seed + validation/diagnostic scripts. `reference/*` — original VBA + workbook.
