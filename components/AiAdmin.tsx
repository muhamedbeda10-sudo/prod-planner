"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, Bot, Clock, Cpu, Gauge, KeyRound, ListChecks, PlugZap, Save, Settings2, Trash2, Users,
} from "lucide-react";
import { AI_CALLS_RANGE, AI_EFFORTS, AI_EFFORT_LABEL, AI_MODELS, aiModel, usdText, type AiEffort } from "@/lib/domain/ai";
import { WEEKDAY_NAMES, describeWindow } from "@/lib/domain/automations";
import { formatDateTime } from "@/lib/domain/format";
import {
  removeAiKey, removeAutomationClock, saveAiKey, setAiEnabled, setAiLimits, setAiModel, setAiPause, setAiUserAccess,
  setAutomationHours, setupAutomationClock, testAi, type AiActionResult,
} from "@/app/admin/ai/actions";
import { AutomationsView } from "@/components/AutomationsView";
import type { AutomationView } from "@/lib/server/automations/views";
import type { SchedulerStatus } from "@/lib/server/automations/scheduler";

// The owner's page for the AI assistant, in tabs across the whole page:
// General (the key and the main switches), Models (the chat's and the
// automations' model and effort), Limits (the plant's caps per day and month,
// steps per question), Automations (on/off, the hours they may run in, the
// morning review, the scheduler, everyone's automations), People (who may use
// it, each one's caps and spend) and Activity (what it changed, what it was asked).

export interface AiAdminUser {
  id: number;
  name: string;
  email: string;
  isOwner: boolean;
  active: boolean;
  enabled: boolean;
  monthlyUsd: number;
  dailyUsd: number;
  spent: number;
  spentToday: number;
  questions: number;
  lastAt: string | null;
}

export interface AiAdminData {
  hasKey: boolean;
  keyReadable: boolean;
  keyHint: string;
  enabled: boolean;
  chat: { model: string; effort: string };
  auto: { model: string; effort: string };
  plantCap: number;
  plantDayCap: number;
  maxCalls: number;
  plantSpent: number;
  plantQuestions: number;
  plantSpentToday: number;
  plantQuestionsToday: number;
  lastMonthSpent: number;
  actionsPaused: boolean;
  automationsPaused: boolean;
  hours: { from: string | null; to: string | null; weekdays: number[] };
  reviewAt: string;
  reviewPaused: boolean;
  updatedBy: string | null;
  users: AiAdminUser[];
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
      try {
        const r = await fn();
        setMsg(r.ok ? (r.message || okText ? { ok: true, text: r.message ?? okText! } : null) : { ok: false, text: r.error ?? "Failed." });
        if (r.ok) {
          after?.();
          router.refresh();
        }
      } catch {
        setMsg({ ok: false, text: "The request failed — refresh the page and try again." });
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

const when = (iso: string) => formatDateTime(iso);
const usdInput = (v: number) => (v > 0 ? String(v) : "");

const CARD = "bg-surface border rounded-xl p-4 md:p-5";

function CardHead({ icon: Icon, title, children }: { icon: typeof Bot; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <h3 className="text-sm font-extrabold flex items-center gap-2 flex-1 min-w-0"><Icon size={16} aria-hidden /> {title}</h3>
      {children}
    </div>
  );
}

/** An on/off switch. */
function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-[var(--brand)]" : "bg-[var(--border-strong)]"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/** One row of switches: a title, its state, the switch. */
function SwitchRow({ title, sub, on, onChange, pending, msg }: { title: string; sub?: string; on: boolean; onChange: (v: boolean) => void; pending: boolean; msg: Msg }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold">{title}</div>
          {sub && <div className="text-xs text-muted">{sub}</div>}
        </div>
        <span className={`text-xs font-bold ${on ? "text-ok-fg" : "text-muted"}`}>{on ? "ON" : "OFF"}</span>
        <Switch on={on} disabled={pending} onChange={onChange} label={title} />
      </div>
      <Note msg={msg} />
    </div>
  );
}

function Meter({ share }: { share: number | null }) {
  if (share === null) return null;
  return (
    <div className="h-1.5 mt-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--viz-1) 16%, var(--surface))" }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(1, share) * 100}%`, background: share >= 1 ? "var(--bad-fg)" : "var(--viz-1)" }} />
    </div>
  );
}

function Kpi({ label, value, sub, share }: { label: string; value: string; sub?: string; share?: number | null }) {
  return (
    <div className="bg-surface border rounded-xl px-3 py-2.5 md:px-4 md:py-3 min-w-0">
      <div className="text-xs font-bold text-muted truncate">{label}</div>
      <div className="text-2xl md:text-[28px] font-semibold leading-tight ltr tabnum">{value}</div>
      <Meter share={share ?? null} />
      {sub && <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

const TABS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "models", label: "Models", icon: Cpu },
  { id: "limits", label: "Limits", icon: Gauge },
  { id: "automations", label: "Automations", icon: Clock },
  { id: "people", label: "People", icon: Users },
  { id: "activity", label: "Activity", icon: Activity },
] as const;
type TabId = (typeof TABS)[number]["id"];

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function AiAdmin({ data, clock, automations }: { data: AiAdminData; clock: SchedulerStatus; automations: AutomationView[] }) {
  // the tab lives in the address (#models …), so a refresh stays on it
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  const tab: TabId = TABS.find((t) => t.id === hash)?.id ?? "general";
  const pick = (t: TabId) => {
    window.history.replaceState(null, "", `#${t}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  const people = data.users.filter((u) => u.enabled && u.active).length;
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title ltr flex items-center gap-2"><Bot size={20} aria-hidden /> AI settings</h1>
        <span className={`pill ${data.enabled ? "pill-ok" : "pill-muted"}`}>{data.enabled ? "Open to the team" : "Only you"}</span>
        {data.updatedBy && <span className="text-xs text-muted ms-auto">Last change by {data.updatedBy}</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 md:gap-3">
        <Kpi label="Today" value={usdText(data.plantSpentToday)} sub={data.plantDayCap > 0 ? `of ${usdText(data.plantDayCap)}` : `${data.plantQuestionsToday} question(s)`} share={data.plantDayCap > 0 ? data.plantSpentToday / data.plantDayCap : null} />
        <Kpi label="This month" value={usdText(data.plantSpent)} sub={data.plantCap > 0 ? `of ${usdText(data.plantCap)}` : "no cap"} share={data.plantCap > 0 ? data.plantSpent / data.plantCap : null} />
        <Kpi label="Questions this month" value={String(data.plantQuestions)} sub={data.plantQuestions > 0 ? `${usdText(data.plantSpent / data.plantQuestions)} each` : undefined} />
        <Kpi label="Last month" value={usdText(data.lastMonthSpent)} />
        <Kpi label="People" value={String(people)} sub={data.enabled ? undefined : "closed — only you"} />
      </div>

      <div role="tablist" aria-label="AI settings" className="tab-strip no-scrollbar flex items-center gap-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => pick(t.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-bold border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id ? "border-[var(--brand)] text-brand" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            <t.icon size={15} aria-hidden /> {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4 items-start">
          <KeyCard data={data} />
          <SwitchesCard data={data} />
        </div>
      )}
      {tab === "models" && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4 items-start">
          <ModelCard scope="chat" title="Chat" current={data.chat} />
          <ModelCard scope="auto" title="Automations & morning review" current={data.auto} />
        </div>
      )}
      {tab === "limits" && <LimitsCard data={data} />}
      {tab === "automations" && <AutomationsTab data={data} clock={clock} automations={automations} />}
      {tab === "people" && <PeopleCard data={data} />}
      {tab === "activity" && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4 items-start">
          <ChangesCard data={data} />
          <RecentCard data={data} />
        </div>
      )}
    </div>
  );
}

// ---- General ----

function KeyCard({ data }: { data: AiAdminData }) {
  const save = useRun();
  const test = useRun();
  const [key, setKey] = useState("");
  return (
    <section className={CARD}>
      <CardHead icon={KeyRound} title="Claude API key">
        {data.hasKey ? (
          data.keyReadable ? <span className="pill pill-ok">••••{data.keyHint}</span> : <span className="pill pill-bad">Enter it again</span>
        ) : (
          <span className="pill pill-muted">Not set</span>
        )}
      </CardHead>
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
          placeholder={data.hasKey ? "New key to replace it" : "sk-ant-…"}
          className="flex-1 min-w-0 px-2.5 py-1.5 text-base sm:text-sm ltr"
        />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary btn-sm flex-1 sm:flex-none" disabled={save.pending || !key.trim()}>
            {save.pending ? "Checking…" : data.hasKey ? "Replace" : "Save"}
          </button>
          {data.hasKey && (
            <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={test.pending} onClick={() => test.run(() => testAi())} title="Checks the key, and that the database login is read-only">
                <PlugZap size={14} aria-hidden /> {test.pending ? "Testing…" : "Test"}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={save.pending}
                onClick={() => confirm("Remove the API key? The assistant stops for everyone until a key is added.") && save.run(() => removeAiKey())}
                aria-label="Remove the key"
                title="Remove the key"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </>
          )}
        </div>
      </form>
      <div className="mt-2 space-y-1">
        <Note msg={save.msg} />
        <Note msg={test.msg} />
      </div>
    </section>
  );
}

function SwitchesCard({ data }: { data: AiAdminData }) {
  const team = useRun();
  const act = useRun();
  return (
    <section className={CARD}>
      <CardHead icon={Bot} title="Assistant" />
      <div className="divide-y">
        <SwitchRow
          title="Open to the team"
          sub="Off: only you."
          on={data.enabled}
          pending={team.pending}
          msg={team.msg}
          onChange={(v) => team.run(() => setAiEnabled(fd({ on: String(v) })))}
        />
        <SwitchRow
          title="Changes by the assistant"
          sub="Off: it only reads and advises."
          on={!data.actionsPaused}
          pending={act.pending}
          msg={act.msg}
          onChange={(v) => act.run(() => setAiPause(fd({ what: "actions", paused: String(!v) })))}
        />
      </div>
    </section>
  );
}

// ---- Models ----

const EFFORT_HINT: Record<AiEffort, string> = {
  low: "Fastest and cheapest — simple look-ups.",
  medium: "Balanced — everyday questions.",
  high: "Thinks harder — plans and analysis.",
  xhigh: "Deep work — slower, costs more.",
  max: "Hardest problems — slowest, costs the most.",
};

function ModelCard({ scope, title, current }: { scope: "chat" | "auto"; title: string; current: { model: string; effort: string } }) {
  const r = useRun();
  const [model, setModel] = useState(current.model);
  const [effort, setEffort] = useState<AiEffort>((AI_EFFORTS as readonly string[]).includes(current.effort) ? (current.effort as AiEffort) : "medium");
  const dirty = model !== current.model || effort !== current.effort;
  return (
    <section className={CARD}>
      <CardHead icon={Cpu} title={title}>
        <span className="text-xs text-muted">{aiModel(current.model).label} · {AI_EFFORT_LABEL[(current.effort as AiEffort)] ?? current.effort}</span>
      </CardHead>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-bold text-muted mb-1.5">Model</legend>
        {AI_MODELS.map((m) => (
          <label key={m.id} className={`flex items-center gap-3 text-sm cursor-pointer rounded-lg border px-3 py-2 ${model === m.id ? "border-[var(--brand)] bg-brand-light/40" : "hover:bg-surface-2"}`}>
            <input type="radio" name={`model-${scope}`} checked={model === m.id} onChange={() => setModel(m.id)} className="accent-[var(--brand)]" />
            <span className="flex-1 min-w-0">
              <span className="font-bold block truncate">{m.label}</span>
              <span className="text-xs text-muted block truncate">{m.note}</span>
            </span>
            <span className="text-xs text-muted tabnum shrink-0" title="US dollars per million tokens, in / out">${m.inUsd} / ${m.outUsd}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="mt-4">
        <legend className="text-xs font-bold text-muted mb-1.5">Effort</legend>
        <div className="grid grid-cols-5 gap-1 rounded-lg border p-1 bg-surface-2">
          {AI_EFFORTS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setEffort(e)}
              aria-pressed={effort === e}
              className={`rounded-md px-1 py-1.5 text-xs sm:text-sm font-bold transition-colors ${effort === e ? "bg-[var(--brand)] text-white shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              {AI_EFFORT_LABEL[e]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mt-1.5">{EFFORT_HINT[effort]}</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Note msg={r.msg} />
        <button
          type="button"
          className="btn btn-primary btn-sm ms-auto"
          disabled={!dirty || r.pending}
          onClick={() => r.run(() => setAiModel(fd({ scope, model, effort })))}
        >
          <Save size={14} aria-hidden /> {r.pending ? "Saving…" : "Save"}
        </button>
      </div>
      {scope === "chat" && <p className="text-[11px] text-muted mt-2">An open chat keeps its model; effort applies from the next question.</p>}
    </section>
  );
}

// ---- Limits ----

function LimitsCard({ data }: { data: AiAdminData }) {
  const r = useRun();
  const [daily, setDaily] = useState(usdInput(data.plantDayCap));
  const [monthly, setMonthly] = useState(usdInput(data.plantCap));
  const [calls, setCalls] = useState(String(data.maxCalls));
  const field = (label: string, value: string, set: (v: string) => void, spent: string, sub: string) => (
    <label className="block">
      <span className="text-xs font-bold text-muted">{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <span className="text-sm font-bold">$</span>
        <input type="number" inputMode="decimal" min={0} step="0.5" value={value} onChange={(e) => set(e.target.value)} placeholder="no cap" className="w-full px-2.5 py-1.5 text-base sm:text-sm tabnum" />
      </span>
      <span className="text-xs text-muted mt-1 block tabnum">{spent} · {sub}</span>
    </label>
  );
  return (
    <section className={CARD}>
      <CardHead icon={Gauge} title="Plant limits" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          r.run(() => setAiLimits(fd({ dailyUsd: daily, monthlyUsd: monthly, maxCalls: calls })));
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {field("Daily cap", daily, setDaily, `${usdText(data.plantSpentToday)} today`, "Cairo day")}
          {field("Monthly cap", monthly, setMonthly, `${usdText(data.plantSpent)} this month`, "from the 1st")}
          <label className="block">
            <span className="text-xs font-bold text-muted">Steps per question</span>
            <input
              type="number"
              inputMode="numeric"
              min={AI_CALLS_RANGE.min}
              max={AI_CALLS_RANGE.max}
              step={1}
              value={calls}
              onChange={(e) => setCalls(e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 text-base sm:text-sm tabnum"
            />
            <span className="text-xs text-muted mt-1 block">{AI_CALLS_RANGE.min}–{AI_CALLS_RANGE.max} look-ups or changes before it must answer</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Note msg={r.msg} />
          <button type="submit" className="btn btn-primary btn-sm ms-auto" disabled={r.pending}><Save size={14} aria-hidden /> {r.pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
      <p className="text-[11px] text-muted mt-3">Everyone together, you included. Each person&apos;s own caps are on the People tab.</p>
    </section>
  );
}

// ---- Automations ----

function AutomationsTab({ data, clock, automations }: { data: AiAdminData; clock: SchedulerStatus; automations: AutomationView[] }) {
  const onOff = useRun();
  const review = useRun();
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4 items-start">
        <div className="space-y-3 md:space-y-4">
        <section className={CARD}>
          <CardHead icon={Clock} title="Automations" />
          <div className="divide-y">
            <SwitchRow
              title="Automations"
              sub={describeWindow({ from: data.hours.from, to: data.hours.to, weekdays: data.hours.weekdays })}
              on={!data.automationsPaused}
              pending={onOff.pending}
              msg={onOff.msg}
              onChange={(v) => onOff.run(() => setAiPause(fd({ what: "automations", paused: String(!v) })))}
            />
            <SwitchRow
              title="Morning review"
              sub={`Working days from ${data.reviewAt}`}
              on={!data.reviewPaused}
              pending={review.pending}
              msg={review.msg}
              onChange={(v) => review.run(() => setAiPause(fd({ what: "review", paused: String(!v) })))}
            />
          </div>
        </section>
        <SchedulerCard clock={clock} />
        </div>
        <HoursCard data={data} />
      </div>
      <section className={CARD}>
        <CardHead icon={ListChecks} title="Everyone's automations">
          <span className="text-xs text-muted">{automations.filter((a) => !a.deleted).length}</span>
        </CardHead>
        <AutomationsView automations={automations} showOwner canTime />
      </section>
    </div>
  );
}

function HoursCard({ data }: { data: AiAdminData }) {
  const r = useRun();
  const [allDay, setAllDay] = useState(!data.hours.from);
  const [from, setFrom] = useState(data.hours.from ?? "07:00");
  const [to, setTo] = useState(data.hours.to ?? "19:00");
  const [days, setDays] = useState<number[]>(data.hours.weekdays.length ? data.hours.weekdays : [0, 1, 2, 3, 4, 5, 6]);
  const [reviewAt, setReviewAt] = useState(data.reviewAt);
  return (
    <section className={CARD}>
      <CardHead icon={Clock} title="When they run" />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          r.run(() => setAutomationHours(fd({ allDay: String(allDay), from, to, weekdays: days.join(","), reviewAt })));
        }}
      >
        <div>
          <p className="text-xs font-bold text-muted mb-1.5">Hours (Cairo)</p>
          <label className="inline-flex items-center gap-1.5 text-sm font-semibold cursor-pointer mb-2">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--brand)] w-4 h-4" />
            All day
          </label>
          <div className={`flex flex-wrap items-center gap-2 text-sm ${allDay ? "opacity-50" : ""}`}>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} disabled={allDay} className="w-36 px-2 py-1 text-sm tabnum" aria-label="From" />
            <span>to</span>
            <input type="time" value={to} onChange={(e) => setTo(e.target.value)} disabled={allDay} className="w-36 px-2 py-1 text-sm tabnum" aria-label="To" />
          </div>
        </div>
        <div>
          <p className="text-xs font-bold text-muted mb-1.5">Days</p>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_NAMES.map((n, d) => (
              <label key={n} className={`pill cursor-pointer select-none ${days.includes(d) ? "pill-ok" : "pill-muted"}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={days.includes(d)}
                  onChange={(e) => setDays((ds) => (e.target.checked ? [...ds, d].sort() : ds.filter((x) => x !== d)))}
                />
                {n.slice(0, 3)}
              </label>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="text-xs font-bold text-muted">Morning review at</span>
          <input type="time" value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} className="mt-1 block w-36 px-2 py-1 text-sm tabnum" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Note msg={r.msg} />
          <button type="submit" className="btn btn-primary btn-sm ms-auto" disabled={r.pending}><Save size={14} aria-hidden /> {r.pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
      <p className="text-[11px] text-muted mt-3">Outside these hours a scheduled run is skipped; a watch catches up at its next check inside them.</p>
    </section>
  );
}

function SchedulerCard({ clock }: { clock: SchedulerStatus }) {
  const r = useRun();
  const failing = clock.lastJobRuns.find((x) => x.status !== "succeeded");
  return (
    <section className={CARD}>
      <CardHead icon={PlugZap} title="Scheduler">
        <span className={`pill ${clock.scheduled ? "pill-ok" : "pill-warn"}`}>{clock.scheduled ? "On time" : "Not set up"}</span>
      </CardHead>
      <div className="text-sm space-y-1">
        <p className="text-muted">
          {clock.scheduled ? "The database calls the app every minute." : "Automations run only while the app is open somewhere."}
          {clock.lastTickAt ? ` Last tick ${when(clock.lastTickAt)}.` : ""}
        </p>
        {failing && <p className="text-bad-fg">Last run: {failing.status}{failing.message ? ` — ${failing.message}` : ""}</p>}
        {clock.error && <p className="text-bad-fg">{clock.error}</p>}
      </div>
      <div className="flex flex-wrap gap-2 items-center mt-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={r.pending}
          onClick={() => (!clock.scheduled || confirm("Set the scheduler up again? It gets a new secret; the old one stops at once.")) && r.run(() => setupAutomationClock())}
        >
          {clock.scheduled ? "Set up again" : "Set up"}
        </button>
        {clock.scheduled && (
          <button type="button" className="btn btn-sm" disabled={r.pending} onClick={() => confirm("Remove the scheduler? Automations will then run only while the app is open.") && r.run(() => removeAutomationClock())}>
            Remove
          </button>
        )}
      </div>
      <div className="mt-2"><Note msg={r.msg} /></div>
    </section>
  );
}

// ---- People ----

function PeopleCard({ data }: { data: AiAdminData }) {
  const [onlyActive, setOnlyActive] = useState(true);
  const rows = data.users.filter((u) => !onlyActive || u.active);
  return (
    <section className={CARD}>
      <CardHead icon={Users} title="Who may use it">
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-[var(--brand)]" />
          Active only
        </label>
      </CardHead>
      <div className="overflow-x-auto -mx-4 md:-mx-5">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr>
              <th className="text-start px-4 md:px-5">Person</th>
              <th className="text-start">Access</th>
              <th className="text-start">Daily cap</th>
              <th className="text-start">Monthly cap</th>
              <th className="text-end">Today</th>
              <th className="text-end">This month</th>
              <th className="text-end px-4 md:px-5">Questions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => <PersonRow key={u.id} u={u} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PersonRow({ u }: { u: AiAdminUser }) {
  const r = useRun();
  const [on, setOn] = useState(u.enabled);
  const [usd, setUsd] = useState(usdInput(u.monthlyUsd));
  const [dayUsd, setDayUsd] = useState(usdInput(u.dailyUsd));
  const dirty = (Number(usd) || 0) !== u.monthlyUsd || (Number(dayUsd) || 0) !== u.dailyUsd;
  const save = (enabled: boolean, okText: string) => r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(enabled), usd, dayUsd })), okText);
  const cap = (value: string, set: (v: string) => void, label: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs font-bold text-muted">$</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.5"
        value={value}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) save(on, "Saved.");
        }}
        placeholder="none"
        aria-label={`${u.name}'s ${label} in dollars`}
        className="w-20 px-2 py-1 text-sm tabnum"
      />
    </span>
  );
  return (
    <tr className={u.active ? "" : "opacity-60"}>
      <td className="px-4 md:px-5">
        <div className="font-semibold flex items-center gap-1.5">
          <span className="truncate">{u.name}</span>
          {u.isOwner && <span className="pill pill-ok text-[10px]">owner</span>}
        </div>
        <div className="text-xs text-muted ltr truncate max-w-[16rem]">{u.email}</div>
        {r.msg && <div className={`text-xs font-semibold ${r.msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{r.msg.text}</div>}
      </td>
      {u.isOwner ? (
        <td colSpan={3} className="text-xs text-muted">Always — the plant&apos;s limits apply</td>
      ) : (
        <>
          <td>
            <Switch
              on={on}
              disabled={r.pending}
              label={`AI for ${u.name}`}
              onChange={(next) => {
                setOn(next);
                save(next, next ? "Opened." : "Closed.");
              }}
            />
          </td>
          <td>{cap(dayUsd, setDayUsd, "daily cap")}</td>
          <td>
            <span className="inline-flex items-center gap-2">
              {cap(usd, setUsd, "monthly cap")}
              {dirty && <button type="button" className="btn btn-primary btn-sm" disabled={r.pending} onClick={() => save(on, "Saved.")}>{r.pending ? "…" : "Save"}</button>}
            </span>
          </td>
        </>
      )}
      <td className="text-end tabnum">
        {usdText(u.spentToday)}
        {u.dailyUsd > 0 && <span className="text-xs text-muted"> / {usdText(u.dailyUsd)}</span>}
      </td>
      <td className="text-end tabnum">
        {usdText(u.spent)}
        {u.monthlyUsd > 0 && <span className="text-xs text-muted"> / {usdText(u.monthlyUsd)}</span>}
      </td>
      <td className="text-end tabnum px-4 md:px-5" title={u.lastAt ? `Last asked ${when(u.lastAt)}` : undefined}>{u.questions || "—"}</td>
    </tr>
  );
}

// ---- Activity ----

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

/** Every change the assistant prepared or made, newest first. */
function ChangesCard({ data }: { data: AiAdminData }) {
  const [status, setStatus] = useState("");
  const rows = data.changes.filter((c) => !status || c.status === status);
  return (
    <section className={CARD}>
      <CardHead icon={ListChecks} title="Changes by the assistant">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-2 py-1 text-sm" aria-label="Filter by status">
          <option value="">All</option>
          {Object.keys(CHANGE_TONE).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </CardHead>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto">
          {rows.map((c) => (
            <li key={c.id} className="py-2">
              <div className="text-sm font-semibold flex flex-wrap items-center gap-1.5" dir="auto">
                <span className="truncate">{c.title}</span>
                <span className={`pill ${CHANGE_TONE[c.status] ?? "pill-muted"} text-[10px]`}>{c.status}</span>
                {c.risk === "destructive" && <span className="pill pill-bad text-[10px]">deletion</span>}
                {c.auto && <span className="pill pill-muted text-[10px]">auto</span>}
                {c.automationId && <span className="pill pill-muted text-[10px]">automation #{c.automationId}</span>}
              </div>
              <div className="text-xs text-muted truncate" dir="auto" title={c.summary}>{c.summary}</div>
              <div className="text-[11px] text-muted">
                #{c.id} · {c.who} · {when(c.at)}
                {c.error && <span className="text-bad-fg"> · {c.error}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentCard({ data }: { data: AiAdminData }) {
  return (
    <section className={CARD}>
      <CardHead icon={Activity} title="Latest questions" />
      {data.recent.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto">
          {data.recent.map((r) => (
            <li key={r.id} className="py-2 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" dir="auto" title={r.question}>{r.question}</div>
                <div className="text-[11px] text-muted">
                  {r.who} · {when(r.at)} · {aiModel(r.model).label}
                  {r.queries > 0 && ` · ${r.queries} look-up${r.queries === 1 ? "" : "s"}`}
                  {r.running && <span className="text-warn-fg"> · running</span>}
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
