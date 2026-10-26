"use client";

import { SectionStrip, type Section } from "@/components/SectionStrip";
import { useActiveLine } from "@/components/LineContext";

// The Dashboards tab: every dashboard of the app in one place, one place
// each — the plan, the floor, the material, the consumables and Odoo. Each
// is still switched on or off per account with the screen it reads (its tab
// id in lib/domain/tabs.ts). The floor's figures are the transformers': on
// the panels there is no Production place.

export type DashboardSection = "planning" | "production" | "material" | "consumables" | "odoo";

const SECTIONS: readonly Section<DashboardSection>[] = [
  { id: "planning", href: "/", label: "Planning", title: "The plan: what needs a decision, the week, the load ahead, the month and its people" },
  { id: "production", href: "/dashboards/production", label: "Production", title: "How the floor worked: efficiency, productivity, output, where the hours went and what stopped it" },
  { id: "material", href: "/dashboards/material", label: "Material", title: "Consumption booked when the MO is closed on Odoo — sheets, tonnes, thicknesses, scrap" },
  { id: "consumables", href: "/dashboards/consumables", label: "Consumables", title: "What went out, to whom, against the limits — and the monthly review" },
  { id: "odoo", href: "/dashboards/odoo", label: "ODOO", title: "Closed quantities per product and the close-out time" },
];

export function DashboardSections({ current }: { current: DashboardSection }) {
  const line = useActiveLine();
  const sections = line === "LV" ? SECTIONS.filter((s) => s.id !== "production") : SECTIONS;
  return <SectionStrip sections={sections} current={current} label="Dashboards" />;
}
