"use client";

import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, Bot, ChevronDown, Clock, Cpu, Gauge, KeyRound, ListChecks, MessageSquare, PlugZap, Save, Settings2, Trash2, Users,
} from "lucide-react";
import { AI_CALLS_RANGE, AI_EFFORTS, AI_EFFORT_LABEL, AI_MODELS, aiModel, usdText, type AiEffort } from "@/lib/domain/ai";
import { WEEKDAY_NAMES, describeWindow } from "@/lib/domain/automations";
import { AI_PERM_GROUPS, permDef } from "@/lib/domain/permissions";
import { formatDateTime } from "@/lib/domain/format";
import {
  removeAiKey, removeAutomationClock, saveAiKey, setAiEnabled, setAiLimits, setAiModel, setAiPause, setAiUserAccess, setAiUserRights,
  setAutomationHours, setupAutomationClock, testAi, type AiActionResult,
} from "@/app/admin/ai/actions";
import { AutomationsView } from "@/components/AutomationsView";
import { EmptyState, Note, SectionCard, SettingRow, Switch, Tabs } from "@/components/primitives";
import type { AutomationView } from "@/lib/server/automations/views";
import type { SchedulerStatus } from "@/lib/server/automations/scheduler";

// The owner's page for the AI assistant: the figures for the day and the
// month across the top, then its settings in sections — down the side on a
// wide screen, as tabs on a small one. General (the key and the main
// switches), Models (the chat's and the automations' model and effort),
// Limits (the plant's caps per day and month, steps per question),
// Automations (on/off, the hours they may run in, the morning review, the
// scheduler, everyone's automations), People (who may use it, what it may do
// for each — never more than they may themselves — each one's caps and
// spend) and Activity (what it changed, what it was asked).

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
  /** What the assistant may do for them (the owner's access rights are implied). */
  aiKeys: string[];
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

/** Runs one server action: pending while it runs, its answer under the control, the page re-read when it worked. */
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

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const when = (iso: string) => formatDateTime(iso);
const usdInput = (v: number) => (v > 0 ? String(v) : "");

const INPUT = "px-2.5 py-1.5 text-base sm:text-sm";

/** A dollar amount — empty for no cap. */
function UsdInput({ value, onChange, label, onEnter }: { value: string; onChange: (v: string) => void; label: string; onEnter?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-sm font-bold text-muted">$</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder="no cap"
        aria-label={label}
        className={`w-28 tabnum ${INPUT}`}
      />
    </span>
  );
}

/** One switch with its answer under it. */
function SwitchRow({ title, hint, on, onChange, pending, msg }: { title: string; hint?: ReactNode; on: boolean; onChange: (v: boolean) => void; pending: boolean; msg: Msg }) {
  return (
    <SettingRow
      title={title}
      hint={
        <>
          {hint}
          <Note msg={msg} className="mt-1" />
        </>
      }
    >
      <span className={`text-xs font-bold ${on ? "text-ok-fg" : "text-muted"}`}>{on ? "On" : "Off"}</span>
      <Switch on={on} disabled={pending} onChange={onChange} label={title} />
    </SettingRow>
  );
}

/** A form's foot: the answer, then Save at the end. */
function SaveBar({ msg, pending, disabled = false, label = "Save" }: { msg: Msg; pending: boolean; disabled?: boolean; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-4 mt-3 border-t">
      <Note msg={msg} />
      <button type="submit" className="btn btn-primary btn-sm ms-auto" disabled={pending || disabled}>
        <Save size={14} aria-hidden /> {pending ? "Saving…" : label}
      </button>
    </div>
  );
}

// ---- The figures ----

function Kpi({ label, value, sub, share }: { label: string; value: string; sub?: string; share?: number | null }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value ltr">{value}</div>
      {share !== null && share !== undefined && (
        <div className={`kpi-meter ${share >= 1 ? "kpi-meter-over" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, share) * 100)} aria-label={label}>
          <span style={{ width: `${Math.min(1, share) * 100}%` }} />
        </div>
      )}
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ---- The sections ----

const SECTIONS = [
  { id: "general", label: "General", desc: "The key and the main switches", icon: Settings2 },
  { id: "models", label: "Models", desc: "Which Claude, how hard it thinks", icon: Cpu },
  { id: "limits", label: "Limits", desc: "Spend caps, steps per question", icon: Gauge },
  { id: "automations", label: "Automations", desc: "Hours, the morning review, the scheduler", icon: Clock },
  { id: "people", label: "People", desc: "Access, caps and rights", icon: Users },
  { id: "activity", label: "Activity", desc: "What it changed and was asked", icon: Activity },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function AiAdmin({ data, clock, automations }: { data: AiAdminData; clock: SchedulerStatus; automations: AutomationView[] }) {
  // the section lives in the address (#models …), so a refresh stays on it
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  const section: SectionId = SECTIONS.find((t) => t.id === hash)?.id ?? "general";
  const pick = (t: SectionId) => {
    window.history.replaceState(null, "", `#${t}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  const people = data.users.filter((u) => u.enabled && u.active).length;
  return (
    <div className="space-y-4">
      <div className="page-head">
        <h1 className="page-title flex items-center gap-2">
          <Bot size={20} className="text-brand" aria-hidden /> AI settings
        </h1>
        <span className={`pill ${data.enabled ? "pill-ok" : "pill-muted"}`}>{data.enabled ? "Open to the team" : "Only you"}</span>
        {data.updatedBy && <span className="text-xs text-muted ms-auto">Last change by {data.updatedBy}</span>}
      </div>

      <div className="kpi-strip">
        <Kpi label="Today" value={usdText(data.plantSpentToday)} sub={data.plantDayCap > 0 ? `of ${usdText(data.plantDayCap)} · ${data.plantQuestionsToday} question${data.plantQuestionsToday === 1 ? "" : "s"}` : `${data.plantQuestionsToday} question${data.plantQuestionsToday === 1 ? "" : "s"} · no daily cap`} share={data.plantDayCap > 0 ? data.plantSpentToday / data.plantDayCap : null} />
        <Kpi label="This month" value={usdText(data.plantSpent)} sub={data.plantCap > 0 ? `of ${usdText(data.plantCap)}` : "no monthly cap"} share={data.plantCap > 0 ? data.plantSpent / data.plantCap : null} />
        <Kpi label="Questions this month" value={String(data.plantQuestions)} sub={data.plantQuestions > 0 ? `${usdText(data.plantSpent / data.plantQuestions)} each` : "none yet"} />
        <Kpi label="Last month" value={usdText(data.lastMonthSpent)} />
        <Kpi label="People" value={String(people)} sub={data.enabled ? "with the assistant" : "closed — only you"} />
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="AI settings sections">
          {SECTIONS.map((s) => {
            const on = s.id === section;
            return (
              <button key={s.id} type="button" onClick={() => pick(s.id)} className={`settings-nav-item ${on ? "settings-nav-active" : ""}`} aria-current={on ? "page" : undefined}>
                <span className="settings-nav-icon"><s.icon size={15} aria-hidden /></span>
                <span className="min-w-0">
                  <span className="settings-nav-label block">{s.label}</span>
                  <span className="settings-nav-desc block truncate">{s.desc}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <Tabs
          className="settings-tabs"
          label="AI settings sections"
          items={SECTIONS.map((s) => ({ id: s.id, label: s.label, icon: s.icon }))}
          value={section}
          onChange={(id) => pick(id as SectionId)}
        />
        <div className="min-w-0 space-y-4">
          {section === "general" && <GeneralSection data={data} />}
          {section === "models" && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              <ModelCard scope="chat" title="Chat" description="Answers the questions people ask it." current={data.chat} />
              <ModelCard scope="auto" title="Automations & morning review" description="Runs by itself — reports, watches, the morning review." current={data.auto} />
            </div>
          )}
          {section === "limits" && <LimitsCard data={data} />}
          {section === "automations" && <AutomationsSection data={data} clock={clock} automations={automations} />}
          {section === "people" && <PeopleCard data={data} />}
          {section === "activity" && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              <ChangesCard data={data} />
              <RecentCard data={data} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- General ----

function GeneralSection({ data }: { data: AiAdminData }) {
  const team = useRun();
  const act = useRun();
  return (
    <>
      <KeyCard data={data} />
      <SectionCard icon={Bot} title="Assistant" description="The main switches. Who exactly may use it, and what it may do for each, is under People.">
        <SwitchRow
          title="Open to the team"
          hint="Off: only you can use it. The people it is open to keep their settings for when it opens again."
          on={data.enabled}
          pending={team.pending}
          msg={team.msg}
          onChange={(v) => team.run(() => setAiEnabled(fd({ on: String(v) })))}
        />
        <SwitchRow
          title="Changes by the assistant"
          hint="Off: it only reads and advises — nothing can be prepared or approved, in a chat or by an automation."
          on={!data.actionsPaused}
          pending={act.pending}
          msg={act.msg}
          onChange={(v) => act.run(() => setAiPause(fd({ what: "actions", paused: String(!v) })))}
        />
      </SectionCard>
    </>
  );
}

function KeyCard({ data }: { data: AiAdminData }) {
  const save = useRun();
  const test = useRun();
  const [key, setKey] = useState("");
  const status = data.hasKey ? (
    data.keyReadable ? <span className="pill pill-ok ltr">••••{data.keyHint}</span> : <span className="pill pill-bad">Enter it again</span>
  ) : (
    <span className="pill pill-muted">Not set</span>
  );
  return (
    <SectionCard icon={KeyRound} title="Claude API key" description="What the assistant calls Claude with. Kept encrypted — only its last characters are ever shown." end={status}>
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
          placeholder={data.hasKey ? "A new key to replace it" : "sk-ant-…"}
          aria-label="Claude API key"
          className={`flex-1 min-w-0 ltr ${INPUT}`}
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
                className="btn btn-secondary btn-sm text-bad-fg"
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
      {(save.msg || test.msg) && (
        <div className="mt-2 space-y-1">
          <Note msg={save.msg} />
          <Note msg={test.msg} />
        </div>
      )}
    </SectionCard>
  );
}

// ---- Models ----

const EFFORT_HINT: Record<AiEffort, string> = {
  low: "Fastest and cheapest — simple look-ups.",
  medium: "Balanced — everyday questions.",
  high: "Thinks harder — plans and analysis.",
  xhigh: "Deep work — slower, costs more.",
  max: "The hardest problems — slowest, costs the most.",
};

function ModelCard({ scope, title, description, current }: { scope: "chat" | "auto"; title: string; description: string; current: { model: string; effort: string } }) {
  const r = useRun();
  const [model, setModel] = useState(current.model);
  const [effort, setEffort] = useState<AiEffort>((AI_EFFORTS as readonly string[]).includes(current.effort) ? (current.effort as AiEffort) : "medium");
  const dirty = model !== current.model || effort !== current.effort;
  return (
    <SectionCard
      icon={scope === "chat" ? MessageSquare : Clock}
      title={title}
      description={description}
      end={<span className="text-xs text-muted whitespace-nowrap">{aiModel(current.model).label} · {AI_EFFORT_LABEL[current.effort as AiEffort] ?? current.effort}</span>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          r.run(() => setAiModel(fd({ scope, model, effort })));
        }}
      >
        <fieldset>
          <legend className="filter-label mb-2">Model</legend>
          <div className="space-y-1.5">
            {AI_MODELS.map((m) => (
              <label key={m.id} className={`option ${model === m.id ? "option-on" : ""}`}>
                <input type="radio" name={`model-${scope}`} value={m.id} checked={model === m.id} onChange={() => setModel(m.id)} className="sr-only" />
                <span className="option-radio" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold truncate">{m.label}</span>
                  <span className="block text-xs text-muted truncate">{m.note}</span>
                </span>
                <span className="text-xs text-muted tabnum ltr shrink-0 text-end" title="US dollars per million tokens — in / out">
                  ${m.inUsd} / ${m.outUsd}
                  <span className="block text-[10px] opacity-80">per 1M tokens</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="filter-label mb-2">Effort</legend>
          <div className="segmented w-full">
            {AI_EFFORTS.map((e) => (
              <button key={e} type="button" onClick={() => setEffort(e)} aria-pressed={effort === e}>
                {AI_EFFORT_LABEL[e]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-2">{EFFORT_HINT[effort]}</p>
        </fieldset>
        <SaveBar msg={r.msg} pending={r.pending} disabled={!dirty} />
      </form>
      {scope === "chat" && <p className="text-xs text-muted mt-3">An open chat keeps its model; the effort applies from the next question.</p>}
    </SectionCard>
  );
}

// ---- Limits ----

function LimitsCard({ data }: { data: AiAdminData }) {
  const r = useRun();
  const [daily, setDaily] = useState(usdInput(data.plantDayCap));
  const [monthly, setMonthly] = useState(usdInput(data.plantCap));
  const [calls, setCalls] = useState(String(data.maxCalls));
  return (
    <SectionCard icon={Gauge} title="Plant limits" description="Everyone together, you included. When a cap is reached the assistant answers no one until it resets. Each person's own caps are under People.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          r.run(() => setAiLimits(fd({ dailyUsd: daily, monthlyUsd: monthly, maxCalls: calls })));
        }}
      >
        <SettingRow title="Daily cap" hint={<>{usdText(data.plantSpentToday)} spent today · a Cairo day, from midnight</>}>
          <UsdInput value={daily} onChange={setDaily} label="Daily cap in dollars" />
        </SettingRow>
        <SettingRow title="Monthly cap" hint={<>{usdText(data.plantSpent)} spent this month · from the 1st</>}>
          <UsdInput value={monthly} onChange={setMonthly} label="Monthly cap in dollars" />
        </SettingRow>
        <SettingRow title="Steps per question" hint={<>{AI_CALLS_RANGE.min}–{AI_CALLS_RANGE.max} look-ups or changes before it must answer. More steps answer harder questions, and cost more.</>}>
          <input
            type="number"
            inputMode="numeric"
            min={AI_CALLS_RANGE.min}
            max={AI_CALLS_RANGE.max}
            step={1}
            value={calls}
            onChange={(e) => setCalls(e.target.value)}
            aria-label="Steps per question"
            className={`w-28 tabnum ${INPUT}`}
          />
        </SettingRow>
        <SaveBar msg={r.msg} pending={r.pending} />
      </form>
    </SectionCard>
  );
}

// ---- Automations ----

function AutomationsSection({ data, clock, automations }: { data: AiAdminData; clock: SchedulerStatus; automations: AutomationView[] }) {
  const onOff = useRun();
  const review = useRun();
  const live = automations.filter((a) => !a.deleted).length;
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <div className="space-y-4">
          <SectionCard icon={Clock} title="Automations" description="What the assistant does by itself: reports on a schedule, watches that act, the morning review.">
            <SwitchRow
              title="Automations"
              hint={<>Off: none runs, for anyone. {describeWindow({ from: data.hours.from, to: data.hours.to, weekdays: data.hours.weekdays })}.</>}
              on={!data.automationsPaused}
              pending={onOff.pending}
              msg={onOff.msg}
              onChange={(v) => onOff.run(() => setAiPause(fd({ what: "automations", paused: String(!v) })))}
            />
            <SwitchRow
              title="Morning review"
              hint={<>Its own look at the plant each working day, from {data.reviewAt} — suggestions land in the inbox.</>}
              on={!data.reviewPaused}
              pending={review.pending}
              msg={review.msg}
              onChange={(v) => review.run(() => setAiPause(fd({ what: "review", paused: String(!v) })))}
            />
          </SectionCard>
          <SchedulerCard clock={clock} />
        </div>
        <HoursCard data={data} />
      </div>
      <SectionCard
        icon={ListChecks}
        title="Everyone's automations"
        description="Every automation in the plant, whose it is, and when it last ran. Each is timed, paused, tested and deleted here."
        end={<span className="pill pill-muted tabnum">{live}</span>}
      >
        <AutomationsView automations={automations} showOwner canTime />
      </SectionCard>
    </>
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
    <SectionCard icon={Clock} title="When they run" description="Cairo time. Outside these hours a scheduled run is skipped; a watch catches up at its next check inside them.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          r.run(() => setAutomationHours(fd({ allDay: String(allDay), from, to, weekdays: days.join(","), reviewAt })));
        }}
      >
        <SettingRow title="All day" hint="Off: only between the hours below.">
          <Switch on={allDay} onChange={setAllDay} label="All day" />
        </SettingRow>
        <SettingRow title="Hours" hint={allDay ? "Any time of day." : "From the first to the last minute they may start in."}>
          <span className={`inline-flex items-center gap-2 text-sm ${allDay ? "opacity-50" : ""}`}>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} disabled={allDay} className="w-32 px-2 py-1.5 text-sm tabnum" aria-label="From" />
            <span className="text-muted">to</span>
            <input type="time" value={to} onChange={(e) => setTo(e.target.value)} disabled={allDay} className="w-32 px-2 py-1.5 text-sm tabnum" aria-label="To" />
          </span>
        </SettingRow>
        <SettingRow title="Days" hint="The days of the week they may run on." stack>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {WEEKDAY_NAMES.map((n, d) => (
              <label key={n} className={`chip ${days.includes(d) ? "chip-on" : ""}`}>
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
        </SettingRow>
        <SettingRow title="Morning review at" hint="Each working day. It waits for the hours above.">
          <input type="time" value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} className="w-32 px-2 py-1.5 text-sm tabnum" aria-label="Morning review at" />
        </SettingRow>
        <SaveBar msg={r.msg} pending={r.pending} disabled={!allDay && (!from || !to)} />
      </form>
    </SectionCard>
  );
}

function SchedulerCard({ clock }: { clock: SchedulerStatus }) {
  const r = useRun();
  const failing = clock.lastJobRuns.find((x) => x.status !== "succeeded");
  return (
    <SectionCard
      icon={PlugZap}
      title="Scheduler"
      description={clock.scheduled ? "The database calls the app every minute, so automations run with the app closed." : "Without it, automations run only while the app is open somewhere."}
      end={<span className={`pill ${clock.scheduled ? "pill-ok" : "pill-warn"}`}>{clock.scheduled ? "On time" : "Not set up"}</span>}
    >
      {(clock.lastTickAt || failing || clock.error) && (
        <div className="text-sm space-y-1 mb-3">
          {clock.lastTickAt && <p className="text-muted">Last tick {when(clock.lastTickAt)}.</p>}
          {failing && <p className="text-bad-fg font-semibold">Last run {failing.status}{failing.message ? ` — ${failing.message}` : ""}</p>}
          {clock.error && <p className="text-bad-fg font-semibold">{clock.error}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          className={`btn btn-sm ${clock.scheduled ? "btn-secondary" : "btn-primary"}`}
          disabled={r.pending}
          onClick={() => (!clock.scheduled || confirm("Set the scheduler up again? It gets a new secret; the old one stops at once.")) && r.run(() => setupAutomationClock())}
        >
          {r.pending ? "Working…" : clock.scheduled ? "Set up again" : "Set up"}
        </button>
        {clock.scheduled && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={r.pending} onClick={() => confirm("Remove the scheduler? Automations will then run only while the app is open.") && r.run(() => removeAutomationClock())}>
            Remove
          </button>
        )}
        <Note msg={r.msg} />
      </div>
    </SectionCard>
  );
}

// ---- People ----

function PeopleCard({ data }: { data: AiAdminData }) {
  const [onlyActive, setOnlyActive] = useState(true);
  const rows = data.users.filter((u) => !onlyActive || u.active);
  return (
    <SectionCard
      icon={Users}
      title="Who may use it"
      description="Each person's access, their own caps, and what the assistant may do for them — never more than they may do themselves."
      padded={false}
      end={
        <label className="chip">
          <input type="checkbox" className="sr-only" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          {onlyActive ? "Active only" : "Everyone"}
        </label>
      }
    >
      <div className="overflow-x-auto border-t">
        <table className="w-full min-w-[880px]">
          <thead>
            <tr>
              <th className="text-start ps-4 md:ps-5">Person</th>
              <th className="text-start">Access</th>
              <th className="text-start">Daily cap</th>
              <th className="text-start">Monthly cap</th>
              <th className="text-end">Today</th>
              <th className="text-end">This month</th>
              <th className="text-end">Questions</th>
              <th className="text-end pe-4 md:pe-5">What it may do</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => <PersonRow key={u.id} u={u} />)}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function PersonRow({ u }: { u: AiAdminUser }) {
  const r = useRun();
  const [rights, setRights] = useState(false);
  const shownKeys = u.isOwner ? u.aiKeys.filter((k) => permDef(k)?.notify || permDef(k)?.optIn) : u.aiKeys;
  const [on, setOn] = useState(u.enabled);
  const [usd, setUsd] = useState(usdInput(u.monthlyUsd));
  const [dayUsd, setDayUsd] = useState(usdInput(u.dailyUsd));
  const dirty = (Number(usd) || 0) !== u.monthlyUsd || (Number(dayUsd) || 0) !== u.dailyUsd;
  const save = (enabled: boolean, okText: string) => r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(enabled), usd, dayUsd })), okText);
  const saveCaps = () => dirty && save(on, "Saved.");
  return (
    <>
      <tr className={u.active ? "" : "opacity-60"}>
        <td className="ps-4 md:ps-5">
          <div className="font-semibold flex items-center gap-1.5">
            <span className="truncate">{u.name}</span>
            {u.isOwner && <span className="pill pill-ok text-[10px]">owner</span>}
            {!u.active && <span className="pill pill-muted text-[10px]">inactive</span>}
          </div>
          <div className="text-xs text-muted ltr truncate max-w-[16rem]">{u.email}</div>
          <Note msg={r.msg} />
        </td>
        {u.isOwner ? (
          <td colSpan={3} className="text-xs text-muted">Always — the plant&apos;s limits apply</td>
        ) : (
          <>
            <td>
              <Switch
                size="sm"
                on={on}
                disabled={r.pending}
                label={`AI for ${u.name}`}
                onChange={(next) => {
                  setOn(next);
                  save(next, next ? "Opened." : "Closed.");
                }}
              />
            </td>
            <td><UsdInput value={dayUsd} onChange={setDayUsd} label={`${u.name}'s daily cap in dollars`} onEnter={saveCaps} /></td>
            <td>
              <span className="inline-flex items-center gap-2">
                <UsdInput value={usd} onChange={setUsd} label={`${u.name}'s monthly cap in dollars`} onEnter={saveCaps} />
                {dirty && <button type="button" className="btn btn-primary btn-sm" disabled={r.pending} onClick={saveCaps}>{r.pending ? "…" : "Save"}</button>}
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
        <td className="text-end tabnum" title={u.lastAt ? `Last asked ${when(u.lastAt)}` : undefined}>{u.questions || "—"}</td>
        <td className="text-end pe-4 md:pe-5">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRights((v) => !v)} aria-expanded={rights}>
            {u.isOwner ? "Everything" : `${shownKeys.length} right${shownKeys.length === 1 ? "" : "s"}`}
            <ChevronDown size={14} className={`transition-transform ${rights ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </td>
      </tr>
      {rights && (
        <tr>
          <td colSpan={8} className="px-4 md:px-5 !pt-0 bg-surface-2/50">
            <RightsEditor u={u} onDone={() => setRights(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

/** "AI — the simulator" → "The simulator". */
const rightLabel = (label: string) => {
  const t = label.replace(/^AI — /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** What the assistant may do for one person — never more than they may do
 *  themselves: each change also needs their own permission for it. */
function RightsEditor({ u, onDone }: { u: AiAdminUser; onDone: () => void }) {
  const r = useRun();
  const [keys, setKeys] = useState<Set<string>>(() => new Set(u.aiKeys));
  const groups = u.isOwner ? AI_PERM_GROUPS.filter((g) => g.title === "Choices") : AI_PERM_GROUPS;
  const toggle = (k: string, on: boolean) =>
    setKeys((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  return (
    <div className="py-3 space-y-3">
      {!u.enabled && !u.isOwner && <p className="text-xs font-semibold text-warn-fg">The assistant is closed to {u.name} — these apply once it is opened.</p>}
      {u.isOwner && <p className="text-xs text-muted">You hold every right; only your own choices are here.</p>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {groups.map((g) => (
          <fieldset key={g.title} className="border rounded-lg p-3 bg-surface">
            <legend className="px-1 filter-label">{g.title}</legend>
            <div className="space-y-1.5">
              {g.keys.map((k) => {
                const d = permDef(k);
                return (
                  <label key={k} className="flex items-start gap-2 text-sm cursor-pointer" title={d?.desc}>
                    <input type="checkbox" checked={keys.has(k)} onChange={(e) => toggle(k, e.target.checked)} className="mt-0.5 accent-[var(--brand)]" />
                    <span className="font-semibold">{rightLabel(d?.label ?? k)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Never more than {u.isOwner ? "you" : u.name} may do on the app — each change also needs that permission.</span>
        <Note msg={r.msg} />
        <button type="button" className="btn btn-sm btn-ghost ms-auto" onClick={onDone} disabled={r.pending}>Close</button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={r.pending}
          onClick={() => {
            const f = new FormData();
            f.set("userId", String(u.id));
            for (const k of keys) f.append("keys", k);
            r.run(() => setAiUserRights(f));
          }}
        >
          <Save size={14} aria-hidden /> {r.pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
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
    <SectionCard
      icon={ListChecks}
      title="Changes by the assistant"
      description="Everything it prepared or made, newest first — in a chat or by an automation."
      padded={false}
      end={
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-2 py-1 text-sm" aria-label="Filter by status">
          <option value="">All</option>
          {Object.keys(CHANGE_TONE).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      }
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={ListChecks} title={data.changes.length === 0 ? "No changes yet" : "None with that status"} />
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto border-t">
          {rows.map((c) => (
            <li key={c.id} className="px-4 md:px-5 py-2.5">
              <div className="text-sm font-semibold flex flex-wrap items-center gap-1.5" dir="auto">
                <span className="truncate">{c.title}</span>
                <span className={`pill ${CHANGE_TONE[c.status] ?? "pill-muted"} text-[10px]`}>{c.status}</span>
                {c.risk === "destructive" && <span className="pill pill-bad text-[10px]">deletion</span>}
                {c.auto && <span className="pill pill-muted text-[10px]">auto</span>}
                {c.automationId && <span className="pill pill-muted text-[10px]">automation #{c.automationId}</span>}
              </div>
              <div className="text-xs text-muted truncate" dir="auto" title={c.summary}>{c.summary}</div>
              <div className="text-[11px] text-muted tabnum">
                #{c.id} · {c.who} · {when(c.at)}
                {c.error && <span className="text-bad-fg"> · {c.error}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RecentCard({ data }: { data: AiAdminData }) {
  return (
    <SectionCard icon={Activity} title="Latest questions" description="What people asked it, and what each answer cost." padded={false}>
      {data.recent.length === 0 ? (
        <EmptyState compact icon={MessageSquare} title="No questions yet" />
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto border-t">
          {data.recent.map((r) => (
            <li key={r.id} className="px-4 md:px-5 py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" dir="auto" title={r.question}>{r.question}</div>
                <div className="text-[11px] text-muted tabnum">
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
    </SectionCard>
  );
}
