import Link from "next/link";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";

/** Segmented switcher between the three department worklists — one nav tab
 *  ("Worklist") opens the user's dept, this switches between them in-page. */
const DEPTS = [
  { key: "cut", href: "/worklist/cut", label: "Fabrication", Icon: LaserCutterIcon },
  { key: "welding", href: "/worklist/welding", label: "Welding", Icon: WeldingIcon },
  { key: "painting", href: "/worklist/painting", label: "Painting", Icon: PowderCoatIcon },
] as const;

export function WorklistDeptTabs({ current }: { current: "cut" | "welding" | "painting" }) {
  return (
    <div className="no-print mb-4 inline-flex items-center gap-1 rounded-xl border bg-surface p-1">
      {DEPTS.map(({ key, href, label, Icon }) => {
        const active = key === current;
        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-bold transition-colors ${
              active ? "bg-brand text-white shadow-sm" : "text-muted hover:bg-brand-light hover:text-brand"
            }`}
          >
            <Icon size={15} className="shrink-0" />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
