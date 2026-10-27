import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { AutomationTicker } from "@/components/AutomationTicker";
import { AiPanel, AiPanelProvider } from "@/components/AiPanel";
import { AskAiAnywhere } from "@/components/AskAi";
import { InboxAlerts } from "@/components/InboxAlerts";
import { InboxPanel, InboxPanelProvider } from "@/components/InboxPanel";
import { TouchLongPress } from "@/components/TouchLongPress";
import { UpdateNotice } from "@/components/UpdateNotice";
import { TabAccessProvider } from "@/components/TabAccess";
import { parseHiddenTabs } from "@/lib/domain/tabs";
import { LineProvider } from "@/components/LineContext";
import { getCurrentUser, userPerms } from "@/lib/server/auth";
import { getChatUnreadCount } from "@/lib/server/chat";
import { getSettings } from "@/lib/server/data";
import { getUserPrefs } from "@/lib/server/userPrefs";
import { WHATS_NEW_PREF_KEYS } from "@/lib/domain/userPrefs";
import { ownLine } from "@/lib/server/line";
import { aiVisibleFor } from "@/lib/server/ai/access";
import { inboxState } from "@/lib/server/inbox";
import { NO_INBOX_HEAD } from "@/lib/domain/inbox";
import { getNeedingMo, getReadyToClose } from "@/lib/server/odooAlerts";
import { ODOO_ALERTS_PERM, ODOO_NEED_MO_PERM } from "@/lib/domain/odooAlerts";
import { THEME_INIT_SCRIPT } from "@/components/themeInit";

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
    { media: "(prefers-color-scheme: light)", color: "#157045" }, // = --nav-bg
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser(); // null on /login (proxy guards the rest)
  const [unreadChat, settings, prefs, ai, inbox] = user
    ? await Promise.all([getChatUnreadCount(user.id), getSettings(), getUserPrefs(user.id, WHATS_NEW_PREF_KEYS), aiVisibleFor(user), inboxState(user.id)])
    : [0, null, {}, false, { ...NO_INBOX_HEAD, any: false }];
  // the ODOO alerts — "ready to close" and "needs an MO" — for whoever is
  // subscribed to either
  const perms = user ? userPerms(user) : new Set<string>();
  // where a screen whose address names no line opens for this person
  const line = ownLine(user);
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
        {/* Applied before paint so there is no light/dark flash on load. The
            dark industrial theme is the default; light stays one click away on
            the toggle, and a choice made there is remembered. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <TouchLongPress />
        <LineProvider line={line}>
        <TabAccessProvider hidden={[...parseHiddenTabs(user?.hiddenTabs)]}>
        <AiPanelProvider config={{ ai, automations: perms.has("ai.automations"), isOwner: !!user?.isOwner }}>
        <InboxPanelProvider>
        {user && (
          <AppNav
            user={{ id: user.id, name: user.name, isAdmin: user.isAdmin, isOwner: user.isOwner, perms: [...userPerms(user)], avatarUrl: user.avatarUrl }}
            unreadChat={unreadChat}
            tankTracking={!!settings?.tankTracking}
            machinePlanning={!!settings?.machinePlanning}
            odooAlerts={{ enabled: odooAlertsOn, count: odooReady }}
            whatsNewSeen={prefs["whatsnew:seen"] ?? null}
            ai={ai}
            inbox={inbox}
          />
        )}
        {user && <AutomationTicker />}
        {user && <UpdateNotice />}
        <main className="flex-1 w-full px-3 py-3 md:px-5 md:py-4">
          {children}
          {user && <AiPanel isOwner={user.isOwner} />}
          {user && <AskAiAnywhere />}
          {user && <InboxPanel />}
          {user && <InboxAlerts initial={{ unread: inbox.unread, latestId: inbox.latestId }} />}
        </main>
        </InboxPanelProvider>
        </AiPanelProvider>
        <SpeedInsights />
        </TabAccessProvider>
        </LineProvider>
      </body>
    </html>
  );
}
