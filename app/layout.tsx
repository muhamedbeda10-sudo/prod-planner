import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { LineProvider } from "@/components/LineContext";
import { getCurrentUser, userPerms } from "@/lib/server/auth";
import { getChatUnreadCount } from "@/lib/server/chat";
import { getSettings } from "@/lib/server/data";
import { getActiveLine } from "@/lib/server/line";
import { getNeedingMo, getReadyToClose } from "@/lib/server/odooAlerts";
import { ODOO_ALERTS_PERM, ODOO_NEED_MO_PERM } from "@/lib/domain/odooAlerts";

const inter = Inter({
  variable: "--font-sans-latin",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ATC — Steel Fabrication (ERP System)",
  description: "Arabian Transformers Co. — steel fabrication ERP system",
  applicationName: "ATC ERP",
  // installed from Safari's "Add to Home Screen" on an iPhone or iPad
  appleWebApp: { capable: true, title: "ATC ERP", statusBarStyle: "black" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1c2220" },
    { media: "(prefers-color-scheme: light)", color: "#1a8150" },
  ],
};

// Applied before paint so there is no light/dark flash on load. The dark
// industrial theme is the default; light stays one click away on the toggle,
// and a choice made there is remembered.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"){document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser(); // null on /login (proxy guards the rest)
  const [unreadChat, settings, line] = user ? await Promise.all([getChatUnreadCount(user.id), getSettings(), getActiveLine()]) : [0, null, "TR" as const];
  // the ODOO alerts — "ready to close" and "needs an MO" — for whoever is
  // subscribed to either
  const perms = user ? userPerms(user) : new Set<string>();
  const wantClose = perms.has(ODOO_ALERTS_PERM);
  const wantMo = perms.has(ODOO_NEED_MO_PERM);
  const odooAlertsOn = wantClose || wantMo;
  const [readyRows, moRows] = odooAlertsOn
    ? await Promise.all([wantClose ? getReadyToClose() : [], wantMo ? getNeedingMo() : []])
    : [[], []];
  const odooReady = readyRows.length + moRows.length;
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <LineProvider line={line}>
        {user && (
          <AppNav
            user={{ id: user.id, name: user.name, isAdmin: user.isAdmin, isOwner: user.isOwner, perms: [...userPerms(user)] }}
            unreadChat={unreadChat}
            tankTracking={!!settings?.tankTracking}
            machinePlanning={!!settings?.machinePlanning}
            odooAlerts={{ enabled: odooAlertsOn, count: odooReady }}
            line={line}
          />
        )}
        <main className="flex-1 w-full px-3 py-3 md:px-5 md:py-4">
          {children}
        </main>
        <SpeedInsights />
        </LineProvider>
      </body>
    </html>
  );
}
