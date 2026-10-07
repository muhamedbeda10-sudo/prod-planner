import "server-only";
import { prisma } from "@/lib/db";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";
import { LV_ITEM } from "@/lib/domain/lv";
import { isItem } from "@/lib/domain/constants";
import { lineMaterialOf, pickJobLines, type LineMaterial, type NestingLineLite } from "@/lib/domain/machineMaterial";

// The sheets behind the lines on the machines, off the MATERIAL tab: a
// transformer part by its part code on its BOM (the order's SOI picks its
// job), an LV order by its own MO — the panels' nesting is filed per order.

export interface MaterialLineRef {
  key: string;
  bom: string;
  mo: string;
  item: string;
}

export interface OrderRef {
  soi: string | null;
  months: string[];
}

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

export async function getLinesMaterial(lines: readonly MaterialLineRef[], orderOf: (mo: string) => OrderRef | undefined): Promise<Record<string, LineMaterial>> {
  const out: Record<string, LineMaterial> = {};
  if (lines.length === 0) return out;
  const partOf = (item: string) => (isItem(item) ? ITEM_PRODUCT[item].partCode : null);
  const tr = lines.filter((l) => l.item !== LV_ITEM && partOf(l.item));
  const lv = lines.filter((l) => l.item === LV_ITEM && l.mo);
  const select = {
    month: true, soi: true, mo: true, bom: true, partCode: true, partName: true, material: true, materialCode: true, thicknessMm: true,
    sheetSize: true, units: true, sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true,
  } as const;
  const [trRows, lvRows] = await Promise.all([
    tr.length > 0
      ? prisma.materialUsage.findMany({
          where: { line: "TR", bom: { in: [...new Set(tr.map((l) => l.bom))] }, partCode: { in: [...new Set(tr.map((l) => partOf(l.item)!))] } },
          select, orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        })
      : [],
    lv.length > 0 ? prisma.materialUsage.findMany({ where: { line: "LV", mo: { not: "" } }, select, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }) : [],
  ]);
  const lite = (r: (typeof trRows)[number]): NestingLineLite => ({ ...r, soi: r.soi ?? "", mo: r.mo ?? "" });

  const byPart = new Map<string, NestingLineLite[]>();
  for (const r of trRows) {
    const k = `${up(r.partCode)}|${up(r.bom)}`;
    (byPart.get(k) ?? byPart.set(k, []).get(k)!).push(lite(r));
  }
  const byMo = new Map<string, NestingLineLite[]>();
  for (const r of lvRows) {
    const k = up(r.mo);
    (byMo.get(k) ?? byMo.set(k, []).get(k)!).push(lite(r));
  }

  for (const l of tr) {
    const all = byPart.get(`${up(partOf(l.item))}|${up(l.bom)}`) ?? [];
    const order = l.mo ? orderOf(l.mo) : undefined;
    const m = lineMaterialOf(pickJobLines(all, order?.soi ?? null), order?.months ?? []);
    if (m && m.specs.length > 0) out[l.key] = m;
  }
  for (const l of lv) {
    const m = lineMaterialOf(byMo.get(up(l.mo)) ?? [], orderOf(l.mo)?.months ?? []);
    if (m && m.specs.length > 0) out[l.key] = m;
  }
  return out;
}
