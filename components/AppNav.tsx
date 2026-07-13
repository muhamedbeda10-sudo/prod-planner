"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

const PRIMARY: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/handover", label: "Daily Logs" },
  { href: "/worklist/cut", label: "Cut Worklist" },
  { href: "/worklist/welding", label: "Welding Worklist" },
  { href: "/worklist/painting", label: "Painting Worklist" },
  { href: "/tracker", label: "Plan Tracker" },
  { href: "/report", label: "Daily Report" },
];

const ADMIN: { href: string; label: string; desc: string; icon: string }[] = [
  { href: "/orders", label: "Orders Registry", desc: "Master MO list — import monthly plans", icon: "📋" },
  { href: "/import", label: "Import Weekly Plan", desc: "Delivery schedule from Excel", icon: "📥" },
  { href: "/reconciliation", label: "Reconciliation", desc: "Compare plan vs previous plan", icon: "🔍" },
  { href: "/boms", label: "BOM Review", desc: "Fix codes & reallocate excess", icon: "🧩" },
  { href: "/calendar", label: "Factory Calendar", desc: "Holidays & shutdown days off", icon: "📆" },
];

export function AppNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // close the dropdown on outside click and on navigation
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => setOpen(false), [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
  const adminActive = ADMIN.some((l) => isActive(l.href));

  return (
    <header className="no-print sticky top-0 z-30 bg-brand text-white shadow-md">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6">
        <div className="flex items-center gap-4 h-16">
          {/* brand — company logo + name */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
            <Image
              src="/brand/atc_white.svg"
              alt="ATC — Arabian Transformers Co."
              width={50}
              height={20}
              priority
              className="transition-transform duration-300 group-hover:scale-110"
            />
            <span className="hidden md:block leading-tight">
              <span className="block text-[13px] font-extrabold tracking-tight">الشركة العربية للمحولات</span>
              <span className="block text-[9.5px] font-semibold tracking-[0.08em] text-white/70 uppercase">Arabian Transformers Co.</span>
            </span>
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
                {ADMIN.map((l) => (
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
              </div>
            )}
          </div>

          <div className="shrink-0 border-l border-white/20 pl-2">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
