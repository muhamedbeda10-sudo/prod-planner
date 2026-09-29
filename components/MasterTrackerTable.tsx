"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { decidePlanQty, setOrderStatus, setExcludedItems, setOrderQty, setOrderSpec, setGroupOrderSpec, setGroupFins, setOrderPriority, setOrderHold, pushOrderToWorklist, removeOrderMonth, closeDeliveredOrders } from "@/app/orders/actions";
import { recordTrackerTotal, recordGroupOutput } from "@/app/worklist/actions";
import { pctStyle, Num, Soi } from "@/components/ui";
import { RingCard } from "@/components/ProgressRing";
import { ExportButton } from "@/components/ExportButton";
import { PrintButton } from "@/components/PrintButton";
import { PrintScope } from "@/components/PrintHeader";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PlanViewToggle } from "@/components/PlanViewToggle";
import { ITEMS, DEPTS, isPaintExempt, deptLabel, FINISHING_LABEL, type Item, type Dept } from "@/lib/domain/constants";
import { agreedSpec, capsFor, finsGroup, isFullyDelivered, spreadOverGroup, spreadWords } from "@/lib/domain/groupSpread";
import { holdLabel } from "@/lib/domain/hold";
import { ContextMenu, useContextMenu, type MenuEntry } from "@/components/ContextMenu";
import { Modal } from "@/components/Modal";

type Progress = "complete" | "inprogress" | "notstarted";

/** The order's spec columns. Every one of them is the planner's own — the
 *  monthly import writes none of them, so a re-import can never blank what he
 *  typed. Fins sits with the components (it is one of them, welded onto the
 *  tank); the others sit beside KVA. */
/** The grid is coloured by COMPONENT, not by stage: all four of an item's
 *  stage columns wear one wash, so a block of twenty-four numbers reads as six
 *  components rather than one undifferentiated field. The hues are ordered so
 *  that NEIGHBOURING items separate best (every adjacent pair ≥ 8 ΔE OKLab in
 *  both themes); non-adjacent ones never touch, so their distance does not
 *  matter. Colour is never the only cue — the item's own header spans its
 *  columns and a strong divider closes each block, which is what carries the
 *  grouping for a colour-blind reader, where green and orange converge. */
const ITEM_TINT: Record<Item, string> = {
  CF: "var(--item-cf)",
  TC: "var(--item-tc)",
  TN: "var(--item-tn)",
  CB: "var(--item-cb)",
  AR: "var(--item-ar)",
  MB: "var(--item-mb)",
};

/** ⏸️ A held row wears ONE wash over every cell, the component tints
 *  included: the planner asked for the row to read yellow at a glance, and
 *  a paused order's stage numbers are not what anyone is scanning for. */
const HOLD_TINT = "var(--warn-bg)";

type SpecField = "fins" | "colorRal" | "crcSize" | "sfm";
/** Fins reads in its own colour down the whole column — header, MO rows and
 *  merged BOM rows — so the eye finds it without counting across to the Core
 *  Frame. The rose is the one hue the stage tints, the status pills and the
 *  brand green leave free; both pairs clear AA on their surfaces. */
const FINS_CELL = { background: "var(--fins-tint)", color: "var(--fins-fg)" } as const;
// the header wears the same pair, not the inverse: inverting it puts white on
// a pale rose in dark mode, which fails. One tint the whole way down also
// reads as a single stripe against the green header row.
const FINS_HEAD = FINS_CELL;

const SPEC_TITLE: Record<SpecField, string> = {
  fins: "Fins — type it here",
  colorRal: "Colour RAL — type it here",
  crcSize: "CRC size — type it here",
  sfm: "SFM — type it here",
};

// the tracker's stage columns, in pipeline order — the Dept filter picks any
// subset of these (the core's Painting column is its SHOT BLAST)
const STAGE_OPTS = [
  { value: "Cut", label: "Fabrication" },
  { value: "Welding", label: "Welding" },
  { value: "Painting", label: FINISHING_LABEL },
  { value: "Delivered", label: "Delivered" },
] as const;

function progressOf(r: MasterTrackerRow): Progress {
  if (r.required > 0 && r.complete >= r.required) return "complete";
  if (r.complete > 0 || ITEMS.some((it) => r.items[it].cut > 0 || r.items[it].weld > 0)) return "inprogress";
  return "notstarted";
}

export interface RowEta {
  etaISO: string | null;
  dueISO: string | null;
  late: boolean;
  done: boolean;
  blockedBy: string | null;
}

/** What a right-click landed on: one MO's row, or a merged BOM's. */
type MenuTarget = { kind: "mo"; row: MasterTrackerRow } | { kind: "group"; bom: string; members: MasterTrackerRow[] };

/** Keyboard manners for the stage cells, borrowed from a spreadsheet: the
 *  arrows walk the grid, a digit typed on a focused cell starts the entry,
 *  and LEAVING the cell — an arrow, Tab, Enter or a click elsewhere —
 *  records what was typed. There is no tick to press; Escape drops it. */
type NavDir = "left" | "right" | "up" | "down";
function navDir(key: string): NavDir | null {
  return key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : key === "ArrowUp" ? "up" : key === "ArrowDown" || key === "Enter" ? "down" : null;
}
/** Focus the neighbouring stage cell. Left/right step along the row; up/down
 *  find the same column (`data-nav`) in the nearest row that has it, so a
 *  merged BOM row and the MO rows under it share one column walk. */
function moveFocus(from: HTMLElement, dir: NavDir): boolean {
  const tr = from.closest("tr");
  const table = from.closest("table");
  if (!tr || !table) return false;
  let target: HTMLElement | null | undefined;
  if (dir === "left" || dir === "right") {
    const cells = Array.from(tr.querySelectorAll<HTMLElement>("[data-nav]"));
    target = cells[cells.indexOf(from) + (dir === "right" ? 1 : -1)];
  } else {
    const col = from.dataset.nav ?? "";
    const rows = Array.from(table.querySelectorAll("tr"));
    for (let i = rows.indexOf(tr) + (dir === "down" ? 1 : -1); i >= 0 && i < rows.length && !target; i += dir === "down" ? 1 : -1) {
      target = rows[i].querySelector<HTMLElement>(`[data-nav="${CSS.escape(col)}"]`);
    }
  }
  if (!target) return false;
  target.focus();
  return true;
}
/** Keys on a cell that is NOT being edited: a digit starts the entry with
 *  that digit, an arrow moves. Enter falls through to the button's click,
 *  which opens the entry with the figure selected. */
function cellKeys(e: React.KeyboardEvent<HTMLElement>, startWith: (digit: string) => void) {
  if (/^\d$/.test(e.key)) { e.preventDefault(); startWith(e.key); return; }
  const dir = navDir(e.key);
  if (dir && e.key !== "Enter") { e.preventDefault(); moveFocus(e.currentTarget, dir); }
}

/** The number box inside a stage cell being edited. */
function CellInput({ col, value, selectAll, label, onChange, onCommit, onCancel }: {
  col: string; value: string; selectAll: boolean; label: string;
  onChange: (v: string) => void; onCommit: () => void; onCancel: () => void;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      data-nav={col}
      value={value}
      autoFocus
      // opened by a click: the figure is selected, typing replaces it; opened
      // by a digit: the caret follows that digit
      onFocus={(e) => { if (selectAll) e.currentTarget.select(); else { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); } }}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
        const dir = navDir(e.key);
        if (!dir) return; // Tab is native: the next cell takes focus and the blur records
        e.preventDefault();
        if (!moveFocus(e.currentTarget, dir)) e.currentTarget.blur();
      }}
      className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface"
      aria-label={label}
    />
  );
}

export function MasterTrackerTable({
  rows,
  features = [],
  editableDepts = [],
  etas = {},
  etaWindowDays = 0,
  viewTabs,
}: {
  rows: MasterTrackerRow[];
  /** Completion forecast per MO (server-computed flow-shop ETA). */
  etas?: Record<string, RowEta>;
  etaWindowDays?: number;
  /** The tracker feature-permission keys this user holds (admin = all):
   *  tracker.status / tracker.components / tracker.qty / tracker.priority / tracker.push */
  features?: string[];
  /** Stage columns this user may record on (their OWN tracker permissions —
   *  separate from the worklist ones): Cut | Welding | Painting | Delivered. */
  editableDepts?: string[];
  /** The tab's view switcher (Tracker / Daily log). It rides in the filter bar
   *  rather than on a row of its own — this table is sized to fill the screen,
   *  and every pixel above it comes off the rows. */
  viewTabs?: React.ReactNode;
}) {
  const can = (k: string) => features.includes(k);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // the row's right-click menu — every row action in one place, so the next
  // one is an entry here rather than another button in the Status cell
  const rowMenu = useContextMenu<MenuTarget>();
  // inline stage-cell editor: one cell at a time (mo|item|dept)
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  // a refusal stays on ITS cell after the entry closed — the planner has
  // usually moved on to the next cell by the time the server answers
  const [cellErr, setCellErrState] = useState<{ key: string; msg: string } | null>(null);
  const setCellErr = (msg: string, key = editKey ?? "") => setCellErrState(msg ? { key, msg } : null);
  const errFor = (k: string) => (cellErr?.key === k ? cellErr.msg : "");
  // the cell whose entry is open: a commit fired for any other key is stale
  // (the entry was already recorded or dropped) and does nothing
  const openRef = useRef<string | null>(null);
  const selectRef = useRef(true); // opened by a click (select the figure) or by a digit
  function openCell(k: string, initial: string, selectAll: boolean) {
    openRef.current = k;
    selectRef.current = selectAll;
    setEditKey(k);
    setEditVal(initial);
    setCellErrState(null);
  }
  function closeCell(k: string) {
    if (openRef.current !== k) return false;
    openRef.current = null;
    setEditKey(null);
    return true;
  }
  // inline Required-qty editor (manual order-qty change, e.g. after a revision
  // lowered a quantity — the import never lowers it automatically)
  const [qtyEditMo, setQtyEditMo] = useState<string | null>(null);
  const [qtyVal, setQtyVal] = useState("");
  const [qtyErr, setQtyErr] = useState("");
  // The spec columns — Fins, Colour, CRC, SFM. No plan sheet carries them in a
  // form the import can trust, so all four are typed here and a re-import
  // never touches them. One cell at a time, keyed "mo|field".
  const [specEdit, setSpecEdit] = useState<string | null>(null);
  const [specVal, setSpecVal] = useState("");

  // the same three cells on a merged BOM row, where one value covers every MO
  function saveGroupSpec(bom: string, field: SpecField) {
    const fd = new FormData();
    fd.set("bom", bom);
    fd.set("field", field);
    fd.set("value", specVal);
    startTransition(async () => {
      const res = await setGroupOrderSpec(fd);
      if (res.ok) {
        setSpecEdit(null);
        router.refresh();
      } else setCellErr(res.error ?? "Failed", `g|${bom}|${field}`);
    });
  }

  function saveSpec(mo: string, field: SpecField) {
    const fd = new FormData();
    fd.set("mo", mo);
    fd.set("field", field);
    fd.set("value", specVal);
    startTransition(async () => {
      const res = await setOrderSpec(fd);
      if (res.ok) {
        setSpecEdit(null);
        router.refresh();
      } else setCellErr(res.error ?? "Failed", `${mo}|${field}`);
    });
  }

  function saveQty(mo: string) {
    const fd = new FormData();
    fd.set("mo", mo);
    fd.set("qty", qtyVal);
    setQtyErr("");
    startTransition(async () => {
      const res = await setOrderQty(fd);
      if (res.ok) {
        setQtyEditMo(null);
        router.refresh();
      } else {
        setQtyErr(res.error ?? "Failed");
      }
    });
  }
  // filters survive navigating away and back (sessionStorage per tab)
  const [q, setQ] = useSavedFilter("tracker.q");
  const [progress, setProgress] = useSavedFilter("tracker.progress");
  const [urgent, setUrgent] = useSavedFilter("tracker.urgent");
  const [status, setStatus] = useSavedFilter("tracker.status"); // lifecycle: every order shows unless the planner narrows it
  const [month, setMonth] = useSavedFilter("tracker.month"); // monthly plan (import source), "" = all months
  // stage scope: only the picked depts' columns per item (one or SEVERAL), and
  // the summary cards report the furthest picked stage — the wide table
  // becomes readable per department. Stored as a comma-separated list.
  const [stage, setStage] = useSavedFilter("tracker.deptStage"); // e.g. "" | "Cut" | "Cut,Welding"
  const stages = useMemo(() => {
    const sel = new Set(stage.split(",").filter(Boolean));
    return STAGE_OPTS.map((o) => o.value).filter((v) => sel.has(v)); // pipeline order, whatever the click order was
  }, [stage]);
  const scoped = stages.length > 0;
  const toggleStage = (v: string) => {
    const sel = new Set(stage.split(",").filter(Boolean));
    if (sel.has(v)) sel.delete(v);
    else sel.add(v);
    setStage(STAGE_OPTS.map((o) => o.value).filter((x) => sel.has(x)).join(","));
  };
  // the cards talk about ONE stage: the furthest (most downstream) picked one
  const cardStage = scoped ? stages[stages.length - 1] : "";
  const [openConfig, setOpenConfig] = useState<string | null>(null); // per-MO "required components" editor

  function saveExcluded(r: MasterTrackerRow, form: HTMLFormElement) {
    const fd = new FormData(form);
    // the six ticks, as ticked — the server turns them into the order's
    // overrides against the KVA/rating rule (forced on, or N/A)
    const required = fd.getAll("req").map(String);
    const out = new FormData();
    out.set("mo", r.mo);
    out.set("required", required.join(","));
    startTransition(async () => {
      const res = await setExcludedItems(out);
      if (res.ok) {
        setOpenConfig(null);
        router.refresh();
      } else {
        alert(res.error ?? "Failed");
      }
    });
  }

  const closedCount = useMemo(() => rows.filter((r) => r.status === "closed").length, [rows]);
  const holdCount = useMemo(() => rows.filter((r) => r.hold.onHold).length, [rows]);

  // Orders the customer has received in full. Closing them one at a time was
  // the only way, and a month's worth is a lot of clicking — this counts them
  // so the button can say how many, and the server recounts before it closes
  // anything (the page can be stale, filtered, or simply wrong).
  const doneCount = useMemo(
    () =>
      rows.filter((r) =>
        r.status === "open" &&
        isFullyDelivered(r.required, ITEMS.map((it) => ({ counts: r.items[it].eligible && !r.items[it].excluded, delivered: r.items[it].delivered })))
      ).length,
    [rows]
  );
  const [closeMsg, setCloseMsg] = useState("");
  function closeDone() {
    if (!confirm(`Close ${doneCount} order(s) the customer has received in full?\n\nClosing is a display state — the logs are untouched, and a closed order can be reopened from the Closed filter.`)) return;
    setCloseMsg("");
    startTransition(async () => {
      const res = await closeDeliveredOrders();
      if (res.ok) {
        setCloseMsg(res.closed === 0 ? "Nothing to close — no open order is fully delivered." : `${res.closed} order(s) closed.`);
        router.refresh();
      } else setCloseMsg(res.error ?? "Failed");
    });
  }

  // the monthly plans present in the registry, newest first ("July 2026" labels)
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthKey = (label: string) => {
    const m = /^(\w+)\s+(\d{4})$/.exec(label.trim());
    const idx = m ? MONTH_NAMES.indexOf(m[1]) : -1;
    return m && idx >= 0 ? Number(m[2]) * 12 + idx : -1; // unparseable labels sort last
  };
  const months = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const m of r.months) seen.add(m);
    return [...seen].sort((a, b) => monthKey(b) - monthKey(a));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasNoMonth = useMemo(() => rows.some((r) => r.months.length === 0), [rows]);

  // month scope — an order carried across plans belongs to EVERY month it
  // appeared in. The summary cards follow THIS filter (each month's plan
  // progress on its own), while search/progress/urgent only narrow the table
  const monthRows = useMemo(
    () => (month ? rows.filter((r) => (month === "—" ? r.months.length === 0 : r.months.includes(month))) : rows),
    [rows, month]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return monthRows.filter((r) => {
      if (status === "hold") { if (!r.hold.onHold) return false; }
      else if (status && r.status !== status) return false;
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.customer ?? ""} ${r.kva ?? ""}`.toUpperCase().includes(needle))) return false;
      if (progress && progressOf(r) !== progress) return false;
      if (urgent === "yes" && !r.urgent) return false;
      return true;
    });
  }, [monthRows, q, progress, urgent, status]);

  const hasActive = !!(q || progress || urgent || month || scoped || status);

  // table shape under the stage filter: only the picked columns per item, no
  // Complete/Left/Achv
  // +1 for Status, +1 for the ETA forecast column
  // MO, SOI, BOM, KVA, Required lead the row before the per-item stage columns
  // MO · SOI · Customer · BOM · KVA · Fins · Color · CRC · SFM · Required, then the items
  const tableCols = scoped ? 10 + ITEMS.length * stages.length + 2 : 10 + ITEMS.length * 4 + 5;

  // shared BOMs: one summary row per BOM, expandable to its MOs
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (gk: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(gk)) n.delete(gk);
      else n.add(gk);
      return n;
    });
  const groups = useMemo(() => {
    const map = new Map<string, MasterTrackerRow[]>();
    for (const r of filtered) {
      if (!map.has(r.bom)) map.set(r.bom, []);
      map.get(r.bom)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  // 🔁 months editor: fix a wrongly-tagged plan month (admin)
  const [openMonths, setOpenMonths] = useState<string | null>(null);

  function dropMonth(r: MasterTrackerRow, m: string) {
    if (!confirm(`Remove "${m}" from ${r.mo}? It will stop showing under that month's filter.`)) return;
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("month", m);
    startTransition(async () => {
      const res = await removeOrderMonth(fd);
      if (res.ok) {
        setOpenMonths(null);
        router.refresh();
      } else {
        alert(res.error ?? "Failed");
      }
    });
  }

  // ⭐ priority toggle — the order shows in the priority table on every worklist
  function togglePriority(r: MasterTrackerRow) {
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("priority", String(!r.priority));
    startTransition(async () => {
      const res = await setOrderPriority(fd);
      if (res.ok) router.refresh();
      else alert(res.error ?? "Failed");
    });
  }

  // 📤 send-to-worklist panel: one MO at a time, dept + qty per item
  const [openPush, setOpenPush] = useState<string | null>(null);
  const [pushDept, setPushDept] = useState<Dept>("Cut");
  const [pushQty, setPushQty] = useState<Record<string, string>>({}); // item -> qty
  const [pushErr, setPushErr] = useState("");

  // what each dept still owes on an item — the push panel's ceiling
  function remainingFor(r: MasterTrackerRow, it: Item, dept: Dept): number {
    const c = r.items[it];
    if (!c.eligible || c.excluded) return 0; // AR/MB the order doesn't need, or N/A
    if (dept === "Painting" && isPaintExempt(it)) return 0; // the core is never painted
    const need = Math.max(0, r.required - c.osp);
    const done = dept === "Cut" ? c.cut : dept === "Welding" ? c.weld : c.paint;
    return Math.max(0, need - done);
  }

  function openPushPanel(r: MasterTrackerRow) {
    setOpenPush(openPush === r.mo ? null : r.mo);
    setPushDept("Cut");
    setPushQty(Object.fromEntries(ITEMS.map((it) => [it, String(remainingFor(r, it, "Cut"))])));
    setPushErr("");
  }

  function submitPush(r: MasterTrackerRow) {
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("dept", pushDept);
    for (const it of ITEMS) fd.set(`qty${it}`, pushQty[it] ?? "");
    setPushErr("");
    startTransition(async () => {
      const res = await pushOrderToWorklist(fd);
      if (res.ok) {
        setOpenPush(null);
        router.refresh();
      } else {
        setPushErr(res.error ?? "Failed");
      }
    });
  }

  // ⏸️ hold / release — from the row's menu. A held order stays here, tinted,
  // and leaves every worklist queue and the ETA until released.
  function setHold(mos: string[], hold: boolean, note = "") {
    const fd = new FormData();
    fd.set("mos", mos.join(","));
    fd.set("hold", String(hold));
    fd.set("note", note);
    startTransition(async () => {
      const res = await setOrderHold(fd);
      if (res.ok) router.refresh();
      else alert(res.error ?? "Failed");
    });
  }

  /** What the right-click menu offers for a row: the MO's actions, or the
   *  whole merged BOM's. Permissions decide which entries appear. */
  function menuEntries(t: MenuTarget): MenuEntry[] {
    if (t.kind === "group") {
      const open = t.members.filter((m) => m.status === "open");
      const held = open.filter((m) => m.hold.onHold);
      const free = open.filter((m) => !m.hold.onHold);
      const e: MenuEntry[] = [{ heading: `${t.bom} — ${t.members.length} MOs` }];
      if (can("tracker.status")) {
        e.push(
          { key: "hold", icon: "⏸️", label: `Put ${free.length} open MO${free.length === 1 ? "" : "s"} on hold`, disabled: free.length === 0, hint: "Pauses every open MO of this BOM: they stay here, tinted, and leave every worklist queue", prompt: { placeholder: "Reason (optional) — e.g. waiting for CRC", submit: "Hold", onSubmit: (note) => setHold(free.map((m) => m.mo), true, note) } },
          { key: "release", icon: "▶", label: `Release ${held.length} from hold`, disabled: held.length === 0, onSelect: () => setHold(held.map((m) => m.mo), false) },
          { sep: true }
        );
      }
      e.push({ key: "trace", icon: "🔍", label: "Open trace for this BOM", href: `/trace?bom=${encodeURIComponent(t.bom)}` });
      return e;
    }
    const r = t.row;
    const closed = r.status === "closed";
    const done = r.required > 0 && r.complete >= r.required;
    const e: MenuEntry[] = [{ heading: r.mo }];
    if (can("tracker.status")) {
      if (r.hold.onHold) e.push({ key: "release", icon: "▶", label: "Release hold", hint: holdLabel(r.hold), onSelect: () => setHold([r.mo], false) });
      else e.push({ key: "hold", icon: "⏸️", label: "Put on hold", disabled: closed, hint: closed ? "A closed order cannot be held — reopen it first" : "Pauses the order: it stays here, tinted, and leaves every worklist queue and the ETA", prompt: { placeholder: "Reason (optional) — e.g. waiting for CRC", submit: "Hold", onSubmit: (note) => setHold([r.mo], true, note) } });
    }
    if (can("tracker.priority") && !closed) e.push({ key: "prio", icon: "⭐", label: r.priority ? "Remove priority flag" : "Flag as priority", hint: "A priority order shows in the dedicated table on top of every dept worklist", onSelect: () => togglePriority(r) });
    if (can("tracker.push") && !closed) e.push({ key: "push", icon: "📤", label: "Send to a worklist", hint: "Pick the dept, items and quantities", onSelect: () => openPushPanel(r) });
    if (can("tracker.components")) e.push({ key: "comp", icon: "⚙", label: "Required components", hint: "Which components this project actually needs", onSelect: () => setOpenConfig(openConfig === r.mo ? null : r.mo) });
    if (can("tracker.status")) {
      e.push({ sep: true });
      if (closed) e.push({ key: "reopen", icon: "↩", label: "Reopen order", onSelect: () => changeStatus(r.mo, "open") });
      else e.push({ key: "close", icon: "✓", label: "Close order", disabled: !done, hint: done ? "It leaves the daily screens; reopen any time" : "Only an order the customer has received in full can close", onSelect: () => changeStatus(r.mo, "closed") });
    }
    e.push({ sep: true }, { key: "trace", icon: "🔍", label: "Open trace", href: `/trace?mo=${encodeURIComponent(r.mo)}` });
    return e;
  }

  function changeStatus(mo: string, next: "open" | "closed") {
    if (next === "closed" && !confirm(`Close order ${mo}? It will drop out of the daily screens (you can reopen it any time).`)) return;
    const fd = new FormData();
    fd.set("mo", mo);
    fd.set("status", next);
    startTransition(async () => {
      await setOrderStatus(fd);
      router.refresh();
    });
  }

  // per-component plan progress — follows the MONTH filter (each month's plan
  // progress on its own; all months when no month is picked):
  // need = required − OSP (excluded items don't count). Done = the FINAL stage
  // by default, or the FILTERED stage when a dept is picked — cards and table
  // always talk about the same stage.
  const itemStats = ITEMS.map((it) => {
    // final stage = SHOT BLAST for the paint-exempt core (CF), Painting otherwise
    const finalIsShp = isPaintExempt(it);
    const doneOf = (c: MasterTrackerRow["items"][Item]) => {
      switch (cardStage) {
        case "Cut": return c.cut;
        case "Welding": return c.weld;
        case "Painting": return finalIsShp ? c.shp : c.paint;
        case "Delivered": return c.delivered;
        default: return finalIsShp ? c.shp : c.paint;
      }
    };
    const doneWord =
      cardStage === "Cut" ? "fabricated"
      : cardStage === "Welding" ? "welded"
      : cardStage === "Delivered" ? "delivered"
      : finalIsShp ? "shot blasted" : "painted";
    let need = 0;
    let done = 0;
    for (const r of monthRows) {
      const c = r.items[it];
      if (!c.eligible || c.excluded) continue; // AR/MB only count on orders that need them
      const n = Math.max(0, r.required - c.osp);
      need += n;
      done += Math.min(doneOf(c), n);
    }
    return { it, doneWord, need, done, remaining: Math.max(0, need - done), pct: need > 0 ? done / need : null };
  });

  // The export mirrors the CURRENT view: the rows already follow the search /
  // month / status / progress / urgent filters, and the columns now follow the
  // Dept (stage) filter too — only the picked stages per component, and the
  // summary columns (Welded / Complete / Left / Achievement) only in the full,
  // unfiltered view (the table hides them under a stage filter).
  const exportStages = scoped ? stages : ["Cut", "Welding", "Painting", "Delivered"];
  const stageColLabel = (s: string, it: Item) =>
    s === "Cut" ? "Fab" : s === "Welding" ? "Weld" : s === "Delivered" ? "Dlvd" : isPaintExempt(it) ? "SHB" : "Paint";
  const stageColValue = (c: MasterTrackerRow["items"][Item], s: string, it: Item) =>
    s === "Cut" ? c.cut : s === "Welding" ? c.weld : s === "Delivered" ? c.delivered : isPaintExempt(it) ? c.shp : c.paint;

  const exportRows = filtered.map((r) => {
    const row: Record<string, string | number> = {
      MO: r.mo,
      BOM: r.bom,
      "Plan months": r.months.join(", "),
      SOI: r.soi ?? "",
      Customer: r.customer ?? "",
      Urgent: r.urgent ? "Yes" : "",
      KVA: r.kva ?? "",
      "Color RAL": r.colorRal ?? "",
      "CRC Size": r.crcSize ?? "",
      SFM: r.sfm ?? "",
      Required: r.required,
      "On hold": r.hold.onHold ? holdLabel(r.hold) : "",
      Fins: r.fins ?? "",
    };
    for (const it of ITEMS) {
      const c = r.items[it];
      for (const s of exportStages) {
        // N/A components (rule or manual) export blank, like the table's dashes
        row[`${it} ${stageColLabel(s, it)}`] = !c.eligible || c.excluded ? "" : stageColValue(c, s, it);
      }
    }
    row.OSP = ITEMS.filter((it) => r.items[it].osp > 0).map((it) => `${it}×${r.items[it].osp}`).join(" ");
    if (!scoped) {
      row.Welded = r.welded;
      row["Complete (painted)"] = r.complete;
      row.Left = r.remaining;
      row["Achievement %"] = r.achievement === null ? "" : Math.round(r.achievement * 100);
    }
    row.Status = r.status;
    return row;
  });
  // filename hints at the active stage scope, so exports don't get confused
  const exportName = `plan-tracker${scoped ? "-" + stages.join("-").toLowerCase() : ""}.xlsx`;

  // the printed sheet is very wide unfiltered (six components × four stages);
  // it only fits A4 landscape at the tighter `print-tight` step. A dept-scoped
  // view has far fewer columns and keeps the roomier size.
  const stageCols = ITEMS.length * (scoped ? stages.length : 4);

  return (
    // On desktop the page fills the viewport below the nav so the cards +
    // filters stay put and ONLY the table scrolls (with its header pinned).
    // `print-flow` hands the height back to the paper: a fixed-height scroller
    // would print one page and clip everything under it.
    <div className="print-flow md:flex md:flex-col md:h-[calc(100vh-7rem)]">
      {/* a plan import brought a different qty for these orders — waiting on the planner */}
      <PendingQtyBanner rows={rows} />
      {/* what the sheet is showing — filters don't survive onto paper otherwise */}
      <PrintScope
        parts={[
          scoped && `Departments: ${STAGE_OPTS.filter((o) => stages.includes(o.value)).map((o) => o.label).join(", ")}`,
          !!month && `Plan month: ${month}`,
          `Status: ${status === "closed" ? "Closed" : status === "open" ? "Open" : "All"}`,
          !!progress && `Progress: ${progress === "complete" ? "Complete" : progress === "inprogress" ? "In progress" : "Not started"}`,
          urgent === "yes" && "Urgent only",
          !!q && `Search: "${q}"`,
          `${filtered.length} of ${rows.length} rows`,
        ]}
      />

      {/* per-component plan progress — remaining / of total / execution % (display only) */}
      <div className="print-keep flex flex-wrap justify-center gap-2 mb-3">
        {itemStats.map(({ it, doneWord, need, done }) => (
          <RingCard key={it} label={it} note={doneWord} done={done} need={need} />
        ))}
      </div>

      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setProgress(""); setUrgent(""); setStatus(""); setMonth(""); setStage(""); }} hasActive={hasActive}>
        {viewTabs}
        <PlanViewToggle value="monthly" />
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / Customer / KVA…" />
        <SelectFilter
          label="Plan month"
          value={month}
          onChange={setMonth}
          options={[
            ...months.map((m) => ({ value: m, label: m })),
            ...(hasNoMonth ? [{ value: "—", label: "No month" }] : []),
          ]}
        />
        {/* multi-pick dept toggle: show only the ticked stages' columns */}
        <div className="col-span-2 flex min-w-0 flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-1.5">
          <span className="text-muted text-[10px] sm:text-[11px] font-bold uppercase tracking-wide">Dept</span>
          <div className="flex flex-wrap gap-1">
            {STAGE_OPTS.map((o) => {
              const on = stages.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggleStage(o.value)}
                  className={`rounded-md border px-2 py-1 text-xs font-bold transition-colors ${on ? "bg-brand text-white border-brand" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
                  title={`${o.label} — pick one or more departments; the table and the cards scope to them`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        <SelectFilter
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: `Closed (${closedCount})` },
            { value: "hold", label: `On hold (${holdCount})` },
          ]}
        />
        {can("tracker.status") && doneCount > 0 && (
          <button type="button" className="btn btn-sm btn-secondary normal-case" onClick={closeDone} disabled={pending} title="Close every open order whose components have all reached the customer — the ones with nothing left to follow">
            ✓ Close {doneCount} delivered
          </button>
        )}
        {closeMsg && <span className="text-xs font-semibold text-ok-fg">{closeMsg}</span>}
        <SelectFilter
          label="Progress"
          value={progress}
          onChange={setProgress}
          options={[
            { value: "complete", label: "Complete (100%)" },
            { value: "inprogress", label: "In progress" },
            { value: "notstarted", label: "Not started" },
          ]}
        />
        <SelectFilter label="Urgent" value={urgent} onChange={setUrgent} options={[{ value: "yes", label: "Urgent only" }]} />
        <ExportButton rows={exportRows} filename={exportName} sheetName="Tracker" />
        <PrintButton />
      </FilterBar>

      <div className={`print-flow print-fit print-tracker ${stageCols > 12 ? "print-tight" : ""} bg-surface border rounded-xl overflow-auto md:flex-1 md:min-h-0`}>
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-brand text-white">
              <th rowSpan={2} className="p-2 text-left">MO</th>
              <th rowSpan={2} className="p-2 text-left" title="Sales order item">SOI</th>
              <th rowSpan={2} className="p-2 text-left" title="The plan sheet's customer column">Customer</th>
              <th rowSpan={2} className="p-2 text-left">BOM</th>
              <th rowSpan={2} className="p-2">KVA</th>
              <th rowSpan={2} className="p-2" title="Colour RAL — typed here; the import never writes it">Color</th>
              <th rowSpan={2} className="p-2" title="CRC size — typed here; the import never writes it">CRC</th>
              <th rowSpan={2} className="p-2" title="SFM — typed here; the import never writes it">SFM</th>
              <th rowSpan={2} className="p-2">Required</th>
              {/* Fins belongs with the components, not with the specs: it is
                  welded onto the tank like the rest, so it reads immediately
                  before the Core Frame. Typed here, never imported. */}
              <th rowSpan={2} className="p-2" style={FINS_HEAD} title="Fins — typed here; the import never writes it">Fins</th>
              {ITEMS.map((it) => (
                <th key={it} colSpan={scoped ? stages.length : 4} className="p-2 border-r border-border-strong">{it}</th>
              ))}
              {!scoped && (
                <>
                  <th rowSpan={2} className="p-2 border-r border-border-strong">Complete</th>
                  <th rowSpan={2} className="p-2">Left</th>
                  <th rowSpan={2} className="p-2">Achv.</th>
                </>
              )}
              <th
                rowSpan={2}
                className="p-2"
                title={`Forecast completion date: the order's remaining work through Fabrication → Welding → Finishing at the plant's actual pace over the last ${etaWindowDays || 14} working days, queued by delivery date. Red = lands after the scheduled delivery.`}
              >
                ETA
              </th>
              <th rowSpan={2} className="p-2 no-print">Status</th>
            </tr>
            <tr className="bg-brand text-white text-xs">
              {ITEMS.map((it) =>
                scoped ? (
                  <Fragment key={it}>
                    {stages.map((s, si) => (
                      <StageHead key={s} tint={ITEM_TINT[it]} shp={isPaintExempt(it)} only={s} borderR={si === stages.length - 1} />
                    ))}
                  </Fragment>
                ) : (
                  <StageHead key={it} tint={ITEM_TINT[it]} shp={isPaintExempt(it)} />
                )
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={tableCols} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No orders yet — import a monthly plan." : "No rows match the filters."}
              </td></tr>
            )}
            {groups.map(([gBom, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gBom);
              const sum = (f: (r: MasterTrackerRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const gReq = sum((r) => r.required);
              const gComplete = sum((r) => r.complete);
              const gLeft = sum((r) => r.remaining);
              const gAch = gReq > 0 ? gComplete / gReq : null;
              const urgentCount = members.filter((m) => m.urgent).length;
              const gKva = members.find((m) => m.kva)?.kva ?? "—";
              const heldCount = members.filter((m) => m.hold.onHold).length;
              const allHeld = heldCount === members.length;
              // one customer reads as itself; a BOM shared by two reads "…" until the group is opened
              const gCustomer = agreedSpec(members.map((m) => m.customer));
              return (
                <Fragment key={`g|${gBom}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(gBom)}
                    onContextMenu={(e) => rowMenu.open(e, { kind: "group", bom: gBom, members })}
                    style={allHeld ? { background: HOLD_TINT } : undefined}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM · right-click for actions"}
                  >
                    <td className="p-2 font-bold whitespace-nowrap text-xs">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {members.length} MOs
                      {urgentCount > 0 && <span className="pill pill-bad ml-1">U×{urgentCount}</span>}
                      {heldCount > 0 && <span className="pill pill-warn ml-1" title={allHeld ? "Every MO of this BOM is on hold" : `${heldCount} of ${members.length} MOs on hold — open the group`}>⏸️ {allHeld ? "HOLD" : `${heldCount}/${members.length}`}</span>}
                    </td>
                    {/* the group names its MOs by count, not by list — its SOIs
                        read the same way: each one sits on its own MO row, which
                        expanding the group reveals. A joined strip of a dozen
                        SOIs here was unreadable and said nothing the rows
                        below do not. */}
                    <td className="p-2 whitespace-nowrap">
                      <Soi soi={null} />
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap" title={gCustomer === null ? `${members.length} MOs for more than one customer — open the group` : undefined}>
                      {gCustomer === null ? <span className="text-muted">…</span> : gCustomer || <span className="text-muted">—</span>}
                    </td>
                    <td className="p-2 font-bold whitespace-nowrap">
                      <Link href={`/trace?bom=${encodeURIComponent(gBom)}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">{gBom}</Link>
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap text-muted text-center">{gKva}</td>
                    {groupSpecCell(gBom, members, "colorRal")}
                    {groupSpecCell(gBom, members, "crcSize")}
                    {groupSpecCell(gBom, members, "sfm")}
                    <td className="p-2 text-center font-bold"><Num v={gReq} /></td>
                    {groupFinsCell(gBom, members)}
                    {ITEMS.map((it) =>
                      scoped ? (
                        <Fragment key={it}>
                          {stages.map((s, si) => (
                            <Fragment key={s}>{groupCell(gBom, members, it, s, si === stages.length - 1)}</Fragment>
                          ))}
                        </Fragment>
                      ) : (
                        <Fragment key={it}>
                          {groupCell(gBom, members, it, "Cut", false)}
                          {groupCell(gBom, members, it, "Welding", false)}
                          {groupCell(gBom, members, it, "Painting", false)}
                          {groupCell(gBom, members, it, "Delivered", true)}
                        </Fragment>
                      )
                    )}
                    {!scoped && (
                      <>
                        <td className="p-2 text-center font-extrabold border-r"><Num v={gComplete} /></td>
                        <td className="p-2 text-center font-bold" style={{ color: gLeft > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                          <Num v={gLeft} />
                        </td>
                        <td className="p-2 text-center font-bold tabnum" style={pctStyle(gAch)}>
                          {gAch === null ? "—" : `${(gAch * 100).toFixed(0)}%`}
                        </td>
                      </>
                    )}
                    {etaCell(groupEta(members), members.every((m) => m.hold.onHold))}
                    <td className="p-2 text-center no-print text-xs text-muted whitespace-nowrap">
                      {open ? "▲ collapse" : "▼ open MOs"}
                      <button type="button" onClick={(e) => { e.stopPropagation(); rowMenu.open(e, { kind: "group", bom: gBom, members }); }} className="text-muted px-1.5 hover:text-accent font-bold" title="Actions for the whole BOM (or right-click the row)">⋯</button>
                    </td>
                  </tr>
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rowMenu.menu && <ContextMenu x={rowMenu.menu.x} y={rowMenu.menu.y} entries={menuEntries(rowMenu.menu.payload)} onClose={rowMenu.close} />}
    </div>
  );

  /** One spec cell on an MO row: click the value to type a new one. Free text
   *  — a spec is a size on some orders and a dash on others, and the dashes he
   *  types are worth keeping as typed. */
  function specCell(r: MasterTrackerRow, field: SpecField) {
    const key = `${r.mo}|${field}`;
    const val = r[field];
    const tinted = field === "fins";
    return (
      <td key={field} className="p-2 text-xs whitespace-nowrap text-center" style={tinted ? FINS_CELL : undefined}>
        {specEdit === key ? (
          <input
            value={specVal}
            autoFocus
            onChange={(e) => setSpecVal(e.target.value)}
            onBlur={() => saveSpec(r.mo, field)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveSpec(r.mo, field);
              if (e.key === "Escape") setSpecEdit(null);
            }}
            className="w-20 border rounded-md px-1 py-0.5 text-center bg-surface"
            disabled={pending}
            aria-label={`${SPEC_TITLE[field].split(" —")[0]} for ${r.mo}`}
          />
        ) : can("tracker.qty") ? (
          <button
            type="button"
            className={`w-full ${val ? "font-semibold" : tinted ? "opacity-60" : "text-muted"}`}
            title={SPEC_TITLE[field]}
            onClick={() => { setSpecEdit(key); setSpecVal(val ?? ""); }}
          >
            {val || "—"}
          </button>
        ) : (
          <span className={val ? "font-semibold" : tinted ? "opacity-60" : "text-muted"}>{val || "—"}</span>
        )}
      </td>
    );
  }

  /** The same spec cell on a MERGED BOM row. The value there stands for the
   *  whole group, so typing it writes it to EVERY MO underneath — the planner
   *  sets a BOM's colour once, not once per MO. A group whose MOs disagree
   *  reads "…" until he types a value, which then makes them agree. */
  function groupSpecCell(gBom: string, members: MasterTrackerRow[], field: SpecField) {
    const key = `g|${gBom}|${field}`;
    const val = agreedSpec(members.map((m) => m[field]));
    const label = SPEC_TITLE[field].split(" —")[0];
    const shown = val === null ? "…" : val || "—";
    const note = `${label} — typing it here sets the SAME value on all ${members.length} MOs of ${gBom}`;
    return (
      <td key={field} className="p-2 text-xs whitespace-nowrap text-center" onClick={(e) => e.stopPropagation()}>
        {specEdit === key ? (
          <input
            value={specVal}
            autoFocus
            onChange={(e) => setSpecVal(e.target.value)}
            onBlur={() => saveGroupSpec(gBom, field)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveGroupSpec(gBom, field);
              if (e.key === "Escape") setSpecEdit(null);
            }}
            className="w-20 border rounded-md px-1 py-0.5 text-center bg-surface"
            disabled={pending}
            aria-label={`${label} for every MO of ${gBom}`}
          />
        ) : can("tracker.qty") ? (
          <button
            type="button"
            className={`w-full ${val ? "font-semibold" : "text-muted"}`}
            title={note}
            onClick={() => { setCellErr(""); setSpecEdit(key); setSpecVal(val ?? ""); }}
          >
            {shown}
          </button>
        ) : (
          <span className={val ? "font-semibold" : "text-muted"}>{shown}</span>
        )}
      </td>
    );
  }

  /** Fins on a merged row is a COUNT, not a shared spec: its figure is the sum
   *  of the MOs under it, the way every other number on this row is. It only
   *  adds up while each MO's Fins reads as a number — the column is free text,
   *  and a group holding "2 rows" beside "3" would sum to nonsense, so that
   *  one falls back to the agreed-value reading instead. */
  function groupFinsCell(gBom: string, members: MasterTrackerRow[]) {
    const group = finsGroup(members.map((m) => ({ mo: m.mo, required: m.required, fins: m.fins })));
    const k = `g|${gBom}|fins`;
    const editing = editKey === k;
    const editable = group !== null && can("tracker.qty");
    const added = editing && group ? Number(editVal) - group.current : 0;
    const tanks = members.reduce((s, m) => s + m.required, 0);
    const cellErr = errFor(k);

    function save() {
      const fd = new FormData();
      fd.set("bom", gBom);
      fd.set("total", editVal);
      fd.set("mos", members.map((m) => m.mo).join(","));
      setCellErr("");
      startTransition(async () => {
        const res = await setGroupFins(fd);
        if (res.ok) {
          setEditKey(null);
          router.refresh();
        } else setCellErr(res.error ?? "Failed", k);
      });
    }

    return (
      <td className="p-2 text-xs whitespace-nowrap text-center font-semibold tabnum" style={FINS_CELL} onClick={(e) => e.stopPropagation()}>
        {editing && group ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={tanks}
                value={editVal}
                autoFocus
                onChange={(e) => { setEditVal(e.target.value); setCellErr(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") setEditKey(null);
                }}
                className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface text-foreground"
                disabled={pending}
              />
              <button type="button" onClick={save} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title={`Save — spread over the ${members.length} MOs in order`}>✓</button>
              <button type="button" onClick={() => setEditKey(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">✕</button>
            </span>
            {/* which MOs the number lands on, before it is saved — the same
                rule the server writes with */}
            {added !== 0 && !cellErr && (
              <span className={`text-[10px] font-bold whitespace-nowrap ${added > 0 ? "text-ok-fg" : "text-bad-fg"}`}>
                {spreadWords(spreadOverGroup(group.members, added)) || (added > 0 ? `+${added}` : `−${-added}`)}
              </span>
            )}
            {cellErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 text-start leading-tight font-normal">{cellErr}</span>}
          </span>
        ) : editable ? (
          <button
            type="button"
            onClick={() => { setEditKey(k); setEditVal(String(group!.current)); setCellErr(""); }}
            disabled={pending}
            className="print-as-text w-full min-w-8 rounded px-1 py-0.5 tabnum hover:ring-2 hover:ring-brand/60 transition-all cursor-text"
            title={`Fins on the WHOLE BOM — how many of its ${tanks} tanks carry fins. Type the group's figure: it fills each MO to its own quantity before the next, and a reduction comes off the last MOs first.`}
          >
            {group!.current > 0 ? group!.current.toLocaleString() : <span className="opacity-60">—</span>}
          </button>
        ) : group ? (
          group.current > 0 ? group.current.toLocaleString() : <span className="opacity-60">—</span>
        ) : (
          <span title="One of these MOs has Fins written as text — expand the group and set them one at a time">
            {agreedSpec(members.map((m) => m.fins)) || "…"}
          </span>
        )}
      </td>
    );
  }

  /** One stage cell on a single-MO row. For depts the user can edit, clicking
   *  the number opens an inline editor: type the NEW cumulative total, the
   *  difference is recorded in the Daily Log dated today (and flows to the
   *  dept's worklist). A LOWER total records a NEGATIVE correction entry —
   *  the chain guard (painted ≤ welded ≤ cut ≤ order) blocks contradictions. */
  function stageCell(r: MasterTrackerRow, it: Item, dept: string, value: number, tint: string, borderR = false) {
    const k = `${r.mo}|${it}|${dept}`;
    const col = `${it}|${dept}`;
    const editing = editKey === k;
    const editable = editableDepts.includes(dept);
    const added = editing && editVal !== "" ? Number(editVal) - value : 0;
    const err = errFor(k);

    // leaving the cell records it: an unchanged or emptied figure just closes
    function commit() {
      const typed = editVal;
      if (!closeCell(k)) return;
      if (typed === "" || Number(typed) === value) return;
      const fd = new FormData();
      fd.set("dept", dept);
      fd.set("bom", r.bom);
      fd.set("mo", r.mo);
      fd.set("item", it);
      fd.set("total", typed);
      startTransition(async () => {
        const res = await recordTrackerTotal(fd);
        if (res.ok) router.refresh();
        else setCellErr(res.error ?? "Failed", k);
      });
    }

    return (
      <td className={`p-1 text-center tabnum ${borderR ? "border-r border-border-strong" : ""}`} style={{ background: tint }}>
        {editing ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <CellInput
              col={col}
              value={editVal}
              selectAll={selectRef.current}
              label={`${deptLabel(dept)} ${it} total for ${r.mo}`}
              onChange={(v) => { setEditVal(v); setCellErrState(null); }}
              onCommit={commit}
              onCancel={() => closeCell(k)}
            />
            {added > 0 && <span className="text-[10px] font-bold text-ok-fg whitespace-nowrap">+{added} today</span>}
            {added < 0 && (
              <span className="text-[10px] font-bold text-bad-fg whitespace-nowrap" title="Recorded as a negative correction entry in today's Daily Log">
                −{-added} correction
              </span>
            )}
            {/* the editor itself never prints — the sheet still shows the
                figure on record, not a blank cell mid-edit */}
            <span className="print-only tabnum">{value}</span>
          </span>
        ) : editable ? (
          <span className="relative inline-flex flex-col items-center gap-0.5 w-full">
            <button
              type="button"
              data-nav={col}
              onClick={() => openCell(k, String(value), true)}
              onKeyDown={(e) => cellKeys(e, (d) => openCell(k, d, false))}
              // print-as-text: the figure IS the cell — print CSS blanks buttons
              // inside tables, which would empty every editable stage cell
              className={`print-as-text w-full min-w-8 rounded px-1 py-1 tabnum hover:ring-2 hover:ring-brand/60 hover:font-bold focus:ring-2 focus:ring-brand focus:outline-none transition-all cursor-text ${err ? "ring-2 ring-bad-fg" : ""}`}
              title={`${deptLabel(dept)} · ${r.mo} · ${it} — type the NEW total (a lower one records a correction in today's Daily Log); arrows move, Escape drops it`}
            >
              {value}
            </button>
            {err && <span className="no-print absolute top-full start-1/2 -translate-x-1/2 mt-0.5 z-20 whitespace-nowrap rounded-md bg-surface border border-bad-fg px-1.5 py-0.5 text-[10px] font-semibold text-bad-fg shadow-md">{err}</span>}
          </span>
        ) : (
          value
        )}
      </td>
    );
  }

/** The spread a group-row edit will make, in words — the same rule the server
 *  records with, read off the rows already on screen. Empty when nothing of
 *  the quantity fits, which is the server's refusal shown early. */
function spreadPreview(members: MasterTrackerRow[], it: Item, dept: string, delta: number): string {
  const usable = members.filter((m) => m.items[it].eligible && !m.items[it].excluded);
  const spread = spreadOverGroup(
    usable.map((m) => {
      const c = m.items[it];
      const caps = capsFor(
        { required: m.required, cut: c.cut, weld: c.weld, paint: c.paint, shp: c.shp, delivered: c.delivered, osp: c.osp, eligible: true, paintExempt: isPaintExempt(it) },
        dept
      );
      return { mo: m.mo, capAdd: caps.add, capSub: caps.sub };
    }),
    delta
  );
  return spreadWords(spread);
}

  /** One stage cell on a BOM GROUP row: shows the members' sum, and (with the
   *  stage's tracker permission) records directly on the whole BOM — type the
   *  NEW group total and the difference is DISTRIBUTED over the member MOs in
   *  the order shown: each absorbs up to its chain headroom, the rest flows
   *  to the next; corrections come back off the last MOs first. */
  function groupCell(gBom: string, members: MasterTrackerRow[], it: Item, stage: string, borderR: boolean) {
    // the core's Painting column is its SHOT BLAST — same as the MO rows
    const dept = stage === "Painting" && isPaintExempt(it) ? "ShotBlast" : stage;
    const [value, itemTint] =
      dept === "Cut" ? [members.reduce((s, r) => s + r.items[it].cut, 0), ITEM_TINT[it]]
      : dept === "Welding" ? [members.reduce((s, r) => s + r.items[it].weld, 0), ITEM_TINT[it]]
      : dept === "ShotBlast" ? [members.reduce((s, r) => s + r.items[it].shp, 0), ITEM_TINT[it]]
      : dept === "Delivered" ? [members.reduce((s, r) => s + r.items[it].delivered, 0), ITEM_TINT[it]]
      : [members.reduce((s, r) => s + r.items[it].paint, 0), ITEM_TINT[it]];
    const tint = members.every((m) => m.hold.onHold) ? HOLD_TINT : itemTint;
    const eligibleMos = members.filter((m) => m.items[it].eligible && !m.items[it].excluded).map((m) => m.mo);
    const k = `g|${gBom}|${it}|${dept}`;
    const col = `${it}|${dept}`;
    const editing = editKey === k;
    const editable = editableDepts.includes(dept) && eligibleMos.length > 0;
    const added = editing && editVal !== "" ? Number(editVal) - value : 0;
    const err = errFor(k);

    function commit() {
      const typed = editVal;
      if (!closeCell(k)) return;
      if (typed === "" || Number(typed) === value) return;
      const fd = new FormData();
      fd.set("source", "tracker");
      fd.set("dept", dept);
      fd.set("bom", gBom);
      fd.set("item", it);
      fd.set("total", typed);
      fd.set("mos", eligibleMos.join(","));
      startTransition(async () => {
        const res = await recordGroupOutput(fd);
        if (res.ok) router.refresh();
        else setCellErr(res.error ?? "Failed", k);
      });
    }

    return (
      <td className={`p-1 text-center tabnum ${borderR ? "border-r border-border-strong" : ""}`} style={{ background: tint }} onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <CellInput
              col={col}
              value={editVal}
              selectAll={selectRef.current}
              label={`${deptLabel(dept)} ${it} total for every MO of ${gBom}`}
              onChange={(v) => { setEditVal(v); setCellErrState(null); }}
              onCommit={commit}
              onCancel={() => closeCell(k)}
            />
            {/* What the number will actually do, before it is saved. The
                planner's question about a merged row is always "which MO does
                this land on" — so it says so, in fill order. The rule is the
                same function the server records with; the server still decides
                and refuses anything that does not fit. */}
            {added !== 0 && (
              <span className={`text-[10px] font-bold whitespace-nowrap ${added > 0 ? "text-ok-fg" : "text-bad-fg"}`} title={added > 0 ? "Each MO is filled to its own limit before the next is touched" : "Taken back off the LAST MOs first — recorded as negative corrections in today's Daily Log"}>
                {spreadPreview(members, it, dept, added) || (added > 0 ? `+${added}` : `−${-added} correction`)}
              </span>
            )}
            <span className="print-only tabnum">{value}</span>
          </span>
        ) : editable ? (
          <span className="relative inline-flex flex-col items-center gap-0.5 w-full">
            <button
              type="button"
              data-nav={col}
              onClick={() => openCell(k, String(value), true)}
              onKeyDown={(e) => cellKeys(e, (d) => openCell(k, d, false))}
              className={`print-as-text w-full min-w-8 rounded px-1 py-1 tabnum hover:ring-2 hover:ring-brand/60 hover:font-bold focus:ring-2 focus:ring-brand focus:outline-none transition-all cursor-text ${err ? "ring-2 ring-bad-fg" : ""}`}
              title={`${deptLabel(dept)} · ${gBom} · ${it} — record on the WHOLE BOM: type the new group total, the difference is distributed over its ${eligibleMos.length} MOs in order; arrows move, Escape drops it`}
            >
              {value}
            </button>
            {err && <span className="no-print absolute top-full start-1/2 -translate-x-1/2 mt-0.5 z-20 whitespace-nowrap rounded-md bg-surface border border-bad-fg px-1.5 py-0.5 text-[10px] font-semibold text-bad-fg shadow-md">{err}</span>}
          </span>
        ) : (
          value
        )}
      </td>
    );
  }

  function etaCell(eta: RowEta | undefined, onHold = false) {
    if (onHold) return <td className="p-2 text-center text-xs font-bold" style={{ color: "var(--warn-fg)" }} title="On hold — in no queue, so no forecast">⏸️</td>;
    if (!eta) return <td className="p-2 text-center text-muted text-xs">—</td>;
    if (eta.done) return <td className="p-2 text-center text-ok-fg font-bold" title="Nothing left to make">✓</td>;
    if (!eta.etaISO) {
      return (
        <td className="p-2 text-center text-muted text-xs" title={`No recent output at ${eta.blockedBy ?? "a needed stage"} — nothing to base a forecast on`}>
          ?
        </td>
      );
    }
    const [, m, d] = eta.etaISO.split("-");
    return (
      <td
        className={`p-2 text-center tabnum text-xs whitespace-nowrap font-bold ${eta.late ? "" : "text-muted"}`}
        style={eta.late ? { color: "var(--bad-fg)" } : undefined}
        title={`Forecast ${eta.etaISO}${eta.dueISO ? ` · scheduled delivery ${eta.dueISO}` : " · never scheduled in a weekly plan"}${eta.late ? " — LATE" : ""}`}
      >
        {eta.late && "⚠ "}{d}/{m}
      </td>
    );
  }

  /** The group row shows the LATEST member forecast — the BOM is done when its
   *  slowest MO is done. */
  function groupEta(members: MasterTrackerRow[]): RowEta | undefined {
    let worst: RowEta | undefined;
    for (const m of members) {
      const e = etas[m.mo];
      if (!e) continue;
      if (!worst) { worst = e; continue; }
      // an unforecastable member outranks a date; a later date outranks an earlier one
      if (worst.done || (e.etaISO && worst.etaISO && e.etaISO > worst.etaISO) || (!e.etaISO && !e.done)) worst = e;
    }
    return worst;
  }

  function renderRow(r: MasterTrackerRow, inGroup = false, lastInGroup = false) {
    // frame: open groups get a clear border so their extent is obvious
    const frame = inGroup ? `bg-brand-light/10 border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    // ⏸️ a held row is yellow end to end — the component tints step aside
    const tintOf = (it: Item): string => (r.hold.onHold ? HOLD_TINT : ITEM_TINT[it]);
    return (
      <Fragment key={r.mo}>
              <tr
                className={frame}
                style={r.hold.onHold ? { background: HOLD_TINT } : undefined}
                onContextMenu={(e) => rowMenu.open(e, { kind: "mo", row: r })}
                title={r.hold.onHold ? `${holdLabel(r.hold)} · right-click for actions` : undefined}
              >
                <td className={`p-2 font-bold whitespace-nowrap text-xs ${inGroup ? "pl-6" : ""}`}>
                  {inGroup && <span className="text-muted mr-1">↳</span>}
                  <Link href={`/trace?mo=${encodeURIComponent(r.mo)}`} className="text-accent hover:underline">{r.mo}</Link>
                  {r.priority && <span className="ml-1" title="Priority order — shown on top of every dept worklist">⭐</span>}
                  {r.months.length > 1 && (
                    can("admin") ? (
                      <button
                        type="button"
                        onClick={() => setOpenMonths(openMonths === r.mo ? null : r.mo)}
                        disabled={pending}
                        // prints like the read-only span a non-admin sees, so
                        // the same MO reads the same on paper for everyone
                        className="print-as-text pill pill-warn ml-1 cursor-pointer hover:ring-2 hover:ring-brand/60 transition-all"
                        title={`Carried across ${r.months.length} monthly plans: ${r.months.join(" · ")} — click to fix a wrong tag`}
                      >
                        🔁 ×{r.months.length}
                      </button>
                    ) : (
                      <span
                        className="pill pill-warn ml-1"
                        title={`Carried across ${r.months.length} monthly plans: ${r.months.join(" · ")}`}
                      >
                        🔁 ×{r.months.length}
                      </span>
                    )
                  )}
                  {r.pendingQty && <PendingQty r={r} canDecide={can("tracker.qty")} />}
                  {r.urgent && <span className="pill pill-bad ml-1">U</span>}
                  {r.hold.onHold && <span className="pill pill-warn ml-1 cursor-help" title={holdLabel(r.hold)}>⏸️ HOLD{r.hold.holdNote ? ` · ${r.hold.holdNote}` : ""}</span>}
                  {ITEMS.filter((it) => r.items[it].osp > 0).map((it) => (
                    <span key={it} className="pill ml-1" style={{ background: "#ece3f7", color: "#6b45a8" }} title={`${it}: ${r.items[it].osp} pcs outsourced (OSP) — not made by our departments`}>
                      OSP {it}×{r.items[it].osp}
                    </span>
                  ))}
                  {ITEMS.filter((it) => r.items[it].excluded).map((it) => (
                    <span key={`x${it}`} className="pill pill-muted ml-1" title={`${it} is not required for this project — it doesn't gate completion and never appears in the worklists`}>
                      N/A {it}
                    </span>
                  ))}
                </td>
                <td className="p-2 whitespace-nowrap">
                  <Soi soi={r.soi} />
                </td>
                <td className="p-2 text-xs whitespace-nowrap">{r.customer || <span className="text-muted">—</span>}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  <Link href={`/trace?bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap text-muted text-center">{r.kva ?? "—"}</td>
                {specCell(r, "colorRal")}
                {specCell(r, "crcSize")}
                {specCell(r, "sfm")}
                <td className="p-2 text-center font-bold">
                  {qtyEditMo === r.mo ? (
                    <span className="inline-flex flex-col items-center gap-0.5">
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="number"
                          min={1}
                          value={qtyVal}
                          autoFocus
                          onChange={(e) => { setQtyVal(e.target.value); setQtyErr(""); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveQty(r.mo);
                            if (e.key === "Escape") setQtyEditMo(null);
                          }}
                          className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface"
                          disabled={pending}
                        />
                        <button type="button" onClick={() => saveQty(r.mo)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save the new order quantity">
                          ✓
                        </button>
                        <button type="button" onClick={() => setQtyEditMo(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">
                          ✕
                        </button>
                      </span>
                      {qtyErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 leading-tight">{qtyErr}</span>}
                      <span className="print-only tabnum"><Num v={r.required} /></span>
                    </span>
                  ) : can("tracker.qty") ? (
                    <button
                      type="button"
                      onClick={() => { setQtyEditMo(r.mo); setQtyVal(String(r.required)); setQtyErr(""); }}
                      disabled={pending}
                      className="print-as-text w-full min-w-10 rounded px-1 py-1 tabnum font-bold hover:ring-2 hover:ring-brand/60 transition-all cursor-text"
                      title={`${r.mo} — click to change the required quantity (revisions that LOWER a qty are applied here manually)`}
                    >
                      <Num v={r.required} />
                    </button>
                  ) : (
                    <Num v={r.required} />
                  )}
                </td>
                {specCell(r, "fins")}
                {ITEMS.map((it) => {
                  const c = r.items[it];
                  // AR/MB the order's KVA/rating rule doesn't match, or a manual
                  // N/A, show as blank dashes and don't gate completion
                  if (!c.eligible || c.excluded) {
                    if (scoped) {
                      return (
                        <Fragment key={it}>
                          {stages.map((s, si) => (
                            <td key={s} className={`p-2 text-center text-muted ${si === stages.length - 1 ? "border-r border-border-strong" : ""}`} style={{ background: tintOf(it) }}>—</td>
                          ))}
                        </Fragment>
                      );
                    }
                    return (
                      <Fragment key={it}>
                        <td className="p-2 text-center text-muted" style={{ background: tintOf(it) }}>—</td>
                        <td className="p-2 text-center text-muted" style={{ background: tintOf(it) }}>—</td>
                        <td className="p-2 text-center text-muted" style={{ background: tintOf(it) }}>—</td>
                        <td className="p-2 text-center text-muted border-r border-border-strong" style={{ background: tintOf(it) }}>—</td>
                      </Fragment>
                    );
                  }
                  // stage scope: only the picked depts' columns (the core's
                  // Painting column is its SHOT BLAST — same as unfiltered)
                  if (scoped) {
                    return (
                      <Fragment key={it}>
                        {stages.map((s, si) => {
                          const last = si === stages.length - 1;
                          return (
                            <Fragment key={s}>
                              {s === "Cut" && stageCell(r, it, "Cut", c.cut, tintOf(it), last)}
                              {s === "Welding" && stageCell(r, it, "Welding", c.weld, tintOf(it), last)}
                              {s === "Painting" && (isPaintExempt(it)
                                ? stageCell(r, it, "ShotBlast", c.shp, tintOf(it), last)
                                : stageCell(r, it, "Painting", c.paint, tintOf(it), last))}
                              {s === "Delivered" && stageCell(r, it, "Delivered", c.delivered, tintOf(it), last)}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  }
                  return (
                    <Fragment key={it}>
                      {stageCell(r, it, "Cut", c.cut, tintOf(it))}
                      {stageCell(r, it, "Welding", c.weld, tintOf(it))}
                      {isPaintExempt(it) ? (
                        stageCell(r, it, "ShotBlast", c.shp, tintOf(it))
                      ) : (
                        stageCell(r, it, "Painting", c.paint, tintOf(it))
                      )}
                      {stageCell(r, it, "Delivered", c.delivered, tintOf(it), true)}
                    </Fragment>
                  );
                })}
                {!scoped && (
                  <>
                    <td className="p-2 text-center font-extrabold border-r"><Num v={r.complete} /></td>
                    <td className="p-2 text-center font-bold" style={{ color: r.remaining > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                      <Num v={r.remaining} />
                    </td>
                    <td className="p-2 text-center font-bold tabnum" style={pctStyle(r.achievement)}>
                      {r.achievement === null ? "—" : `${(r.achievement * 100).toFixed(0)}%`}
                    </td>
                  </>
                )}
                {etaCell(etas[r.mo], r.hold.onHold)}
                <td className="p-2 text-center no-print whitespace-nowrap">
                  <button type="button" onClick={(e) => rowMenu.open(e, { kind: "mo", row: r })} className="text-muted px-1.5 hover:text-accent font-bold" title="Actions — hold, priority, close… (or right-click the row)">⋯</button>
                  {/* the row's actions live in the ⋯ menu (and on right-click);
                      the cell keeps only the state, and the one call to action
                      a finished order earns */}
                  {r.status === "closed" ? (
                    <span className="pill pill-muted" title="Reopen from the ⋯ menu">Closed</span>
                  ) : can("tracker.status") && r.required > 0 && r.complete >= r.required ? (
                    <button onClick={() => changeStatus(r.mo, "closed")} disabled={pending} className="rounded-md px-2 py-0.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                      ✓ Close
                    </button>
                  ) : (
                    <span className="pill pill-ok">Open</span>
                  )}
                </td>
              </tr>
              {/* the inline editor panels are controls, not data — off the paper */}
              {openMonths === r.mo && (
                <tr className={`no-print ${inGroup ? "border-x-2 border-brand" : ""}`}>
                  <td colSpan={tableCols} className="p-3 bg-brand-light/30 border-y">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-bold text-xs">🔁 {r.mo} appears under:</span>
                      {r.months.map((m) => (
                        <span key={m} className="pill pill-muted inline-flex items-center gap-1">
                          {m}
                          <button
                            type="button"
                            onClick={() => dropMonth(r, m)}
                            disabled={pending || r.months.length <= 1}
                            className="text-bad-fg font-extrabold px-0.5 disabled:opacity-30"
                            title={r.months.length <= 1 ? "An order must keep at least one plan month" : `Remove "${m}" — wrong tag`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      <button type="button" onClick={() => setOpenMonths(null)} className="text-muted text-xs hover:underline">Close</button>
                      <span className="text-[11px] text-muted w-full">
                        A month is tagged automatically when the MO appears as a row in that month&apos;s imported sheet. Remove a wrong tag here — re-importing that month&apos;s file would tag it again only if the MO is still in the file.
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {openPush === r.mo && (
                <Modal title={`📤 Send ${r.mo} to a worklist`} onClose={() => setOpenPush(null)} busy={pending}>
                    <form
                      onSubmit={(e) => { e.preventDefault(); submitPush(r); }}
                      className="flex flex-wrap items-center gap-3 text-sm"
                    >
                      <span className="font-bold text-xs">Send to:</span>
                      <select
                        value={pushDept}
                        onChange={(e) => {
                          const d = e.target.value as Dept;
                          setPushDept(d);
                          setPushQty(Object.fromEntries(ITEMS.map((it) => [it, String(remainingFor(r, it, d))])));
                          setPushErr("");
                        }}
                        className="border rounded-md px-2 py-1 bg-surface text-sm font-semibold"
                        disabled={pending}
                      >
                        {DEPTS.map((d) => (
                          <option key={d} value={d}>{deptLabel(d)} worklist</option>
                        ))}
                      </select>
                      {ITEMS.filter((it) => r.items[it].eligible).map((it) => {
                        const max = remainingFor(r, it, pushDept);
                        return (
                          <label key={it} className={`inline-flex items-center gap-1 font-semibold ${max === 0 ? "opacity-40" : ""}`}>
                            {it}
                            <input
                              type="number"
                              min={0}
                              max={max}
                              value={pushQty[it] ?? ""}
                              onChange={(e) => { setPushQty((s) => ({ ...s, [it]: e.target.value })); setPushErr(""); }}
                              className="w-16 border rounded-md px-1 py-0.5 text-center tabnum bg-surface"
                              disabled={pending || max === 0}
                              title={max === 0 ? `${it}: nothing left for ${deptLabel(pushDept)}` : `${it}: up to ${max} pcs still open`}
                            />
                            <span className="text-[10px] text-muted tabnum">/{max}</span>
                          </label>
                        );
                      })}
                      <button type="submit" disabled={pending} className="rounded-md px-3 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                        Send
                      </button>
                      <button type="button" onClick={() => setOpenPush(null)} className="text-muted text-xs hover:underline">Cancel</button>
                      {pushErr && <span className="text-xs text-bad-fg font-semibold w-full">{pushErr}</span>}
                      <span className="text-[11px] text-muted w-full">
                        Quantities are capped at what the department still owes on this order. The line lands date-less on the chosen worklist — schedule it there (📅✎). Sending again replaces the previous push; all-zero clears it.
                      </span>
                    </form>
                </Modal>
              )}
              {openConfig === r.mo && (
                <Modal title={`Components ${r.mo} actually needs`} onClose={() => setOpenConfig(null)} busy={pending}>
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveExcluded(r, e.currentTarget); }}
                      className="flex flex-wrap items-center gap-4 text-sm"
                    >
                      {ITEMS.map((it) => {
                        const c = r.items[it];
                        const needed = c.eligible && !c.excluded;
                        return (
                          <label key={it} className="inline-flex items-center gap-1.5 font-semibold cursor-pointer" title={it === "AR" ? "Arrester — the KVA rule adds it on 100–300 kVA; tick or untick it here regardless" : it === "MB" ? "Mono Box — the rating rule adds it when the secondary lists two voltages; tick or untick it here regardless" : undefined}>
                            <input type="checkbox" name="req" value={it} defaultChecked={needed} className="accent-[var(--brand)]" />
                            {it}
                          </label>
                        );
                      })}
                      <button type="submit" disabled={pending} className="rounded-md px-3 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setOpenConfig(null)} className="text-muted text-xs hover:underline">Cancel</button>
                      <span className="text-[11px] text-muted w-full">Ticked components are what this project is made of — all six are yours to switch, whatever the KVA/rating rule says. Unticked ones leave the worklists and stop gating completion &amp; OTD.</span>
                    </form>
                </Modal>
              )}
      </Fragment>
    );
  }
}

// stage sub-headers sit on the same tints as their data columns — readable
// in both themes (the old dark-green fill swallowed the muted header text)
function StageHead({ tint, shp = false, only, borderR = true }: { tint: string; shp?: boolean; only?: string; borderR?: boolean }) {
  // The sub-header wears its ITEM's wash like the numbers under it, so the
  // whole column reads as one block. Which stage a column is stays in the
  // label — Fab / Weld / SHB / Paint / Dlvd — not in a colour of its own.
  if (only) {
    const [label, title] =
      only === "Cut" ? ["Fab", undefined]
      : only === "Welding" ? ["Weld", undefined]
      : only === "Delivered" ? ["Dlvd", "Delivered — received by the customer"]
      : shp ? ["SHB", "Shot Blast — the core's final stage after welding"]
      : ["Paint", undefined];
    return <th className={`p-1 font-medium on-tint ${borderR ? "border-r border-border-strong" : ""}`} style={{ background: tint }} title={title}>{label}</th>;
  }
  return (
    <>
      <th className="p-1 font-medium on-tint" style={{ background: tint }}>Fab</th>
      <th className="p-1 font-medium on-tint" style={{ background: tint }}>Weld</th>
      {/* the core (CF) is never painted — its final stage is SHOT BLAST */}
      {shp ? (
        <th className="p-1 font-medium on-tint" style={{ background: tint }} title="Shot Blast — the core's final stage after welding">SHB</th>
      ) : (
        <th className="p-1 font-medium on-tint" style={{ background: tint }}>Paint</th>
      )}
      <th className="p-1 font-medium on-tint border-r border-border-strong" style={{ background: tint }} title="Delivered — received by the customer">Dlvd</th>
    </>
  );
}


/** ⚠ on an order whose qty a plan import held back: the old figure stays in
 *  the plan until the planner uses the sheet's or keeps his own. */
function PendingQty({ r, canDecide }: { r: MasterTrackerRow; canDecide: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const p = r.pendingQty!;
  const title = `${p.month ?? "A plan import"} says ${p.to} — the registry keeps ${r.required} until you choose`;
  const decide = (decision: "use" | "keep") => {
    const fd = new FormData();
    fd.set("mos", r.mo);
    fd.set("decision", decision);
    setErr("");
    start(async () => {
      const res = await decidePlanQty(fd);
      if (!res.ok) { setErr(res.error ?? "Could not save."); return; }
      setOpen(false);
      router.refresh();
    });
  };
  const pill = <>⚠ Qty {r.required} → {p.to}?</>;
  if (!canDecide) return <span className="pill pill-warn ml-1 cursor-help" title={title}>{pill}</span>;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="print-as-text pill pill-warn ml-1 cursor-pointer hover:ring-2 hover:ring-brand/60 transition-all"
        title={`${title} — click to choose`}
        aria-expanded={open}
      >
        {pill}
      </button>
      {open && (
        <span className="absolute left-0 top-[calc(100%+4px)] z-30 flex flex-col gap-1.5 whitespace-normal rounded-lg border bg-surface p-2.5 text-foreground shadow-lg w-60 font-normal">
          <span className="text-xs">
            <b>{p.month ?? "The new plan"}</b> has <b className="text-warn-fg">{p.to}</b>; the registry has <b>{r.required}</b>.
          </span>
          <span className="flex gap-1.5">
            <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => decide("use")}>Use {p.to}</button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => decide("keep")}>Keep {r.required}</button>
          </span>
          {err && <span className="text-[11px] font-semibold text-bad-fg">{err}</span>}
        </span>
      )}
    </span>
  );
}

/** One line above the table while any order has a held qty. */
function PendingQtyBanner({ rows }: { rows: MasterTrackerRow[] }) {
  const waiting = rows.filter((r) => r.pendingQty);
  if (waiting.length === 0) return null;
  return (
    <div className="no-print mb-2 rounded-lg border border-warn-fg/40 bg-warn-bg px-3 py-2 text-sm text-warn-fg">
      <b>⚠ {waiting.length} order{waiting.length === 1 ? "" : "s"}</b>: the new plan brought a different quantity — the old one stays until you choose. Click the ⚠ on the MO:{" "}
      <span className="font-semibold">{waiting.slice(0, 6).map((r) => `${r.mo} (${r.required}→${r.pendingQty!.to})`).join(" · ")}{waiting.length > 6 ? " …" : ""}</span>
    </div>
  );
}
