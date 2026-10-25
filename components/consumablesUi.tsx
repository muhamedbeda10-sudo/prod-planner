"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ConsumableRevisionView } from "@/lib/server/consumables";
import { OVER_LIMIT_REASON_MIN } from "@/lib/domain/consumables";
import { restoreConsumableRevision } from "@/app/consumables/actions";
import { SAVE_UNCONFIRMED } from "@/components/ui";

// What the CONSUMABLES log and the admin's Edits view share: running a server
// action with its message, and one line of a row's history with its Restore.

export type ConsumableActionResultLike = { ok: boolean; error?: string; department?: string; needsReason?: boolean; breaches?: string[] };
type ActionFn = (fd: FormData) => Promise<ConsumableActionResultLike>;

export function useConsumableAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(
    (fn: ActionFn, fd: FormData, okText: string, after?: (res: ConsumableActionResultLike) => void, onFail?: (res: ConsumableActionResultLike) => void) => {
      startTransition(async () => {
        // A rejected action must stay a message here, not reach the route's
        // error boundary — that replaces the whole log and claims nothing changed.
        try {
          const res = await fn(fd);
          setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
          if (res.ok) {
            after?.(res);
            router.refresh();
          } else {
            onFail?.(res);
          }
        } catch {
          setMsg({ ok: false, text: SAVE_UNCONFIRMED });
        }
      });
    },
    [router]
  );
  return { pending, msg, run };
}

export function ActionMsg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`} role="status">{msg.text}</p>;
}

const ACTION_WORD: Record<ConsumableRevisionView["action"], string> = { edit: "edited", delete: "deleted", restore: "restored an earlier version of" };
const ACTION_PILL: Record<ConsumableRevisionView["action"], string> = { edit: "pill-warn", delete: "pill-bad", restore: "pill-ok" };

export function RevisionPill({ action }: { action: ConsumableRevisionView["action"] }) {
  return <span className={`pill ${ACTION_PILL[action]}`}>{action}</span>;
}

/**
 * One change to a row: who, when, what changed (before → after), and — for
 * the admin — "Restore" to put the row back the way it read before it.
 * `version` is the row's current optimistic-lock token. A version that takes
 * a limit over is not restored without a reason: the server refuses it with
 * the breaches, and the admin is asked for the reason, then it is sent again.
 */
export function RevisionItem({ r, version, deleted }: { r: ConsumableRevisionView; version: string; deleted?: boolean }) {
  const act = useConsumableAction();
  const restore = (reason?: string) => {
    const fd = new FormData();
    fd.set("revisionId", String(r.id));
    fd.set("version", version);
    if (reason) fd.set("overLimitReason", reason);
    act.run(restoreConsumableRevision, fd, reason ? "Restored over the limit — flagged with your reason." : "Restored.", undefined, (res) => {
      if (!res.needsReason || !res.breaches) return;
      const why = prompt(
        `⚠ This version takes ${res.breaches.length > 1 ? `${res.breaches.length} limits` : "a limit"} over — it is not restored without a reason.\n\n${res.breaches.join("\n")}` +
        `${reason && res.error ? `\n\n${res.error}` : ""}\n\nReason — required (at least ${OVER_LIMIT_REASON_MIN} characters):`,
        reason ?? ""
      );
      if (why !== null) restore(why);
    });
  };
  return (
    <li className="py-1.5 border-t first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="ltr tabnum text-muted">{r.atLabel}</span>
        <RevisionPill action={r.action} />
        <span><b>{r.by}</b> {ACTION_WORD[r.action]} the row</span>
        {r.restorable && (
          <button
            type="button" className="btn btn-sm ml-auto" disabled={act.pending}
            title="Put the row back the way it read before this change — the restore is itself kept in the history"
            onClick={() => {
              if (!confirm(`Restore this version?\n\n${r.before}${deleted ? "\n\nThe row is deleted — it comes back onto the log." : ""}`)) return;
              restore();
            }}
          >
            ↺ Restore this version
          </button>
        )}
      </div>
      {r.changes.length > 0 ? (
        <ul className="mt-0.5 ml-1">
          {r.changes.map((c) => <li key={c} className="font-semibold">{c}</li>)}
        </ul>
      ) : (
        <div className="mt-0.5">
          <span className="text-muted">Before:</span> <span className="font-semibold">{r.before}</span>
          {r.after && <> <span className="text-muted">→ After:</span> <span className="font-semibold">{r.after}</span></>}
        </div>
      )}
      <ActionMsg msg={act.msg} />
    </li>
  );
}
