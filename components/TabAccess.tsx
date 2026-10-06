"use client";

import { createContext, useContext, useMemo } from "react";
import { canSeePath } from "@/lib/domain/tabs";

// The screens switched off for the signed-in account (lib/domain/tabs.ts),
// for the menus and view switches to leave out. The pages guard themselves
// on the server; this only keeps a hidden screen out of sight.

const HiddenTabs = createContext<ReadonlySet<string>>(new Set());

export function TabAccessProvider({ hidden, children }: { hidden: string[]; children: React.ReactNode }) {
  const key = hidden.join(",");
  const set = useMemo(() => new Set(key ? key.split(",") : []), [key]);
  return <HiddenTabs.Provider value={set}>{children}</HiddenTabs.Provider>;
}

/** Whether this account sees the screen at `href`. */
export function useCanSee(): (href: string) => boolean {
  const hidden = useContext(HiddenTabs);
  return (href: string) => canSeePath(hidden, href);
}
