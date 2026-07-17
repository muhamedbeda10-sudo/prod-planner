"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { logoutAction } from "@/app/login/actions";

const PRIMARY: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/handover", label: "Daily Logs" },
  { href: "/worklist/cut", label: "Cut Worklist" },
  { href: "/worklist/welding", label: "Welding Worklist" },
  { href: "/worklist/painting", label: "Painting Worklist" },
  { href: "/tracker", label: "Plan Tracker" },
  { href: "/report", label: "Daily Report" },
];

const ADMIN: { href: string; label: string; desc: string; icon: string; perm: string | null }[] = [
  { href: "/orders", label: "Orders Registry", desc: "Master MO list — import monthly plans", icon: "📋", perm: "plans.import" },
  { href: "/import", label: "Import Weekly Plan", desc: "Delivery schedule from Excel", icon: "📥", perm: "plans.import" },
  { href: "/reconciliation", label: "Reconciliation", desc: "Compare plan vs previous plan", icon: "🔍", perm: null },
  { href: "/boms", label: "BOM Review", desc: "Fix codes & reallocate excess", icon: "🧩", perm: "boms.manage" },
  { href: "/calendar", label: "Factory Calendar", desc: "Holidays & shutdown days off", icon: "📆", perm: "calendar.manage" },
];

export interface NavUser {
  name: string;
  isAdmin: boolean;
  perms: string[];
}

export function AppNav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // close the dropdown on navigation — state adjusted during render, not in an effect
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }

  // close the dropdown on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  // admin tools the user may open: viewing is free, so show pages the user can
  // at least see; entries with a perm are highlighted only if usable
  const adminItems = ADMIN;
  const adminActive = adminItems.some((l) => isActive(l.href)) || isActive("/admin/users");

  return (
    <header className="no-print sticky top-0 z-30 bg-brand text-white shadow-md">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6">
        <div className="flex items-center gap-4 h-16">
          {/* brand — the OFFICIAL horizontal logo (white version for the green bar) */}
          <Link href="/" className="flex items-center shrink-0 group">
            <Image
              src="/brand/atc-logo-horizontal-white.svg"
              alt="ATC — Arabian Transformers Co."
              width={266}
              height={32}
              priority
              className="transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </Link>

          {/* primary nav — centered */}
          <nav className="flex-1 overflow-x-auto overflow-y-hidden">
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

          {/* admin tools dropdown */}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={`nav-tab flex items-center gap-1.5 ${adminActive || open ? "nav-tab-active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              ⚙️ Admin Tools
              <svg width="10" height="10" viewBox="0 0 10 10" className={`transition-transform ${open ? "rotate-180" : ""}`}>
                <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {open && (
              <div
                role="menu"
                className="nav-drop absolute right-0 top-[calc(100%+10px)] w-72 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40"
              >
                {adminItems.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    role="menuitem"
                    className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                      isActive(l.href) ? "bg-brand-light" : "hover:bg-brand-light/60"
                    }`}
                  >
                    <span className="text-lg leading-none mt-0.5">{l.icon}</span>
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
                      isActive("/admin/users") ? "bg-brand-light" : "hover:bg-brand-light/60"
                    }`}
                  >
                    <span className="text-lg leading-none mt-0.5">👥</span>
                    <span>
                      <span className={`block text-sm font-bold ${isActive("/admin/users") ? "text-brand" : ""}`}>Users & Permissions</span>
                      <span className="block text-xs text-muted mt-0.5">Accounts, passwords & what each can edit</span>
                    </span>
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* user + logout */}
          <div className="shrink-0 flex items-center gap-2 border-l border-white/20 pl-3">
            <span className="hidden md:block text-sm font-semibold max-w-[140px] truncate" title={user.name}>
              {user.name}
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="rounded-md px-2 py-1.5 text-sm hover:bg-white/15 transition-colors"
              >
                ⎋
              </button>
            </form>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
