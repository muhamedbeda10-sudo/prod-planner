// Slowing down password guessing on the login page. Failed sign-ins are
// counted over a short window: too many for one account from one place, or
// too many from one place for any account, and the login waits the window
// out before it checks a password again. Counting per account AND place
// (not per account alone) keeps someone elsewhere from locking a colleague
// out by typing wrong passwords against his email. Pure, so the rule is
// tested without a database.

/** How far back failures are counted. */
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Failures for one email from one address before the login waits. */
export const MAX_FAILURES_PER_ACCOUNT = 8;
/** Failures from one address, any email, before the login waits — a shared
 *  factory connection has many people behind it, so this one is generous. */
export const MAX_FAILURES_PER_ADDRESS = 40;
/** How long a failure is kept at all. */
export const LOGIN_FAILURE_KEEP_MS = 24 * 60 * 60_000;

export const LOGIN_THROTTLED = "Too many wrong passwords — wait 15 minutes and try again, or ask the admin to reset yours.";

/** Whether the login waits, given the failures counted in the window. */
export function loginThrottled(failures: { account: number; address: number }): boolean {
  return failures.account >= MAX_FAILURES_PER_ACCOUNT || failures.address >= MAX_FAILURES_PER_ADDRESS;
}

/** The address a request came from, as the platform reports it: the first
 *  hop of x-forwarded-for, else x-real-ip, else "unknown" (every request
 *  without one then shares one address's allowance). */
export function clientAddress(get: (name: string) => string | null): string {
  const forwarded = get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}
