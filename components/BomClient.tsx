"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, Boxes, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListTree } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { FilterBar, FilterSelect, SearchBox, useSavedFilter } from "@/components/FilterControls";
import { TableEmpty, TableFrame, Th } from "@/components/DataTable";
import { ITEM_NAME, ITEMS, type Item } from "@/lib/domain/constants";
import { flattenNodes, itemCheckOk, type BomNode } from "@/lib/domain/odooBom";
import { formatDateTime, formatNumber } from "@/lib/domain/format";
import type { BomListRow, BomTreeData, SyncView } from "@/lib/server/odooBom";
import { hrefWithLine, type ProductLine } from "@/lib/domain/lines";

// MATERIAL → BOMS — the bills of materials the open orders are built with, as
// Odoo holds them (mirrored read-only by the Odoo sync). The
// list: one row per code, whether Odoo has its BoM, the components it carries
// and how many orders disagree with it. One code: its whole tree, level by
// level, the raw materials one unit takes, and each open order's components
// against the BoM's.

/** A quantity as Odoo writes it: whole when whole, else up to four places. */
const q = (n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 4);

/** A code's BoM on its own line — the line rides on every link (lib/domain/lines.ts). */
const bomHref = (bom: string, line: ProductLine) => hrefWithLine(`/bom?bom=${encodeURIComponent(bom)}`, line);

const VIA_LABEL: Record<string, string> = {
  code: "by its reference",
  product: "by the product's code",
  mo: "by the order's MO",
};

/** When the BoMs came from Odoo and who ran it — or that none has yet. */
export function SyncLine({ sync }: { sync: SyncView | null }) {
  if (!sync) return <span className="text-xs text-muted">Not read from Odoo yet — the Odoo sync fills this in.</span>;
  return (
    <span className="text-xs text-muted" title={`${sync.boms} BoMs and ${sync.lines} lines held · ${sync.roots} codes found, ${sync.missing} not in Odoo`}>
      Read from Odoo <b className="text-foreground tabnum">{formatDateTime(sync.atISO)}</b>
    </span>
  );
}

function ItemPills({ items, tone = "pill-muted" }: { items: readonly Item[]; tone?: string }) {
  if (items.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((it) => <span key={it} className={`pill ${tone}`} title={ITEM_NAME[it]}>{it}</span>)}
    </span>
  );
}

// ---------------------------------------------------------------- the list

const LIST_STATUS = [
  { value: "found", label: "In Odoo" },
  { value: "missing", label: "Not in Odoo" },
  { value: "unsynced", label: "Not synced yet" },
  { value: "differ", label: "Components differ" },
] as const;

function rowStatus(r: BomListRow): "found" | "missing" | "unsynced" {
  return r.root ? "found" : r.looked ? "missing" : "unsynced";
}

export function BomListClient({ rows, sync, lineSwitch }: { rows: BomListRow[]; sync: SyncView | null; lineSwitch: React.ReactNode }) {
  const [search, setSearch] = useSavedFilter("bom.q");
  const [status, setStatus] = useSavedFilter("bom.status");
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (needle && !`${r.bom} ${r.root?.code ?? ""} ${r.root?.productName ?? ""}`.toLowerCase().includes(needle)) return false;
      if (status === "differ") return r.mismatched > 0;
      if (status && rowStatus(r) !== status) return false;
      return true;
    });
  }, [rows, search, status]);
  const counts = useMemo(() => ({
    found: rows.filter((r) => r.root).length,
    differ: rows.filter((r) => r.mismatched > 0).length,
    off: rows.filter((r) => !r.root).length,
  }), [rows]);
  const hasActive = !!(search || status);
  const reset = () => { setSearch(""); setStatus(""); };

  return (
    <div className="space-y-3">
      <FilterBar
        count={shown.length}
        total={rows.length}
        onReset={reset}
        hasActive={hasActive}
        head={<>{lineSwitch}<SearchBox value={search} onChange={setSearch} placeholder="Search code or product…" wide /></>}
        actions={<SyncLine sync={sync} />}
      >
        <FilterSelect label="Status" value={status} onChange={setStatus} options={LIST_STATUS.map((s) => ({ value: s.value, label: s.label }))} />
        <span className="text-xs text-muted tabnum">
          <b className="text-foreground">{counts.found}</b> in Odoo
          {counts.off > 0 && <> · <b className="text-bad-fg">{counts.off}</b> not found</>}
          {counts.differ > 0 && <> · <b className="text-warn-fg">{counts.differ}</b> with orders that differ</>}
        </span>
      </FilterBar>

      <section className="bg-surface border rounded-[10px] overflow-hidden">
        {rows.length === 0 ? (
          <TableEmpty title="No open order on this line" hint="The BoMs listed here are those of the open orders in the Orders Registry." />
        ) : shown.length === 0 ? (
          <TableEmpty filtered title="No BoM matches these filters" hint={`${rows.length} codes are hidden by the filters above.`} action={<button type="button" className="btn btn-sm btn-secondary" onClick={reset}>Reset filters</button>} />
        ) : (
          <TableFrame>
            <table className="erp-table grid-lines w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  <Th label="BOM" full="The orders' BOM code" />
                  <Th label="Odoo BoM" full="Odoo's reference for it" group="source" />
                  <Th label="Product" group="source" />
                  <Th label="Orders" full="Open orders on this code" num />
                  <Th label="Units" unit="pcs" full="Planned units over those orders" num />
                  <Th label="Components" hint="The components the BoM builds (tank, top cover, core frame, cable box, arrester, mono box)" group="source" />
                  <Th label="Check" hint="Open orders whose required components differ from the BoM's" group="computed" center />
                  <Th label="Levels" num group="source" />
                  <Th label="Lines" full="Lines in the whole tree" num group="source" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.bom}>
                    <td className="p-2 whitespace-nowrap ltr text-xs font-bold"><Link href={bomHref(r.bom, r.line)} className="text-brand-ink hover:underline">{r.bom}</Link></td>
                    <td className="p-2 whitespace-nowrap ltr text-xs">
                      {r.root
                        ? <span title={VIA_LABEL[r.root.via] ? `Found ${VIA_LABEL[r.root.via]}` : undefined}>{r.root.code}</span>
                        : <span className={`pill ${r.looked ? "pill-bad" : "pill-muted"}`}>{r.looked ? "Not in Odoo" : "Not synced yet"}</span>}
                    </td>
                    <td className="p-2 text-xs min-w-[16rem]">{r.root?.productName || <span className="text-muted">—</span>}</td>
                    <td className="p-2 num tabnum">{r.orders}</td>
                    <td className="p-2 num tabnum">{q(r.units)}</td>
                    <td className="p-2">{r.root ? <ItemPills items={r.items} /> : <span className="text-muted">—</span>}</td>
                    <td className="p-2 text-center">
                      {!r.root || r.line === "LV" ? <span className="text-muted">—</span>
                        : r.mismatched > 0 ? <Link href={bomHref(r.bom, r.line)} className="pill pill-warn">{r.mismatched} differ</Link>
                        : <span className="pill pill-ok">OK</span>}
                    </td>
                    <td className="p-2 num tabnum">{r.stats?.depth ?? <span className="text-muted">—</span>}</td>
                    <td className="p-2 num tabnum">{r.stats?.nodes ?? <span className="text-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- one BoM

const INDENT = ["ps-2", "ps-6", "ps-10", "ps-14", "ps-18", "ps-22", "ps-26", "ps-30", "ps-34", "ps-38", "ps-42"] as const;

/** The keys of every node whose subtree holds a match, and the matches. */
function searchTree(nodes: readonly BomNode[], needle: string): { open: Set<string>; hits: Set<string> } {
  const open = new Set<string>();
  const hits = new Set<string>();
  const go = (ns: readonly BomNode[]): boolean => {
    let any = false;
    for (const n of ns) {
      const self = `${n.productCode} ${n.productName}`.toLowerCase().includes(needle);
      const below = go(n.children);
      if (self) hits.add(n.key);
      if (below) open.add(n.key);
      if (self || below) any = true;
    }
    return any;
  };
  go(nodes);
  return { open, hits };
}

const VIEWS = [
  { value: "tree", label: "Tree" },
  { value: "raw", label: "Raw materials" },
] as const;

export function BomTreeClient({ data, sync }: { data: BomTreeData; sync: SyncView | null }) {
  const all = useMemo(() => flattenNodes(data.nodes), [data.nodes]);
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [search, setSearch] = useState("");
  // the first level open: the transformer's assemblies, one click from their parts
  const [open, setOpen] = useState<Set<string>>(() => new Set(data.nodes.map((n) => n.key)));
  const needle = search.trim().toLowerCase();
  const found = useMemo(() => (needle ? searchTree(data.nodes, needle) : null), [data.nodes, needle]);
  const rawShown = useMemo(() => data.raw.filter((r) => !needle || `${r.productCode} ${r.productName}`.toLowerCase().includes(needle)), [data.raw, needle]);
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const isOpen = (n: BomNode) => (found ? found.open.has(n.key) : open.has(n.key));
  const differing = data.orders.filter((o) => o.check && !itemCheckOk(o.check));

  const rows: BomNode[] = [];
  const walk = (ns: readonly BomNode[]) => {
    for (const n of ns) {
      if (found && !found.hits.has(n.key) && !found.open.has(n.key)) continue;
      rows.push(n);
      if (n.children.length && isOpen(n)) walk(n.children);
    }
  };
  walk(data.nodes);

  const back = <Link href={hrefWithLine("/bom", data.line)} className="btn btn-sm btn-ghost"><ArrowLeft size={14} aria-hidden />All BoMs</Link>;

  if (!data.root) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">{back}<SyncLine sync={sync} /></div>
        <section className="bg-surface border rounded-[10px]">
          <TableEmpty
            title={data.looked ? <>Odoo has no BoM for <span className="ltr">{data.bom}</span></> : <>No BoM synced for <span className="ltr">{data.bom}</span> yet</>}
            hint={data.looked
              ? "The sync looked for its reference (FG- / TX- and the code itself), the product with this code and its orders' MOs, and found none of them."
              : "The Odoo sync reads the BoMs of the open orders' codes. A code added since then comes with the next sync."}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <FilterBar
        count={view === "tree" ? rows.length : rawShown.length}
        total={view === "tree" ? all.length : data.raw.length}
        onReset={() => setSearch("")}
        hasActive={!!search}
        head={<>{back}<SearchBox value={search} onChange={setSearch} placeholder="Search component or material…" wide /></>}
        actions={<>
          <SyncLine sync={sync} />
          <nav className="seg" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} className={view === v.value ? "on" : ""} onClick={() => setView(v.value)}>{v.label}</button>
            ))}
          </nav>
        </>}
      >
        {view === "tree" && !found && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(new Set(all.filter((n) => n.children.length).map((n) => n.key)))}><ChevronsUpDown size={14} aria-hidden />Expand all</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(new Set())}><ChevronsDownUp size={14} aria-hidden />Collapse all</button>
          </>
        )}
      </FilterBar>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]">
        <SectionCard icon={ListTree} title={<span className="ltr">{data.root.code}</span>} description={data.root.productName}>
          <p className="text-xs text-muted">
            {data.stats ? <>{data.stats.depth} levels · {data.stats.nodes} lines · {data.raw.length} raw materials</> : null}
            {VIA_LABEL[data.root.via] ? <> · found {VIA_LABEL[data.root.via]}</> : null}
          </p>
          {data.incomplete.length > 0 && (
            <p className="text-xs text-warn-fg mt-1">Not synced yet: <span className="ltr">{data.incomplete.slice(0, 6).join(", ")}</span>{data.incomplete.length > 6 ? ` +${data.incomplete.length - 6}` : ""}</p>
          )}
        </SectionCard>
        <SectionCard icon={Boxes} title="Components in the BoM" description="How many one unit takes">
          {data.items.length === 0 ? <p className="text-sm text-muted">None of the tracked components.</p> : (
            <span className="flex flex-wrap gap-2">
              {data.items.map((x) => (
                <span key={x.item} className="pill pill-muted" title={ITEM_NAME[x.item]}>{x.item} <b className="tabnum">× {q(x.perUnit)}</b></span>
              ))}
            </span>
          )}
          {data.line === "TR" && data.orders.length > 0 && (
            <p className={`text-xs font-semibold mt-2 ${differing.length ? "text-warn-fg" : "text-ok-fg"}`}>
              {differing.length ? `${differing.length} of ${data.orders.length} open orders differ from the BoM — see below` : `All ${data.orders.length} open orders agree with the BoM`}
            </p>
          )}
        </SectionCard>
      </div>

      <section className="bg-surface border rounded-[10px] overflow-hidden">
        {view === "tree" ? (
          rows.length === 0 ? (
            <TableEmpty filtered title="Nothing in this BoM matches" hint="Try another code or name." action={<button type="button" className="btn btn-sm btn-secondary" onClick={() => setSearch("")}>Clear search</button>} />
          ) : (
            <TableFrame>
              <table className="erp-table grid-lines w-full border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <Th label="Component" full="Odoo product code, indented by level" />
                    <Th label="Name" />
                    <Th label="Qty" full="For one unit of the line above" num group="source" />
                    <Th label="UOM" center />
                    <Th label="Per unit" full={`For one ${data.root.code}, in the product's stock unit`} num group="computed" />
                    <Th label="Built with" full="The sub-BoM Odoo builds it with — blank when bought or raw" group="source" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => {
                    const hit = found?.hits.has(n.key);
                    return (
                      <tr key={n.key} className={n.level === 1 ? "font-semibold" : undefined}>
                        <td className={`p-2 whitespace-nowrap ltr text-xs ${INDENT[Math.min(n.level - 1, INDENT.length - 1)]}`}>
                          <span className="inline-flex items-center gap-1">
                            {n.children.length ? (
                              <button type="button" onClick={() => toggle(n.key)} aria-expanded={isOpen(n)} disabled={!!found} aria-label={`${isOpen(n) ? "Collapse" : "Expand"} ${n.productCode}`} className="inline-flex items-center justify-center min-w-6 min-h-6 -my-1">
                                <ChevronRight size={14} className={`transition-transform ${isOpen(n) ? "rotate-90" : ""}`} aria-hidden />
                              </button>
                            ) : <span className="inline-block w-6" aria-hidden />}
                            <span className={hit ? "bg-warn-bg rounded px-0.5" : undefined}>{n.productCode}</span>
                            {n.item && <span className="pill pill-muted" title={ITEM_NAME[n.item]}>{n.item}</span>}
                          </span>
                        </td>
                        <td className="p-2 text-xs min-w-[16rem]">{n.productName}</td>
                        <td className="p-2 num tabnum">{q(n.qty)}</td>
                        <td className="p-2 text-center text-xs text-muted">{n.uom || "—"}</td>
                        <td className="p-2 num tabnum font-semibold" title={n.stockUom ? `${q(n.perRoot)} ${n.stockUom}` : undefined}>{q(n.perRoot)}</td>
                        <td className="p-2 whitespace-nowrap ltr text-xs">
                          {n.childCode ?? (n.childMissing ? <span className="pill pill-warn">not synced</span> : <span className="text-muted">—</span>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          )
        ) : rawShown.length === 0 ? (
          <TableEmpty filtered={!!needle} title={needle ? "No raw material matches" : "No raw material in this BoM"} />
        ) : (
          <TableFrame>
            <table className="erp-table grid-lines w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  <Th label="Material" full="Odoo product code" />
                  <Th label="Name" />
                  <Th label="Per unit" full={`For one ${data.root.code}, summed through every sub-BoM`} num group="computed" />
                  <Th label="UOM" center />
                </tr>
              </thead>
              <tbody>
                {rawShown.map((r) => (
                  <tr key={r.productCode}>
                    <td className="p-2 whitespace-nowrap ltr text-xs font-semibold">{r.productCode}</td>
                    <td className="p-2 text-xs min-w-[16rem]">{r.productName}</td>
                    <td className="p-2 num tabnum font-semibold">{q(r.qty)}</td>
                    <td className="p-2 text-center text-xs text-muted">{r.uom || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>

      {data.line === "TR" && data.orders.length > 0 && (
        <section className="bg-surface border rounded-[10px] overflow-hidden">
          <TableFrame>
            <table className="erp-table grid-lines w-full border-collapse">
              <thead>
                <tr>
                  <Th label="MO" full="Open orders on this code" />
                  <Th label="Units" unit="pcs" num />
                  <Th label="Required" hint="The components the order counts — the rules by kVA and rating, and the planner's N/A" />
                  <Th label="Against the BoM" hint="What the order needs that the BoM has none of, and what the BoM builds that the order does not count" group="computed" />
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                    <tr key={o.mo}>
                      <td className="p-2 whitespace-nowrap ltr text-xs font-semibold">{o.mo}{o.held && <span className="pill pill-muted ms-1">on hold</span>}</td>
                      <td className="p-2 num tabnum">{q(o.planQty)}</td>
                      <td className="p-2"><ItemPills items={ITEMS.filter((it) => o.required.includes(it))} /></td>
                      <td className="p-2 text-xs">
                        {!o.check ? <span className="text-muted">—</span> : itemCheckOk(o.check) ? <span className="pill pill-ok">Agrees</span> : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            {o.check.notInBom.length > 0 && <span className="inline-flex items-center gap-1">Not in the BoM: <ItemPills items={o.check.notInBom} tone="pill-bad" /></span>}
                            {o.check.notRequired.length > 0 && <span className="inline-flex items-center gap-1">The BoM also builds: <ItemPills items={o.check.notRequired} tone="pill-warn" /></span>}
                          </span>
                        )}
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </section>
      )}
    </div>
  );
}
