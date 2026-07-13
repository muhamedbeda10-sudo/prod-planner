"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { ITEMS } from "@/lib/domain/constants";

/* ATC brand chart palette */
const GREEN = "#1a8150"; // brand green
const GREEN_DARK = "#136041";
const GRAY = "#717171"; // brand gray
const GRAY_LIGHT = "#b8c1bc";

export function OutputByComponentChart({
  cut, welding, painting,
}: {
  cut: Record<string, number>;
  welding: Record<string, number>;
  painting: Record<string, number>;
}) {
  const data = ITEMS.map((it) => ({ item: it, Cut: cut[it] ?? 0, Welding: welding[it] ?? 0, Painting: painting[it] ?? 0 }));
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="item" />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Bar dataKey="Cut" fill={GREEN} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Welding" fill={GRAY} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Painting" fill={GREEN_DARK} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SetsVsTargetChart({
  target, cutSets, weldSets, paintSets,
}: {
  target: number;
  cutSets: number;
  weldSets: number;
  paintSets: number;
}) {
  const data = [
    { name: "Cut", Complete: cutSets, Target: target },
    { name: "Welding", Complete: weldSets, Target: target },
    { name: "Painting", Complete: paintSets, Target: target },
  ];
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Bar dataKey="Target" fill={GRAY_LIGHT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Complete" fill={GREEN} radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.Complete >= target ? GREEN_DARK : GREEN} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PlannedVsWeldedChart({
  data,
}: {
  data: { date: string; planned: number; welded: number }[];
}) {
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Bar dataKey="planned" name="Planned" fill={GRAY_LIGHT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="welded" name="Welded" fill={GREEN} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="no-print bg-brand hover:bg-brand-dark text-white font-bold rounded-md px-4 py-1.5 text-sm transition-colors">
      🖨️ Print / Save PDF
    </button>
  );
}
