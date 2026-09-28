"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Menu, X, LogOut, Settings, LayoutDashboard, ClipboardList,
  Table2, FileBarChart2, BookOpenCheck, ListChecks, ChevronDown,
  CalendarDays, Users, Timer,
  FlaskConical, MessagesSquare, Droplets, QrCode, HardHat, SlidersHorizontal, Layers, Boxes, Clock, Factory, ChartColumnBig,
} from "lucide-react";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ChatDock } from "@/components/ChatDock";
import { useOdooAlerts } from "@/components/OdooAlerts";
import { LineTabs } from "@/components/LineTabs";
import type { ProductLine } from "@/lib/domain/lines";
import { logoutAction } from "@/app/login/actions";

type Item = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  match?: string;
  /** Extra routes that light this tab — the views that live inside it. */
  also?: string[];
};

// The three department worklists live under ONE "Worklist" tab — clicking it
// expands them inline in the bar; picking one navigates and collapses again.
// Leak test sits where it does on the shop floor: between welding and painting.
const WORKLIST_DEPTS = [
  { href: "/worklist/cut", label: "Fabrication", icon: LaserCutterIcon, perm: "cut.edit" },
  { href: "/worklist/welding", label: "Welding", icon: WeldingIcon, perm: "welding.edit" },
  { href: "/worklist/leak-test", label: "Leak Test", icon: Droplets, perm: "leaktest.edit" },
  { href: "/worklist/painting", label: "Painting", icon: PowderCoatIcon, perm: "painting.edit" },
] as const;
// The LV panels' four stages, in the order a panel passes them. Punching and
// bending are the panel's fabrication; each opens on the panels' own key.
const LV_WORKLIST_DEPTS = [
  { href: "/worklist/punching", label: "Punching", icon: LaserCutterIcon, perm: "lv.punching" },
  { href: "/worklist/bending", label: "Bending", icon: LaserCutterIcon, perm: "lv.bending" },
  { href: "/worklist/welding", label: "Welding", icon: WeldingIcon, perm: "lv.welding" },
  { href: "/worklist/painting", label: "Painting", icon: PowderCoatIcon, perm: "lv.painting" },
] as const;

// Tabs after Worklist, ordered by shop-floor flow: work → log → track →
// review → the overview dashboard sits last (right side).
// One tab per QUESTION, not per screen. Several of these hold more than one
// view behind their own switcher (see components/ViewTabs.tsx), which is what
// keeps the strip short enough to read:
//   Plan Tracker → the tracker and the daily log it adds up
//   Floor        → the bay as it is, and the what-if simulator
//   Dashboard    → this week, the printed report, and the sheet analytics
// Chat is not here at all — it is the icon in the right cluster.
const REST: Item[] = [
  // Material comes FIRST: nesting is decided before a single sheet is cut.
  { href: "/material", label: "Material", icon: Layers },
  { href: "/odoo", label: "ODOO", icon: Boxes },
  // who worked today, how long, on what — the supervisors' page
  { href: "/shifts", label: "Shifts", icon: Clock },
  { href: "/tracker", label: "Plan Tracker", icon: Table2, also: ["/handover"] },
  // the tanks' sticker sheet — its own tab while per-piece tracking is on
  // (TANK_ONLY drops it otherwise), and still a button on the painting worklist
  { href: "/barcode", label: "Tank Barcodes", icon: QrCode, match: "/barcode" },
  { href: "/simulate", label: "Floor", icon: FlaskConical },
  { href: "/", label: "Dashboard", icon: LayoutDashboard, also: ["/report", "/analytics"] },
];

// The mobile drawer has vertical room — it lists the three worklists directly.
const DRAWER: Item[] = [
  { href: "/worklist/cut", label: "Fabrication Worklist", icon: LaserCutterIcon },
  { href: "/worklist/welding", label: "Welding Worklist", icon: WeldingIcon },
  { href: "/worklist/leak-test", label: "Leak Test", icon: Droplets },
  { href: "/worklist/painting", label: "Painting Worklist", icon: PowderCoatIcon },
  ...REST,
];

// The drawer has room for the views that ride inside a tab on desktop, so a
// phone reaches them in one tap instead of two.
const DRAWER_VIEWS: Item[] = [
  { href: "/report", label: "Report", icon: FileBarChart2 },
  { href: "/analytics", label: "Analytics", icon: ChartColumnBig },
  { href: "/handover", label: "Daily log", icon: BookOpenCheck },
  { href: "/chat", label: "Chat", icon: MessagesSquare },
];

// `perm` opens an entry to a non-admin holding that permission — the rest of
// the list stays admin-only, exactly as it was.
const ADMIN: (Item & { desc: string; perm?: string })[] = [
  // both plan imports live here now, behind the page's own switcher — they
  // were two Admin entries doing the same job a month apart
  { href: "/orders", label: "Orders & plan imports", desc: "Master MO list, the monthly plan, and the weekly delivery schedule", icon: ClipboardList, also: ["/import"] },
  { href: "/calendar", label: "Factory Calendar", desc: "Holidays & shutdown days off", icon: CalendarDays },
  { href: "/admin/settings", label: "Settings", desc: "Plant-wide switches, including per-piece tank tracking", icon: SlidersHorizontal },
  { href: "/admin/workers", label: "Production Workers", desc: "The shop-floor people of every department — the shift log and the tank dropdowns", icon: HardHat, perm: "workers.manage" },
  { href: "/admin/machines", label: "Machines & Lines", desc: "Lasers, punches, presses, paint lines & shot-blast cabinets per department", icon: Factory, perm: "machines.manage" },
  { href: "/admin/machine-times", label: "Times per Machine", desc: "What one piece of each item really takes on each machine — it outranks the standard time", icon: Timer, perm: "machines.manage" },
];

export interface NavUser {
  id: number;
  name: string;
  isAdmin: boolean;
  perms: string[];
}

// The two tabs that only exist while per-piece tank tracking is on.
const TANK_ONLY = new Set(["/worklist/leak-test", "/barcode"]);

/** Unread chat badge, shared by the desktop tab and the drawer entry. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-0.5 grid place-items-center min-w-[18px] h-[18px] rounded-full bg-red-600 text-white text-[10px] font-extrabold px-1 leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function AppNav({
  user,
  unreadChat = 0,
  tankTracking = false,
  machinePlanning = false,
  odooAlerts = { enabled: false, count: 0 },
  line = "TR",
}: {
  user: NavUser;
  unreadChat?: number;
  /** With tracking off, the Leak Test and Barcode tabs are not part of the app. */
  tankTracking?: boolean;
  /** With machine planning off, the Floor tab is the what-if simulator alone — it is named so. */
  machinePlanning?: boolean;
  /** The subscribed person's "ready to close in Odoo" alert: its count on the ODOO tab, and the popup. */
  odooAlerts?: { enabled: boolean; count: number };
  /** The product line every tab is showing — transformers or LV panels. */
  line?: ProductLine;
}) {
  const pathname = usePathname();
  const alerts = useOdooAlerts(odooAlerts.enabled, odooAlerts.count, user.id);
  // the ODOO tab lights up with the rows waiting to be closed; its badge
  // opens the popup rather than the page
  const odooBadge = (size: "sm" | "md") => alerts.count > 0 && (
    <span
      role="button" tabIndex={0} title={`${alerts.count} ready to close in Odoo — show them`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); alerts.show(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); alerts.show(); } }}
      className={`ml-0.5 grid place-items-center rounded-full bg-[#F2C94C] text-[#14201A] font-extrabold leading-none px-1 cursor-pointer ${size === "sm" ? "min-w-[18px] h-[18px] text-[10px]" : "min-w-[22px] h-[22px] text-xs"}`}
    >
      {alerts.count > 99 ? "99+" : alerts.count}
    </span>
  );

  // A user who can edit exactly ONE department jumps straight to it from the
  // Worklist tab; everyone else (admins, multi-dept, view-only) expands the
  // tab into the three departments inline.
  // the leak test and the barcodes are the tanks' — with tracking off, or the
  // panels on screen, they are not part of the app
  const tankTabs = tankTracking && line !== "LV";
  const named = (l: Item): Item => (l.href === "/simulate" && !machinePlanning ? { ...l, label: "Simulator" } : l);
  const worklistDepts = (line === "LV" ? LV_WORKLIST_DEPTS : WORKLIST_DEPTS).filter((d) => tankTabs || !TANK_ONLY.has(d.href));
  const restTabs = REST.filter((l) => tankTabs || !TANK_ONLY.has(l.href)).map(named);
  const drawerTabs = (line === "LV"
    ? [...LV_WORKLIST_DEPTS.map((d): Item => ({ href: d.href, label: `${d.label} Worklist`, icon: d.icon })), ...DRAWER.filter((l) => !l.href.startsWith("/worklist/"))]
    : DRAWER
  ).filter((l) => tankTabs || !TANK_ONLY.has(l.href)).map(named);
  const drawerViews = DRAWER_VIEWS.filter((l) => tankTabs || !TANK_ONLY.has(l.href));
  const deptEdits = worklistDepts.filter((d) => user.perms.includes(d.perm));
  const singleDeptHref = !user.isAdmin && deptEdits.length === 1 ? deptEdits[0].href : null;

  const [open, setOpen] = useState(false); // desktop admin dropdown
  const [worklistOpen, setWorklistOpen] = useState(false); // inline worklist dept expansion
  const [drawer, setDrawer] = useState(false); // mobile navigation drawer
  const menuRef = useRef<HTMLDivElement>(null);
  const wlRef = useRef<HTMLLIElement>(null);
  const wlBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // The tab strip scrolls horizontally, so it CLIPS anything that reaches below
  // it. An absolutely-positioned menu inside it is simply never visible. The
  // panel is therefore fixed to the viewport and anchored to the button's
  // measured rect, which no ancestor's overflow can cut off.
  const [wlPos, setWlPos] = useState<{ top: number; left: number } | null>(null);

  // close menus on navigation — state adjusted during render, not in an effect
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
    setWorklistOpen(false); // picking a dept collapses the expansion again
    setDrawer(false);
  }

  // close the dropdowns on outside click; close everything on Escape
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
      if (wlRef.current && !wlRef.current.contains(e.target as Node)) setWorklistOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setWorklistOpen(false);
        setDrawer(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // The worklist panel is fixed to where the button WAS. Resizing the window or
  // scrolling the tab strip moves the button out from under it, so close it
  // rather than leave a menu floating away from its tab.
  useEffect(() => {
    if (!worklistOpen) return;
    const close = () => setWorklistOpen(false);
    const nav = navRef.current;
    window.addEventListener("resize", close);
    nav?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("resize", close);
      nav?.removeEventListener("scroll", close);
    };
  }, [worklistOpen]);

  const on = (base: string) =>
    base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(base + "/");
  // a tab holding several views lights on any of them
  const isActive = (href: string, match?: string, also?: string[]) =>
    on(match ?? href) || (also ?? []).some(on);
  // what THIS account may open from the tools menu
  const adminLinks = ADMIN.filter((l) => user.isAdmin || (l.perm && user.perms.includes(l.perm)));
  const showTools = user.isAdmin || adminLinks.length > 0;
  const adminActive = adminLinks.some((l) => isActive(l.href, l.match, l.also)) || isActive("/admin/users") || isActive("/admin/standard-times");

  return (
    <header className="no-print sticky top-0 z-30 bg-brand text-white shadow-md">
      <div className="w-full px-4 md:px-6">
        <div className="flex items-center gap-2 md:gap-4 h-14 md:h-16">
          {/* mobile: drawer trigger */}
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawer}
            className="md:hidden -ml-1 rounded-lg p-2.5 hover:bg-white/15 active:bg-white/20 transition-colors"
          >
            <Menu size={22} />
          </button>

          {/* brand — the OFFICIAL horizontal logo (white version for the green bar) */}
          <Link href="/" className="flex items-center shrink-0 group min-w-0">
            <Image
              src="/brand/atc-logo-horizontal-white.svg"
              alt="ATC — Arabian Transformers Co."
              width={266}
              height={32}
              priority
              className="h-5 w-auto sm:h-6 md:h-8 transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </Link>

          {/* desktop: centered tabs */}
          <nav ref={navRef} className="hidden md:block flex-1 overflow-x-auto overflow-y-hidden">
            <ul className="flex items-center justify-center gap-1 w-max min-w-full">
              {/* Worklist — opens the three departments in a panel BELOW the tab.
                  They used to unroll sideways inside the bar, which shoved every
                  tab to its right along and left the bar a different width open
                  than closed. */}
              <li ref={wlRef} className="relative flex items-center">
                {singleDeptHref ? (
                  <Link href={singleDeptHref} className={`nav-tab ${isActive("/worklist") ? "nav-tab-active" : ""}`}>
                    <ListChecks size={15} className="shrink-0" />
                    Worklist
                  </Link>
                ) : (
                  <>
                    <button
                      type="button"
                      ref={wlBtnRef}
                      onClick={() => {
                        if (!worklistOpen) {
                          const r = wlBtnRef.current?.getBoundingClientRect();
                          // keep the panel on screen when the tab sits near the right edge
                          if (r) setWlPos({ top: r.bottom + 10, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
                        }
                        setWorklistOpen((v) => !v);
                      }}
                      aria-expanded={worklistOpen}
                      className={`nav-tab ${isActive("/worklist") || worklistOpen ? "nav-tab-active" : ""}`}
                    >
                      <ListChecks size={15} className="shrink-0" />
                      Worklist
                      <ChevronDown size={13} className={`shrink-0 transition-transform duration-150 ${worklistOpen ? "rotate-180" : ""}`} />
                    </button>
                    {worklistOpen && wlPos && (
                      <div
                        role="menu"
                        style={{ top: wlPos.top, left: wlPos.left }}
                        className="nav-drop nav-drop-left fixed w-60 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40"
                      >
                        {worklistDepts.map((d) => (
                          <Link
                            key={d.href}
                            href={d.href}
                            role="menuitem"
                            className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-bold whitespace-nowrap transition-colors ${
                              isActive(d.href) ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                            }`}
                          >
                            <d.icon size={16} className={`shrink-0 ${isActive(d.href) ? "text-brand" : "text-muted"}`} />
                            {d.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </li>
              {restTabs.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`nav-tab ${isActive(l.href, l.match, l.also) ? "nav-tab-active" : ""} ${l.href === "/odoo" && alerts.count > 0 ? "ring-2 ring-[#F2C94C]/70" : ""}`}>
                    <l.icon size={15} className="shrink-0" />
                    {l.label}
                    {l.href === "/odoo" && odooBadge("sm")}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* right cluster */}
          <div className="ml-auto flex items-center gap-1 md:gap-2 shrink-0">
            {/* the plant's two products: one switch, inside every tab at once */}
            <LineTabs line={line} />
            {/* chat is a glance, not a destination — an icon here with its
                unread badge, opening a panel over whatever page you are on */}
            <div className="hidden md:block">
              <ChatDock me={{ id: user.id, name: user.name }} unread={unreadChat} />
            </div>

            {/* desktop: admin tools dropdown — admins only, invisible to everyone else */}
            {showTools && (
            <div className="relative shrink-0 hidden md:block" ref={menuRef}>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={`nav-tab nav-tab-icon flex items-center ${adminActive || open ? "nav-tab-active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Admin Tools"
                title="Admin Tools"
              >
                <Settings size={18} />
              </button>

              {open && (
                <div
                  role="menu"
                  className="nav-drop absolute right-0 top-[calc(100%+10px)] w-80 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40"
                >
                  {adminLinks.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      role="menuitem"
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                        isActive(l.href, l.match, l.also) ? "bg-brand-light" : "hover:bg-surface-2"
                      }`}
                    >
                      <l.icon size={17} className={`mt-0.5 shrink-0 ${isActive(l.href, l.match, l.also) ? "text-brand" : "text-muted"}`} />
                      <span>
                        <span className={`block text-sm font-bold ${isActive(l.href, l.match, l.also) ? "text-brand" : ""}`}>{l.label}</span>
                        <span className="block text-xs text-muted mt-0.5">{l.desc}</span>
                      </span>
                    </Link>
                  ))}
                  {user.isAdmin && (
                    <Link
                      href="/admin/standard-times"
                      role="menuitem"
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors border-t mt-1 pt-2.5 ${
                        isActive("/admin/standard-times") ? "bg-brand-light" : "hover:bg-surface-2"
                      }`}
                    >
                      <Timer size={17} className={`mt-0.5 shrink-0 ${isActive("/admin/standard-times") ? "text-brand" : "text-muted"}`} />
                      <span>
                        <span className={`block text-sm font-bold ${isActive("/admin/standard-times") ? "text-brand" : ""}`}>Standard Times & Capacity</span>
                        <span className="block text-xs text-muted mt-0.5">Man-hours per KVA class, stage capacity & FG map</span>
                      </span>
                    </Link>
                  )}
                  {user.isAdmin && (
                    <Link
                      href="/admin/users"
                      role="menuitem"
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                        isActive("/admin/users") ? "bg-brand-light" : "hover:bg-surface-2"
                      }`}
                    >
                      <Users size={17} className={`mt-0.5 shrink-0 ${isActive("/admin/users") ? "text-brand" : "text-muted"}`} />
                      <span>
                        <span className={`block text-sm font-bold ${isActive("/admin/users") ? "text-brand" : ""}`}>Users & Permissions</span>
                        <span className="block text-xs text-muted mt-0.5">Accounts, passwords & what each can edit</span>
                      </span>
                    </Link>
                  )}
                </div>
              )}
            </div>

            )}

            {/* user + logout (desktop shows the name; mobile keeps it in the drawer) */}
            <div className="shrink-0 flex items-center gap-1 md:gap-2 md:border-l md:border-white/20 md:pl-3">
              <span className="hidden md:block text-sm font-semibold max-w-[140px] truncate" title={user.name}>
                {user.name}
              </span>
              <form action={logoutAction} className="hidden md:block">
                <button
                  type="submit"
                  title="Sign out"
                  aria-label="Sign out"
                  className="rounded-md p-2 hover:bg-white/15 transition-colors"
                >
                  <LogOut size={16} />
                </button>
              </form>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>

      {/* ===== mobile navigation drawer ===== */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-[drawerfade_0.2s_ease-out]"
          />
          <div className="absolute left-0 top-0 h-full w-[300px] max-w-[85vw] bg-surface text-foreground shadow-2xl flex flex-col animate-[drawerslide_0.22s_ease-out]">
            {/* drawer head */}
            <div className="bg-brand text-white px-4 py-3.5 flex items-center justify-between">
              <Image
                src="/brand/atc-logo-horizontal-white.svg"
                alt="ATC"
                width={266}
                height={32}
                className="h-6 w-auto"
              />
              <button
                type="button"
                onClick={() => setDrawer(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 hover:bg-white/15 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* signed-in user */}
            <div className="px-4 py-3 border-b flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-brand-light text-brand font-extrabold grid place-items-center text-sm">
                {user.name.trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold truncate">{user.name}</div>
                <div className="text-xs text-muted">{user.isAdmin ? "Administrator" : "Signed in"}</div>
              </div>
            </div>

            {/* links */}
            <nav className="flex-1 overflow-y-auto py-2">
              <p className="px-4 pt-2 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted">Production</p>
              {drawerTabs.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`flex items-center gap-3 mx-2 px-3 py-3 rounded-lg text-[15px] font-semibold transition-colors ${
                    isActive(l.href, l.match) ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  <l.icon size={19} className={isActive(l.href, l.match) ? "text-brand" : "text-muted"} />
                  {l.label}
                  {l.href === "/odoo" && odooBadge("md")}
                </Link>
              ))}

              {/* on desktop these sit behind a tab's own switcher; the drawer
                  has the room to list them, so a phone reaches them in one tap */}
              <p className="px-4 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted">More</p>
              {drawerViews.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`flex items-center gap-3 mx-2 px-3 py-3 rounded-lg text-[15px] font-semibold transition-colors ${
                    isActive(l.href, l.match) ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  <l.icon size={19} className={isActive(l.href, l.match) ? "text-brand" : "text-muted"} />
                  {l.label}
                  {l.href === "/chat" && <UnreadBadge count={unreadChat} />}
                </Link>
              ))}

              {showTools && (
                <p className="px-4 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted">Admin tools</p>
              )}
              {adminLinks.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`flex items-center gap-3 mx-2 px-3 py-3 rounded-lg text-[15px] font-semibold transition-colors ${
                    isActive(l.href) ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  <l.icon size={19} className={isActive(l.href) ? "text-brand" : "text-muted"} />
                  {l.label}
                </Link>
              ))}
              {user.isAdmin && (
                <Link
                  href="/admin/standard-times"
                  className={`flex items-center gap-3 mx-2 px-3 py-3 rounded-lg text-[15px] font-semibold transition-colors ${
                    isActive("/admin/standard-times") ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  <Timer size={19} className={isActive("/admin/standard-times") ? "text-brand" : "text-muted"} />
                  Standard Times & Capacity
                </Link>
              )}
              {user.isAdmin && (
                <Link
                  href="/admin/users"
                  className={`flex items-center gap-3 mx-2 px-3 py-3 rounded-lg text-[15px] font-semibold transition-colors ${
                    isActive("/admin/users") ? "bg-brand-light text-brand" : "hover:bg-surface-2"
                  }`}
                >
                  <Users size={19} className={isActive("/admin/users") ? "text-brand" : "text-muted"} />
                  Users & Permissions
                </Link>
              )}
            </nav>

            {/* drawer foot */}
            <div className="border-t p-3">
              <form action={logoutAction}>
                <button type="submit" className="btn btn-secondary w-full text-bad-fg">
                  <LogOut size={16} />
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
      {alerts.popup}
    </header>
  );
}
