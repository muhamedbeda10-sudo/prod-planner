"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { ITEM_NAME } from "@/lib/domain/constants";
import { factoryDayISO } from "@/lib/domain/dates";
import { LV_ITEM } from "@/lib/domain/lv";
import { MATERIAL_PRESETS } from "@/lib/domain/material";
import { checkRule, ruleSentence, RULE_EFFECTS, RULE_ITEMS, type MachineRuleView, type RuleEffect } from "@/lib/domain/machineRules";
import type { MachineDTO } from "@/lib/server/machines";
import { createMachineRule, setMachineRuleOn } from "./ruleActions";
import { inputCls, Msg, useAction } from "./formBits";

// A machine's rules, under its row: what it takes only, never takes, or goes
// first for — the planner's own way of spreading the work, which ⚡ Plan
// follows (lib/domain/machineRules.ts). A rule is never edited in place: one
// that no longer holds is taken off (it stays on record) and a new one added,
// so the record shows what the plan followed when.

const EFFECT_TEXT: Record<RuleEffect, { pill: string; label: string; help: string }> = {
  only: { pill: "pill-info", label: "Only takes", help: "The machine takes ONLY work that matches (several “only” rules: any of them)." },
  never: { pill: "pill-bad", label: "Never takes", help: "The machine never takes work that matches." },
  prefer: { pill: "pill-ok", label: "Goes first for", help: "Among the machines allowed, this one goes first for matching work." },
};

const itemLabel = (i: string) => (i === LV_ITEM ? "LV panel" : ITEM_NAME[i as keyof typeof ITEM_NAME] ?? i);

const dayOf = (iso: string) => {
  const d = factoryDayISO(new Date(iso));
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
};

interface Draft {
  effect: RuleEffect;
  item: string;
  line: string;
  minThicknessMm: string;
  maxThicknessMm: string;
  material: string;
  minKva: string;
  maxKva: string;
  note: string;
}

const EMPTY: Draft = { effect: "only", item: "", line: "", minThicknessMm: "", maxThicknessMm: "", material: "", minKva: "", maxKva: "", note: "" };

const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function RuleForm({ machine, onClose }: { machine: MachineDTO; onClose: () => void }) {
  const [d, setD] = useState<Draft>(EMPTY);
  const add = useAction();
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setD((x) => ({ ...x, [k]: e.target.value }));
  // the same check the server makes, so the sentence below is the rule it keeps
  const checked = checkRule({
    effect: d.effect, item: d.item, line: d.line, material: d.material, note: d.note,
    minThicknessMm: num(d.minThicknessMm), maxThicknessMm: num(d.maxThicknessMm), minKva: num(d.minKva), maxKva: num(d.maxKva),
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!checked.ok) return;
    const fd = new FormData(e.currentTarget);
    fd.set("machineId", String(machine.id));
    add.run(createMachineRule, fd, "Rule added.", onClose);
  }

  return (
    <Modal title={`Rule for ${machine.code}`} sub={machine.name} onClose={onClose} busy={add.pending}>
      <form className="space-y-3" onSubmit={submit}>
        <fieldset className="flex flex-wrap gap-2" disabled={add.pending}>
          <legend className="text-xs font-semibold text-muted mb-1">The machine…</legend>
          {RULE_EFFECTS.map((eff) => (
            <label key={eff} className={`btn btn-sm ${d.effect === eff ? "btn-primary" : ""}`}>
              <input type="radio" name="effect" value={eff} checked={d.effect === eff} onChange={set("effect")} className="sr-only" />
              {EFFECT_TEXT[eff].label}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted">{EFFECT_TEXT[d.effect].help} Every field you fill must match; leave the rest empty.</p>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Item</span>
            <select name="item" value={d.item} onChange={set("item")} disabled={add.pending} className={inputCls}>
              <option value="">Any item</option>
              {RULE_ITEMS.map((i) => <option key={i} value={i}>{i} — {itemLabel(i)}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Line</span>
            <select name="line" value={d.line} onChange={set("line")} disabled={add.pending} className={inputCls}>
              <option value="">Both</option>
              <option value="TR">Transformers</option>
              <option value="LV">LV panels</option>
            </select>
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Thickness from (mm)</span>
            <input name="minThicknessMm" type="number" min={0.1} max={200} step={0.1} value={d.minThicknessMm} onChange={set("minThicknessMm")} disabled={add.pending} className={`${inputCls} tabnum`} />
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Thickness to (mm)</span>
            <input name="maxThicknessMm" type="number" min={0.1} max={200} step={0.1} value={d.maxThicknessMm} onChange={set("maxThicknessMm")} disabled={add.pending} className={`${inputCls} tabnum`} />
          </label>
          <label className="text-xs font-semibold md:col-span-2">
            <span className="block mb-1 text-muted">Sheet material</span>
            <input name="material" list="rule-materials" maxLength={60} value={d.material} onChange={set("material")} placeholder="Any" disabled={add.pending} className={inputCls} />
            <datalist id="rule-materials">{MATERIAL_PRESETS.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">kVA from</span>
            <input name="minKva" type="number" min={1} step={1} value={d.minKva} onChange={set("minKva")} disabled={add.pending} className={`${inputCls} tabnum`} />
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">kVA to</span>
            <input name="maxKva" type="number" min={1} step={1} value={d.maxKva} onChange={set("maxKva")} disabled={add.pending} className={`${inputCls} tabnum`} />
          </label>
          <label className="text-xs font-semibold col-span-2 md:col-span-4">
            <span className="block mb-1 text-muted">Why (your own words, optional)</span>
            <input name="note" maxLength={300} value={d.note} onChange={set("note")} placeholder="The old laser cannot cut over 12 mm" disabled={add.pending} className={inputCls} />
          </label>
        </div>
        <p className={`text-sm font-semibold ${checked.ok ? "" : "text-bad-fg"}`}>
          {checked.ok ? `“${ruleSentence(machine.code, { id: 0, machineId: machine.id, ...checked.rule })}”` : checked.error}
        </p>
        {checked.ok && (checked.rule.minThicknessMm !== null || checked.rule.maxThicknessMm !== null || checked.rule.material) && (
          <p className="text-xs text-muted">Thickness and material come from the line&apos;s nesting on the MATERIAL tab — a line not nested yet cannot be shown to match them.</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <Msg msg={add.msg} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={add.pending}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending || !checked.ok}>{add.pending ? "Adding…" : "Add the rule"}</button>
        </div>
      </form>
    </Modal>
  );
}

function RuleLine({ machine, rule }: { machine: MachineDTO; rule: MachineRuleView }) {
  const act = useAction();
  const eff = EFFECT_TEXT[rule.effect as RuleEffect] ?? EFFECT_TEXT.only;
  const toggle = () => {
    const fd = new FormData();
    fd.set("id", String(rule.id));
    fd.set("active", rule.active ? "false" : "true");
    act.run(setMachineRuleOn, fd, rule.active ? "Taken off." : "Back on.");
  };
  return (
    <li className={`flex flex-wrap items-center gap-2 text-sm ${rule.active ? "" : "opacity-60"}`}>
      <span className={`pill ${eff.pill}`}>{rule.effect}</span>
      <span className="font-semibold">{ruleSentence(machine.code, rule)}</span>
      {rule.note && <span className="text-muted italic">— {rule.note}</span>}
      <span className="text-xs text-muted">
        {rule.active ? `by ${rule.createdBy ?? "?"} · ${dayOf(rule.createdAt)}` : `taken off by ${rule.updatedBy ?? "?"} · ${dayOf(rule.updatedAt)}`}
      </span>
      <button type="button" className="btn btn-sm ms-auto" disabled={act.pending} onClick={toggle}>{rule.active ? "Take off" : "Put back"}</button>
      <Msg msg={act.msg} />
    </li>
  );
}

export function MachineRules({ machine, rules, planningOn }: { machine: MachineDTO; rules: MachineRuleView[]; planningOn: boolean }) {
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const active = rules.filter((r) => r.active);
  const retired = rules.filter((r) => !r.active);
  return (
    <div className="mt-2 border-t pt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted">
          Rules for ⚡ Plan{active.length === 0 ? " — none: it takes any work of its centre" : ""}
          {!planningOn && " · machine planning is off (Settings), so nothing follows them yet"}
        </span>
        {retired.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowRetired((v) => !v)}>
            {showRetired ? "Hide" : "Show"} {retired.length} taken off
          </button>
        )}
        {machine.active && <button type="button" className="btn btn-sm ms-auto" onClick={() => setAdding(true)}>＋ Rule</button>}
      </div>
      {(active.length > 0 || showRetired) && (
        <ul className="space-y-1">
          {active.map((r) => <RuleLine key={r.id} machine={machine} rule={r} />)}
          {showRetired && retired.map((r) => <RuleLine key={r.id} machine={machine} rule={r} />)}
        </ul>
      )}
      {adding && <RuleForm machine={machine} onClose={() => setAdding(false)} />}
    </div>
  );
}
