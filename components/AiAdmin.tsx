"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Hand, KeyRound, ListChecks, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { AI_MODELS, aiModel, usdText } from "@/lib/domain/ai";
import { removeAiKey, saveAiKey, setAiEnabled, setAiModel, setAiPause, setAiPlantCap, setAiUserAccess, testAi, type AiActionResult } from "@/app/admin/ai/actions";

// The owner's page for the AI assistant: the key, the switch and the model,
// the plant's monthly cap, the brakes on what it changes and on automations,
// each person's access and allowance with what they have spent, every change
// it prepared or made, and the latest questions with what each cost.

export interface AiAdminUser {
  id: number;
  name: string;
  email: string;
  isOwner: boolean;
  active: boolean;
  enabled: boolean;
  monthlyUsd: number;
  spent: number;
  questions: number;
  lastAt: string | null;
}

export interface AiAdminData {
  hasKey: boolean;
  keyReadable: boolean;
  keyHint: string;
  enabled: boolean;
  model: string;
  plantCap: number;
  plantSpent: number;
  plantQuestions: number;
  lastMonthSpent: number;
  updatedBy: string | null;
  users: AiAdminUser[];
  actionsPaused: boolean;
  automationsPaused: boolean;
  changes: { id: number; at: string; who: string; title: string; summary: string; status: string; risk: string; auto: boolean; automationId: number | null; error: string | null }[];
  recent: { id: number; at: string; who: string; question: string; model: string; queries: number; tokens: number; costUsd: number; error: string | null; running: boolean }[];
}

type Msg = { ok: boolean; text: string } | null;

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const run = (fn: () => Promise<AiActionResult>, okText?: string, after?: () => void) => {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.message || okText ? { ok: true, text: r.message ?? okText! } : null) : { ok: false, text: r.error ?? "Failed." });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  };
  return { pending, msg, run };
}

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function AiAdmin({ data }: { data: AiAdminData }) {
  const capShare = data.plantCap > 0 ? Math.min(1, data.plantSpent / data.plantCap) : null;
  const people = data.users.filter((u) => u.enabled && u.active).length;
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        <Kpi label="This month" value={usdText(data.plantSpent)} sub={data.plantCap > 0 ? `of ${usdText(data.plantCap)}` : "no cap"} meter={capShare} />
        <Kpi label="Questions" value={String(data.plantQuestions)} sub={data.plantQuestions > 0 ? `${usdText(data.plantSpent / data.plantQuestions)} each` : undefined} />
        <Kpi label="Last month" value={usdText(data.lastMonthSpent)} />
        <Kpi label="People" value={String(people)} sub={data.enabled ? undefined : "closed — only you"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 items-start">
        <KeyCard data={data} />
        <SwitchCard data={data} />
      </div>

      <BrakesCard data={data} />
      <PeopleCard data={data} />
      <ChangesCard data={data} />
      <RecentCard data={data} />
    </div>
  );
}

function Kpi({ label, value, sub, meter }: { label: string; value: string; sub?: string; meter?: number | null }) {
  return (
    <div className="bg-surface border rounded-xl px-3 py-2.5 md:px-4 md:py-3 min-w-0">
      <div className="text-xs font-bold text-muted truncate">{label}</div>
      <div className="text-2xl md:text-[28px] font-semibold leading-tight ltr tabnum">{value}</div>
      {meter !== undefined && meter !== null && (
        <div className="h-1.5 mt-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--viz-1) 16%, var(--surface))" }}>
          <div className="h-full rounded-full" style={{ width: `${meter * 100}%`, background: meter >= 1 ? "var(--bad-fg)" : "var(--viz-1)" }} />
        </div>
      )}
      {sub && <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

const CARD = "bg-surface border rounded-xl p-4 md:p-5";

function KeyCard({ data }: { data: AiAdminData }) {
  const save = useRun();
  const test = useRun();
  const [key, setKey] = useState("");
  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className="text-sm font-extrabold flex flex-wrap items-center gap-2">
        <KeyRound size={16} /> Claude API key
        {data.hasKey ? (
          data.keyReadable ? <span className="pill pill-ok">••••{data.keyHint}</span> : <span className="pill pill-bad">Enter it again</span>
        ) : (
          <span className="pill pill-muted">Not set</span>
        )}
      </h2>
      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(() => saveAiKey(fd({ apiKey: key })), undefined, () => setKey(""));
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={data.hasKey ? "New key to replace it" : "sk-ant-… (console.anthropic.com)"}
          className="flex-1 min-w-0 px-2.5 py-1.5 text-base sm:text-sm ltr"
        />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary btn-sm flex-1 sm:flex-none" disabled={save.pending || !key.trim()}>
            {save.pending ? "Checking…" : data.hasKey ? "Replace" : "Save"}
          </button>
          {data.hasKey && (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={test.pending}
                onClick={() => test.run(() => testAi())}
                title="Checks the key with Claude, and that the database login is read-only"
              >
                <PlugZap size={14} /> {test.pending ? "Testing…" : "Test"}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={save.pending}
                onClick={() => confirm("Remove the API key? The assistant stops for everyone until a key is added.") && save.run(() => removeAiKey())}
                aria-label="Remove the key"
                title="Remove the key"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </form>
      <Note msg={save.msg} />
      <Note msg={test.msg} />
    </section>
  );
}

function SwitchCard({ data }: { data: AiAdminData }) {
  const sw = useRun();
  const mdl = useRun();
  const cap = useRun();
  const [capVal, setCapVal] = useState(data.plantCap > 0 ? String(data.plantCap) : "");
  return (
    <section className={`${CARD} space-y-3`}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-extrabold flex items-center gap-2 flex-1 min-w-0" title="On: the people ticked below get the AI button. Off: only you.">
          <Bot size={16} /> Open to the team
          <span className={`pill ${data.enabled ? "pill-ok" : "pill-muted"}`}>{data.enabled ? "ON" : "OFF"}</span>
        </h2>
        <button
          type="button"
          disabled={sw.pending}
          onClick={() => sw.run(() => setAiEnabled(fd({ on: String(!data.enabled) })))}
          className={`shrink-0 rounded-md px-3.5 py-1.5 text-sm font-bold text-white disabled:opacity-50 ${data.enabled ? "bg-bad-fg hover:opacity-90" : "bg-brand hover:bg-brand-dark"}`}
        >
          {sw.pending ? "Saving…" : data.enabled ? "Turn OFF" : "Turn ON"}
        </button>
      </div>
      <Note msg={sw.msg} />

      <fieldset className="border-t pt-3" title="For new chats — a chat keeps the model it started on. Price per million tokens, in / out.">
        <legend className="text-sm font-extrabold mb-1.5">Model</legend>
        <div className="grid gap-1.5">
          {AI_MODELS.map((m) => (
            <label key={m.id} className={`flex items-center gap-2.5 text-sm cursor-pointer rounded-lg border px-3 py-2 ${data.model === m.id ? "border-brand bg-brand-light/40" : ""}`} title={m.note}>
              <input
                type="radio"
                name="model"
                checked={data.model === m.id}
                disabled={mdl.pending}
                onChange={() => mdl.run(() => setAiModel(fd({ model: m.id })))}
                className="accent-[var(--brand,#1b7a43)]"
              />
              <span className="font-bold flex-1 min-w-0 truncate">{m.label}</span>
              <span className="text-xs text-muted tabnum shrink-0">${m.inUsd} / ${m.outUsd}</span>
            </label>
          ))}
        </div>
        <Note msg={mdl.msg} />
      </fieldset>

      <form
        className="border-t pt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          cap.run(() => setAiPlantCap(fd({ usd: capVal })));
        }}
        title="Everyone together, you included, from the 1st of each month. Empty = no cap."
      >
        <span className="text-sm font-extrabold flex-1 min-w-[8rem]">Monthly cap</span>
        <span className="text-sm font-bold">$</span>
        <input type="number" inputMode="decimal" min={0} step="0.5" value={capVal} onChange={(e) => setCapVal(e.target.value)} placeholder="none" className="w-24 px-2.5 py-1.5 text-base sm:text-sm tabnum" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={cap.pending}>Save</button>
        <div className="basis-full"><Note msg={cap.msg} /></div>
      </form>
    </section>
  );
}

function PeopleCard({ data }: { data: AiAdminData }) {
  const [onlyActive, setOnlyActive] = useState(true);
  const rows = data.users.filter((u) => !onlyActive || u.active);
  return (
    <section className={CARD}>
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-sm font-extrabold flex items-center gap-2 flex-1" title="A person's monthly limit is their own allowance in dollars (empty = none — the plant's cap still holds). The same ticks are on Users & Permissions.">
          <ShieldCheck size={16} /> Who may use it
        </h2>
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-[var(--brand,#1b7a43)]" />
          Active only
        </label>
      </div>
      <ul className="divide-y">
        {rows.map((u) => <PersonRow key={u.id} u={u} />)}
      </ul>
    </section>
  );
}

function PersonRow({ u }: { u: AiAdminUser }) {
  const r = useRun();
  const [on, setOn] = useState(u.enabled);
  const [usd, setUsd] = useState(u.monthlyUsd > 0 ? String(u.monthlyUsd) : "");
  const dirty = (Number(usd) || 0) !== u.monthlyUsd;
  const share = u.monthlyUsd > 0 ? Math.min(1, u.spent / u.monthlyUsd) : null;
  return (
    <li className={`py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 ${u.active ? "" : "opacity-60"}`}>
      <div className="flex-1 min-w-[11rem]">
        <div className="font-semibold flex items-center gap-1.5">
          <span className="truncate">{u.name}</span>
          {u.isOwner && <span className="pill pill-ok text-[10px]">owner</span>}
        </div>
        <div className="text-xs text-muted ltr truncate">{u.email}</div>
      </div>

      {u.isOwner ? (
        <span className="text-xs text-muted">Always · the plant&apos;s cap</span>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(on), usd })), "Saved.");
          }}
        >
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-sm font-semibold me-1">
            <input
              type="checkbox"
              checked={on}
              disabled={r.pending}
              onChange={(e) => {
                const next = e.target.checked;
                setOn(next);
                r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(next), usd })), next ? "Opened." : "Closed.");
              }}
              className="accent-[var(--brand,#1b7a43)] w-4 h-4"
            />
            AI
          </label>
          <span className="text-xs font-bold text-muted">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
            placeholder="no limit"
            aria-label={`${u.name}'s monthly limit in dollars`}
            className="w-24 px-2 py-1 text-base sm:text-sm tabnum"
          />
          {dirty && <button type="submit" className="btn btn-primary btn-sm" disabled={r.pending}>{r.pending ? "…" : "Save"}</button>}
        </form>
      )}

      <div className="w-32 text-end tabnum ms-auto">
        <div className="font-semibold text-sm">
          {usdText(u.spent)}
          {u.monthlyUsd > 0 && <span className="text-xs text-muted font-normal"> / {usdText(u.monthlyUsd)}</span>}
        </div>
        {share !== null && (
          <div className="h-1 mt-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--viz-1) 16%, var(--surface))" }}>
            <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: share >= 1 ? "var(--bad-fg)" : "var(--viz-1)" }} />
          </div>
        )}
        <div className="text-[11px] text-muted" title={u.lastAt ? `Last asked ${when(u.lastAt)}` : undefined}>
          {u.questions > 0 ? `${u.questions} question${u.questions === 1 ? "" : "s"}` : "—"}
        </div>
      </div>
      {r.msg && <div className={`basis-full text-xs font-semibold ${r.msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{r.msg.text}</div>}
    </li>
  );
}

function RecentCard({ data }: { data: AiAdminData }) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-extrabold mb-1">Latest questions</h2>
      {data.recent.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y max-h-[460px] overflow-y-auto">
          {data.recent.map((r) => (
            <li key={r.id} className="py-2 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" dir="auto" title={r.question}>{r.question}</div>
                <div className="text-[11px] text-muted">
                  {r.who} · {when(r.at)} · {aiModel(r.model).label}
                  {r.queries > 0 && ` · ${r.queries} look-up${r.queries === 1 ? "" : "s"}`}
                  {r.running && <span className="text-warn-fg"> · being answered</span>}
                  {r.error && <span className="text-bad-fg"> · {r.error}</span>}
                </div>
              </div>
              <div className="text-sm font-semibold tabnum shrink-0" title={`${r.tokens.toLocaleString("en")} tokens`}>{usdText(r.costUsd)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The owner's two brakes. Off is instant and needs no deployment: the
 *  assistant then only reads and advises, and automations wait. */
function BrakesCard({ data }: { data: AiAdminData }) {
  const act = useRun();
  const auto = useRun();
  const row = (title: string, help: string, paused: boolean, r: ReturnType<typeof useRun>, what: "actions" | "automations") => (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <div className="flex-1 min-w-[14rem]">
        <div className="text-sm font-bold flex items-center gap-2">
          {title}
          <span className={`pill ${paused ? "pill-bad" : "pill-ok"}`}>{paused ? "PAUSED" : "ON"}</span>
        </div>
        <div className="text-xs text-muted">{help}</div>
      </div>
      <button
        type="button"
        disabled={r.pending}
        onClick={() => r.run(() => setAiPause(fd({ what, paused: String(!paused) })))}
        className={`shrink-0 rounded-md px-3.5 py-1.5 text-sm font-bold text-white disabled:opacity-50 ${paused ? "bg-brand hover:bg-brand-dark" : "bg-bad-fg hover:opacity-90"}`}
      >
        {r.pending ? "Saving…" : paused ? "Start again" : "Pause"}
      </button>
      <div className="basis-full"><Note msg={r.msg} /></div>
    </div>
  );
  return (
    <section className={CARD}>
      <h2 className="text-sm font-extrabold flex items-center gap-2 mb-1">
        <Hand size={16} /> Brakes
      </h2>
      <div className="divide-y">
        {row("Changes by the assistant", "Paused: it only reads and advises — nothing it prepared can be approved, nothing small runs on its own. Who may have it change what is on Users & Permissions (AI assistant).", data.actionsPaused, act, "actions")}
        {row("Automations", "Paused: no automation fires and no scheduled report goes out; they stay saved and pick up again when started.", data.automationsPaused, auto, "automations")}
      </div>
    </section>
  );
}

const CHANGE_TONE: Record<string, string> = {
  proposed: "pill-info",
  executing: "pill-muted",
  executed: "pill-ok",
  failed: "pill-bad",
  rejected: "pill-muted",
  stale: "pill-warn",
  expired: "pill-muted",
  undone: "pill-muted",
};

/** Every change the assistant prepared or made, newest first — the record a
 *  click on Approve leaves, beside the app's own audit columns. */
function ChangesCard({ data }: { data: AiAdminData }) {
  const [status, setStatus] = useState("");
  const rows = data.changes.filter((c) => !status || c.status === status);
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-sm font-extrabold flex items-center gap-2 flex-1">
          <ListChecks size={16} /> Changes by the assistant
        </h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-2 py-1 text-sm" aria-label="Filter by what became of them">
          <option value="">All</option>
          {Object.keys(CHANGE_TONE).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y max-h-[460px] overflow-y-auto">
          {rows.map((c) => (
            <li key={c.id} className="py-2 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold flex flex-wrap items-center gap-1.5" dir="auto">
                  <span className="truncate">{c.title}</span>
                  <span className={`pill ${CHANGE_TONE[c.status] ?? "pill-muted"} text-[10px]`}>{c.status}</span>
                  {c.risk === "destructive" && <span className="pill pill-bad text-[10px]">deletion</span>}
                  {c.auto && <span className="pill pill-muted text-[10px]">without asking</span>}
                  {c.automationId && <span className="pill pill-muted text-[10px]">automation #{c.automationId}</span>}
                </div>
                <div className="text-xs text-muted truncate" dir="auto" title={c.summary}>{c.summary}</div>
                <div className="text-[11px] text-muted">
                  #{c.id} · {c.who} · {when(c.at)}
                  {c.error && <span className="text-bad-fg"> · {c.error}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
