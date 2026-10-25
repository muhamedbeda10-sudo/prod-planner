"use client";

import { useState, useTransition } from "react";
import { Eye, Plus, Sparkles, X } from "lucide-react";
import { previewAutomation, saveAutomation } from "@/app/automations/actions";
import { Modal } from "@/components/Modal";
import { Note, Switch } from "@/components/primitives";
import {
  AUTOMATION_LIMITS, AUTOMATION_RECIPES, CHECK_EVERY, ESCALATE_AFTER, WEEKDAY_NAMES, minutesText,
  type AutomationAction, type AutomationConfig, type AutomationInput, type AutomationRecipe, type AutomationTrigger, type ScheduleDays,
} from "@/lib/domain/automations";
import { APP_EVENTS, APP_EVENT_TYPES } from "@/lib/domain/appEvents";

// Making an automation without the chat: WHEN (at times, when the data
// matches, the moment something happens) → THEN (a message, the assistant's
// report, changes to approve, a task) → TO WHOM — with a preview of what it
// would do before it is saved. The ready-made ones fill it in.

export interface BuilderPeople {
  meId: number;
  people: { id: number; name: string }[];
}

const TRIGGERS: { id: AutomationTrigger; label: string }[] = [
  { id: "schedule", label: "At times" },
  { id: "condition", label: "When the data matches" },
  { id: "event", label: "The moment something happens" },
];
const ACTIONS: { id: AutomationAction; label: string; hint: string }[] = [
  { id: "notify", label: "A message", hint: "Sent as written — no AI, no cost." },
  { id: "task", label: "A task", hint: "Given to the people below (none: you) — one for each new row. No AI, no cost." },
  { id: "report", label: "The assistant's report", hint: "It reads the live data each time and writes it up." },
  { id: "act", label: "Changes to approve", hint: "It prepares changes; they wait in your inbox for your click." },
];

type Draft = Required<Omit<AutomationInput, "conditionSql" | "activeFrom" | "activeTo" | "eventMatch" | "message" | "prompt" | "escalateAfterMin">> & {
  conditionSql: string;
  activeFrom: string;
  activeTo: string;
  eventMatch: string;
  message: string;
  prompt: string;
  escalateAfterMin: number | null;
  limitHours: boolean;
  includeCurrent: boolean;
};

function draftOf(c: Partial<AutomationConfig> | AutomationInput): Draft {
  return {
    name: c.name ?? "",
    trigger: (c.trigger as AutomationTrigger) ?? "schedule",
    times: [...(c.times ?? ["07:30"])],
    days: (c.days as ScheduleDays) ?? "working",
    weekdays: [...(c.weekdays ?? [])],
    conditionSql: c.conditionSql ?? "",
    checkEveryMin: c.checkEveryMin ?? 30,
    activeFrom: c.activeFrom ?? "07:00",
    activeTo: c.activeTo ?? "19:00",
    limitHours: !!c.activeFrom,
    eventTypes: [...(c.eventTypes ?? [])],
    eventActorIds: [...(c.eventActorIds ?? [])],
    eventMatch: c.eventMatch ?? "",
    action: (c.action as AutomationAction) ?? "notify",
    message: c.message ?? "",
    prompt: c.prompt ?? "",
    recipientIds: [...(c.recipientIds ?? [])],
    taskDueDays: c.taskDueDays ?? 1,
    taskUrgent: c.taskUrgent ?? false,
    escalateAfterMin: c.escalateAfterMin ?? null,
    includeCurrent: false,
  };
}

function inputOf(d: Draft): AutomationInput & { includeCurrent?: boolean } {
  return {
    name: d.name, trigger: d.trigger, action: d.action, recipientIds: d.action === "act" ? [] : d.recipientIds,
    ...(d.trigger === "schedule" ? { times: d.times, days: d.days, weekdays: d.days === "weekdays" ? d.weekdays : [] } : {}),
    ...(d.trigger === "condition"
      ? { conditionSql: d.conditionSql, checkEveryMin: d.checkEveryMin, activeFrom: d.limitHours ? d.activeFrom : null, activeTo: d.limitHours ? d.activeTo : null, escalateAfterMin: d.escalateAfterMin, includeCurrent: d.includeCurrent }
      : {}),
    ...(d.trigger === "event" ? { eventTypes: d.eventTypes, eventActorIds: d.eventActorIds, eventMatch: d.eventMatch || null } : {}),
    ...(d.action === "notify" || d.action === "task" ? { message: d.message } : { prompt: d.prompt }),
    ...(d.action === "task" ? { taskDueDays: d.taskDueDays, taskUrgent: d.taskUrgent } : {}),
  };
}

function Chips({ items, on, toggle, label }: { items: { id: number | string; name: string }[]; on: readonly (number | string)[]; toggle: (id: number | string) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {items.map((p) => (
        <button key={p.id} type="button" className="chip-toggle" aria-pressed={on.includes(p.id)} onClick={() => toggle(p.id)}>{p.name}</button>
      ))}
    </div>
  );
}

/** The builder, new or for one of the person's own automations (id). */
export function AutomationBuilder({ id, initial, people, onClose, onSaved }: {
  id?: number;
  initial: Partial<AutomationConfig> | AutomationInput;
  people: BuilderPeople["people"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(initial));
  const [time, setTime] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ text: string; sample: string[] } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setPreview(null);
  };
  const flip = <T,>(xs: readonly T[], v: T) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);
  const form = () => {
    const f = new FormData();
    if (id) f.set("id", String(id));
    f.set("config", JSON.stringify(inputOf(d)));
    return f;
  };
  const doPreview = () =>
    start(async () => {
      setMsg(null);
      const r = await previewAutomation(form());
      if (r.ok) setPreview({ text: r.text ?? "", sample: r.sample ?? [] });
      else setMsg({ ok: false, text: r.error ?? "Could not preview it." });
    });
  const save = () =>
    start(async () => {
      setMsg(null);
      const r = await saveAutomation(form()).catch(() => ({ ok: false, error: "The request failed — try again." }));
      if (r.ok) {
        onSaved();
        onClose();
      } else setMsg({ ok: false, text: r.error ?? "It was not saved." });
    });

  const groups = [...new Set(APP_EVENT_TYPES.map((t) => APP_EVENTS[t].group))];
  return (
    <Modal title={id ? "Change the automation" : "A new automation"} sub="When → then → to whom. Preview what it would do before you save it." onClose={onClose} busy={pending} width="max-w-3xl">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="block text-sm font-semibold">Name
          <input className="block mt-1 w-full" dir="auto" maxLength={AUTOMATION_LIMITS.name} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Machines still stopped" />
        </label>

        <fieldset className="space-y-2">
          <legend className="filter-label mb-1">When</legend>
          <div className="segmented segmented-stack w-full">
            {TRIGGERS.map((t) => <button key={t.id} type="button" aria-pressed={d.trigger === t.id} onClick={() => set("trigger", t.id)}>{t.label}</button>)}
          </div>
          {d.trigger === "schedule" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {d.times.map((t) => (
                  <span key={t} className="pill pill-muted tabnum">{t}
                    <button type="button" className="ms-1" onClick={() => set("times", d.times.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X size={12} /></button>
                  </span>
                ))}
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="A time to add" />
                <button type="button" className="btn btn-secondary btn-sm" disabled={!time || d.times.includes(time) || d.times.length >= AUTOMATION_LIMITS.times}
                  onClick={() => { set("times", [...d.times, time].sort()); setTime(""); }}><Plus size={14} /> Add</button>
              </div>
              <select value={d.days} onChange={(e) => set("days", e.target.value as ScheduleDays)} aria-label="Which days">
                <option value="working">Working days</option>
                <option value="every">Every day</option>
                <option value="weekdays">Chosen weekdays</option>
              </select>
              {d.days === "weekdays" && (
                <Chips label="Weekdays" items={WEEKDAY_NAMES.map((n, i) => ({ id: i, name: n.slice(0, 3) }))} on={d.weekdays} toggle={(v) => set("weekdays", flip(d.weekdays, v as number).sort())} />
              )}
            </div>
          )}
          {d.trigger === "condition" && (
            <div className="space-y-2">
              <label className="block text-sm">A read-only query that returns the rows that matter now — a <code>key</code> column tells one row from the next
                <textarea className="block mt-1 w-full font-mono text-xs ltr" rows={5} maxLength={AUTOMATION_LIMITS.sql} value={d.conditionSql} onChange={(e) => set("conditionSql", e.target.value)}
                  placeholder={'SELECT "mo" AS key, "mo", "customer" FROM "MasterOrder" WHERE …'} />
              </label>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-1.5">Check every
                  <select value={d.checkEveryMin} onChange={(e) => set("checkEveryMin", Number(e.target.value))}>
                    {CHECK_EVERY.map((m) => <option key={m} value={m}>{minutesText(m)}</option>)}
                  </select>
                </label>
                <span className="inline-flex items-center gap-1.5"><Switch on={d.limitHours} onChange={(v) => set("limitHours", v)} label="Only in working hours" size="sm" /> only</span>
                {d.limitHours && (
                  <span className="inline-flex items-center gap-1">
                    <input type="time" value={d.activeFrom} onChange={(e) => set("activeFrom", e.target.value)} aria-label="From" />–
                    <input type="time" value={d.activeTo} onChange={(e) => set("activeTo", e.target.value)} aria-label="To" />
                  </span>
                )}
                <label className="inline-flex items-center gap-1.5">Still there after
                  <select value={d.escalateAfterMin ?? ""} onChange={(e) => set("escalateAfterMin", e.target.value ? Number(e.target.value) : null)}>
                    <option value="">— never send it up</option>
                    {ESCALATE_AFTER.map((m) => <option key={m} value={m}>{minutesText(m)} → up to the owner</option>)}
                  </select>
                </label>
                {!id && <span className="inline-flex items-center gap-1.5"><Switch on={d.includeCurrent} onChange={(v) => set("includeCurrent", v)} label="Also what matches now" size="sm" /> also what matches now</span>}
              </div>
            </div>
          )}
          {d.trigger === "event" && (
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g}>
                  <div className="text-xs font-bold text-muted mb-1">{g}</div>
                  <Chips label={g} items={APP_EVENT_TYPES.filter((t) => APP_EVENTS[t].group === g).map((t) => ({ id: t, name: APP_EVENTS[t].label }))} on={d.eventTypes} toggle={(v) => set("eventTypes", flip(d.eventTypes, v as string))} />
                </div>
              ))}
              <input className="w-full" dir="auto" maxLength={AUTOMATION_LIMITS.eventMatch} value={d.eventMatch} onChange={(e) => set("eventMatch", e.target.value)} placeholder="Only when it mentions… (an MO, Welding, a tank serial) — optional" aria-label="Words it must mention" />
              <details>
                <summary className="text-xs text-muted cursor-pointer">Only when these people do it ({d.eventActorIds.length || "anyone"})</summary>
                <div className="mt-1.5"><Chips label="People watched" items={people} on={d.eventActorIds} toggle={(v) => set("eventActorIds", flip(d.eventActorIds, v as number))} /></div>
              </details>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="filter-label mb-1">Then</legend>
          <div className="segmented segmented-stack w-full">
            {ACTIONS.map((a) => <button key={a.id} type="button" aria-pressed={d.action === a.id} onClick={() => set("action", a.id)}>{a.label}</button>)}
          </div>
          <p className="text-xs text-muted">{ACTIONS.find((a) => a.id === d.action)?.hint}</p>
          {d.action === "notify" || d.action === "task" ? (
            <>
              <textarea className="w-full" dir="auto" rows={4} maxLength={AUTOMATION_LIMITS.text} value={d.message} onChange={(e) => set("message", e.target.value)}
                placeholder={d.action === "task" ? "The task's title on the first line\nWhat to do after it" : "The message — Markdown"} aria-label={d.action === "task" ? "The task" : "The message"} />
              <p className="text-xs text-muted">Blanks: {"{name}"} {"{count}"}{d.trigger === "condition" ? (d.action === "task" ? " and each row's {column}" : " {rows} and each row's {column}") : ""}{d.trigger === "event" ? " {who} {what} {about} {detail} {when}" : ""}.</p>
              {d.action === "task" && (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="inline-flex items-center gap-1.5">Due in
                    <input type="number" className="w-16 text-end tabnum" min={0} max={AUTOMATION_LIMITS.taskDueDays} value={d.taskDueDays} onChange={(e) => e.target.value !== "" && set("taskDueDays", Math.max(0, Math.round(Number(e.target.value))))} /> working days
                  </label>
                  <span className="inline-flex items-center gap-1.5"><Switch on={d.taskUrgent} onChange={(v) => set("taskUrgent", v)} label="Urgent" size="sm" /> urgent</span>
                </div>
              )}
            </>
          ) : (
            <textarea className="w-full" dir="auto" rows={4} maxLength={AUTOMATION_LIMITS.text} value={d.prompt} onChange={(e) => set("prompt", e.target.value)}
              placeholder="What the assistant is to do each time — complete on its own" aria-label="The assistant's instruction" />
          )}
        </fieldset>

        {d.action !== "act" && (
          <fieldset>
            <legend className="filter-label mb-1">{d.action === "task" ? "Given to" : "To"} <span className="font-normal text-muted">(none: you)</span></legend>
            <Chips label="Recipients" items={people} on={d.recipientIds} toggle={(v) => set("recipientIds", flip(d.recipientIds, v as number))} />
          </fieldset>
        )}

        {preview && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm" role="status">
            <p className="font-semibold">{preview.text}</p>
            {preview.sample.length > 0 && <ul className="mt-1 text-sm text-muted list-disc ps-4">{preview.sample.map((x, k) => <li key={k} dir="auto">{x}</li>)}</ul>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t">
          <Note msg={msg} />
          <button type="button" className="btn btn-secondary btn-sm ms-auto" disabled={pending} onClick={doPreview}><Eye size={14} /> Preview</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>{pending ? "Saving…" : id ? "Save the change" : "Turn it on"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** The ready-made automations — one picked opens the builder filled in. */
export function RecipeGallery({ onPick, onClose }: { onPick: (r: AutomationRecipe) => void; onClose: () => void }) {
  const groups = [...new Set(AUTOMATION_RECIPES.map((r) => r.group))];
  return (
    <Modal title={<span className="inline-flex items-center gap-2"><Sparkles size={18} aria-hidden /> Ready-made automations</span>} sub="Pick one — you choose who it goes to, and can change anything before it is on." onClose={onClose} focusField={false} width="max-w-3xl">
      <div className="space-y-4">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="text-xs font-bold text-muted mb-1.5">{g}</h3>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
              {AUTOMATION_RECIPES.filter((r) => r.group === g).map((r) => (
                <button key={r.id} type="button" className="text-start border rounded-xl px-3 py-2.5 bg-surface hover:bg-surface-2 hover:border-[var(--border-strong)]" onClick={() => onPick(r)}>
                  <span className="block text-sm font-bold">{r.title}</span>
                  <span className="block text-xs text-muted mt-0.5">{r.desc}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
