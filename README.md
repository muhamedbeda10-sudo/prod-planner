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
Tabs, one per QUESTION rather than per screen — Floor (the worklists) · Dashboards · Material · Shifts · Plan
Tracker. A tab that holds several places opens a panel of their icons when the pointer rests on it (or it
takes the keyboard's focus) — the places' `places` in `components/AppNav.tsx`; the pages carry no strip and
show no name of their own (the lit tab says where you are; `PageHead` gives the screen reader its `<h1>`), and
each page puts its controls in ONE bar: the line switch first in its filter bar, its actions and views at the
end. **Dashboards** holds every dashboard of the app, one place each: **Planning** (`/`, the home page — will we make the plan, where
is the next shortfall, what does it take; feature 13), **Production**
(`/dashboards/production`, what was made, at what efficiency, where the time went, what needs intervention;
feature 13), **Material** (`/dashboards/material`, feature 5), **Consumables**
(`/dashboards/consumables`) and **ODOO** (`/dashboards/odoo`). Each is seen with the screen it reads (its
tab id: the Production dashboard with Shifts), and no dashboard is anywhere else; the old addresses
(`/analytics`, `?view=dashboard`) land on them. Planning shows **both lines on one page**: the
plant's figures first, then a section for the transformers and one for the LV panels (`components/LineSection.tsx`;
each folds away, remembered in the browser, and a link opens it at `#tr` or `#lv`); its bar's **All | Transformers |
LV Panels** switch (`?scope=`) shows one line's section alone. Production reads both lines
through its own **All | TR | LV** switch (`?scope=`, first in its bar). Neither takes the app's line
(`BOTH_LINES` in `lib/domain/lines.ts`): the proxy sends an older address naming one to that line's section on
Planning, and to `?scope=` on Production; no line is carried onto them, and the assistant reads both lines there
(`lib/domain/dashboardLinks.ts` builds Production's addresses, `planningUrl` in `lib/domain/planningDashboard.ts`
Planning's). The recording screens still work one line at a time. **Material** holds the nesting sheets, Physical Material
and Consumables; **Plan Tracker** carries the tracker, the **Daily log** it
adds up and the
**ODOO log** (`/odoo`, whose alerts' badge rides on the Plan Tracker tab). The rule: the tab's panel moves
between its PLACES; the switch in a page's bar moves between VIEWS of one place's rows (`components/ViewTabs.tsx`). Two things are not tabs at all: **chat** is the icon in the nav's
right cluster, docking down the right of whatever page you are on, the page moved beside it, as the assistant and the inbox do (a glance, not a destination — its
bundle is fetched only on first open), and the **barcode sheet** is a button on the painting
worklist, where the tanks it prints for finish. In Admin the Orders Registry (with the monthly plan import) and the weekly plan import are two entries of the tools menu. The
mobile drawer still lists every view flat, since it has the vertical room.

**Product lines (Transformers / LV Panels).** There is no line switch in the top bar. A screen whose rows
depend on the line (Planning, the Material dashboard, the Plan Tracker, the Daily log, Material, the Orders
Registry) carries a **Transformers | LV Panels** switch first in its filter bar (`components/LineSwitch.tsx`);
the worklists carry none — the Floor tab's menu lists each line's departments, and its links name the line. And the line is part of the address (`?line=LV`): the proxy copies it into a
request header that `getActiveLine` (`lib/server/line.ts`) reads, so the page's loaders and every server
action posted from the page agree on it. With no line in the address a screen opens on the person's own line
(`defaultLineOf`, `lib/domain/permissions.ts`): LV Panels for someone who records only on the panels, Transformers for
everyone else. A screen that belongs to one line always shows it (`PINNED_LINE`, which the proxy applies): the weekly import
and Fabrication are the transformers', Punching and Bending the panels'. The ODOO log shows both lines at once; a trace opens on its order's own line.

## Features
1. **Weekly plan import** (`/import`) — grid parser from row 6, merged-BOM carry-down, `ParseBalance`
   (bidirectional digit/letter split, RC→TC), `targetQty = balance + gridSum` (or `requiredQty`),
   idempotent re-import, warnings (oversize / misaligned remark column / suspected double-count).
2. **Daily handover entry** (`/handover`) — fast RTL form, BOM autocomplete with **entry-time
   normalization** (green auto-correct badge, red block for unknown/ambiguous), editable audited log. An
   edit appends to the row's note rather than replacing it, and a return's own rows — the deduction upstream
   and the re-delivery's credit — are re-dated, never re-quantified by hand: deleting the deduction cancels the
   return, deleting the credit reopens it.
3. **Plan Tracker** (`/tracker`) — one row per BOM (MOs merged), per-item stages and Achievement %
   (completion = MIN over the needed components' final stage). Every number is click-through-traceable
   (`/trace`) to handover rows; the trace's **On Odoo → Closed on** is the real closing moment on the factory
   clock, as the ODOO tab shows it. Each component ends with a read-only **Odoo** column: from the
   **October 2026** plans on (`ODOO_EXACT_FROM`, by the plan that first brought the MO) it is the qty of every
   Done / Closed row of the ODOO log born from that MO's own daily-log closing, on that closing's MO and
   component — never spread by BOM and not capped
   (`exactOdooClosings` in `lib/domain/trackerOdoo.ts`); an order from an earlier plan reads —. The screen reads
   only those orders' rows (`getTrackerSheet`); the auto-close, the BOM trace and the assistant read the same
   figure for them and the allocation below for the older orders (`getMasterTracker`). The same rule
   (`odooClosedByLedger`, read through `lib/server/odooClosings.ts`) gives the **LV panels'** tracker an Odoo
   column after Dlvd (the Done rows born from the panel's own painting) and the **weekly plan** an Odoo
   column per component, waterfalled over the order's promises earliest first and capped like the stages
   (not on the Cut worklist's view). Every Odoo column wears Odoo's plum (`--odoo-head`, `--odoo-tint`,
   `--odoo-fg`, class `.odoo-col`). No ETA, Complete or
   Left columns — forecasting every order made the sheet heavy. The sheet (both lines) opens on open orders: closed ones
   are sent only when **Status** is Closed or All (the table adds `?closed=1`), since they pile up month
   after month.
   For the orders planned before October 2026: the BOM trace's **On Odoo** closing rows are the primary source per component; separate imports
   are used only where that component has no linked closing records. The ledger identifies the part
   and planner MO, even if a freely typed product or FG code differs. Project-only quantities fill the
   oldest matching tracked plan first, up to each MO/component requirement. The plant’s confirmed recording
   start is **6 September 2026**, editable as a full date on Admin → Settings. Automatic
   allocation uses project rows recorded on/after that day and plans from September onward; old backlog stays untracked (—),
   while an explicit linked closing still confirms its own older MO. When the start is unset, quantities
   without an MO remain unallocated. Allocation uses the whole registry before filters: a carried MO
   keeps its original plan month, so it cannot be counted again in a newer month. Excess quantities are
   flagged separately.
   Recording on a MERGED BOM row fills its MOs **one at a time**: the first order is closed to its own chain
   limit before the second is touched, then the third — never spread evenly — and a correction comes back off
   the LAST MOs first. The cell says which MOs the number will land on, in fill order, **before** it is saved;
   the preview and the write are the same functions (`lib/domain/groupSpread.ts`), so they cannot disagree.
   A **Close N delivered** button closes every open order whose components have all reached the customer —
   the in-house share of each (outsourced pieces never pass through the plant), so an order with an outsourced
   component closes too — and the server recounts from the ledger rather than trusting the page, so a stale or
   filtered view can never close an order that is still short. A merged row's cell records exactly the figure
   it shows (the same eligible orders, the same capped totals), and an order whose quantity was lowered below
   what is already recorded is refused with a message instead of being written around.
   **A transformer order closes by itself** once it is finished on the tracker AND Odoo has closed all it
   needs (`lib/server/odooAutoClose.ts`; the rule is `closesByItself` in `lib/domain/trackerOdoo.ts`): every
   component it needs, its plan quantity closed in Odoo by the tracker's own Odoo allocation, judged as
   "Close N delivered" judges deliveries (`isFullyDelivered`: outsourced pieces are not owed). Never an order on hold or with a plan qty waiting for
   the planner. Checked when Odoo rows are logged, edited, closed or imported, and on the hourly
   housekeeping tick; it records `order.closed` (reason "odoo") and stamps `MasterOrder.autoClosedAt`. It
   never reopens an order by itself. An order reopened by hand after it closed by itself stays open
   (`MasterOrder.autoCloseOff`) until someone closes it again; any other reopen leaves it to close by itself.
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
   allocation, overdue rollover, fill-up rows, Cut Alarm (Cut ready / Partial / NOT CUT YET). Every worklist,
   the Daily log's day presets and the shift roster date a record with the factory's day (Africa/Cairo,
   `factoryDayISO`), so the night shift's output after midnight belongs to the day it works. One rule for the
   two finishing stages everywhere output is recorded (`stageItemError`): the core frame is shot blasted, never
   painted; everything else is painted, never shot blasted. Closed and on-hold orders leave every daily
   screen — the Welding and Painting queues, their machine boards and run order, the Floor and the machine
   plan — and a line the Plan Tracker sent to a worklist that is already in that queue counts once on the
   board. Every department worklist carries the same three layers above its own lists: the lines **sent from
   the Plan Tracker** (date-less, recorded straight on the row), the ⭐ **priority orders**, and, for admins,
   the **hidden lines** panel.
   The **Fabrication** worklist (`/worklist/cut`) works in **sheet jobs**: its machine board on top, the orders on
   hold and the pieces Welding sent back, then the **weekly plan measured at Fabrication** (one block per delivery
   day, one row per project, Req and Fab per component, the week picker beside it) — what each day still needs
   cut, and where the cut pieces are recorded: a click on a Fab cell adds pieces, under the Cut key, filling the
   project's earliest unfilled promise first. ✋ **Add job** types a job in as SHEETS of one thickness, material
   and size — how many — and every project's part on them (any BOM — the plan's are suggested and kept in the plan's spelling — component, the part in the
   planner's words such as Bottom / Side wall / Skirt base, and the pieces when known), and queues it on a machine. The fabrication
   machines carry those jobs alone (and the panels' punching on the shared punches): no transformer plan line
   goes on them by itself, and the nest runs are gone. A job is shared between machines in sheets (the box beside
   the picker, ✂ on a card), and closed on each machine **in sheets cut** (✓), each ✓ on the sheet cut log with
   the machine and the day; the job leaves the board when its last sheet is cut. A click on a sheet job's sheet — on
   a machine card or in the list of what waits on no machine — opens its details: sheets for the
   job, cut and left, which machines hold the rest, every project's part on the sheets, the note and every ✓
   (when, which machine, how many, by whom), with ✓, ✎ Edit and ⧉ Duplicate beside them. Closing sheets records no
   pieces in the plan — those are recorded on the weekly plan below. A machine's load there reads in sheets.
5. **Material dashboard** (`/dashboards/material`, the Material place of the Dashboards tab) — steel in sheets and
   tonnes, for one line (Transformers | LV Panels), answering four questions: what the BOM needs, what the nesting
   took, what the period's ODOO closings consumed **by calculation**, and how much of it the data covers. Two
   views: **Consumption in period** (`?from=&to=`, or `?all=1`; the last 90 days by default) and **Nesting plan ·
   Now** (the current sheet — no period touches it). Filters in the address: material, thickness, size, part, MO,
   SOI. Six tiles: BOM planned t (units × BOM sheets per unit × one sheet's weight), nested t, nesting variance t
   (nested − BOM on the SAME nested lines only), weighted utilization (by nested tonnes of the lines whose
   utilization is known), calculated consumption t (each ODOO row moved to Done in the period, on its Cairo day,
   whose MO is on the sheet — a backorder (`…-002`) by the MO it came from, as the ODOO tab finds it: closed qty × the actual nesting rate — else the BOM's, shown as *Estimated from BOM* —
   × one sheet's weight; each closing's units once, whatever its MO's number of material lines) and estimated
   scrap t on known coverage (consumed t × (1 − utilization) where utilization is known — the rest is unknown, not
   scrap-free). A sheet's weight is the sheet's own, else size × thickness × density, else unknown — counted in
   sheets, never as zero. The period tiles carry their change against the period before (N/A where there is no
   base); the nesting tiles say **Now**. A **Data coverage** strip says how the closings link (rows and units —
   a blank MO never links; an unlinked closing's weight is unknown), the share consumed at an actual rate, the
   lines with a known weight and the nested tonnes with a known utilization, and which sheet copies were read:
   one copy of each MO — the living sheet, else the newest month that carries it — so an older month's MOs stay
   in and no MO counts twice. What needs a look (closings without an MO or off the sheet, lines with no weight, rate
   or utilization, the worst overrun) opens from the **Needs a look** button in the bar, as a popup. Then
   calculated consumption per closing day (or actual vs BOM by part), the breakdown by thickness / material / size, the MOs most over their BOM, and the detail by MO and part,
   whose totals equal the tiles. Every tile and bar opens the rows behind it and keeps the choices; every chart
   folds out its numbers as a table; the Excel comes from the assistant (`make_excel` → `material_dashboard`),
   and `get_material_dashboard` gives it the same figures. Consumption here is not a store issue and not the
   sheets cut: the machines' sheets are on the Floor, the store's balance in Material → Physical. The panels'
   sheet has no part codes, weights or utilization, so their side reads partial — said on the page.

6. **Material — nesting project tracker** (`/material`) — the planner's Nesting Project Tracker sheet, filed
   month by month, exactly its columns: BOM Ref · Quantity of Units · Part Code · Part Name · Codes · Material ·
   Thickness · Sheet Size · Sheets in BOM for one Unit / for Job · Actual Nesting for one Unit / for Job ·
   Difference · Notes. The sheet is the tab's **only source**: nothing is typed, edited or deleted on the tab
   (nor by the assistant) — uploading the sheet again is how a line changes, its figures replacing what the
   line held (a blank note aside), and "upload and remove the rows no longer in the file" (confirmed first)
   drops every line the file no longer carries, those typed in by hand before included. The panels' tab shows the units produced (the sheet's count, else the panels painted on the
   tracker) and the sheets they consumed. The sheets nested
   **for the job** are computed on import as the sheet's own **Actual Nesting for one Unit × Quantity of
   Units**, not read from its "for Job" column: that column is a figure somebody left behind — change the job
   size and it keeps the old answer (one row of the tracker says 17.6 sheets where 90 units at 0.568 a unit is
   51.1). A sheet with no per-unit rate still falls back to its job column, and the import says how many rows
   were stale. Import the sheet for a
   month (re-importing adds new lines and updates changed ones; the same BOM's tank and top-cover lines stay
   apart), filter by month and, within it, by part, material, thickness, sheet size, status (nested / not
   nested / with produced / over BOM) or a search across BOM, SOI, part, code and note — the Total row
   follows the filter.
7. **Odoo close-out log** (`/odoo`) — the office's daily sheet of Odoo manufacturing orders it tried to
   close: Date · SOI# · FG-CODE · Product · MO# · QTY · Status, plus Notes. Rows come from the floor's
   closings and from the assistant (which can also import the sheet — its first seven columns, the same MO
   on the same day updated, never doubled); the page itself has no Add a row or Import Excel. The planner ticks the Status in place — ✓ Done or ✗ Cancelled, a second click opens it
   again; ✗ only once a note says why — marking it Done stamps the moment, shown under the marks and
   exported as "Done at" — and
   keeps Notes on it — a list with time and author, each deletable on its own. A filter row (search across
   SOI, FG-CODE, MO, product and notes; product; status; closing; with/without notes) sticks between visits,
   as does the day. **The day's counts are themselves filters** — clicking "19 not closed" narrows to those
   nineteen, clicking again clears it, and each count is taken with its own filter lifted so the numbers hold
   still while they are toggled. "Not closed" is every status that is not a closing, which the exact-match
   status select cannot express, and **"ready to close"** is the office's own queue — still open AND Odoo's MO
   already on the row, so nothing stands between it and a closing but someone doing it. The three read as one
   sentence: of the open rows, these are ready and those are still waiting for a number. Its Excel (the assistant's `odoo_log` sheet) keeps the sheet's own headers. A row can also be **born from the daily log**: every
   painting record (and the core frame's shot blast) writes its own row here on the same day with the SOI,
   product and qty, MO left empty for the office to type in place — the FG-CODE is copied from the last row
   of the same SOI and product, or composed from the part code and the transformer's BOM and flagged
   "check FG-CODE" until someone confirms it. The tab opens on the last 30 days (the whole log grows without
   end), so a banner says how many rows sit on other days and how many of the whole log are
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
   says so. The **ODOO dashboard** (`/dashboards/odoo`, in the Dashboards tab) shows what was logged per day by
   product — a card per product (the sheet's six and any other product logged, by its own name)
   with its trend and change vs the previous period — **each card a filter**: a click narrows every
   chart, figure, table and export below to that product (`product=` in the address, beside the BOM),
   a second click widens back — stacked columns
   with every count written on, one small chart per product, totals, and logged vs closed per day —
   counted, by a **Closed day · Logged day** switch, on the day each row's status went to Done
   (the default: a row logged in August and closed in September is one of September's closings,
   under its product) or on the day it was logged — over today, yesterday, 7/30/90 days, this
   month, all time or a custom from/to (the assistant makes its Excel of the numbers).
8. **Shift log** (`/shifts`) — the supervisors' page, one day at a time: every worker registered in a
   section (Tools → Production Workers), narrowed to a line, a section or a search. Each worker gets ONE
   choice that says whether he came and on which shift — ☀ **Day** (07:00–16:00), 🌙 **Night** (19:00–04:00)
   or ✕ **Absent** — plus optional overtime (day 16:00–19:00, night 04:00–07:00 the next morning) and a note. Both shifts default to 8 net base hours plus 3 optional OT hours. The overtime saved is the period Settings names, to the hundredth of an hour (2.25 h is a period), and a day recorded under an earlier period keeps the figures already on its rows when it is re-saved. A worker with no record for the
   day is **not set** (never silently present or absent). Record **one department at a time**: choose its
   tab and save as soon as everyone in that department is set, even when the other departments are still
   unfinished. **Save & next department** saves then advances; the department tabs show recording progress.
   Switching departments and a successful save preserve other departments' drafts. "Set …
   not set to Day / Night / Absent" fills the rest in one click, keeping anyone on vacation absent. The
   figures on top — day shift, night shift, overtime, absent, not set — are also the list's filters,
   beside the man-hours against the capacity. The **Day / Night board** lists the two shifts' people side by side by
   department, with the absent under them; it is what Ctrl+P prints, and its Excel comes from the assistant.
   **Save [department]** (pinned to the bottom of the screen) writes every worker in that department,
   including those hidden by search, section or attendance filters, and re-sums its
   man-hours into the figure the calibration and the plan's capacity check read (Admin → Standard Times
   shows it read-only). The capacity check (Plan Tracker) and the assistant's what-ifs price the plan's promises the
   same way (`owedPlanQtys`): one order's pieces once however often a line is repeated, the in-house share only
   (outsourced and N/A components owe no hours), the pace over the full days elapsed, and a stage set to 0 h/day
   as over capacity rather than unset. Undo and Clear also affect only the chosen department. The **Day / Night board**
   still covers the whole selected line/factory for print and export. **Recorded days** is a table of day/night attendance, absences, man-hours and
   machine-stop counts for every recorded date. Use From/To filters, pagination or **All days**; check
   individual rows, a page or all matching dates across pages for bulk deletion. Each row opens attendance
   or stops for editing; the date field also opens older dates. Delete day (or Delete selected) removes
   attendance, notes, stops and daily hour totals in one transaction for the confirmed dates and
   departments, requiring recording permission for all of them. Production output and worker profiles
   are retained. Recording needs
   `shifts.<dept>`; viewing is free, and the save action itself refuses a worker still not set, and a row under a
   department the worker is not registered in (a worker moved or retired since keeps the rows already recorded). The
   assistant's `record_shift_day` follows the same rule: workers it is not told about are refused, not
   guessed, unless the person says what the `rest` of them get (day, night or absent) — an automation
   that records shifts has to say it in its instruction. The vacation rule applies to today only: the
   workers list keeps when a vacation ends, not when it began.
   **Work centres**: a Fabrication worker is booked to the centre he was on — laser / punch, bending or fin
   folding — his section's by default (Channels book to bending), changed on the row when he moved that
   day, so each centre's man-hours can be set against what it produced.
   **Machine stops** (a tab of the shift log): choose start/end clock times and the app computes duration
   to the minute. **To is optional while unresolved**: save only From, then use **Resolve** later to enter
   the actual end time and date. Open incidents remain visible on subsequent days with elapsed duration.
   **Still open** clears a previously guessed end. Notes can be updated while it stays open. A dated
   repair can span multiple days; daily losses and available machine hours count only its actual overlap
   with each factory day (up to now while open). Previously recorded rows without an explicit end date
   keep their original start-day booking; a timed stop recorded through the assistant carries its end date
   too (the next day when it crosses midnight) and is refused while its end is still to come. Open rows store `isOpen=true`, no end and `hours=0` as a marker;
   loaders calculate live elapsed hours, so that marker must never be reported as zero downtime.
   A clock end earlier than the start automatically suggests the next date; adjust **End date** when needed.
   Choose **Other equipment** to type an unlisted asset's name and department (and work centre for
   Fabrication); it is logged without creating a schedulable machine. The table, the editor and the
   assistant's sheet keep the range. Timed stops cannot overlap on the same asset, including across midnight; older
   duration-only rows retain their hours and can be corrected without inventing times. Why — one of the plant's
   codes (`lib/domain/downtime.ts`: breakdown mechanical / electrical, no material, no operator, no drawing
   or program, setup, quality, power or air, planned maintenance, other) with an optional note; each stop
   can be corrected in place (hours, cause and note) or deleted on its own. Recording needs the machine's department's `shifts.<dept>`. The assistant records
   and deletes them too (`record_machine_stop`, `delete_machine_stop`), never guessing a reason.
   **Hours a piece, by work centre** (Admin → Standard Times, admin): the hours ONE piece of each item takes
   at each centre — laser / punch, bending, fin folding, welding, shot blast, painting — typed by hand per
   KVA class. An empty cell keeps the estimate (the stage's hours split over the centres the item routes
   through); a typed figure replaces it in the standard-hours engine itself (`lib/domain/stdEngine.ts`), so
   every earned hour, efficiency, calibration, load and capacity figure in the app is priced with it — and
   an item the timings sheet never priced (AR, MB) gets hours at last. The assistant sets them with
   `set_centre_hours`. The three Fabrication centres come pre-typed for every class from the plant's manpower
   sheet (laser 1.99 h, bending 2.45 h, fin folding 4.1 h a 500 kVA transformer, spread over the components
   and the classes in the estimate's proportions; migration `20261025180000`), set by "Manpower plan sheet" —
   clear a cell to fall back to the estimate.
   **Times per machine** (Tools → Times per Machine, `machines.manage`): what ONE piece of each item really
   takes on each machine, in hours. A figure here **outranks the standard time** for that machine — its queue
   on the board is priced with it and the machine plan schedules with it, so a 6 kW laser and a punch stop being planned
   as the same machine, and an item the timings sheet never priced (AR, MB) gets a time at last. An empty cell
   keeps the estimate (the stage's standard hours split over the centres the item routes through, which
   follows the kVA class); the placeholder shows that estimate for a 1000 kVA tank. A typed figure is flat for
   every size. Under each cell is what the floor **actually did** over the last 90 days: the pieces that machine
   finished against the man-hours the shift log put on it, a day's hours split between the items it ran (by the
   standard hours they earned, or by pieces when nothing that day is priced — so AR and MB get a figure too).
   Click it to take it as the figure. Only a ✓ on a machine card carries the machine, so the page says what
   share of the recorded output can be measured at all. The machines are one physical floor: the measured
   figures are priced against the transformer registry whichever line is on screen, and a record whose
   MO is not on the master list is priced by its project's class.
   **Shift hours** (Shifts → Shift hours, admin): what the day shift, the night shift and each shift's overtime are
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
   is the pool the board and the machine plan draw from, so the worklist ends at the work the shift actually runs.
   **Print sheet** on a card opens the technician's sheet for that
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
   **The machine plan** (`lib/domain/optimizePlan.ts`) — no button on the screens any more: the AI assistant runs it
   (`preview_machine_plan`, `plan_machines`) and spreads the fabrication board's sheet jobs itself — fills every
   queue in one go: lines in the order they are **due** (the weekly plan's date for this stage, then the
   flagged orders, then the longest job), each on the machine that **finishes** it soonest, split over
   machines of the same centre when running them in parallel clears the batch sooner (they finish together,
   each at its own speed), and along the route so the bender never starts before that batch is cut. Speed is
   pieces a day: a machine's hours a day over what one piece costs it — the planner's figure from Times per
   Machine where there is one, the estimate otherwise. What is **running now is never moved** — the plan is
   built around it. It answers with what it did: lines placed, machines used, when the last piece clears,
   which lines cannot make their date and by how much, and any centre with no machine to run it.
   **⟲ Reset** on the board takes every line off every machine of the department — the plan is cleared, the
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
10. **What-ifs — through the assistant only** (the transformers only; there is no Simulator screen, and `/simulate`
   lands on `/ai`) — the model (`lib/domain/whatif.ts`, `lib/domain/whatifScenario.ts`) moves the capacity and the crew,
   Fridays, stoppages and material holds, reorders and splits the queue, and says what lands on time and what slips, in
   standard hours. The assistant runs it (`simulate_scenario`, `compare_scenarios`, `stress_test_plan`) and keeps the
   what-if a chat is working on on the chat (`keep_scenario`, `AiConversation.scenario`), so "and Fridays too" builds
   on the last one. **Meet the deadlines** (`plan_for_deadlines`, `lib/domain/deadlinePlan.ts`) searches the same model
   for the cheapest way to bring the late orders back on time — the order of the jobs first, then one step at a time
   the addition that rescues the most per man-hour (workers at a department, Fridays — overtime for today's crew is not
   in the model). A scenario can be saved by name for everyone (`simulator.edit`), and an admin can apply one as the
   plant's run order — each a change with a card. The right stays on Users & Permissions ("What-ifs (through the
   assistant)", tab id `simulate`, no screen): ticked off, the assistant runs no what-if for that person. The cockpit's
   capacity decisions open the assistant with the question ready (`CockpitAction.ask`, `lib/aiAsk.ts`).
   **Planning controls** (`lib/domain/planningControl.ts`, the tools in `lib/server/ai/tools/planningControl.ts`) —
   the assistant plans like a production planner (the "Planning method" of its rules: critical ratio, load bands,
   input/output, the constraint, release, exceptions) on the same model, every figure computed and returned with
   its inputs and assumptions: `get_dispatch_list` (a station's priorities by CR, EDD, slack, SPT, LWR or FOR, the job
   running on a machine kept on top), `get_load_profile` (load against capacity per plant week — under 85% ok, to 100%
   tight, past it overloaded), `get_io_report` (input/output and the queue, upstream or inside), `identify_bottleneck`,
   `get_delay_pareto` (machine stops by cause, the holds), `check_release_readiness` (hold, quantity, standard times,
   nesting, the material, Fabrication's load), `get_material_coverage` and `simulate_rush_order`. **The material**
   (`lib/domain/materialCoverage.ts`): the pieces Fabrication still owes × the nesting's sheets a piece (actual where
   nested, else the BOM's rate), per Odoo product code, against the **Physical Material** table — Odoo's SF01 stock and
   the store's count: covered, short (blocks a release), store-short, not listed, or held in KG; and contended when all
   the open orders want more of a code than Odoo holds (stock is not reserved per order). Read only for a person with
   both the Physical Material and Material screens. The **Physical Material** screen (`/physical`) shows the same open
   need beside SF01's stock — **Open need** (≈ where part of it is at the BOM's rate; the orders behind it on hover) and
   **After need** (Odoo − need) — with a "Short for open orders" card and filter, and names the needed codes missing
   from the table; its Excel (`physical_stock`) carries both columns. For a person without the Material screen the
   columns are left out. Each has a tile under the assistant's "What it can do". Operation
   start/finish times, queue/setup/move standards and order-level delay codes are not recorded, so queue time per
   operation is not measured and CR's lead time is the forecast's.
11. **Consumables** (`/consumables`, a place of the **Material** tab beside the nesting sheets and Physical Material —
   the Material tab's panel moves between the three, each keeping its own views; each is still switched on or
   off per account) — the store's log of what it hands out to the floor. A hand-out is recorded
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
   itself kept as a change. A restore is checked against the item's limits like a correction: a version that
   would take a limit over asks for the reason first, and the row's over-limit flag is recomputed either way.
   An edit made on a page older than the row is refused rather than overwriting
   someone else's. A worker with hand-outs cannot be deleted from the workers list, only deactivated.
   Likewise a user account that chat messages, assistant changes or automation runs name is deactivated,
   never deleted, so that history keeps its person.
   Opens on today; the slicer reaches a year back; the log and the edits as Excel through the assistant.
   **Powder** (the switch's Powder view) — the painting lines' **powder scrap**: the storekeeper records each
   weighing (day, Transformer Painting / USS Painting, kg, note — `PowderScrap`, corrected by its recorder or
   an admin with every change kept, deleted softly by the admin). The month sets it against the **powder
   drawn**: the hand-outs to that section of items named "…Powder…" (catalogue or typed), in kg — a powder
   item counted in another unit is listed apart, not added in. **Scrap rate = scrap ÷ drawn**, **net used =
   drawn − scrap**, per section and both together, the month before in points, six months of trend
   (bars + rate line), what was drawn by item; its Excel and printout through the assistant.
   **Catalogue & limits** (the **Limits** view, `consumables.edit`): the store's list — code, name, unit, remark — loaded
   from its sheet (47 items), each with its limits: a number per **calendar month**, or every **2, 3, 4 or 6 months** or a
   **year** — nothing shorter: the store is tracked month by month and draws stock in bulk — for the departments it names,
   each its own, **shared** by them, or **per worker** (× each department's workers). The sheet's weekly numbers became
   monthly ones of four weeks, and its "Every day" items six working days a week before that (every conversion is in the
   Limits history). Items, limits and retirements are edited in place and every change is kept (who, when, before → after).
   The item is typed or **pasted** (the catalogue suggested as you type, the department's items first): text naming a
   catalogue item by its name or code — case, spacing and a size's × / x aside — is linked to it; anything else is recorded as
   typed and has no limit, shows where the limit stands as the quantity is typed, and a hand-out that would take a limit over is refused
   until the recorder gives a **reason** — then saved flagged "over limit" with the reason and the breach. The
   **Consumables dashboard** (`/dashboards/consumables`, in the Dashboards tab) reads as decisions — what went out, to which
   department, and is it over the limits that are set? One period and four filters in the address (`dept`, `item`, `link`
   = in / not in the catalogue, `status` = over / close / within / no limit) set every card, chart and the table. A
   **data-quality strip** says what the figures stand on (live hand-outs, how many are not in the catalogue, the limits as
   set now — "recomputed using current limits" for a window already over — and whose headcount a per-worker limit is
   times). Six cards: hand-outs (against the same days before, only when the log covers them — N/A otherwise), items (or
   the quantity, when one item is picked — never across units), departments, limits over **now**, hand-outs **no limit
   counts** (typed items and departments a limit does not cover — never "within"), and the share in the catalogue. The
   **Decisions** button at the end of the bar opens what needs someone in a popup (the limits over now, the coverage gaps,
   the months closed over, the hand-outs **recorded** over a limit when saved — kept apart from the recomputed standing —
   and, as notes, the powder scrap weighed, in kg as weighed). Then the hand-outs per hour / day / week, use against each row's limit, the most handed-out items (by hand-outs, or by quantity
   in one unit), and the table: a row per item × department with its limit's basis, window, used, left, over, the
   recorded reason, the catalogue link (a typed name is only **suggested** a catalogue item, for review) and the last
   hand-out — each row opening onto its hand-outs and the log. A click on a card or a chart opens its rows; its Excel is
   the assistant's (`consumables_dashboard`, the page's own address).
   **Monthly review: YYYY-MM** (the foot of the Dashboard — the period's last month, or its own month picker; its Excel through the assistant) — the month-end review: every
   catalogue item's calendar month against its monthly limit (a limit of several months counted over its months so far
   against its whole number), graded **over / close (80–100%) / under / not issued**, with the month before and the last six
   months (a sparkline per item and a chart of how many items fell in each grade), each item opening onto its departments.
   Month picker; the assistant makes its Excel (item and limit lines).
12. **AI assistant** (`/ai`) — Claude answers from the live data in Arabic or English: SQL through `ai_reader`, a
   read-only login that cannot see the private tables, nor the tables of a screen hidden from the person. What it may do
   is the owner's call per person (Users & Permissions → AI assistant), and never more than the person may do themselves.
   - **Ask AI on a right-click** (`components/AskAi.tsx`, `lib/aiTarget.ts`, `lib/domain/aiExplain.ts`): right-click
     (long-press on a phone) a card, a chart, a figure, a table row or a column header anywhere and **Ask AI** explains it
     in a new chat, sent at once — what it is, what it says now and how it is worked out. The screens keep their cards
     short: a chart's or tile's note on how it is counted (`about`) and its numbers (`data`) are no longer on screen but
     ride in the question, so the answer explains the figure the person is looking at; a server-rendered card says the same
     in `data-ai-title` / `data-ai-about`. A row menu of its own (hold, close, trace…) carries the entry at its foot. The
     browser's own menu stays in a field, on selected text and on Shift + right-click; there is none of it for someone
     without the assistant. Each Ask AI is one question, from the person's AI allowance.
   - **A chart's title explains it** (`components/ChartAbout.tsx`, the shared `Tooltip`'s `interactive` card): resting
     the pointer on a chart card's title or its ⓘ (a tap on a phone, Tab from the keyboard) opens a card with the chart's
     `about` and an **Ask AI about these numbers** button. It costs nothing until that button is pressed.
   - **Tools on demand** (`lib/server/ai/agent.ts`): the model starts each question with two tools — `query_database` and
     `get_machine_board` (`loaded` on the tool) — and finds every other one with the API's tool search (BM25, the tools
     sent with `defer_loading`), so a question carries only the definitions it uses (two tools and the search ≈ 0.5 k
     tokens instead of ≈ 39 k for all of them) and the cached prefix stays the same. A chat from before keeps the tools it
     called loaded, a find of a tool the person no longer has is left out of what is sent, and a turn the API pauses is
     sent back to carry on.
   - **Changes** (`lib/server/ai/changes.ts`, `lib/server/ai/tools/*`): the Plan Tracker and Daily log, the Orders Registry
     (an admin's edits, plan months, deletions) and a BOM's Fins, the machine board and the machine plan (a line's share
     on a machine too), the jobs — the fabrication board's sheet jobs (sheets carrying several projects' parts, spread
     over the machines and closed in sheets) and the other boards' jobs in pieces — the worklists' notes (with photos from the chat),
     returns upstream, an admin's dates and hidden lines, tanks piece by piece (welder, leak test, repair, painting,
     quality), the what-ifs (saved scenarios) and the run order, the ODOO log (FG codes and merged lines
     too), Material (new lines, an LV order's sheets, SOI groups), physical stock, consumables with their catalogue,
     limits and powder scrap, the shift roster, the calendar, workers and machines, the standard times, capacity,
     calibration, times per machine and settings (key "AI — standard times and settings"), automations (a test run too)
     and messages — to colleagues' inboxes or, in a live chat and only when asked, the team chat — and, for the owner
     alone, in a live chat only, Users & Permissions (an account it makes has a password nobody knows; the owner sets
     the first one). Left out on purpose: the assistant's own settings (its key, limits, pause, model), approving its own
     changes, passwords and signing in, and what is only a screen's own view (polls, preferences,
     marking things read).
     A write tool never writes by itself: `describe` shows the card (before → after) and keeps a
     snapshot of the data; on Approve it runs only if the data still reads the same, through the screen's own server action
     as the person (`runAsActor` — the audit names "Sara (AI)"). The snapshot is what the change relies on, not the whole
     screen: a machine-board card keeps where its own line is (a move, its machine's queue), so cards approved one after
     another do not put each other out of date, and a distribution of many lines is one card (`assign_lines_to_machines`
     — one approval, one board refresh, one undo). Undo runs only while nothing changed since; where an
     action stamps things as it goes, the undo writes the rows back exactly from the snapshot (`lib/server/rowSnapshots.ts`,
     reachable only from an undo). Deletions need their own key and always wait; "small changes without asking" is a
     per-person opt-in — and a change that carries a quantity (pieces pushed, sheets cut, counts, closings) or
     touches more than a few rows waits for the click whatever the opt-in. The owner can pause every change, or every automation, at once (AI assistant settings).
   - **A chat's working what-if** (`keep_scenario`, `AiConversation.scenario`): each chat keeps the scenario it is
     working on — workers, hours, Fridays, stoppages, holds, splits, jobs rushed to the front, the optimised queue, or a
     saved scenario opened — read against today's jobs where a tool starts from it, so the next what-if, comparison or
     deadline search builds on it ("from: plant" starts afresh). No card: it is the person's own chat and nothing in the
     plant changes, so it works with the changes paused too, and never in an automation; the system message says when a
     chat keeps one. Saving a scenario for everyone and the run order stay changes with a card.
   - **Charts and printouts** (`lib/domain/aiChart.ts`, `components/AiChart*.tsx`, `components/AiPrint.tsx`): an answer or a
     report draws its figures from a ```chart block — bar, line, area and combo (stacked or as shares of 100%, target
     lines, one thing picked out with the rest in gray), pie, KPI cards (with a trend and progress), Pareto (the causes
     that make 80% stand out), histogram, scatter, heatmap, progress against target, funnel, waterfall, Gantt, dumbbell,
     radar, treemap, gauge (a dial against its target), box plot (spread per group), Sankey (flows between stages),
     calendar (a value per day as the month) and control chart (3-sigma limits, the points outside marked) — on one
     value scale each, in the palette's slots, the values written on the marks wherever they fit, every chart with its
     numbers as a table and their export. A chart's JSON draws however its fence was labelled, and other names for a
     form (column, donut, bullet, slope, step …) draw as the form that does that job. The same blocks draw in the chat and in the
     inbox's reports (expanded, the inbox fills the screen); **Print / PDF** on an answer or a report prints it alone under the company header, charts and all.
   - **How it answers** (`lib/domain/aiAnswer.ts`, `lib/domain/aiHistory.ts`, `components/AiChat.tsx`, `components/AiMarkdown.tsx`):
     the system prompt asks for the answer first, then the detail (a table, a chart), the cause and up to three actions when
     asked why or what to do, a self-check before writing (every figure from a tool result, totals that add up, the scope
     said, estimates called estimates), one closing `Scope: <line> · <period> · read <HH:MM>` line — drawn as a strip, not
     prose — and up to three follow-up questions in a ```followups block, drawn as chips (stripped from a report, a printout
     and the copied text). A blockquote opening with ⚠️ / ✅ / ❌ is a coloured callout; a Markdown table groups its figures'
     thousands, folds past 15 rows and exports to Excel. The chat shows each look-up as a step (its purpose, its time, its
     rows: `step` events from the agent, which runs the reads of one turn concurrently and a change alone after them), a
     seconds counter while it thinks, Stop (the server finishes and keeps the answer; the client's stream is cut), Try again
     after a failure, ↑ for the last question, and under the answer the model, the time, the owner's cost, Copy, Print,
     Share (`shareAiAnswer`: to colleagues' inboxes as a message from the person — the automations key, the recipients'
     and the hour's caps of the inbox's own message action, through `lib/server/inboxMessage.ts` — and/or kept as their own
     report; `shareAiAnswerToChat` as plain text through the team chat's own action; the follow-ups are left
     out) and 👍 / 👎. The depth beside the box — Quick / Standard / Deep — sets the effort, the
     model and the calls for one question (`depthPlan`: Quick is Haiku at low effort, Standard the model Auto routes the
     question to at medium, Deep Opus at high with half again the calls); the chat has no model or effort setting of its
     own. An empty chat opens on what the assistant can do — tiles for a report, a chart, an Excel file, a
     what-if, a plan to a deadline, the morning briefing, what looks wrong, why an efficiency moved, a scanned paper
     sheet and (for whoever may) a new automation (`lib/domain/aiQuickActions.ts`): a tile's short form (topic, period,
     department, line, the form of the answer) writes the question, and the composer's ✨ brings the tiles back in a
     chat already going — then the questions for the screen it is opened on (`AI_PAGE_SUGGESTIONS`). Chats can be
     pinned and renamed; "Select" (or Ctrl/⌘ + click, Shift + click for a run) ticks several to pin or delete together
     (`deleteAiConversations` / `pinAiConversations`, the person's own only). Beside the chat the list is dragged
     wider or narrower by its edge (arrow keys too) and hidden or shown from the window's head, kept on the browser
     (`lib/domain/aiSidebar.ts`, `components/AiSidebar.tsx`). Before a long chat is sent back to the model, the big
     results of every question but the last two are folded to a note that keeps their source (`compactHistory`), so the
     chat goes on to 200 messages and the prompt cache keeps hitting on the folded prefix. Stop closes the connection, which
     stops the model too: what was written is kept in the chat with a note, and the question's turn is freed. A chat
     question has up to 740 s (the route's `maxDuration` 800 under Vercel's Fluid compute, less a minute to save;
     `AI_ASK_TIMEOUT_MAX`), an automation's or a check's four minutes; past three quarters of its time the next model call
     must answer with what it has (`tool_choice: none`, with a note) rather than time out with nothing. `AiUsage`
     keeps how long each question (a chat's, an automation's, a check's) took and when its first word came (shown on AI
     settings → Latest questions).
   - **It learns and is measured** (`lib/domain/aiLearn.ts`, `lib/server/ai/memory.ts`, `lib/server/ai/checks.ts`,
     `components/AiFeedback.tsx`, `components/AiQuality.tsx`): it keeps a few lines about each person between chats
     (`AiMemory` — what they told it about their work and how they like answers; the brain button lists them to correct
     or delete; never plant figures or secrets); 👍 / 👎 under each answer (`AiFeedback`), a thumbs-down with what was
     wrong, which the owner turns into a playbook rule or a quality check on AI settings → Quality; quality checks
     (`AiCheck`) — real questions, what a right answer must say and optional reference SQL run read-only — asked as the
     owner with changes off and graded by Haiku, the run counted like a question; and the chat is always on **Auto**:
     Haiku for a short look-up, Sonnet for a change, Opus for analysis, plans and files — each question on its own, so a
     chat moved up for a hard question comes back down for the next look-up, and every answer (reopened chats too, read
     off `AiUsage`) names the model that wrote it.
   - **Owner's reach**: the app's owner lists everyone's automations and pauses, retimes
     (`set_automation_timing`) or deletes any, as AI assistant settings lets them; what one does stays its owner's to
     change.
   - **Excel files and printing** (`lib/server/ai/tools/sheets.ts`, `lib/server/sheets.ts`): the screens carry no
     Export or Print button — the Floor's worklists (and the tank barcodes) aside. Asked for "an Excel of …", the
     assistant's `make_excel` builds the sheet the screen's button used to make — the same loader, filters, columns and
     headers (the Plan Tracker TR/LV, a weekly plan, the Daily log, the Orders Registry, a trace, the ODOO log and its
     days, Material, Physical Material, the consumables' log, limits, edits, summary, monthly review and powder scrap,
     a day's attendance and machine stops) — or the rows of one read-only SELECT, up to 50,000 rows. Any of them can be
     laid out in the same file (`lib/domain/sheetLayout.ts`): `nonBlank` keeps the rows with given columns filled,
     `splitBy` puts each value of a column on its own sheet (a sheet per thickness, up to 50), and `totals` closes each
     sheet with a Total row over the columns named. Every workbook the app writes — these, and the Floor's and the
     chat's Export buttons (the writer is fetched on the first press) — comes in the house style
     (`lib/domain/sheetStyle.ts`, `lib/excel/workbook.ts`, on `exceljs`): a coloured, frozen header with filters,
     fitted columns, number formats, banded rows, a bold Total row, set to print a page wide; the values are written as
     they are (a text is never a formula). The assistant's `style` adds what the person asks for — a title, a header
     colour, cells or rows coloured by a rule, a colour scale, data bars, a number format, bold or frozen columns — as
     live Excel rules. Each screen's sheet
     follows the screen's own access (its tab; the Orders Registry and the consumables' edits the admin's). The workbook
     is kept as the person's own file in their chat (`AiFile`, same limits and 14 days), and the answer carries two
     buttons: download it, or `/ai/print/[id]` — every sheet of it under the company header with the print dialog open. A
     dashboard or an analysis is printed from the answer itself (its Print / PDF).
   - **Attached files and imports** (`lib/server/ai/files.ts`, `lib/server/ai/tools/imports.ts`): a photo, a PDF, an Excel
     or CSV sheet attached with the 📎 is checked by its bytes (a photo shrunk in the browser first; a photo or PDF also
     measured by the model's own token count, so one it refuses never reaches a chat), kept in `AiFile` for 14 days (closed
     to `ai_reader`) and opened only in its own chat. Photos and PDFs go to the model with
     the question — the chat keeps a reference (`aifile_<id>`) that is turned back into the file each time the chat is
     sent: the chat's newest, while they fit (20 files, 16 MB, 250 thousand tokens — the count measured at upload is kept
     in `AiFile.tokens`), older ones named only. It takes the figures off them as asked and records them with the write
     tools (`record_output` for production). **Scan a sheet** (the composer's scan button; on a phone the back camera)
     attaches a photo of a handwritten form with `SCAN_SHEET_QUESTION`: the assistant copies the sheet into a table as
     written (unreadable cells as ?), matches names and orders, asks about what did not read or match, then prepares the
     records as cards to check against the paper.
     Sheets it reads with a tool, and imports through the screen's own importer — the card is the importer's dry run, and
     the import runs only while a fresh dry run reads the same. No undo for an import; key "AI — imports" plus the
     person's own import permission.
   - **Machine rules** (Tools → Machines & lines): only / never / prefer, by item, line, sheet thickness and material, kVA —
     the machine plan follows them (`lib/domain/machineRules.ts`, `optimizePlan`'s `allowed` / `preferred`).
   - **Automations** (`/automations`, `lib/domain/automations.ts`, `lib/server/automations/*`): on a schedule (Cairo times on
     working days, every day or weekdays) or when a read-only query finds rows it did not at its last check (edge-triggered by
     a `key` column); notify (no AI), report, act (changes wait for approval), or task (one task per new row, from a
     template (title, then details; `{name}`, `{count}` and each row's `{column}`), given to the people named, due in so many working days — needs
     "Tasks — assign"). A condition can escalate: a row still found after `escalateAfterMin` minutes is sent once to the
     app's owners and the automation's owner (`keySeenAt`, `escalatedKeys`). Built on /automations with a form that shows
     the next runs, the rows a condition finds now, or what an event would have caught in the last 7 days, or from ten
     ready-made recipes (`AUTOMATION_RECIPES`) — under the assistant's ideas (`lib/domain/automationIdeas.ts`,
     `lib/server/automations/ideas.ts`, `AutomationIdea`): once a week (the first working day from 09:00, the week claimed
     on `AiSettings.ideasWeekISO`) Haiku reads the last month's events, the automations kept and its earlier ideas, and
     suggests new ones; up to three that pass the save checks (a condition's query is run) are kept, the owners are told
     in the inbox, each person sees those fit for them (new this week marked, set aside one by one), the owner can ask
     for more now, and `list_automation_ideas` lets the assistant read them. They run as their owner, count against the month's caps, stop after five
     failures in a row. The clock: Supabase pg_cron + pg_net call `/api/automations/tick`
     every minute through the plant's day (UTC 02:00-21:59: 04:00-23:59 Cairo in winter, 05:00-00:59 in summer) and
     every quarter hour at night, with a secret kept in Supabase Vault — set up in one click on AI assistant settings,
     which also schedules the nightly clearing of pg_cron's own run log (a week is kept); until then open pages tick,
     at most once a minute for the whole plant.
   - **Inbox and push** (`/inbox`): reports, messages and suggestions, with Web Push to phones (VAPID keys made on first use,
     the private half encrypted; only the real push services are posted to). The count rides on the chat's poll, with the
     newest unread item's id. Every unread item but one a person sent themselves also pops up under the bell on any page
     (`components/InboxAlerts.tsx`, the newest three, one on a phone) with a chime, until it is marked read or opened — what
     is unread is kept on the server, so a reload or another device shows it again.
   - **Tasks** (the inbox's Tasks tab, `lib/domain/tasks.ts`, `lib/server/tasks.ts`, `app/tasks/actions.ts`): given by
     someone with "Tasks — assign" (through the assistant, an automation or a repeating task — the tab has no form of its
     own), reported on by the
     people it was given to, approved or returned by the giver. Views: List, Board (to do / in progress / to review / done),
     Calendar (by due day) and Team (each person's open, late, due this week and to review, and over 30 days the approved,
     the share on time and the days taken; the owner sees everyone's), all under one filter bar (words, due day, person,
     urgent). A task may carry a checklist its giver and people tick (written over the checklist as it was read); a task
     can repeat by itself (`TaskRepeat`: each working day, on weekdays or a day of
     the month, a day off moving to the next working day, due so many working days later) — given by the minute tick as
     its giver while they may give tasks. The tick also reminds a task's people on its due day, once after it is late, and
     sends a task late for two days or more to the app's owner, once.
   - **Morning review** (`lib/server/automations/review.ts`): for the people ticked "AI — daily review and suggestions", every
     working morning from 07:30 — suggestions only; every change waits.
   - **Playbook** (`/ai/playbook`): how this plant works, told to the assistant with every question; admins keep it there or
     through the assistant.

13. **Planning and Production dashboards** (`/` and `/dashboards/production`, the first two places of the Dashboards
   tab; each shows both lines on one page — the plant's figures, then the transformers' section and the LV panels').
   **Planning** has one bar, all of it in the address (`lib/domain/planningDashboard.ts`, tested): the scope first
   (All | Transformers | LV Panels, `?scope=`), the transformers' weekly plan (`?plan=`, the newest by default — an
   earlier one shows its lines as they stand now), component (`?item=`), work centre (`?centre=`) and MO / BOM / SOI
   search (`?q=`), the panels' family (`?family=panels|mb`) and department (`?lvDept=`), then when the page was read
   and the **Decisions** button — the decisions are a popup, never a card on the page. Each section opens on what its
   figures rest on (the share of the work priced, centres with no hours to measure capacity, OSP and N/A pieces, orders
   on hold, the last recorded shift day), up to six headline tiles — each one a link to the rows it is the sum of
   (`?detail=`, a popup that keeps the filters; the totals are the tile's) and a ▲ / ▼ against a week ago where a
   reading was kept on the same basis, **N/A** otherwise — then the plan against achieved (the transformers by oven day,
   each stage on its own, today marked; the panels by stage against the month's even pace), the **load against
   capacity** (each centre × the next 10 working days: the hours due over what it can work a day, short or tight on the
   running totals), the work waiting between the stages (**Now**), the month's pace and its people, and **At risk**: every
   line late at a stage, made late by a centre already short before its date (the catch-up day an estimate at the
   measured pace, no overtime), or on hold — out of the queues and the load, still on the plan — with its MO, SOI, BOM,
   component, stage date, required, done, left, the stage holding it, its std-h left, why, and its trace and worklist.
   The panels' list is the month's orders and the urgent ones still short (no dates, so nothing "late"). Under All the
   plant's tiles keep each line's headline apart and add only what adds: the month's std-h left and the people to add.
   On the
   transformers, Planning is the **cockpit** — the planner's one page, every figure in **standard hours**
   (what the work is worth, from the hours a piece per work centre — typed, else the estimate), so Fabrication's
   ten projects a day add up and departments compare. The **Decisions** button in its bar (icon: the worst news; badge: how many) opens what needs a decision today (lines behind, a centre
   short at the end of the horizon or falling behind in it and when it catches up, thin or heavy welding coverage, a slow centre, the
   biggest loss, an unrecorded day) in a popup, the printout carrying the list. The headline tiles: the plan delivered on
   its day, the lines behind, welding's coverage, and — over the last 7 recorded days — Fabrication's efficiency, the
   machine time lost and the people short. Then: **1** the newest weekly plan — each stage's pieces due by
   today (the oven date less the Settings lead days) against done, by delivery day, and the lines behind with the
   stage they are stuck at (the card shows the oldest 20; the assistant reads them all through `get_kpis`); **2** the load ahead —
   each centre's remaining plan hours over the next 10 working days against what it
   can work (its usual man-hours × its measured pace — "not measured" while no hours are booked there); **3** welding
   coverage — days of cut parts waiting in front of the welders; and **the month in
   people** — each centre's standard hours for the month's plan (its orders' components × pieces, outsourced ones
   left out) over the month's working days × the net hours a person works (Settings) give the people it needs, what
   is left over the days still to come the people needed from today, against who comes on an average recorded day
   (the plant's manpower sheet, read live). Every card answers with a chart and shows no more than its
   title: what it means, how it is counted and its numbers go to the assistant on a right-click's **Ask AI**: the week's plan as a burn-up (pieces asked and finished, summed day by day);
   the load as one centre's running totals (owed so far against what it could have worked, the short days shaded)
   beside every centre's status; **the month's pace** — each centre's share of the month's plan done against where an
   even pace through its working days stands today; the people as bullets (who comes against who is needed from
   today), with welding's coverage beside them. **Where did the hours go?** (`lib/domain/losses.ts`) walks a
   choice's rostered man-hours over the Production dashboard's own period down to the standard hours earned —
   absence, overtime, the man-hours machine stops idled by cause (machine-hours × the centre's people's hours against
   its machines', never more than the hours not earned), and what is left: slower than the standard, or work not on the
   Daily log — as a waterfall, and says which of them moved the efficiency against the days before (the assistant's
   `explain_efficiency`; it sits on the Production dashboard). The headline figures each read against a week ago. The
   Production dashboard (`/dashboards/production`) answers *what did we make, at what efficiency, and where is the
   gap between the effort and the output* for one choice in ONE bar, all in the URL: the line (`?scope=` All | TR | LV),
   a department (`?dept=` — Fabrication, Welding, ShotBlast, Painting, Punching, Bending, WeldingLV or PaintingLV; it
   names its line), on Fabrication a work centre (`?centre=`), and the period (the app's date slicer, the last 7 days by
   default, up to 92 days within the last 180; `?from=&to=`); then, at the bar's end, three popups — **Data** (attendance
   recorded on how many of the working days since recording began, the last recorded day, each line's output priced,
   output on days nobody booked hours, today still being logged), **Worth a look** (the unit-days with the most hours
   not earned, those unusually above the standard — over 130%, shown as they are — and what moved the efficiency) and
   **Interventions**. The page: six tiles — earned standard hours, booked man-hours, efficiency, std-h a person-day,
   attendance, overtime share — each against the equal stretch before (relative for amounts, points for ratios, N/A with
   no valid base) and each opening the rows it adds up (`?focus=`); earned against booked day by day (a click opens a
   day's rows, `?day=`); each work centre's (TR) or department's (LV) efficiency day by day (grey where nobody booked —
   never red or zero); what each stage recorded each day by component in its own unit (`?stage=`; pieces at four stages
   are never added as finished units); who came — present, absent, Not set (against today's workers list, from the day a
   worker was added) — by department with the day and night shifts (`?shift=` narrows the attendance and the hours only:
   the Daily log records no shift, so there is no efficiency by shift); **Where did the hours go?** over the same
   choice (absence, overtime, the machine stops' man-hours as an estimate, the unexplained rest); and the departments'
   table (recorded days of the working days, person-days, hours, overtime, earned, efficiency, output in its unit, a
   link to the day's record), its total row the tiles. Efficiency is Σ earned ÷ Σ booked over the unit-days that booked
   hours, never capped. Below, under More: the item card, the floor's trend, the machines' stops by cause and, on the
   transformers, the machines and quality. The figures are `lib/domain/productionDashboard.ts` (tested), read by
   `lib/server/productionDashboard.ts` from the same reads as the line periods (`getFloorPeriodWithFacts`,
   `getLvFloorPeriodWithFacts`) — the page, `get_floor_performance`, `explain_efficiency` and the assistant's
   `production` / `production_days` sheets all read that one loader.
   The transformers' **Floor performance**: the period's efficiency, standard hours and pieces
   a person a day (shot blast's pieces are every painted piece, as on Shifts), people a day, attendance, overtime share
   and machine availability; each centre's efficiency day by
   day as a heatmap (green at the standard, 90% and up; amber 70–90%; red under 70%; the period at the end); what
   stopped the machines as a Pareto; each department's productivity in one table (people, hours booked and earned,
   efficiency, std-h and pieces a person a day, overtime, attendance, machines up, stopped hours); each day's output
   in standard hours by department against the man-hours booked; and the floor's efficiency each day with its rolling
   7-recorded-day line. The page prints. An account the Shifts screen is closed to sees neither the centres'
   efficiency, nor the losses, nor who is present (the floor's tiles, Where did the hours go?, the Floor performance section, and the people
   card's Present and Gap) — on the page or through the assistant. The day's figures are kept for their trend
   (`KpiSnapshot`): after the page is served, and each hour by the automations' housekeeping. The
   pure arithmetic is `lib/domain/kpis.ts` and `lib/domain/floorKpis.ts` (tested); the loader `lib/server/kpis.ts` is
   the one both the page and the assistant read — `get_kpis` for the cockpit (the morning review starts from it),
   `get_floor_performance` for a period and a department. The trend keeps the cockpit's own figures, whatever period
   the Floor performance section shows. The calibration reads the ledger through
   the same `earnedOfRecord`. Admin → Standard Times shows, under each hours-a-piece cell,
   what the floor really took there over the calibration's window and limits (the centre's measured pace), to take
   with a click. The cockpit also shows **where the work waits** between the stages over the open orders — cut and not
   welded, welded and not finished, sent back and not re-delivered, on hold — netted project by project, never a stage's
   output added to the next's (the records say where a piece stands, not since when).
   The Production dashboard's transformer side adds **which machines stand still** (the stops still open with the time
   stopped so far, the machines that lost the most unplanned hours), **quality and rework** (`lib/domain/quality.ts`,
   `lib/server/quality.ts`: while tanks are tracked piece by piece, the tanks waiting for the test, in repair and ready to
   paint, the leak test passed FIRST time over the tanks first tested in the period — every attempt is kept, so a re-test
   never flatters it — and the median days welding → test → painting; the pieces sent back upstream, open and filed, by
   reason) and **Needs intervention** (`lib/domain/productionActions.ts`: an open stop, a slow department with enough
   recorded days and priced output, returns on urgent orders, tanks in repair, a day with output but no attendance or
   hours but nothing on the Daily log, a period whose pieces mostly carry no standard hours) behind an **Interventions**
   button in its head.
   **The LV panels** (`lib/domain/lvKpis.ts`, `lib/server/lvKpis.ts`) are judged in their own terms, never the
   transformers' with the names changed: their plan is a MONTH with no delivery date, so Planning reads the month's
   orders through the chain (punched, bent, welded, painted — finished when painted) against an **even pace through the
   month's working days** (the cockpit's own `monthPace` rule, in panels), the panels waiting between the stages netted
   order by order, the urgent orders still short with the stage they are stuck at, the people each of the panels' four
   departments (Punching, Bending, Welding (LV), Painting (LV)) needs for the month — priced by the timings sheet's LV
   tab, with how many orders it covers — against who comes, and what needs a decision. Production on the panels is the
   same Floor performance read (efficiency = the panels moved × their sheet hours ÷ the man-hours the shift log booked
   in the panels' departments; a heatmap per department; standard hours and panels a person a day; attendance,
   overtime; output day by day). Not the panels': the load ahead, the lines behind a stage date and welding's coverage
   (no delivery dates, no lead days), machine stops (recorded by department on shared machines — the punches carry
   panels too) and quality (panels are recorded as quantities). **The plant's figures** at the top of both pages
   (`lib/domain/plantKpis.ts`, `lib/server/dashboards.ts`; each line loads on its own, so one that fails leaves the other
   on screen) show the plant only where it adds — standard hours, man-hours and people (each line's own departments; the one shot-blast
   crew is booked on the transformers' side and earns the panels' blasting there), efficiency as **Σ earned ÷ Σ worked,
   never the mean of the two rates**, the stops once as the plant's — and the two lines side by side for everything else:
   plan progress per line (dated promises on one, a month's pace on the other, no single percentage), pieces never added
   (a panel is not a tank), both lines' decisions tagged by line. Coverage is said, never hidden: a line with no shift
   day, or output that mostly carries no standard hours, is noted on the card. Production's plant figures carry **What did
   we make, item by item?** (`lib/domain/outputByType.ts`): each line's pieces at each stage in the period by item and
   type — the transformers by component and the order's KVA class (the class its standard hours are priced at) through
   cut, welded and finished (painted, or shot blast for the core frame); the panels by plan (LV panels, meter boxes) and
   panel type (USS, LSS, …) through punched, bent, welded and painted — against the plan of the month the period ends in:
   planned, finished on the month's orders (each order counted up to what it asks, so one order's extra never covers
   another's shortfall), left and the share done. Pieces add within an item, never across items or lines; an Items /
   Items and types switch folds the types away, and the assistant's `make_excel` makes it a sheet (`output_by_type`,
   every type of both lines). The assistant reads the same loaders
   with the same `line` (`get_kpis`, `get_floor_performance`, whose `byItemAndType` is that card) — both lines when the
   person is on a dashboard, else the line they are on — and follows the same rules.

## Validation against the workbook
The pure logic is checked cell-for-cell against the workbook's own computed sheets:
- **Plan Tracker**: **35/39 rows match exactly**. The remaining 4 are **stale cached values in the
  workbook** — e.g. `14002E13M13` shows nonzero on the Plan Tracker sheet but has **zero** handover
  rows in the log (the sheet is a snapshot from an earlier handover state). Our compute produces the
  correct fresh values. See `scripts/validate-tracker.mjs`.

## Key nuances faithfully replicated
- **`BomGroup` merges** same base + same M-number (`12011E13M12`/`E14`/`E16` → `12011|M12`) and is
  used by the **worklists and reallocation** — but **NOT by the Plan Tracker**, which groups
  by RAW BOM. So those three codes are ONE row in a worklist and THREE rows in the tracker, exactly
  like the VBA. (`lib/domain/bom.ts`, `tracker.ts`)
- **Excel serial dates** convert correctly (46211 = 08/07/2026).
- **`ParseBalance`** splits digit↔letter in **both** directions (the spec's fix over the VBA).

## Notes / deviations
- **Reallocation** is an explicit approve/reject transaction layer rather than silent log mutation.

## Layout
- `lib/domain/*` — pure, unit-tested ports (no I/O). `*.test.ts` alongside.
- `lib/server/*` — Prisma-backed data access feeding the pure functions (`server-only`). `loads.ts` holds the
  request-cached loads of the tables every screen reads (orders registry, schedules, the daily log, holidays,
  plans, settings): the first caller in a request pays for the query, every later one shares the rows.
- Heavy browser code loads on demand: the charts (`components/LazyCharts.tsx`) and SheetJS (only when an Export
  is pressed — the Floor's worklists and the assistant's answer tables) stay out of every page's first load; `app/loading.tsx` paints a skeleton the instant a tab is
  clicked while the page streams in.
- `app/*` — RTL pages + server actions. `components/*` — shared UI + client widgets.
- `scripts/*` — seed + validation/diagnostic scripts. `reference/*` — original VBA + workbook.
