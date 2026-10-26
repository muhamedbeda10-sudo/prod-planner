"use client";

import { useSearchParams } from "next/navigation";
import { SectionStrip, type Section } from "@/components/SectionStrip";
import { LINE_PARAM } from "@/lib/domain/lines";

// The Dashboards tab: every dashboard of the app in one place, one place
// each — the plan, the floor, the material, the consumables and Odoo. Each
// is still switched on or off per account with the screen it reads (its tab
// id in lib/domain/tabs.ts). Planning and Production show either line or the
// whole plant (?line=all|TR|LV), so both are offered whatever the line, and
// "All" rides along between them as a line named in the address does.

export type DashboardSection = "planning" | "production" | "material" | "consumables" | "odoo";

const SECTIONS: readonly Section<DashboardSection>[] = [
  { id: "planning", href: "/", label: "Planning", title: "The plan: what needs a decision, the week, the load ahead, the month and its people" },
  { id: "production", href: "/dashboards/production", label: "Production", title: "How the floor worked: output, efficiency, where the hours went, what stopped the machines, quality and rework" },
  { id: "material", href: "/dashboards/material", label: "Material", title: "Consumption booked when the MO is closed on Odoo — sheets, tonnes, thicknesses, scrap" },
  { id: "consumables", href: "/dashboards/consumables", label: "Consumables", title: "What went out, to whom, against the limits — and the monthly review" },
  { id: "odoo", href: "/dashboards/odoo", label: "ODOO", title: "Closed quantities per product and the close-out time" },
];
/** The two dashboards that take the plant as a whole. */
const PLANT_WIDE = new Set<DashboardSection>(["planning", "production"]);

export function DashboardSections({ current }: { current: DashboardSection }) {
  const all = useSearchParams().get(LINE_PARAM)?.trim().toLowerCase() === "all";
  const sections = all ? SECTIONS.map((s) => (PLANT_WIDE.has(s.id) ? { ...s, href: `${s.href}?${LINE_PARAM}=all` } : s)) : SECTIONS;
  return <SectionStrip sections={sections} current={current} label="Dashboards" />;
}
