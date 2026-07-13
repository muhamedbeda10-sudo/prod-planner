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
2. **Plan-vs-plan reconciliation** (`/reconciliation`) — CONTINUED delta, DROPPED-WITH-BACKLOG,
   NEW MOs, BALANCE CONFLICTS; severity colors + Excel export.
3. **Daily handover entry** (`/handover`) — fast RTL form, BOM autocomplete with **entry-time
   normalization** (green auto-correct badge, red block for unknown/ambiguous), editable audited log.
4. **BOM hygiene & excess reallocation** (`/boms`) — `NormalizeBoms` review queue; `ReallocateExcess`
   as **explicit reviewable `ReallocationMove` transactions** (approve/reject). Raw handover entries
   stay immutable (the VBA edited them silently — this app never does).
5. **Plan Tracker** (`/tracker`) — one row per BOM (MOs merged), per-item Cut/Weld, Complete = MIN,
   Remaining, Achievement %. Every number is click-through-traceable (`/trace`) to handover rows.
6. **Daily worklists** (`/worklist/cut`, `/worklist/welding`) — due/still/today-target with capacity
   allocation, overdue rollover, fill-up rows, Cut Alarm (Cut ready / Partial / NOT CUT YET).
7. **Daily report + Dashboard** (`/report`, `/`) — dept output, complete sets, efficiency/balance %,
   projects worked today, tracker snapshot, charts. Dashboard: achievement per item, dept output
   day/week, planned (oven−lead) vs welded.

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
