"use client";

import { SectionStrip, type Section } from "@/components/SectionStrip";
import { useActiveLine } from "@/components/LineContext";
import { pinnedLine } from "@/lib/domain/lines";

// The Plan Tracker tab holds four places: the tracker, the daily log it adds
// up, the what-if simulator and the ODOO close-out log. The same strip at the
// top of each moves between them, keeping the product line on screen.

export type TrackerSection = "tracker" | "handover" | "simulate" | "odoo";

const SECTIONS: readonly Section<TrackerSection>[] = [
  { id: "tracker", href: "/tracker", label: "Plan Tracker", title: "One row per order, every stage" },
  { id: "handover", href: "/handover", label: "Daily log", title: "The raw entries the tracker adds up — edit and correct them here" },
  { id: "simulate", href: "/simulate", label: "Simulator", title: "What-if: move the dates and the capacity and see what lands — the transformers' plan" },
  { id: "odoo", href: "/odoo", label: "ODOO log", title: "The daily close-out log on Odoo" },
];

export function TrackerSections({ current }: { current: TrackerSection }) {
  // a place pinned to the other line (the simulator models the transformers'
  // plan) is not offered on this one
  const line = useActiveLine();
  const sections = SECTIONS.filter((s) => (pinnedLine(s.href) ?? line) === line || s.id === current);
  return <SectionStrip sections={sections} current={current} label="Plan Tracker" />;
}
