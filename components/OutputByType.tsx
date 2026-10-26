"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { ChartCard, fmt, pctOrDash } from "@/components/charts/kit";
import { EmptyState } from "@/components/primitives";
import { GroupBand, TableFrame, Th } from "@/components/DataTable";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { LV_TYPE_STAGE_LABEL, TR_TYPE_STAGE_LABEL, outputByTypeRows, type OutputByTypeData, type TypeRow } from "@/lib/domain/outputByType";
import { STAGES, type Stage } from "@/lib/domain/kpis";
import { LV_STAGES, type LvStage } from "@/lib/domain/lv";

// What the floor made, item by item and type by type, against the month's
// plan — both lines on one card, each in its own table: the transformers by
// component and KVA class, the panels by plan and panel type. Pieces add up
// within an item, never across items or lines. The figures come from the
// lines' floor periods (FloorPeriod.byType, LvFloorPeriod.byType).

/** One line's table: the stages' pieces made in the period, then its month's plan. */
function LineTable<S extends string>({ line, data, stages, stageLabel, typeWord, finishWord, range, detail }: {
  line: ProductLine;
  data: OutputByTypeData<S>;
  stages: readonly S[];
  stageLabel: Record<S, string>;
  typeWord: string;
  finishWord: string;
  range: string;
  detail: boolean;
}) {
  const head = <h3 className="text-sm font-bold mb-1.5">{LINE_LABEL[line]} <span className="text-muted font-normal">— by {typeWord}</span></h3>;
  if (data.groups.length === 0) {
    return (
      <div className="min-w-0">
        {head}
        <EmptyState compact icon={Info} title="Nothing made, nothing planned" hint={`No ${LINE_LABEL[line].toLowerCase()} record in ${range}, and none on ${data.monthLabel}'s plan.`} />
      </div>
    );
  }
  const planCells = (r: TypeRow<S>, strong: boolean) =>
    r.plan ? (
      <>
        <td className="px-2 text-right tabnum">{fmt(r.plan.required)}</td>
        <td className="px-2 text-right tabnum">{fmt(r.plan.done[stages[stages.length - 1]])}</td>
        <td className={`px-2 text-right tabnum ${r.plan.left > 0 ? "font-bold" : "text-muted"}`}>{fmt(r.plan.left)}</td>
        <td className={`px-2 text-right tabnum ${strong ? "font-bold" : ""}`}>{pctOrDash(r.plan.share)}</td>
      </>
    ) : (
      <td colSpan={4} className="px-2 text-right text-muted">not on {data.monthLabel}&apos;s plan</td>
    );
  const madeCells = (r: TypeRow<S>) => stages.map((s) => <td key={s} className={`px-2 text-right tabnum ${r.made[s] === 0 ? "text-muted" : ""}`}>{fmt(r.made[s])}</td>);
  return (
    <div className="min-w-0">
      {head}
      <TableFrame className="!max-h-[28rem]">
        <table className="w-full text-sm">
          <thead>
            <GroupBand spans={[{ span: 1 }, { span: stages.length, label: `Made, ${range}` }, { span: 4, label: `${data.monthLabel}'s plan` }]} />
            <tr>
              <Th label={detail ? `Item · ${typeWord}` : "Item"} />
              {stages.map((s) => <Th key={s} label={stageLabel[s]} full={`Pieces the Daily log recorded at this stage in the period, whatever order they were for`} num className="text-right" />)}
              <Th label="Planned" full={`What ${data.monthLabel}'s orders ask`} num className="text-right" />
              <Th label={finishWord} full={`Pieces finished on ${data.monthLabel}'s orders so far — each order counted up to what it asks`} num className="text-right" />
              <Th label="Left" full="Planned, not finished yet" num className="text-right" />
              <Th label="Done" full={`${finishWord} ÷ planned`} num className="text-right" />
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => {
              // one type: the item's row says it; several: the item's total, then each type
              const single = g.types.length === 1;
              const label = single && detail ? <>{g.item} <span className="text-muted font-normal">· {g.types[0].type}</span></> : g.item;
              return [
                <tr key={g.item} className={detail && !single ? "bg-surface-2" : ""}>
                  <th scope="row" className="px-2 py-1 text-left font-semibold whitespace-nowrap">{label}</th>
                  {madeCells(g.total)}
                  {planCells(g.total, true)}
                </tr>,
                ...(detail && !single ? g.types.map((t) => (
                  <tr key={`${g.item}|${t.type}`}>
                    <th scope="row" className="px-2 ps-5 py-1 text-left font-normal whitespace-nowrap">{t.type}</th>
                    {madeCells(t)}
                    {planCells(t, false)}
                  </tr>
                )) : []),
              ];
            })}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}

export function OutputByType({ tr, lv, range }: { tr: OutputByTypeData<Stage>; lv: OutputByTypeData<LvStage>; range: string }) {
  const [detail, setDetail] = useState(true);
  const months = tr.monthLabel === lv.monthLabel ? tr.monthLabel : `${tr.monthLabel} / ${lv.monthLabel}`;
  return (
    <ChartCard
      title="What did we make, item by item?"
      data={outputByTypeRows(tr, lv)}
      about={`Each line's pieces at each stage in the period, by item and type — the transformers by component and KVA class, the panels by plan and panel type — against ${months}'s plan. Pieces add up within an item, never across items or lines; an order counts on the plan up to what it asks.`}
      right={
        <nav className="seg" aria-label="Rows">
            <button type="button" className={detail ? "" : "on"} aria-pressed={!detail} onClick={() => setDetail(false)}>Items</button>
            <button type="button" className={detail ? "on" : ""} aria-pressed={detail} onClick={() => setDetail(true)}>Items and types</button>
        </nav>
      }
    >
      <div className="grid gap-4 2xl:grid-cols-2">
        <LineTable line="TR" data={tr} stages={STAGES} stageLabel={TR_TYPE_STAGE_LABEL} typeWord="KVA class" finishWord="Finished" range={range} detail={detail} />
        <LineTable line="LV" data={lv} stages={LV_STAGES} stageLabel={LV_TYPE_STAGE_LABEL} typeWord="panel type" finishWord="Painted" range={range} detail={detail} />
      </div>
    </ChartCard>
  );
}
