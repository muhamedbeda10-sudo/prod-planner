// Tank serials — the first component tracked PIECE BY PIECE.
//
// A tank (item TN) gets its identity at the moment welding is recorded:
//
//     SF-<BOM>-<0001>
//
// "SF" is fixed, the BOM is the order's code, and the number restarts at 1 for
// every BOM (so the same BOM's tanks read as one continuous run even when they
// come from several MOs). The technician reads the serial off the app and
// writes it on the steel, so it stays short and unambiguous.
//
// From there the tank walks a fixed path:
//
//     welded ──leak test fails──> repair ──re-welded──> welded
//        │
//        └──leak test passes──> tested ──painted──> painted (all stages done)
//
// Quantities in the daily-log ledger stay the truth for planning; the tank rows
// are the per-piece layer on top. Everything here is pure so the transitions
// can be tested without a database.

/** The component tracked per piece. Everything else stays quantity-only. */
export const TANK_ITEM = "TN";

/** Fixed serial prefix — "Steel Fabrication". */
export const TANK_SERIAL_PREFIX = "SF";

/** Zero-padding on the running number: 0001 … 9999, then it simply grows. */
export const TANK_SEQ_DIGITS = 4;

/** Where a tank is on its path. Stored on TankUnit.status. */
export const TANK_STATUSES = ["welded", "repair", "tested", "painted"] as const;
export type TankStatus = (typeof TANK_STATUSES)[number];

export function isTankStatus(x: string): x is TankStatus {
  return (TANK_STATUSES as readonly string[]).includes(x);
}

/** What each stage writes into the tank's history (TankEvent.kind), with the
 *  label and pill tone the tank page shows it under. */
export const TANK_EVENT_KINDS = {
  welded: { label: "Welded", tone: "pill-muted" },
  repaired: { label: "Repaired", tone: "pill-warn" },
  "leak-pass": { label: "Passed the leak test", tone: "pill-ok" },
  "leak-repair": { label: "Failed the leak test", tone: "pill-bad" },
  painted: { label: "Painted", tone: "pill-ok" },
  unpainted: { label: "Painting record removed", tone: "pill-warn" },
  "qa-ok": { label: "Quality check — OK", tone: "pill-ok" },
  "qa-not-ok": { label: "Quality check — not OK", tone: "pill-bad" },
} as const;
export type TankEventKind = keyof typeof TANK_EVENT_KINDS;

/** Label + tone for a stored event kind, tolerating one written by a future
 *  version of the app. */
export function tankEventLook(kind: string): { label: string; tone: string } {
  return TANK_EVENT_KINDS[kind as TankEventKind] ?? { label: kind, tone: "pill-muted" };
}

/** The departments a worker can be credited in — the dropdowns' source, and
 *  the shift log's: a worker is counted on the days of every department here. */
export const WORKER_DEPTS = ["Cut", "Welding", "ShotBlast", "LeakTest", "Painting", "Quality"] as const;
export type WorkerDept = (typeof WORKER_DEPTS)[number];

export function isWorkerDept(x: string): x is WorkerDept {
  return (WORKER_DEPTS as readonly string[]).includes(x);
}

/** What each status means on the shop floor. */
export const TANK_STATUS_LABEL: Record<TankStatus, string> = {
  welded: "Welded — waiting for the leak test",
  repair: "Needs repair — back to welding",
  tested: "Passed the leak test — ready to paint",
  painted: "All stages done",
};

/** Pill colour class per status (globals.css tones). */
export function tankStatusTone(status: string): string {
  switch (status) {
    case "painted":
      return "pill-ok";
    case "tested":
      return "pill-ok";
    case "repair":
      return "pill-bad";
    default:
      return "pill-warn";
  }
}

export const WORKER_DEPT_LABEL: Record<WorkerDept, string> = {
  Cut: "Fabrication",
  Welding: "Welding",
  ShotBlast: "Shot blast",
  LeakTest: "Leak test",
  Painting: "Painting",
  Quality: "Quality",
};

/** Normalize a worker's badge number. It is typed by hand on a noisy floor, so
 *  "100 058" and "100058" have to be the same man. Lives here rather than in
 *  the server layer because the picker matches on it in the browser too. */
export function normalizeEmpId(raw: string): string {
  return String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** Normalize a BOM for use inside a serial: trimmed, upper-cased, no spaces.
 *  The serial is written by hand on steel — whitespace in it is a bug. */
export function normalizeSerialBom(bom: string): string {
  return String(bom ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** Build the serial for one tank: SF-<BOM>-<0001>. */
export function tankSerial(bom: string, seq: number): string {
  return `${TANK_SERIAL_PREFIX}-${normalizeSerialBom(bom)}-${String(seq).padStart(TANK_SEQ_DIGITS, "0")}`;
}

/** Split a serial back into its BOM and running number, or null if it is not
 *  one of ours. The BOM itself may contain dashes, so the LAST dash wins. */
export function parseTankSerial(serial: string): { bom: string; seq: number } | null {
  const s = String(serial ?? "").trim().toUpperCase();
  if (!s.startsWith(`${TANK_SERIAL_PREFIX}-`)) return null;
  const rest = s.slice(TANK_SERIAL_PREFIX.length + 1);
  const cut = rest.lastIndexOf("-");
  if (cut <= 0) return null;
  const bom = rest.slice(0, cut);
  const digits = rest.slice(cut + 1);
  if (!/^[0-9]+$/.test(digits)) return null;
  const seq = parseInt(digits, 10);
  if (!Number.isInteger(seq) || seq < 1) return null;
  return { bom, seq };
}

/** The serials a batch of `count` tanks takes, given the counter's next value.
 *  The caller bumps the counter by `count` in the same transaction. */
export function serialsForBatch(bom: string, startSeq: number, count: number): { seq: number; serial: string }[] {
  const out: { seq: number; serial: string }[] = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    out.push({ seq, serial: tankSerial(bom, seq) });
  }
  return out;
}

// ---- transitions ----

/** The status behind each screen's queue. Having one map means a database
 *  query and a UI guard can never end up disagreeing about what "waiting for
 *  the leak test" or "ready to paint" means. */
export const TANK_QUEUE_STATUS = {
  /** Welding is done, the leak test has not happened (or the repair is confirmed). */
  leakTest: "welded",
  /** The leak test failed — the welding worklist shows it until it is fixed. */
  repair: "repair",
  /** Passed the leak test: the ONLY state painting accepts. */
  paintable: "tested",
  /** Every stage done — it earns a barcode sticker. */
  finished: "painted",
} as const satisfies Record<string, TankStatus>;

export type LeakTestResult = "pass" | "repair";

export function isLeakTestResult(x: string): x is LeakTestResult {
  return x === "pass" || x === "repair";
}

export type QaResult = "ok" | "not-ok";

export function isQaResult(x: string): x is QaResult {
  return x === "ok" || x === "not-ok";
}

/** The status a leak-test verdict moves the tank to. */
export function statusAfterLeakTest(result: LeakTestResult): TankStatus {
  return result === "pass" ? "tested" : "repair";
}

/** Why a transition is refused, or null when it is allowed. Every action calls
 *  this before writing, so the shop floor gets one consistent explanation. */
export function blockedReason(action: "leak-test" | "repair" | "paint", status: string): string | null {
  switch (action) {
    case "leak-test":
      if (status === "repair") return "This tank needs its repair first — welding has to confirm the fix before it can be re-tested.";
      if (status === "tested") return "This tank has already passed the leak test.";
      if (status === "painted") return "This tank is already painted.";
      return null;
    case "repair":
      if (status !== "repair") return "Nobody sent this tank back for repair.";
      return null;
    case "paint":
      if (status === "welded") return "This tank has not had its leak test yet — painting stays closed until it passes.";
      if (status === "repair") return "This tank failed the leak test and needs repair — it cannot be painted.";
      if (status === "painted") return "This tank is already painted.";
      return null;
  }
}

// ---- the printed sticker / scanned page ----

/** The path a scan lands on. Kept in one place so the QR, the links and the
 *  route can never drift apart. */
export function tankPath(serial: string): string {
  return `/tank/${encodeURIComponent(serial)}`;
}

/** What the QR encodes: the absolute URL of the tank's page, so quality scans
 *  the sticker and reads live data instead of a frozen copy. */
export function tankQrPayload(baseUrl: string, serial: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${tankPath(serial)}`;
}
