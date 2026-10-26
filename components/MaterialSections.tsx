"use client";

import { SectionStrip, type Section } from "@/components/SectionStrip";

// The Material tab holds three places: the nesting sheets, the store's
// physical count, and the consumables the store hands out. Their dashboards
// live in the Dashboards tab (components/DashboardSections.tsx).

export type MaterialSection = "material" | "physical" | "consumables";

const SECTIONS: readonly Section<MaterialSection>[] = [
  { id: "material", href: "/material", label: "Material", title: "The nesting project tracker — what each order consumed" },
  { id: "physical", href: "/physical", label: "Physical Material", title: "The store's count against Odoo's stock, code by code" },
  { id: "consumables", href: "/consumables", label: "Consumables", title: "What the store hands out to the floor — item, quantity, department, worker" },
];

export function MaterialSections({ current }: { current: MaterialSection }) {
  return <SectionStrip sections={SECTIONS} current={current} label="Material" />;
}
