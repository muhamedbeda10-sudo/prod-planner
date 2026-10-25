import "server-only";

/**
 * An error whose message was written for the person: thrown on purpose (often
 * inside a transaction, to roll it back) with a sentence that tells them what
 * to do next. `userMessage` passes its text through as it is, without the
 * sentence test it applies to other errors. Subclass it for each deliberate
 * refusal (TankMovedError, LvRefused, LedgerSyncError, …); their own catch
 * blocks still catch them by class first.
 */
export class UserError extends Error {}

/**
 * One sentence for the person, the whole error for the log.
 *
 * Server actions catch whatever the database driver, Prisma or a library
 * throws and hand the message back to the screen. Those messages are written
 * for developers: Prisma's run to several lines and carry the invocation, the
 * query path and the database host; the driver's name constraints and
 * columns. Shop-floor users cannot act on any of that, and the host must not
 * be printed to them. `userMessage` keeps the full error in the server log
 * (console.error, so Vercel's log drain picks it up) and returns a single
 * plain sentence to show instead.
 *
 * What comes back, in order:
 *  0. A UserError (or a subclass) → its message, unchanged. Throwing one is
 *     the app saying "this text was written for the person"; the sentence
 *     test in 2. is not applied to it.
 *  1. A Prisma error (its name starts with "PrismaClient", or it carries a
 *     `code` like P2002) → the sentence for that code when it is one the
 *     person can act on (duplicate key, missing reference, row gone,
 *     transaction timeout, database unreachable), otherwise the generic
 *     sentence. Prisma text never passes through.
 *  2. The app's own message passes through unchanged when it was clearly
 *     written for a person: an Error (not a built-in TypeError, RangeError,
 *     SyntaxError, ReferenceError, URIError, EvalError or AggregateError — those
 *     are programming faults) whose message is ONE line, at most 240
 *     characters, starts with a capital letter or a digit (a serial, a count),
 *     ends with ".", "!" or "?", and contains none of the technical markers
 *     below. That is how every deliberate throw in this app reads: a
 *     sentence that tells the person what to do next (a UserError skips
 *     this test, see 0.; a plain `new Error(…)` relies on it). Driver and
 *     library messages fail this test — "connection lost", "Unique constraint failed on ledgerId",
 *     "ENOENT: no such file or directory, open '…'" — so they never leak.
 *     The markers are matched so that ordinary English passes: Node's error
 *     codes (ENOENT, ECONNRESET) are all-caps and matched case-sensitively, so
 *     "Enter", "exists" or "empty" are not codes; a stack frame needs a
 *     file:line, so "recorded at Welding (3 of 5)" is not a frame; "null" and
 *     "undefined" must be whole words, so "annulled" is fine.
 *  3. Anything else → `Could not ${what} — the server did not finish it.
 *     Check the records, then try again.` (an import writes in several
 *     batches, so no sentence here claims that nothing was written)
 *
 * `what` is the verb phrase of the action as the person sees it, in the
 * infinitive: "save the output", "put the rows back", "remove the photo".
 */
export function userMessage(e: unknown, what: string): string {
  console.error(`[${what}]`, e);
  if (e instanceof UserError) return e.message;
  const prismaCode = prismaCodeOf(e);
  if (prismaCode !== null) return prismaSentence(prismaCode, what);
  if (isOwnSentence(e)) return e.message;
  return generic(what);
}

function generic(what: string): string {
  return `Could not ${what} — the server did not finish it. Check the records, then try again.`;
}

/** Prisma's error code when `e` is a Prisma error, "" for a Prisma error
 *  without one (validation, panic, initialization), null otherwise. */
function prismaCodeOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { name, code } = e as { name?: unknown; code?: unknown };
  const isPrismaName = typeof name === "string" && name.startsWith("PrismaClient");
  const isPrismaCode = typeof code === "string" && /^P\d{4}$/.test(code);
  if (!isPrismaName && !isPrismaCode) return null;
  if (isPrismaCode) return code;
  // Prisma could not even start: the database URL or the connection is the problem
  return name === "PrismaClientInitializationError" ? "P1001" : "";
}

/** True when `e` is Prisma's unique-index violation (P2002): a save that
 *  lost the race with another save of the same key. */
export function isUniqueViolation(e: unknown): boolean {
  return prismaCodeOf(e) === "P2002";
}

/** The columns a unique-index violation hit, from Prisma's `meta.target`:
 *  usually the field names (["empId"]), but some drivers name the index
 *  instead ("Worker_empId_key") — then the model prefix and the `_key` suffix
 *  are dropped and the rest is split on "_" (["empId"]). Empty when `e` is
 *  not a unique violation or names no target. */
export function uniqueViolationTarget(e: unknown): string[] {
  if (!isUniqueViolation(e)) return [];
  const target = (e as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target !== "string" || !target) return [];
  const parts = target.replace(/_(key|pkey|idx|index|unique)$/i, "").split("_").filter(Boolean);
  return parts.length > 1 ? parts.slice(1) : parts;
}

function prismaSentence(code: string, what: string): string {
  switch (code) {
    case "P2002":
      return `Could not ${what} — a row with the same key is already there. Refresh the page and check it.`;
    case "P2003":
      return `Could not ${what} — it points at a record that is no longer there. Refresh the page and try again.`;
    case "P2025":
      return `Could not ${what} — that record is no longer there. Refresh the page.`;
    case "P2028":
    case "P2024":
      return `Could not ${what} — the database took too long. Check the records, then try again.`;
    case "P1001":
    case "P1002":
    case "P1008":
    case "P1017":
      return `Could not ${what} — the database cannot be reached right now. Check the records, then try again in a moment.`;
    default:
      return generic(what);
  }
}

/** Built-in error classes a thrown message never comes from on purpose. */
const BUILT_IN = new Set(["TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError"]);

/** Fragments that mark a message as the driver's, a library's or a stack
 *  trace's, whatever its shape. Matched case-insensitively, so each one is
 *  either a word that never appears in a sentence for a person or a phrase
 *  bound tightly enough (whole word, file:line) that ordinary English passes. */
const TECHNICAL =
  /prisma|invocation|constraint|\bat\s+\S+\s+\(.*:\d+|sqlstate|relation "|column "|syntax error|timed? ?out|\bundefined\b|\bnull\b|\[object|stack trace|\.[cm]?[jt]s:\d+/i;

/** Node's error codes (ENOENT, ECONNRESET, EADDRINUSE, …) are all caps, so this
 *  is matched case-SENSITIVELY: with /i it would also hit "Enter", "exists",
 *  "empty" or "Either" and swallow the app's own sentences. */
const NODE_CODE = /\bE[A-Z]{3,}\b/;

function isOwnSentence(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  if (BUILT_IN.has(e.name) || BUILT_IN.has(e.constructor.name)) return false;
  const msg = e.message.trim();
  if (!msg || msg.length > 240 || msg.includes("\n")) return false;
  if (!/^[A-Z0-9]/.test(msg) || !/[.!?]$/.test(msg)) return false;
  return !TECHNICAL.test(msg) && !NODE_CODE.test(msg);
}
