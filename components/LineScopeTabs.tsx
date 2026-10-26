"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DASH_SCOPES, DASH_SCOPE_LABEL, DASH_SCOPE_TITLE, type DashScope } from "@/lib/domain/dashboardScope";

// All | TR | LV — the line a dashboard shows, in its page head where the
// other screens carry their Transformers | LV Panels switch (LineSwitch).
// Each is a link that keeps the page's filters and names the scope in the
// address (?line=), so a bookmark or a link sent to a colleague opens the
// same view. "All" is the dashboards' alone: the recording screens still
// work one line at a time.

export function LineScopeTabs({ scope }: { scope: DashScope }) {
  const path = usePathname();
  const params = useSearchParams();
  const href = (s: DashScope) => {
    const p = new URLSearchParams(params.toString());
    p.set("line", s);
    return `${path}?${p}`;
  };
  return (
    <nav className="seg" aria-label="Line shown">
      {DASH_SCOPES.map((s) => (
        <Link key={s} href={href(s)} aria-current={s === scope ? "page" : undefined} title={DASH_SCOPE_TITLE[s]} className={s === scope ? "on" : ""}>
          {DASH_SCOPE_LABEL[s]}
        </Link>
      ))}
    </nav>
  );
}
