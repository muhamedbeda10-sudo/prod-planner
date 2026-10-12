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

## Navigation
Seven tabs, one per QUESTION rather than per screen — Worklist · Material · ODOO · Consumables · Shifts ·
Plan Tracker · Floor. There is **no Dashboard tab**: each dashboard lives with what it reads. Three tabs
hold several views behind their own switcher (`components/ViewTabs.tsx`): **Plan Tracker** carries the
tracker, the plan's **Dashboard** (`/`, the home page), the **Daily log** it adds up and the printed
**Report** of that log; **Material** the nesting sheets and the sheet **Analytics** built on them;
**Floor** the bay as it is and the what-if simulator. Two things left the strip entirely: **chat** is the icon in the nav's
right cluster, opening a panel over whatever page you are on (a glance, not a destination — its
bundle is fetched only on first open), and the **barcode sheet** is a button on the painting
worklist, where the tanks it prints for finish. In Admin the two plan imports share one page. The
mobile drawer still lists every view flat, since it has the vertical room.

## Features
1. **Weekly plan import** (`/import`) — grid parser from row 6, merged-BOM carry-down, `ParseBalance`
   (bidirectional digit/letter split, RC→TC), `targetQty = balance + gridSum` (or `requiredQty`),
   idempotent re-import, warnings (oversize / misaligned remark column / suspected double-count).
2. **Daily handover entry** (`/handover`) — fast RTL form, BOM autocomplete with **entry-time
   normalization** (green auto-correct badge, red block for unknown/ambiguous), editable audited log.
3. **Plan Tracker** (`/tracker`) — one row per BOM (MOs merged), per-item Cut/Weld, Complete = MIN,
   Remaining, Achievement %. Every number is click-through-traceable (`/trace`) to handover rows.
   Recording on a MERGED BOM row fills its MOs **one at a time**: the first order is closed to its own chain
   limit before the second is touched, then the third — never spread evenly — and a correction comes back off
   the LAST MOs first. The cell says which MOs the number will land on, in fill order, **before** it is saved;
   the preview and the write are the same functions (`lib/domain/groupSpread.ts`), so they cannot disagree.
   A **Close N delivered** button closes every open order whose components have all reached the customer —
   the server recounts from the ledger rather than trusting the page, so a stale or filtered view can never
   close an order that is still short.
   The grid is coloured by COMPONENT, not by stage: all four of an item's stage columns wear one wash, so
   twenty-four numbers read as six components instead of one field. The hues are ordered to separate
   NEIGHBOURING components best (every adjacent pair ≥ 8 ΔE OKLab in both themes; non-adjacent ones never
   touch). Colour is never the only cue — the item's header spans its columns and a strong divider closes
   each block, which is what carries the grouping where green and orange converge under colour blindness.
   Four spec columns ride along, all four **typed on the tracker and never imported**, so a re-import of the
   monthly plan can't blank or overwrite what the planner wrote: **Color** (RAL), **CRC** and **SFM** beside
   KVA, and **Fins** immediately before the Core Frame — it is a component welded onto the tank, not a spec, and
   it carries its own rose down the whole column (the one hue the stage tints, the status pills and the
   brand green leave free) so the eye finds it without counting across. Click a cell to type it. A merged BOM row shows a spec only when its MOs agree on it, "…" when they
   differ. All four export with the rest.
4. **Daily worklists** (`/worklist/cut`, `/worklist/welding`) — due/still/today-target with capacity
   allocation, overdue rollover, fill-up rows, Cut Alarm (Cut ready / Partial / NOT CUT YET).
5. **Daily report + Dashboard** (`/report`, `/` — views of the Plan Tracker tab; the report covers
   ONE day or any period through its From→To picker, with the capacity its efficiency is measured
   against scaled to the working days the range really spans) — dept output, complete sets, efficiency/balance %,
   projects worked today, tracker snapshot, charts. Dashboard: achievement per item, dept output
   day/week, planned (oven−lead) vs welded.
5b. **Fabrication analytics** (`/analytics`, a view of the Material tab) — the floor read in SHEETS instead of pieces, because a piece is
   not a unit of work: a tank cut from four sheets and one cut from half a sheet are both "1". Every daily-log
   cut record is converted through its BOM's bill of sheets off the Material tab, over a 30/60/90-day or
   all-time window. Sheets and tonnes cut, per day and in total; the thickness mix (which decides what a job
   can go to — the thin end and the thick end are not the same plant); and **sheets per piece per component**
   with the range across the BOMs produced, which is the argument for sheets over pieces and sizes a new order
   before anyone nests it. Tonnes come from the sheet size, the thickness and the material's own density; a BOM
   planned in several months takes its NEWEST nesting, never the sum. A piece whose BOM has no bill still
   counts as a piece and contributes no sheets, so the rates read low rather than flattering — the coverage
   figure and the list of un-nested BOMs say exactly how much of the floor the Material tab describes.

6. **Material — nesting project tracker** (`/material`) — the planner's Nesting Project Tracker sheet, filed
   month by month, exactly its columns: BOM Ref · Quantity of Units · Part Code · Part Name · Codes · Material ·
   Thickness · Sheet Size · Sheets in BOM for one Unit / for Job · Actual Nesting for one Unit / for Job ·
   Difference · Notes. The tab adds two columns: units **produced** (typed) and the sheets those units really
   consumed at the job's actual rate (50 sheets nested for 30 units, 5 produced → 8.333). The sheets nested
   **for the job** are computed on import as the sheet's own **Actual Nesting for one Unit × Quantity of
   Units**, not read from its "for Job" column: that column is a figure somebody left behind — change the job
   size and it keeps the old answer (one row of the tracker says 17.6 sheets where 90 units at 0.568 a unit is
   51.1). A sheet with no per-unit rate still falls back to its job column, and the import says how many rows
   were stale. Import the sheet for a
   month (re-importing adds new lines and updates changed ones; the same BOM's tank and top-cover lines stay
   apart), filter by month and, within it, by part, material, thickness, sheet size, status (nested / not
   nested / with produced / over BOM) or a search across BOM, SOI, part, code and note — the totals follow
   the filter; edit any value inline, delete a whole month (confirmed by typing its name), export in the
   sheet's own headers.
7. **Odoo close-out log** (`/odoo`) — the office's daily sheet of Odoo manufacturing orders it tried to
   close: Date · SOI# · FG-CODE · Product · MO# · QTY · Status, plus Notes. Two people work a row: the
   clerk types it in (or imports the sheet — its first seven columns, the same MO on the same day
   updated, never doubled); the planner then moves the Status in place (Pending, Done, Blocked …) —
   moving it to Done stamps the moment, shown under the pill and exported as "Done at" — and
   keeps Notes on it — a list with time and author, each deletable on its own. A filter row (search across
   SOI, FG-CODE, MO, product and notes; product; status; closing; with/without notes) sticks between visits,
   as does the day. **The day's counts are themselves filters** — clicking "19 not closed" narrows to those
   nineteen, clicking again clears it, and each count is taken with its own filter lifted so the numbers hold
   still while they are toggled. "Not closed" is every status that is not a closing, which the exact-match
   status select cannot express, and **"ready to close"** is the office's own queue — still open AND Odoo's MO
   already on the row, so nothing stands between it and a closing but someone doing it. The three read as one
   sentence: of the open rows, these are ready and those are still waiting for a number. Exports in the sheet's own headers. A row can also be **born from the daily log**: every
   painting record (and the core frame's shot blast) writes its own row here on the same day with the SOI,
   product and qty, MO left empty for the office to type in place — the FG-CODE is copied from the last row
   of the same SOI and product, or composed from the part code and the transformer's BOM and flagged
   "check FG-CODE" until someone confirms it. The tab opens on ONE day, which is how a row logged last
   week reads as lost, so a banner says how many rows sit on other days and how many of the whole log are
   still not closed, with **All days** a click away in the day picker (the search covers the day on screen,
   so the whole log is searched from there). Such a row follows its log entry's edits only while nobody has
   touched it, and when the log entry behind it is deleted or corrected to nothing the row is **Cancelled
   with the reason as a note, never silently deleted**; a "Needs MO / Check FG-CODE" filter and a count in the day's summary keep
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

8. **Shift log** (`/shifts`) — the supervisors' page, one department and one day at a time: every worker
   registered for the department (Tools → Production Workers, now for Fabrication, Welding, Shot Blast and
   Painting too) with present / shift (9 h or 11 h) / overtime (+3 in one click) / the machine they were on /
   a note; the day's present count, man-hours against the stage's capacity, overtime and downtime up top;
   machine downtime with its reason; the last days recorded as a strip. A worker without a row counts as
   present on the 9-hour shift, so only the exceptions need touching; "Save day" writes every row and
   re-sums the department's man-hours into the figure the calibration and the plan's capacity check read
   (Admin → Standard Times shows it read-only now). Recording needs `shifts.<dept>`; viewing is free.
   **Times per machine** (Tools → Times per Machine, `machines.manage`): what ONE piece of each item really
   takes on each machine, in hours. A figure here **outranks the standard time** for that machine — its queue
   on the board is priced with it and ⚡ Plan schedules with it, so a 6 kW laser and a punch stop being planned
   as the same machine, and an item the timings sheet never priced (AR, MB) gets a time at last. An empty cell
   keeps the estimate (the stage's standard hours split over the centres the item routes through, which
   follows the kVA class); the placeholder shows that estimate for a 1000 kVA tank. A typed figure is flat for
   every size. Under each cell is what the floor **actually did** over the last 90 days: the pieces that machine
   finished against the man-hours the shift log put on it, a day's hours split between the items it ran (by the
   standard hours they earned, or by pieces when nothing that day is priced — so AR and MB get a figure too).
   Click it to take it as the figure. Only a ✓ on a machine card carries the machine, so the page says what
   share of the recorded output can be measured at all.
   **Shift hours** (Tools → Settings, admin): what the short shift, the long shift and the "+OT" button are
   worth. Every man-hour the app counts is measured with them — the shift log's day, a machine's crew, the
   figure the standard times are calibrated against — so a new roster is a setting, not a code change. A day
   already recorded keeps the shift it was recorded under and is re-counted with the new hours.
   **Machines & lines** (Tools → Machines, `machines.manage`): the plant's machines by department — code,
   name, work centre (every laser and punch is "Cutting"; bending, fins, tubes, roll blank; a paint line or
   shot-blast cabinet is a "Line"), hours a day, retire / bring back — seeded from the fabrication list.
   The plant's ten-odd **bending presses are one machine** (`BND-1`) for now: one queue, one load. Hours a
   day are seeded from the capacity sheet's own crews (laser 15 + bending 8 + fin folding 10 people on the
   11-hour shift → 15 h a machine, 88 for bending, 110 for fins; 22 a shot-blast cabinet, 159.5 a paint
   line), so fabrication totals the 363 man-hours a day the sheet states. Editing a figure keeps it.
9. **Machine board** (top of the Fabrication and Painting worklists) — who is on what: a card per machine
   with what it is on **now**, what waits behind it in the order the planner ranked it (⏫ run next, ▲ ▼, ✕),
   the queue answered in **time, not percentage**: how long the work on it takes (hours while it is under a
   day, days once it is more) and the working day it **clears** on, with Fridays and the calendar's days off
   skipped — green to a day's work, amber past it, red past a day and a half. The standard hours, pieces and
   lines sit under it, and the crew the shift log put on it. Every table row carries a **Machine** picker ("this is
   running on that now"), and the lines not on any machine are listed most urgent first with a picker each.
   Recording output never touches the board: a line leaves it by itself once nothing remains on it.
   **Several lines can run on one machine at once** (a nest that mixes orders, a bay working two jobs):
   ▶ starts a waiting line alongside what runs, ⏸ puts it back to waiting, and the waiting ones keep their
   order. **A line need not go whole**: the pieces box beside every picker splits it — type 12 and pick
   B4-09 and 12 pieces queue there while the rest stays where it was (or waits, listed as "rest of 20");
   ✂ on a card resizes a machine's share, ✕ takes only that machine's share off, and a blank pieces box
   gives the machine picked the whole rest of the line. Each share is priced by its pieces.
   **✓ records what the machine finished** without leaving the board: blank takes the whole share, a number
   takes only the pieces done and the rest stays in that machine's queue (✕ drops the rest off the card).
   A welded tank is the exception — it carries a serial and the welder's name, so it is recorded on the
   queue table. The list of lines **not on a machine stays folded** behind the "n not on a machine" pill:
   the cards are the board, the backlog opens when the planner wants to place work (the weekly plan's
   dated lines first, the month's undated ones behind "show all"). Every worklist's filter bar carries
   **🏭 on a machine / not on a machine** chips that filter every table to what the floor is running, or to
   what still has to be placed. The month's undated backlog is no longer a table on the page at all — it
   is the pool the board and ⚡ Plan draw from, so the worklist ends at the work the shift actually runs.
   **Print sheet** on a card (or in the Floor's inspector) opens the technician's sheet for that
   machine — what runs now, then what is next in order, with pieces, standard hours, delivery date, the
   crew and a Done column to tick — and **Print all sheets** prints every machine of the department, one per
   page, to hand out at the start of the shift (`/worklist/machines?dept=Cut&machine=…`).
   **Routing is respected**: a piece owes work at every work centre its route names — a tank is cut, then
   bent, then its fins folded; a top cover is only cut — so a line queues **once per centre**, each priced
   with that centre's share of the stage's standard hours (the timings sheet prices "Cut = laser + bending
   + fin folding" as one stage, and the share follows the crew that does the work). The board's list of
   work still to place names the centre on every row and only offers that centre's machines; a table row
   shows where the line goes next (→ BND-1) and what it still **needs** (amber "needs bending").
   Welding has no machines but **partitions** of the bay — groups of welders on the same orders — kept on
   the same list (centre "Zone"), so the welding worklist, the shift log ("which partition") and the board
   treat a partition like a machine, with the welders the shift log put on it today.
   **⚡ Plan the machines** (on the board and in the Floor toolbar, `lib/domain/optimizePlan.ts`) fills every
   queue in one go: lines in the order they are **due** (the weekly plan's date for this stage, then the
   flagged orders, then the longest job), each on the machine that **finishes** it soonest, split over
   machines of the same centre when running them in parallel clears the batch sooner (they finish together,
   each at its own speed), and along the route so the bender never starts before that batch is cut. Speed is
   pieces a day: a machine's hours a day over what one piece costs it — the planner's figure from Times per
   Machine where there is one, the estimate otherwise. What is **running now is never moved** — the plan is
   built around it. It answers with what it did: lines placed, machines used, when the last piece clears,
   which lines cannot make their date and by how much, and any centre with no machine to run it.
   **⟲ Reset** beside it takes every line off every machine of the department — the plan is cleared, the
   work itself untouched — so the board can be planned again from nothing.
   **📊 Timeline** draws the whole department on the working days ahead (5, 10 or 20 of them): one track per
   machine, one block per queued line, each as long as that machine needs for it and starting where the one
   before it ends — the queue's own order, what is running now first. A block turns **red** when it is still
   running after the day its stage was owed, with that day marked on the track, so "this tank will not be cut
   in time, on this machine" is something the planner SEES rather than works out. Fridays and the calendar's
   days off are not on the axis; lines whose hours are unknown are drawn as slivers, and work starting past
   the picture is counted beside the machine's code. Its second view, **Department load**, leaves the machines
   aside and asks whether the department can carry what it has promised at all: one bar a day for the standard
   hours falling due by the end of it — every open line, on a machine or not — against the hours the department
   has that day (today's after the shift log's downtime). A bar over that mark is a day that cannot be worked
   as it stands, and the headline carries what actually decides a week: the RUNNING totals, since work can be
   done early, so it names the day everything promised so far passes everything workable so far, and by how
   many hours. Work with no date, work owed past the picture and lines with no standard time are named under
   it rather than folded in.
10. **Floor** (the Floor tab) — each department's bay drawn as the planner sees it: place the machines
   (or partitions) as blocks, drag them where they stand, pull a corner to resize, draw areas ("Laser hall",
   "Bending & fins") and labels around them, zoom — the drawing saves itself a moment after every change, so
   it is there for everyone who opens that department's floor next. Every block is live: what it is on now, how many
   lines wait, its load colour, the crew on it today. **Clicking a block opens it over the floor** — a wide
   panel with every order on that machine in full (BOM, item, pieces, standard hours, delivery date, MO and
   description), its crew, and the buttons to run one next, split it, take it off or ✓ record what it
   finished; a long queue scrolls inside the panel, and Esc or the backdrop closes it. A press that moves is
   still a drag, so the floor is re-drawn with the same hand. "＋ New partition" creates one on the
   spot. The floor itself keeps the **whole width of the screen** — no side list: the lines not on any machine sit behind the toolbar's
   **"n to place"** button — open it and the weekly plan's dated ones come first (earliest first), the month's
   undated ones after; click a block, then "→ code" sends a line to it in one click (the board on each
   worklist lists them the same way). Drawing needs
   `machines.manage`; working a queue needs the department's worklist permission; viewing is free.
11. **Consumables** (`/consumables`) — the store's log of what it hands out to the floor. A hand-out is recorded
   on **one line above the log** (after a save the department and the person stay and the item box is ready for the
   next paste); a correction opens in a popup. Item (typed
   freely, earlier items suggested) · Qty (up to 3 decimals) · Department · **Requested / collected by** (a worker of
   that section, anyone on the list for a typed department — the hand-out still counts under the department) · Notes. The
   **department** is a dropdown of the worker sections, plus any department typed before; "➕ New
   department…" opens a box for one that is not there (Maintenance, Store …) — typed in any case it is filed
   under its first spelling, and a section typed by name is filed as the section. The **worker** is a
   dropdown from Production Workers, narrowed to the section picked (a typed department offers every active
   worker). **Hand-out for: One worker · Several workers · Whole department** — one storekeeper often draws a
   section's week in one go: "Several workers" ticks names from the list; "Whole department" (worker sections
   only) is the section's active workers **at work that day** (not on vacation), and the form shows the count.
   A group row keeps the workers it was for (`ConsumableIssueRecipient`, fixed at saving — its department and
   workers are never edited, only its item, qty and notes). The limits give each of them an **equal share**:
   a **per-person** limit becomes the number × the workers (2 gloves each × 10 workers = 20), a shared limit
   counts the hand-out whole. The date and time are the **server's clock at saving** — never typed, so a row cannot be
   back-dated. Recording needs `consumables.edit`; viewing is free. **A saved row is corrected by the person
   who recorded it, or by an admin** — a recorder cannot touch a colleague's rows; deleting is the admin's,
   and soft. Every change keeps the row **before and after** (`ConsumableIssueRevision`). The history is the
   admin's: the "edited" pill opens it under the row, and the **Log · Edits** switch lists every correction,
   delete and restore in the period (who, when, "Qty: 10 → 8"), with **↺ Restore this version** on each —
   it puts the row back the way it read before that change, brings a deleted row back onto the log, and is
   itself kept as a change. An edit made on a page older than the row is refused rather than overwriting
   someone else's. A worker with hand-outs cannot be deleted from the workers list, only deactivated.
   Opens on today; the slicer reaches a year back; Excel export of the log and of the edits.
   **Powder** (the switch's Powder view) — the painting lines' **powder scrap**: the storekeeper records each
   weighing (day, Transformer Painting / USS Painting, kg, note — `PowderScrap`, corrected by its recorder or
   an admin with every change kept, deleted softly by the admin). The month sets it against the **powder
   drawn**: the hand-outs to that section of items named "…Powder…" (catalogue or typed), in kg — a powder
   item counted in another unit is listed apart, not added in. **Scrap rate = scrap ÷ drawn**, **net used =
   drawn − scrap**, per section and both together, the month before in points, six months of trend
   (bars + rate line), what was drawn by item; print and Excel.
   **Catalogue & limits** (the **Limits** view, `consumables.edit`): the store's list — code, name, unit, remark — loaded
   from its sheet (47 items), each with its limits: a number per **calendar month**, or every **2, 3, 4 or 6 months** or a
   **year** — nothing shorter: the store is tracked month by month and draws stock in bulk — for the departments it names,
   each its own, **shared** by them, or **per worker** (× each department's workers). The sheet's weekly numbers became
   monthly ones of four weeks, and its "Every day" items six working days a week before that (every conversion is in the
   Limits history). Items, limits and retirements are edited in place and every change is kept (who, when, before → after).
   The item is typed or **pasted** (the catalogue suggested as you type, the department's items first): text naming a
   catalogue item by its name or code — case, spacing and a size's × / x aside — is linked to it; anything else is recorded as
   typed and has no limit, shows where the limit stands as the quantity is typed, and a hand-out that would take a limit over is refused
   until the recorder gives a **reason** — then saved flagged "over limit" with the reason and the breach. The Dashboard
   opens with the **alarms** — a limit **past its number** in the running month (or its months so far), nothing less —
   then the finished months that ended over, and the hand-outs recorded over a limit.
   **Monthly review** (the foot of the Dashboard, with its own month picker and its own Excel) — the month-end review: every
   catalogue item's calendar month against its monthly limit (a limit of several months counted over its months so far
   against its whole number), graded **over / close (80–100%) / under / not issued**, with the month before and the last six
   months (a sparkline per item and a chart of how many items fell in each grade), each item opening onto its departments.
   Month picker, Excel export (item and limit lines) and a print / PDF with the company header.
12. **AI assistant** (`/ai`) — Claude answers from the live data in Arabic or English: SQL through `ai_reader`, a
   read-only login that cannot see the private tables, nor the tables of a screen hidden from the person. What it may do
   is the owner's call per person (Users & Permissions → AI assistant), and never more than the person may do themselves.
   - **Changes** (`lib/server/ai/changes.ts`, `lib/server/ai/tools/*`): the Plan Tracker and Daily log, the machine board
     and ⚡ Plan (a line's share on a machine too), the cutting floor — nest runs (several jobs' parts on the same sheets,
     their pieces taken off what the machines cut of those lines), manual jobs and the sheets cut — the Simulator and the
     run order, the ODOO log, Material, physical stock, consumables with their catalogue,
     limits and powder scrap, the shift roster, the calendar, workers and machines, the standard times, capacity,
     calibration, times per machine and settings (key "AI — standard times and settings"), and — for the owner alone, in a
     live chat only — Users & Permissions (an account it makes has a password nobody knows; the owner sets the first one).
     A write tool never writes by itself: `describe` shows the card (before → after) and keeps a
     snapshot of the data; on Approve it runs only if the data still reads the same, through the screen's own server action
     as the person (`runAsActor` — the audit names "Sara (AI)"). The snapshot is what the change relies on, not the whole
     screen: a machine-board card keeps where its own line is (a move, its machine's queue), so cards approved one after
     another do not put each other out of date, and a distribution of many lines is one card (`assign_lines_to_machines`
     — one approval, one board refresh, one undo). Undo runs only while nothing changed since; where an
     action stamps things as it goes, the undo writes the rows back exactly from the snapshot (`lib/server/rowSnapshots.ts`,
     reachable only from an undo). Deletions need their own key and always wait; "small changes without asking" is a
     per-person opt-in. The owner can pause every change, or every automation, at once (AI assistant settings).
   - **Attached files and imports** (`lib/server/ai/files.ts`, `lib/server/ai/tools/imports.ts`): a photo, a PDF, an Excel
     or CSV sheet attached with the 📎 is checked by its bytes (a photo shrunk in the browser first; a photo or PDF also
     measured by the model's own token count, so one it refuses never reaches a chat), kept in `AiFile` for 14 days (out
     of the nightly backup, closed to `ai_reader`) and opened only in its own chat. Photos and PDFs go to the model with
     the question — the chat keeps a reference (`aifile_<id>`) that is turned back into the file each time the chat is
     sent: the chat's newest, while they fit (20 files, 16 MB, 250 thousand tokens — the count measured at upload is kept
     in `AiFile.tokens`), older ones named only. It takes the figures off them as asked and records them with the write
     tools (`record_output` for production).
     Sheets it reads with a tool, and imports through the screen's own importer — the card is the importer's dry run, and
     the import runs only while a fresh dry run reads the same. No undo for an import; key "AI — imports" plus the
     person's own import permission.
   - **Machine rules** (Tools → Machines & lines): only / never / prefer, by item, line, sheet thickness and material, kVA —
     ⚡ Plan follows them (`lib/domain/machineRules.ts`, `optimizePlan`'s `allowed` / `preferred`).
   - **Automations** (`/automations`, `lib/domain/automations.ts`, `lib/server/automations/*`): on a schedule (Cairo times on
     working days, every day or weekdays) or when a read-only query finds rows it did not at its last check (edge-triggered by
     a `key` column); notify (no AI), report, or act (changes wait for approval). They run as their owner, count against the
     month's caps, stop after five failures in a row. The clock: Supabase pg_cron + pg_net call `/api/automations/tick`
     every minute with a secret kept in Supabase Vault — set up in one click on AI assistant settings; until then open pages
     tick, at most once a minute for the whole plant.
   - **Inbox and push** (`/inbox`): reports, messages and suggestions, with Web Push to phones (VAPID keys made on first use,
     the private half encrypted; only the real push services are posted to). The count rides on the chat's poll.
   - **Morning review** (`lib/server/automations/review.ts`): for the people ticked "AI — daily review and suggestions", every
     working morning from 07:30 — suggestions only; every change waits.
   - **Playbook** (`/ai/playbook`): how this plant works, told to the assistant with every question; admins keep it there or
     through the assistant.

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
- `lib/server/*` — Prisma-backed data access feeding the pure functions (`server-only`). `loads.ts` holds the
  request-cached loads of the tables every screen reads (orders registry, schedules, the daily log, holidays,
  plans, settings): the first caller in a request pays for the query, every later one shares the rows.
- Heavy browser code loads on demand: the charts (`components/LazyCharts.tsx`) and SheetJS (only when Export
  is pressed) stay out of every page's first load; `app/loading.tsx` paints a skeleton the instant a tab is
  clicked while the page streams in.
- `app/*` — RTL pages + server actions. `components/*` — shared UI + client widgets.
- `scripts/*` — seed + validation/diagnostic scripts. `reference/*` — original VBA + workbook.
