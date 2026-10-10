"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, KeyRound, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { AI_MODELS, aiModel, usdText } from "@/lib/domain/ai";
import { removeAiKey, saveAiKey, setAiEnabled, setAiModel, setAiPlantCap, setAiUserAccess, testAi, type AiActionResult } from "@/app/admin/ai/actions";
import { StatTile } from "@/components/charts/kit";

// The owner's page for the AI assistant: the key, the switch and the model,
// the plant's monthly cap, each person's access and allowance with what they
// have spent, and the latest questions with what each cost.

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
  const capShare = data.plantCap > 0 ? data.plantSpent / data.plantCap : null;
  return (
    <div className="space-y-4 mt-2">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Spent this month" value={usdText(data.plantSpent)} sub={data.plantCap > 0 ? `of the ${usdText(data.plantCap)} cap` : "no monthly cap"} meter={capShare ?? undefined} hero />
        <StatTile label="Questions this month" value={String(data.plantQuestions)} sub={data.plantQuestions > 0 ? `${usdText(data.plantSpent / data.plantQuestions)} a question on average` : undefined} />
        <StatTile label="Last month" value={usdText(data.lastMonthSpent)} />
        <StatTile label="Using it" value={String(data.users.filter((u) => u.enabled && u.active).length)} sub={data.enabled ? "open to the people ticked" : "closed — only you"} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <KeyCard data={data} />
        <SwitchCard data={data} />
      </div>

      <PeopleCard data={data} />
      <RecentCard data={data} />
    </div>
  );
}

function KeyCard({ data }: { data: AiAdminData }) {
  const save = useRun();
  const test = useRun();
  const [key, setKey] = useState("");
  return (
    <section className="bg-surface border rounded-xl p-5 space-y-3">
      <h2 className="text-sm font-extrabold flex items-center gap-2">
        <KeyRound size={16} /> Claude API key
        {data.hasKey ? (
          data.keyReadable ? <span className="pill pill-ok">Set · ••••{data.keyHint}</span> : <span className="pill pill-bad">Cannot be read — enter it again</span>
        ) : (
          <span className="pill pill-muted">Not set</span>
        )}
      </h2>
      <p className="text-sm text-muted">
        From console.anthropic.com → API keys. It is kept encrypted on the server and never sent to anyone&apos;s browser. Set a spend limit on
        the Anthropic console too — the caps here count what the app asked.
      </p>
      <form
        className="flex flex-wrap gap-2"
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
          placeholder={data.hasKey ? "Paste a new key to replace it" : "sk-ant-…"}
          className="flex-1 min-w-[220px] px-2.5 py-1.5 text-sm ltr"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending || !key.trim()}>
          {save.pending ? "Checking…" : data.hasKey ? "Replace key" : "Save key"}
        </button>
        {data.hasKey && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={save.pending}
            onClick={() => confirm("Remove the API key? The assistant stops for everyone until a key is added.") && save.run(() => removeAiKey())}
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
      </form>
      <Note msg={save.msg} />
      <div className="border-t pt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={test.pending} onClick={() => test.run(() => testAi())}>
          <PlugZap size={14} /> {test.pending ? "Testing…" : "Test the connection"}
        </button>
        <span className="text-xs text-muted">Checks the key with Claude, and that the assistant&apos;s database login is read-only and kept out of the private tables.</span>
      </div>
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
    <section className="bg-surface border rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[220px]">
          <h2 className="text-sm font-extrabold flex items-center gap-2">
            <Bot size={16} /> Open to the team
            <span className={`pill ${data.enabled ? "pill-ok" : "pill-muted"}`}>{data.enabled ? "ON" : "OFF"}</span>
          </h2>
          <p className="text-sm text-muted mt-1">On, the people ticked below get the AI button in their bar. Off, only you can use it.</p>
        </div>
        <button
          type="button"
          disabled={sw.pending}
          onClick={() => sw.run(() => setAiEnabled(fd({ on: String(!data.enabled) })))}
          className={`rounded-md px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${data.enabled ? "bg-bad-fg hover:opacity-90" : "bg-brand hover:bg-brand-dark"}`}
        >
          {sw.pending ? "Saving…" : data.enabled ? "Turn OFF" : "Turn ON"}
        </button>
      </div>
      <Note msg={sw.msg} />

      <fieldset className="border-t pt-3">
        <legend className="text-sm font-extrabold">Model</legend>
        <p className="text-xs text-muted mb-2">For new chats; a chat keeps the model it started on. Prices per million tokens (in / out).</p>
        <div className="space-y-1.5">
          {AI_MODELS.map((m) => (
            <label key={m.id} className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="model"
                checked={data.model === m.id}
                disabled={mdl.pending}
                onChange={() => mdl.run(() => setAiModel(fd({ model: m.id })))}
                className="mt-1 accent-[var(--brand,#1b7a43)]"
              />
              <span>
                <span className="font-bold">{m.label}</span>
                {m.id === AI_MODELS[0].id && <span className="pill pill-ok text-[10px] ms-1.5">recommended</span>}
                <span className="block text-xs text-muted">{m.note} · ${m.inUsd} / ${m.outUsd}</span>
              </span>
            </label>
          ))}
        </div>
        <Note msg={mdl.msg} />
      </fieldset>

      <form
        className="border-t pt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          cap.run(() => setAiPlantCap(fd({ usd: capVal })));
        }}
      >
        <div className="text-sm font-extrabold">The plant&apos;s monthly cap</div>
        <p className="text-xs text-muted">Everyone together, you included, from the 1st of each month. Empty or 0 = no cap.</p>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold">$</span>
          <input type="number" min={0} step="0.5" value={capVal} onChange={(e) => setCapVal(e.target.value)} placeholder="no cap" className="w-32 px-2.5 py-1.5 text-sm tabnum" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={cap.pending}>Save cap</button>
        </div>
        <Note msg={cap.msg} />
      </form>
    </section>
  );
}

function PeopleCard({ data }: { data: AiAdminData }) {
  const [onlyActive, setOnlyActive] = useState(true);
  const rows = data.users.filter((u) => !onlyActive || u.active);
  return (
    <section className="bg-surface border rounded-xl p-5">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-sm font-extrabold flex items-center gap-2 flex-1">
          <ShieldCheck size={16} /> Who may use it, and how much
        </h2>
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-[var(--brand,#1b7a43)]" />
          Active accounts only
        </label>
      </div>
      <p className="text-xs text-muted mb-3">
        A monthly limit is that person&apos;s own allowance in dollars (empty = none of their own — the plant&apos;s cap still holds). The same ticks are on
        Users &amp; Permissions.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b">
            <tr className="text-xs text-muted text-start">
              <th className="py-1.5 pe-2 text-start font-bold">Account</th>
              <th className="py-1.5 px-2 text-start font-bold">Uses AI</th>
              <th className="py-1.5 px-2 text-start font-bold">Monthly limit</th>
              <th className="py-1.5 px-2 text-end font-bold">Spent this month</th>
              <th className="py-1.5 px-2 text-end font-bold">Questions</th>
              <th className="py-1.5 ps-2 text-end font-bold">Last asked</th>
            </tr>
          </thead>
          <tbody className="divide-y">
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
  const [usd, setUsd] = useState(u.monthlyUsd > 0 ? String(u.monthlyUsd) : "");
  const dirty = (Number(usd) || 0) !== u.monthlyUsd;
  const share = u.monthlyUsd > 0 ? Math.min(1, u.spent / u.monthlyUsd) : null;
  return (
    <tr className={u.active ? "" : "opacity-60"}>
      <td className="py-2 pe-2">
        <div className="font-semibold">{u.name} {u.isOwner && <span className="pill pill-ok text-[10px]">owner</span>}</div>
        <div className="text-xs text-muted ltr">{u.email}</div>
      </td>
      <td className="py-2 px-2">
        {u.isOwner ? (
          <span className="text-xs text-muted">Always</span>
        ) : (
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={on}
              disabled={r.pending}
              onChange={(e) => {
                const next = e.target.checked;
                setOn(next);
                r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(next), usd })), next ? "Can use it." : "Closed to them.");
              }}
              className="accent-[var(--brand,#1b7a43)]"
            />
            {on ? "Yes" : "No"}
          </label>
        )}
      </td>
      <td className="py-2 px-2">
        {u.isOwner ? (
          <span className="text-xs text-muted">The plant&apos;s cap</span>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              r.run(() => setAiUserAccess(fd({ userId: String(u.id), enabled: String(on), usd })), "Limit saved.");
            }}
          >
            <span className="text-xs font-bold">$</span>
            <input type="number" min={0} step="0.5" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="none" className="w-20 px-2 py-1 text-sm tabnum" />
            <button type="submit" className="btn btn-primary btn-sm" disabled={r.pending || !dirty}>{r.pending ? "…" : "Save"}</button>
          </form>
        )}
        {r.msg && <div className={`text-xs font-semibold mt-0.5 ${r.msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{r.msg.text}</div>}
      </td>
      <td className="py-2 px-2 text-end tabnum">
        <div className="font-semibold">{usdText(u.spent)}{u.monthlyUsd > 0 && <span className="text-xs text-muted font-normal"> / {usdText(u.monthlyUsd)}</span>}</div>
        {share !== null && (
          <div className="h-1 mt-1 rounded-full overflow-hidden w-24 ms-auto" style={{ background: "color-mix(in srgb, var(--viz-1) 16%, var(--surface))" }}>
            <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: share >= 1 ? "var(--bad-fg)" : "var(--viz-1)" }} />
          </div>
        )}
      </td>
      <td className="py-2 px-2 text-end tabnum">{u.questions || "—"}</td>
      <td className="py-2 ps-2 text-end text-xs text-muted whitespace-nowrap">{u.lastAt ? when(u.lastAt) : "—"}</td>
    </tr>
  );
}

function RecentCard({ data }: { data: AiAdminData }) {
  return (
    <section className="bg-surface border rounded-xl p-5">
      <h2 className="text-sm font-extrabold mb-2">Latest questions</h2>
      {data.recent.length === 0 ? (
        <p className="text-sm text-muted">Nobody has asked anything yet.</p>
      ) : (
        <div className="overflow-x-auto max-h-[460px]">
          <table className="w-full text-sm">
            <thead className="border-b sticky top-0 bg-surface">
              <tr className="text-xs text-muted">
                <th className="py-1.5 pe-2 text-start font-bold">When</th>
                <th className="py-1.5 px-2 text-start font-bold">Who</th>
                <th className="py-1.5 px-2 text-start font-bold">Question</th>
                <th className="py-1.5 px-2 text-end font-bold">Look-ups</th>
                <th className="py-1.5 px-2 text-end font-bold">Tokens</th>
                <th className="py-1.5 ps-2 text-end font-bold">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pe-2 text-xs text-muted whitespace-nowrap">{when(r.at)}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{r.who}</td>
                  <td className="py-1.5 px-2 max-w-[420px]">
                    <div className="truncate" dir="auto" title={r.question}>{r.question}</div>
                    <div className="text-[11px] text-muted">{aiModel(r.model).label}{r.running && <span className="text-warn-fg"> · being answered</span>}{r.error && <span className="text-bad-fg"> · {r.error}</span>}</div>
                  </td>
                  <td className="py-1.5 px-2 text-end tabnum">{r.queries}</td>
                  <td className="py-1.5 px-2 text-end tabnum text-muted">{r.tokens.toLocaleString("en")}</td>
                  <td className="py-1.5 ps-2 text-end tabnum font-semibold">{usdText(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
