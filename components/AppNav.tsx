"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Menu, X, LogOut, Settings, LayoutDashboard, ClipboardList, Warehouse,
  Table2, BookOpenCheck, ListChecks, ChevronDown,
  CalendarDays, Users, Timer,
  FlaskConical, MessagesSquare, Droplets, QrCode, HardHat, SlidersHorizontal, Layers, Boxes, Clock, Factory, ChartColumnBig, PackageMinus, Bot, Gauge,
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
import { useActiveLine, useCarryLine } from "@/components/LineContext";
import { Avatar, UserMenu } from "@/components/UserMenu";
import { LINE_LABEL, LINE_PARAM, PRODUCT_LINES, hrefWithLine, pinnedLine, type ProductLine } from "@/lib/domain/lines";
import { signOut } from "@/lib/signOut";
import { trapTab } from "@/components/Modal";

type Item = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  match?: string;
  /** Extra routes that light this tab — the views that live inside it. */
  also?: string[];
  /** The places the tab holds, offered in a panel when the pointer rests on it. */
  places?: Place[];
};
/** One place inside a tab — a screen of its own. */
type Place = { href: string; label: string; icon: Item["icon"]; title: string };

// The department worklists live under ONE "Floor" tab — clicking it opens
// them in a panel below it; picking one navigates and closes it again. Both
// lines' departments are listed: the transformers' (leak test where it sits on
// the shop floor, between welding and painting), then the LV panels' four
// stages in the order a panel passes them. Welding and painting are one route
// each for both lines — the address's line says whose queue it shows — so
// every entry names its line in its link.
type FloorDept = { path: string; label: string; drawerLabel: string; icon: Item["icon"]; perm: string; line: ProductLine };
const FLOOR_DEPTS: readonly FloorDept[] = [
  { path: "/worklist/cut", label: "Fabrication", drawerLabel: "Fabrication Worklist", icon: LaserCutterIcon, perm: "cut.edit", line: "TR" },
  { path: "/worklist/welding", label: "Welding", drawerLabel: "Welding Worklist", icon: WeldingIcon, perm: "welding.edit", line: "TR" },
  { path: "/worklist/leak-test", label: "Leak Test", drawerLabel: "Leak Test", icon: Droplets, perm: "leaktest.edit", line: "TR" },
  { path: "/worklist/painting", label: "Painting", drawerLabel: "Painting Worklist", icon: PowderCoatIcon, perm: "painting.edit", line: "TR" },
  { path: "/worklist/punching", label: "Punching", drawerLabel: "LV Punching", icon: LaserCutterIcon, perm: "lv.punching", line: "LV" },
  { path: "/worklist/bending", label: "Bending", drawerLabel: "LV Bending", icon: LaserCutterIcon, perm: "lv.bending", line: "LV" },
  { path: "/worklist/welding", label: "Welding", drawerLabel: "LV Welding", icon: WeldingIcon, perm: "lv.welding", line: "LV" },
  { path: "/worklist/painting", label: "Painting", drawerLabel: "LV Painting", icon: PowderCoatIcon, perm: "lv.painting", line: "LV" },
];
const deptHref = (d: FloorDept) => hrefWithLine(d.path, d.line);
const LINE_GROUPS = PRODUCT_LINES.map((line) => ({ line, label: LINE_LABEL[line] }));

// Tabs after Floor. One tab per QUESTION, not per screen. Several hold more
// than one place: resting the pointer on the tab (or focusing it) opens a
// panel of its places, which is the only way between them — the pages carry
// no strip of their own. A place's own views stay behind the switch in its
// toolbar (components/ViewTabs.tsx).
//   Dashboards   → every dashboard, one place each: Planning (the home page),
//                  Production, Material, Consumables, ODOO
//   Material     → the nesting sheets, the store's physical count, and the
//                  consumables it hands out
//   Plan Tracker → the tracker, the daily log, the what-if simulator and the ODOO close-out log
// Chat is not here at all — it is the icon in the right cluster.
const DASHBOARD_PLACES: Place[] = [
  { href: "/", label: "Planning", icon: LayoutDashboard, title: "The plan: what needs a decision, the week, the load ahead, the month and its people" },
  { href: "/dashboards/production", label: "Production", icon: Gauge, title: "How the floor worked: output, efficiency, where the hours went, what stopped the machines" },
  { href: "/dashboards/material", label: "Material", icon: ChartColumnBig, title: "Consumption booked when the MO is closed on Odoo — sheets, tonnes, thicknesses, scrap" },
  { href: "/dashboards/consumables", label: "Consumables", icon: PackageMinus, title: "What went out, to whom, against the limits — and the monthly review" },
  { href: "/dashboards/odoo", label: "ODOO", icon: Boxes, title: "Closed quantities per product and the close-out time" },
];
const MATERIAL_PLACES: Place[] = [
  { href: "/material", label: "Material", icon: Layers, title: "The nesting project tracker — what each order consumed" },
  { href: "/physical", label: "Physical Material", icon: Warehouse, title: "The store's count against Odoo's stock, code by code" },
  { href: "/consumables", label: "Consumables", icon: PackageMinus, title: "What the store hands out to the floor — item, quantity, department, worker" },
];
const TRACKER_PLACES: Place[] = [
  { href: "/tracker", label: "Plan Tracker", icon: Table2, title: "One row per order, every stage" },
  { href: "/handover", label: "Daily log", icon: BookOpenCheck, title: "The raw entries the tracker adds up — edit and correct them here" },
  { href: "/simulate", label: "Simulator", icon: FlaskConical, title: "What-if: move the dates and the capacity and see what lands — the transformers' plan" },
  { href: "/odoo", label: "ODOO log", icon: Boxes, title: "The daily close-out log on Odoo" },
];
/** A tab of places: it lights on any of them. */
const placesTab = (href: string, label: string, icon: Item["icon"], places: Place[]): Item =>
  ({ href, label, icon, places, also: places.map((p) => p.href).filter((h) => h !== href) });
// the dashboards that take the plant as a whole (?line=all)
const PLANT_WIDE = new Set(["/", "/dashboards/production"]);

const REST: Item[] = [
  // the home page; the tab lights on every dashboard
  placesTab("/", "Dashboards", LayoutDashboard, DASHBOARD_PLACES),
  // Material comes next: nesting is decided before a single sheet is cut. The
  // store's physical count against Odoo's stock and the consumables it hands
  // out to the floor live in the same tab, each with its own screens.
  placesTab("/material", "Material", Layers, MATERIAL_PLACES),
  // who worked today, how long, on what — the supervisors' page
  { href: "/shifts", label: "Shifts", icon: Clock },
  // the ODOO close-out log is one of its places; the tab carries its alerts' badge
  placesTab("/tracker", "Plan Tracker", Table2, TRACKER_PLACES),
  // the tanks' sticker sheet — its own tab while per-piece tracking is on
  // (TANK_ONLY drops it otherwise), and still a button on the painting worklist
  { href: "/barcode", label: "Tank Barcodes", icon: QrCode, match: "/barcode" },
];


// The drawer has room for the views that ride inside a tab on desktop, so a
// phone reaches them in one tap instead of two.
const DRAWER_VIEWS: Item[] = [
  { href: "/dashboards/production", label: "Production dashboard", icon: Gauge },
  { href: "/dashboards/material", label: "Material dashboard", icon: ChartColumnBig },
  { href: "/dashboards/consumables", label: "Consumables dashboard", icon: ChartColumnBig },
  { href: "/dashboards/odoo", label: "ODOO dashboard", icon: ChartColumnBig },
  { href: "/handover", label: "Daily log", icon: BookOpenCheck },
  { href: "/simulate", label: "Simulator", icon: FlaskConical },
  { href: "/odoo", label: "ODOO log", icon: Boxes },
  { href: "/physical", label: "Physical Material", icon: Warehouse },
  { href: "/consumables", label: "Consumables", icon: PackageMinus },
  { href: "/chat", label: "Chat", icon: MessagesSquare },
];

// `perm` opens an entry to a non-admin holding that permission — the rest of
// the list stays admin-only, exactly as it was.
const ADMIN: (Item & { desc: string; perm?: string })[] = [
  // both plan imports live here now, behind the page's own switcher — they
  // were two Admin entries doing the same job a month apart
  { href: "/orders", label: "Orders Registry", desc: "Master MO list, with the monthly plan and weekly delivery schedule imports", icon: ClipboardList, also: ["/import"] },
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
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-bold transition-colors ${active ? "bg-brand-light text-brand-ink" : "hover:bg-surface-2"}`}
    >
      <Icon size={17} className={`shrink-0 ${active ? "text-brand-ink" : "text-muted"}`} />
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

/** What a tab with places needs from the bar: which panel is open, where, and
 *  the pointer's comings and goings. */
type MenuCtl = {
  open: string | null;
  pos: { top: number; left: number } | null;
  /** The pointer came to rest on the tab: open its panel after a breath, so
   *  a pointer only passing over the bar opens nothing. */
  onHover: (id: string, el: HTMLElement) => void;
  /** Open now — keyboard focus, a tap. */
  onOpen: (id: string, el: HTMLElement) => void;
  onLeave: () => void;
  onKeep: () => void;
  onClose: () => void;
};

/** A tab holding several places. Resting the pointer on it — or focusing it
 *  from the keyboard — opens a panel of its places below it (a disclosure: the
 *  places are plain links). Clicked with a mouse, the tab opens its first
 *  place; tapped on a touch screen, which has no resting pointer, the first
 *  tap opens the panel. */
function MenuTab({ ctl, id, label, icon: Icon, active, href, badge, children }: {
  ctl: MenuCtl; id: string; label: string; icon: Item["icon"]; active: boolean; href?: string; badge?: React.ReactNode; children: React.ReactNode;
}) {
  const shown = ctl.open === id && ctl.pos;
  const cls = `nav-tab ${active || ctl.open === id ? "nav-tab-active" : ""}`;
  const panelId = `nav-places-${id.replace(/[^a-z0-9]/gi, "") || "home"}`;
  const touch = useRef(false);
  const inner = (
    <>
      <Icon size={15} className="shrink-0" />
      {label}
      {badge}
      <ChevronDown size={13} className={`shrink-0 transition-transform duration-150 ${ctl.open === id ? "rotate-180" : ""}`} />
    </>
  );
  return (
    <li
      data-nav-menu
      className="relative flex items-center"
      onPointerDown={(e) => { touch.current = e.pointerType === "touch"; }}
      onMouseEnter={(e) => ctl.onHover(id, e.currentTarget)}
      onMouseLeave={ctl.onLeave}
      onFocus={(e) => { if (ctl.open !== id) ctl.onOpen(id, e.currentTarget); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctl.onLeave(); }}
    >
      {href ? (
        <Link
          href={href} className={cls} aria-expanded={ctl.open === id} aria-controls={panelId}
          onClick={(e) => {
            if (!touch.current || ctl.open === id) return;
            e.preventDefault();
            ctl.onOpen(id, e.currentTarget.parentElement!);
          }}
        >
          {inner}
        </Link>
      ) : (
        // the Floor has no page of its own: a click opens or closes its departments
        <button
          type="button" className={cls} aria-expanded={ctl.open === id} aria-controls={panelId}
          onClick={(e) => (ctl.open === id ? ctl.onClose() : ctl.onOpen(id, e.currentTarget.parentElement!))}
        >
          {inner}
        </button>
      )}
      {shown && (
        <div
          id={panelId}
          aria-label={label}
          style={{ top: ctl.pos!.top, left: ctl.pos!.left }}
          onMouseEnter={ctl.onKeep}
          className="nav-drop nav-drop-left fixed w-64 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40"
        >
          {children}
        </div>
      )}
    </li>
  );
}

/** One place in a tab's panel: its icon and its name. */
function MenuLink({ href, label, icon: Icon, title, active }: { href: string; label: string; icon: Item["icon"]; title?: string; active: boolean }) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-bold whitespace-nowrap transition-colors ${active ? "bg-brand-light text-brand-ink" : "hover:bg-surface-2"}`}
    >
      <Icon size={16} className={`shrink-0 ${active ? "text-brand-ink" : "text-muted"}`} />
      {label}
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
  whatsNewSeen = null,
  ai = false,
  inbox = { unread: 0, any: false },
}: {
  user: NavUser;
  unreadChat?: number;
  /** With tracking off, the Leak Test and Barcode tabs are not part of the app. */
  tankTracking?: boolean;
  /** One switch for the worklists, the machines and machine planning: off, the
   *  Floor tab and the two machine pages are gone. */
  machinePlanning?: boolean;
  /** The subscribed person's "ready to close in Odoo" alert: its count on the Plan Tracker tab (which holds the ODOO log), and the popup. */
  odooAlerts?: { enabled: boolean; count: number };
  /** The newest "What's new" entry this person has seen. */
  whatsNewSeen?: string | null;
  /** The AI assistant is open to this person (lib/server/ai/access). */
  ai?: boolean;
  /** The inbox's unread count, and whether anything was ever sent to them. */
  inbox?: { unread: number; any: boolean };
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // on the assistant's own pages it is already full size: the bar's buttons go there as links
  const aiPage = pathname === "/ai" || pathname.startsWith("/ai/");
  const panelCtx = useAiPanel();
  const panel = aiPage ? null : panelCtx;
  const aiOn = aiPage || !!panel?.shown;
  const inboxPanel = useInboxPanel();
  const alerts = useOdooAlerts(odooAlerts.enabled, odooAlerts.count, user.id);
  // the Plan Tracker tab (the ODOO log is one of its views) lights up with the rows waiting to be closed; its badge
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
  // Floor tab; everyone else (admins, multi-dept, view-only) opens the tab
  // onto its departments.
  // the leak test and the barcodes are the tanks' — with tracking off they are not part of the app
  const tankOk = (href: string) => tankTracking || !TANK_ONLY.has(href);
  // the line on screen — which of welding's or painting's two queues is lit
  const line = useActiveLine();
  // the screens the owner switched off for this account leave the menus too
  const canSee = useCanSee();
  const worklistDepts = FLOOR_DEPTS.filter((d) => tankOk(d.path) && canSee(d.path));
  const deptOn = (d: FloorDept) => on(d.path) && line === d.line;
  const shown = (l: { href: string }) => tankOk(l.href) && (machinePlanning || !MACHINE_ONLY.has(l.href)) && canSee(l.href);
  // a tab whose own screen is off but one of its views is on opens on that view
  const reachable = (l: Item): Item | null => {
    const to = [l.href, ...(l.also ?? [])].find(canSee);
    return to ? (to === l.href ? l : { ...l, href: to, match: l.match ?? l.href }) : null;
  };
  const restTabs = REST.filter((l) => tankOk(l.href) && (machinePlanning || !MACHINE_ONLY.has(l.href)))
    .map(reachable).filter((l): l is Item => l !== null);
  // the mobile drawer has vertical room — it lists the worklists directly
  const drawerDepts = machinePlanning ? worklistDepts : [];
  const drawerTabs = REST.filter(shown);
  const drawerViews = DRAWER_VIEWS.filter((l) => tankOk(l.href) && canSee(l.href));
  const deptEdits = worklistDepts.filter((d) => user.perms.includes(d.perm));
  const singleDept = worklistDepts.length === 1 ? worklistDepts[0] : !user.isAdmin && deptEdits.length === 1 ? deptEdits[0] : null;

  const [open, setOpen] = useState(false); // desktop admin dropdown
  const [tabMenu, setTabMenu] = useState<string | null>(null); // the tab whose places are open
  const [drawer, setDrawer] = useState(false); // mobile navigation drawer
  const menuRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null); // the drawer panel
  const drawerCloseRef = useRef<HTMLButtonElement>(null); // its ✕, focused on open
  // The tab strip scrolls horizontally, so it CLIPS anything that reaches below
  // it. An absolutely-positioned menu inside it is simply never visible. The
  // panel is therefore fixed to the viewport and anchored to the tab's
  // measured rect, which no ancestor's overflow can cut off.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // the pointer may cross the gap between a tab and its panel without closing it
  const closeTimer = useRef<number | null>(null);
  const keepMenu = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openMenu = (key: string, el: HTMLElement) => {
    keepMenu();
    const r = el.getBoundingClientRect();
    // keep the panel on screen when the tab sits near the right edge
    setMenuPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 268)) });
    setTabMenu(key);
  };
  const closeMenuSoon = () => {
    keepMenu();
    closeTimer.current = window.setTimeout(() => setTabMenu(null), 150);
  };
  // a pointer resting on a tab — not one crossing the bar on its way elsewhere
  const hoverMenu = (key: string, el: HTMLElement) => {
    keepMenu();
    if (tabMenu === key) return;
    closeTimer.current = window.setTimeout(() => openMenu(key, el), tabMenu ? 0 : 120);
  };

  // close menus on navigation — state adjusted during render, not in an effect.
  // The query counts: welding's two queues are one path, two lines.
  const here = `${pathname}?${searchParams}`;
  const [prevPath, setPrevPath] = useState(here);
  if (prevPath !== here) {
    setPrevPath(here);
    setOpen(false);
    setTabMenu(null); // picking a place closes its panel again
    setDrawer(false);
  }

  // close the dropdowns on outside click; close everything on Escape
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
      if (!(e.target as Element).closest?.("[data-nav-menu]")) setTabMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setTabMenu(null);
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

  // The drawer is a dialog: focus moves onto its close button when it opens,
  // Tab and Shift+Tab stay inside it (the page behind is dimmed, not inert),
  // and focus goes back to where it came from — the ☰ button — when it closes.
  useEffect(() => {
    if (!drawer) return;
    const before = document.activeElement as HTMLElement | null;
    drawerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => trapTab(e, drawerRef.current);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [drawer]);

  // A tab's panel is fixed to where the tab WAS. Resizing the window or
  // scrolling the tab strip moves the tab out from under it, so close it
  // rather than leave a menu floating away from its tab.
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const nav = navRef.current;
    window.addEventListener("resize", close);
    nav?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("resize", close);
      nav?.removeEventListener("scroll", close);
    };
  }, [tabMenu]);
  useEffect(() => keepMenu, []); // no timer outlives the bar
  const menuCtl: MenuCtl = { open: tabMenu, pos: menuPos, onHover: hoverMenu, onOpen: openMenu, onLeave: closeMenuSoon, onKeep: keepMenu, onClose: () => setTabMenu(null) };
  // inside the tab on screen, a place keeps the line the address names — and
  // the plant-wide dashboards keep "All"
  const carry = useCarryLine();
  const allPlant = searchParams.get(LINE_PARAM)?.trim().toLowerCase() === "all";
  const placeHref = (href: string) => (allPlant && PLANT_WIDE.has(href) ? `${href}?${LINE_PARAM}=all` : carry(href));

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
              {/* Floor (the worklists) — opens the departments in a panel BELOW the tab.
                  They used to unroll sideways inside the bar, which shoved every
                  tab to its right along and left the bar a different width open
                  than closed. */}
              {machinePlanning && worklistDepts.length > 0 && (
              singleDept ? (
                <li>
                  <Link href={deptHref(singleDept)} className={`nav-tab ${isActive("/worklist") ? "nav-tab-active" : ""}`}>
                    <ListChecks size={15} className="shrink-0" />
                    Floor
                  </Link>
                </li>
              ) : (
                <MenuTab ctl={menuCtl} id="floor" label="Floor" icon={ListChecks} active={isActive("/worklist")}>
                  {LINE_GROUPS.map((g) => {
                    const depts = worklistDepts.filter((d) => d.line === g.line);
                    if (depts.length === 0) return null;
                    return (
                      <div key={g.line} role="group" aria-label={g.label}>
                        <p className="nav-drop-label" aria-hidden>{g.label}</p>
                        {depts.map((d) => <MenuLink key={deptHref(d)} href={deptHref(d)} label={d.label} icon={d.icon} active={deptOn(d)} />)}
                      </div>
                    );
                  })}
                </MenuTab>
              )
              )}
              {restTabs.map((l) => {
                const active = isActive(l.href, l.match, l.also);
                const badge = l.also?.includes("/odoo") && canSee("/odoo") && odooBadge();
                const places = (l.places ?? []).filter((p) => shown(p) && (on(p.href) || (pinnedLine(p.href) ?? line) === line));
                if (places.length < 2) {
                  return (
                    <li key={l.href}>
                      <Link href={l.href} className={`nav-tab ${active ? "nav-tab-active" : ""}`}>
                        <l.icon size={15} className="shrink-0" />
                        {l.label}
                        {badge}
                      </Link>
                    </li>
                  );
                }
                return (
                  <MenuTab ctl={menuCtl} key={l.href} id={l.href} label={l.label} icon={l.icon} active={active} href={active ? placeHref(l.href) : l.href} badge={badge}>
                    {places.map((p) => (
                      <MenuLink key={p.href} href={active ? placeHref(p.href) : p.href} label={p.label} icon={p.icon} title={p.title} active={on(p.href)} />
                    ))}
                  </MenuTab>
                );
              })}
            </ul>
          </nav>

          {/* right cluster */}
          <div className="ml-auto flex items-center gap-1 md:gap-2 shrink-0">
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
          <div ref={drawerRef} className="absolute left-0 top-0 h-full w-[300px] max-w-[85vw] bg-surface text-foreground shadow-2xl flex flex-col animate-[drawerslide_0.22s_ease-out]">
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
                ref={drawerCloseRef}
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
              {LINE_GROUPS.map((g) => {
                const depts = drawerDepts.filter((d) => d.line === g.line);
                return depts.length > 0 && (
                  <div key={g.line} role="group" aria-label={`Floor — ${g.label}`}>
                    <p className="drawer-label">Floor · {g.label}</p>
                    {depts.map((d) => (
                      <DrawerLink key={deptHref(d)} href={deptHref(d)} label={d.drawerLabel} icon={d.icon} active={deptOn(d)} />
                    ))}
                  </div>
                );
              })}
              <p className="drawer-label">Production</p>
              {drawerTabs.map((l) => (
                <DrawerLink key={l.href} href={l.href} label={l.label} icon={l.icon} active={isActive(l.href, l.match)} badge={null} />
              ))}

              {/* on desktop these sit behind a tab's own switcher; the drawer
                  has the room to list them, so a phone reaches them in one tap */}
              <p className="drawer-label">More</p>
              {drawerViews.map((l) => (
                <DrawerLink key={l.href} href={l.href} label={l.label} icon={l.icon} active={isActive(l.href, l.match)} badge={l.href === "/chat" ? <UnreadBadge count={unreadChat} /> : l.href === "/odoo" ? odooBadge() : null} />
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
              <form action={signOut}>
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
