"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Menu, X, LogOut, Settings, LayoutDashboard, ClipboardList, Warehouse,
  Table2, FileBarChart2, BookOpenCheck, ListChecks, ChevronDown,
  CalendarDays, Users, Timer,
  FlaskConical, MessagesSquare, Droplets, QrCode, HardHat, SlidersHorizontal, Layers, Boxes, Clock, Factory, ChartColumnBig, PackageMinus, Bot,
} from "lucide-react";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { InstallApp } from "@/components/InstallApp";
import { useCanSee } from "@/components/TabAccess";
import { ChatDock } from "@/components/ChatDock";
import { InboxBell } from "@/components/InboxBell";
import { useAiPanel } from "@/components/AiPanel";
import { useInboxPanel } from "@/components/InboxPanel";
import { useOdooAlerts } from "@/components/OdooAlerts";
import { LineTabs } from "@/components/LineTabs";
import { Avatar, UserMenu } from "@/components/UserMenu";
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
// review. There is no Dashboard tab: each dashboard lives with what it reads.
// One tab per QUESTION, not per screen. Several of these hold more than one
// view behind their own switcher (see components/ViewTabs.tsx), which is what
// keeps the strip short enough to read:
//   Material     → the nesting sheets, and the sheet analytics built on them
//   Plan Tracker → the tracker, the plan's dashboard, the daily log and its report
//   Floor        → the bay as it is, and the what-if simulator
// Chat is not here at all — it is the icon in the right cluster.
const REST: Item[] = [
  // Material comes FIRST: nesting is decided before a single sheet is cut.
  { href: "/material", label: "Material", icon: Layers, also: ["/analytics"] },
  // the store's count against Odoo's stock, code by code
  { href: "/physical", label: "Physical Material", icon: Warehouse },
  { href: "/odoo", label: "ODOO", icon: Boxes },
  // what the store hands out to the floor — item, qty, department, worker
  { href: "/consumables", label: "Consumables", icon: PackageMinus },
  // who worked today, how long, on what — the supervisors' page
  { href: "/shifts", label: "Shifts", icon: Clock },
  // the home page (/) is the plan's dashboard — a view of this tab
  { href: "/tracker", label: "Plan Tracker", icon: Table2, also: ["/", "/handover", "/report"] },
  // the tanks' sticker sheet — its own tab while per-piece tracking is on
  // (TANK_ONLY drops it otherwise), and still a button on the painting worklist
  { href: "/barcode", label: "Tank Barcodes", icon: QrCode, match: "/barcode" },
  { href: "/simulate", label: "Floor", icon: FlaskConical },
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
  { href: "/", label: "Plan dashboard", icon: LayoutDashboard },
  { href: "/handover", label: "Daily log", icon: BookOpenCheck },
  { href: "/report", label: "Report", icon: FileBarChart2 },
  { href: "/analytics", label: "Material analytics", icon: ChartColumnBig },
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
  /** The app's owner — the only one who sees Users & Permissions. */
  isOwner?: boolean;
  perms: string[];
  /** Their own photo for the round button; none shows their initials. */
  avatarUrl?: string | null;
}

// What only exists while machine planning is on — the worklists ride on it
// too (see machinePlanning below): the machine list and the
// times per machine all serve that one job.
const MACHINE_ONLY = new Set(["/admin/machines", "/admin/machine-times"]);

// The two tabs that only exist while per-piece tank tracking is on.
const TANK_ONLY = new Set(["/worklist/leak-test", "/barcode"]);

/** One entry of the tools menu: its name, with what it holds as the tooltip. */
function ToolLink({ href, label, title, icon: Icon, active }: { href: string; label: string; title?: string; icon: Item["icon"]; active: boolean }) {
  return (
    <Link
      href={href}
      role="menuitem"
      title={title}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-bold transition-colors ${active ? "bg-brand-light text-brand" : "hover:bg-surface-2"}`}
    >
      <Icon size={17} className={`shrink-0 ${active ? "text-brand" : "text-muted"}`} />
      {label}
    </Link>
  );
}

/** One row of the phone's drawer: an icon, its name, a count when it has one. */
function DrawerLink({ href, label, icon: Icon, active, badge }: { href: string; label: string; icon: Item["icon"]; active: boolean; badge?: React.ReactNode }) {
  return (
    <Link href={href} className={`drawer-link ${active ? "drawer-link-active" : ""}`}>
      <Icon size={19} />
      {label}
      {badge}
    </Link>
  );
}

/** Unread chat badge, shared by the desktop tab and the drawer entry. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="count-badge count-badge-alert">{count > 99 ? "99+" : count}</span>;
}

export function AppNav({
  user,
  unreadChat = 0,
  tankTracking = false,
  machinePlanning = false,
  odooAlerts = { enabled: false, count: 0 },
  line = "TR",
  whatsNewSeen = null,
  ai = false,
  inbox = { unread: 0, any: false },
}: {
  user: NavUser;
  unreadChat?: number;
  /** With tracking off, the Leak Test and Barcode tabs are not part of the app. */
  tankTracking?: boolean;
  /** One switch for the worklists, the shift log, the machines and machine planning: off, the
   *  Worklist and Shifts tabs and the two machine pages are gone, and the Floor tab is the
   *  what-if simulator alone — it is named so. */
  machinePlanning?: boolean;
  /** The subscribed person's "ready to close in Odoo" alert: its count on the ODOO tab, and the popup. */
  odooAlerts?: { enabled: boolean; count: number };
  /** The product line every tab is showing — transformers or LV panels. */
  line?: ProductLine;
  /** The newest "What's new" entry this person has seen. */
  whatsNewSeen?: string | null;
  /** The AI assistant is open to this person (lib/server/ai/access). */
  ai?: boolean;
  /** The inbox's unread count, and whether anything was ever sent to them. */
  inbox?: { unread: number; any: boolean };
}) {
  const pathname = usePathname();
  // on the assistant's own pages it is already full size: the bar's buttons go there as links
  const aiPage = pathname === "/ai" || pathname.startsWith("/ai/");
  const panelCtx = useAiPanel();
  const panel = aiPage ? null : panelCtx;
  const aiOn = aiPage || !!panel?.shown;
  const inboxPanel = useInboxPanel();
  const alerts = useOdooAlerts(odooAlerts.enabled, odooAlerts.count, user.id);
  // the ODOO tab lights up with the rows waiting to be closed; its badge
  // opens the popup rather than the page
  // the same count badge as every other count in the bar — it opens the popup
  // rather than the page
  const odooBadge = () => alerts.count > 0 && (
    <span
      role="button" tabIndex={0} title={`${alerts.count} ready to close in Odoo — show them`}
      aria-label={`${alerts.count} ready to close in Odoo — show them`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); alerts.show(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); alerts.show(); } }}
      className="count-badge count-badge-warn cursor-pointer"
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
  // the screens the owner switched off for this account leave the menus too
  const canSee = useCanSee();
  const worklistDepts = (line === "LV" ? LV_WORKLIST_DEPTS : WORKLIST_DEPTS).filter((d) => (tankTabs || !TANK_ONLY.has(d.href)) && canSee(d.href));
  const shown = (l: { href: string }) => (tankTabs || !TANK_ONLY.has(l.href)) && (machinePlanning || !MACHINE_ONLY.has(l.href)) && canSee(l.href);
  // a tab whose own screen is off but one of its views is on opens on that view
  const reachable = (l: Item): Item | null => {
    const to = [l.href, ...(l.also ?? [])].find(canSee);
    return to ? (to === l.href ? l : { ...l, href: to, match: l.match ?? l.href }) : null;
  };
  const restTabs = REST.filter((l) => (tankTabs || !TANK_ONLY.has(l.href)) && (machinePlanning || !MACHINE_ONLY.has(l.href)))
    .map(reachable).filter((l): l is Item => l !== null).map(named);
  const drawerTabs = (!machinePlanning
    ? DRAWER.filter((l) => !l.href.startsWith("/worklist/"))
    : line === "LV"
    ? [...LV_WORKLIST_DEPTS.map((d): Item => ({ href: d.href, label: `${d.label} Worklist`, icon: d.icon })), ...DRAWER.filter((l) => !l.href.startsWith("/worklist/"))]
    : DRAWER
  ).filter(shown).map(named);
  // the printed report is the transformers' — the panels' dashboard carries its own
  const drawerViews = DRAWER_VIEWS.filter((l) => (tankTabs || !TANK_ONLY.has(l.href)) && !(line === "LV" && l.href === "/report") && canSee(l.href));
  const deptEdits = worklistDepts.filter((d) => user.perms.includes(d.perm));
  const singleDeptHref = worklistDepts.length === 1 ? worklistDepts[0].href : !user.isAdmin && deptEdits.length === 1 ? deptEdits[0].href : null;

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
  // a link with its own key follows the tick, admins included; one without
  // is an admin page
  const adminLinks = ADMIN.filter((l) => shown(l) && (l.perm ? user.perms.includes(l.perm) : user.isAdmin));
  const showTools = adminLinks.length > 0 || (user.isAdmin && canSee("/admin/standard-times")) || !!user.isOwner;
  const adminActive = adminLinks.some((l) => isActive(l.href, l.match, l.also)) || isActive("/admin/users") || isActive("/admin/ai") || isActive("/admin/standard-times");

  return (
    <header className="no-print sticky top-0 z-30 bg-[var(--nav-bg)] text-white border-b border-[var(--nav-border)] shadow-sm">
      <div className="w-full px-2.5 sm:px-4 md:px-6">
        <div className="flex items-center gap-2 md:gap-4 h-12">
          {/* mobile: drawer trigger */}
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawer}
            className="min-[1440px]:hidden -ml-1 rounded-lg p-2.5 hover:bg-white/15 active:bg-white/20 transition-colors"
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
              className="h-5 w-auto max-[400px]:h-4 md:h-6 transition-opacity duration-150 group-hover:opacity-85"
            />
          </Link>

          {/* desktop: centered tabs */}
          <nav ref={navRef} className="hidden min-[1440px]:block flex-1 overflow-x-auto overflow-y-hidden">
            <ul className="flex items-center justify-center gap-1 w-max min-w-full">
              {/* Worklist — opens the three departments in a panel BELOW the tab.
                  They used to unroll sideways inside the bar, which shoved every
                  tab to its right along and left the bar a different width open
                  than closed. */}
              {machinePlanning && worklistDepts.length > 0 && (
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
              )}
              {restTabs.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`nav-tab ${isActive(l.href, l.match, l.also) ? "nav-tab-active" : ""}`}>
                    <l.icon size={15} className="shrink-0" />
                    {l.label}
                    {l.href === "/odoo" && odooBadge()}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* right cluster */}
          <div className="ml-auto flex items-center gap-1 md:gap-2 shrink-0">
            {/* the plant's two products: one switch, inside every tab at once */}
            <LineTabs line={line} />
            {/* the AI assistant has no button here: its round button sits in
                the corner of every page (components/AiPanel) */}
            {/* the inbox — alerts, reports and tasks — for everyone: anyone
                can be given a task. It opens as a window of its own. */}
            <InboxBell
              initial={inbox.unread}
              active={isActive("/inbox") || !!inboxPanel?.shown}
              onOpen={inboxPanel && !isActive("/inbox") ? inboxPanel.toggle : undefined}
            />
            {/* chat is a glance, not a destination — an icon here with its
                unread badge, opening a panel over whatever page you are on */}
            <div className={canSee("/chat") ? "hidden md:block" : "hidden"}>
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
                  className="nav-drop absolute right-0 top-[calc(100%+10px)] w-64 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40"
                >
                  {adminLinks.map((l) => (
                    <ToolLink key={l.href} href={l.href} label={l.label} title={l.desc} icon={l.icon} active={isActive(l.href, l.match, l.also)} />
                  ))}
                  {user.isAdmin && canSee("/admin/standard-times") && (
                    <ToolLink href="/admin/standard-times" label="Standard Times & Capacity" title="Man-hours per KVA class, stage capacity & FG map" icon={Timer} active={isActive("/admin/standard-times")} />
                  )}
                  {user.isOwner && (
                    <>
                      <div className="border-t my-1" />
                      <ToolLink href="/admin/users" label="Users & Permissions" title="Accounts, passwords & what each can edit" icon={Users} active={isActive("/admin/users")} />
                      <ToolLink href="/admin/ai" label="AI assistant settings" title="The Claude key, who may use it & monthly limits" icon={Bot} active={isActive("/admin/ai")} />
                    </>
                  )}
                </div>
              )}
            </div>

            )}

            {/* the account: one round button — the person's photo — opening
                their name, photo, what's new, dark mode, install and sign out */}
            <div className="shrink-0 flex items-center md:border-l md:border-white/15 md:pl-3">
              <UserMenu user={user} whatsNewSeen={whatsNewSeen} />
            </div>
          </div>
        </div>
      </div>

      {/* ===== mobile navigation drawer ===== */}
      {drawer && (
        <div className="min-[1440px]:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-[drawerfade_0.2s_ease-out]"
          />
          <div className="absolute left-0 top-0 h-full w-[300px] max-w-[85vw] bg-surface text-foreground shadow-2xl flex flex-col animate-[drawerslide_0.22s_ease-out]">
            {/* drawer head */}
            <div className="bg-[var(--nav-bg)] text-white px-4 py-3 flex items-center justify-between">
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
              <Avatar id={user.id} name={user.name} url={user.avatarUrl} size={36} />
              <div className="min-w-0">
                <div className="text-sm font-bold truncate">{user.name}</div>
                <div className="text-xs text-muted">{user.isOwner ? "Owner" : user.isAdmin ? "Administrator" : "Signed in"}</div>
              </div>
            </div>

            {/* links */}
            <nav className="flex-1 overflow-y-auto py-1">
              <p className="drawer-label">Production</p>
              {drawerTabs.map((l) => (
                <DrawerLink key={l.href} href={l.href} label={l.label} icon={l.icon} active={isActive(l.href, l.match)} badge={l.href === "/odoo" ? odooBadge() : null} />
              ))}

              {/* on desktop these sit behind a tab's own switcher; the drawer
                  has the room to list them, so a phone reaches them in one tap */}
              <p className="drawer-label">More</p>
              {drawerViews.map((l) => (
                <DrawerLink key={l.href} href={l.href} label={l.label} icon={l.icon} active={isActive(l.href, l.match)} badge={l.href === "/chat" ? <UnreadBadge count={unreadChat} /> : null} />
              ))}
              {ai && (
                <button
                  type="button"
                  onClick={() => {
                    setDrawer(false);
                    if (panel) panel.openTab("chat");
                  }}
                  className={`drawer-link ${aiOn ? "drawer-link-active" : ""}`}
                >
                  <Bot size={19} />
                  AI assistant
                </button>
              )}

              {showTools && <p className="drawer-label">Admin tools</p>}
              {adminLinks.map((l) => (
                <DrawerLink key={l.href} href={l.href} label={l.label} icon={l.icon} active={isActive(l.href)} />
              ))}
              {user.isAdmin && canSee("/admin/standard-times") && (
                <DrawerLink href="/admin/standard-times" label="Standard Times & Capacity" icon={Timer} active={isActive("/admin/standard-times")} />
              )}
              {user.isOwner && (
                <>
                  <DrawerLink href="/admin/users" label="Users & Permissions" icon={Users} active={isActive("/admin/users")} />
                  <DrawerLink href="/admin/ai" label="AI assistant settings" icon={Bot} active={isActive("/admin/ai")} />
                </>
              )}
            </nav>

            {/* drawer foot */}
            <div className="border-t p-3 space-y-2">
              <span className="sm:hidden block"><ThemeToggle wide /></span>
              <InstallApp wide />
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
