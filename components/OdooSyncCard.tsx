import { Badge, type BadgeTone } from "@/components/Badge";
import { SettingRow } from "@/components/primitives";
import { formatDateTime } from "@/lib/domain/format";
import { summaryText } from "@/lib/domain/odooSync";
import type { OdooSyncStatus } from "@/lib/server/odooSync";

const RUN_TONE: Record<string, BadgeTone> = { ok: "success", partial: "warning", failed: "danger" };
const RUN_LABEL: Record<string, string> = { ok: "OK", partial: "Partly done", failed: "Failed" };

/** Admin → Settings: what the Odoo sync last did. It runs as a scheduled task
 *  on the owner's computer (lib/domain/odooSync.ts), so there is nothing to
 *  set here — only what happened, and whether a run is overdue. */
export function OdooSyncCard({ status: st }: { status: OdooSyncStatus }) {
  const last = st.last;
  return (
    <div className="space-y-3">
      <SettingRow
        title={st.late ? "Overdue" : last ? "Running on schedule" : "No run yet"}
        hint={`A scheduled task on the owner's computer reads Odoo at about 09:00 and 13:00 Riyadh time, Sunday to Thursday — in the Claude desktop app's browser, with the user's own Odoo login — and writes what it read here. It only reads Odoo; nothing is ever changed there. Next: ${st.nextLabel || "—"}.`}
      >
        {st.late && <Badge tone="danger">Last run missed</Badge>}
      </SettingRow>
      {st.late && (
        <p className="text-[length:var(--fs-body)] text-bad-fg font-semibold">
          The last scheduled run did not arrive. Check that the computer was on with the Claude desktop app open, and that Odoo and this app are still signed in in its browser.
        </p>
      )}
      {last && (
        <div className="rounded-md border px-3 py-2 text-[length:var(--fs-body)] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Last run</span>
            <Badge tone={RUN_TONE[last.status] ?? "neutral"}>{RUN_LABEL[last.status] ?? last.status}</Badge>
            <span className="text-muted tabnum">{formatDateTime(last.startedAtISO)}</span>
            {last.summary && <span className="text-muted tabnum">· read in {Math.round(last.summary.ms / 1000)} s</span>}
          </div>
          {last.summary && <p className="text-muted">{summaryText(last.summary)}</p>}
          {last.summary?.issues.map((i) => <p key={i} className="text-warn-fg">{i}</p>)}
          {last.error && <p className="text-bad-fg font-semibold">{last.error}</p>}
          {st.lastOkAtISO && last.status === "failed" && <p className="text-muted">Last good run: {formatDateTime(st.lastOkAtISO)}</p>}
        </div>
      )}
      <p className="text-[length:var(--fs-body)] text-muted">
        <b className="tabnum text-foreground">{st.differs}</b> row{st.differs === 1 ? "" : "s"} of the ODOO log read differently from Odoo right now.
      </p>
    </div>
  );
}
