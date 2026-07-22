"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Menu, X, LogOut, Settings, LayoutDashboard, ClipboardList,
  Table2, FileBarChart2, BookOpenCheck,
  FileDown, GitCompareArrows, Puzzle, CalendarDays, Users,
} from "lucide-react";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { logoutAction } from "@/app/login/actions";

type Item = { href: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }> };

const PRIMARY: Item[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/handover", label: "Daily Logs", icon: BookOpenCheck },
  { href: "/worklist/cut", label: "Fabrication Worklist", icon: LaserCutterIcon },
  { href: "/worklist/welding", label: "Welding Worklist", icon: WeldingIcon },
  { href: "/worklist/painting", label: "Painting Worklist", icon: PowderCoatIcon },
  { href: "/tracker", label: "Plan Tracker", icon: Table2 },
  { href: "/report", label: "Daily Report", icon: FileBarChart2 },
];

const ADMIN: (Item & { desc: string })[] = [
  { href: "/orders", label: "Orders Registry", desc: "Master MO list — import monthly plans", icon: ClipboardList },
  { href: "/import", label: "Import Weekly Plan", desc: "Delivery schedule from Excel", icon: FileDown },
  { href: "/reconciliation", label: "Reconciliation", desc: "Compare plan vs previous plan", icon: GitCompareArrows },
  { href: "/boms", label: "BOM Review", desc: "Fix codes & reallocate excess", icon: Puzzle },
  { href: "/calendar", label: "Factory Calendar", desc: "Holidays & shutdown days off", icon: CalendarDays },
];

export interface NavUser {
  name: string;
  isAdmin: boolean;
  perms: string[];
}

export function AppNav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false); // desktop admin dropdown
  const [drawer, setDrawer] = useState(false); // mobile navigation drawer
  const menuRef = useRef<HTMLDivElement>(null);

  // close menus on navigation — state adjusted during render, not in an effect
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
    setDrawer(false);
  }

  // close the dropdown on outside click; close everything on Escape
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
  const adminActive = ADMIN.some((l) => isActive(l.href)) || isActive("/admin/users");

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
          <nav className="hidden md:block flex-1 overflow-x-auto overflow-y-hidden">
            <ul className="flex items-center justify-center gap-1 w-max min-w-full">
              {PRIMARY.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`nav-tab ${isActive(l.href) ? "nav-tab-active" : ""}`}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* right cluster */}
          <div className="ml-auto flex items-center gap-1 md:gap-2 shrink-0">
            {/* desktop: admin tools dropdown — admins only, invisible to everyone else */}
            {user.isAdmin && (
            <div className="relative shrink-0 hidden md:block" ref={menuRef}>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={`nav-tab flex items-center ${adminActive || open ? "nav-tab-active" : ""}`}
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
                  {ADMIN.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      role="menuitem"
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                        isActive(l.href) ? "bg-brand-light" : "hover:bg-surface-2"
                      }`}
                    >
                      <l.icon size={17} className={`mt-0.5 shrink-0 ${isActive(l.href) ? "text-brand" : "text-muted"}`} />
                      <span>
                        <span className={`block text-sm font-bold ${isActive(l.href) ? "text-brand" : ""}`}>{l.label}</span>
                        <span className="block text-xs text-muted mt-0.5">{l.desc}</span>
                      </span>
                    </Link>
                  ))}
                  {user.isAdmin && (
                    <Link
                      href="/admin/users"
                      role="menuitem"
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors border-t mt-1 pt-2.5 ${
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
              {PRIMARY.map((l) => (
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
                <p className="px-4 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted">Admin tools</p>
              )}
              {user.isAdmin && ADMIN.map((l) => (
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
    </header>
  );
}
