import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { getCurrentUser, userPerms } from "@/lib/server/auth";
import { getChatUnreadCount } from "@/lib/server/chat";
import { getSettings } from "@/lib/server/data";

const inter = Inter({
  variable: "--font-sans-latin",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ATC — Steel Fabrication (ERP System)",
  description: "Arabian Transformers Co. — steel fabrication ERP system",
};

// Applied before paint so there is no light/dark flash on load.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser(); // null on /login (proxy guards the rest)
  const [unreadChat, settings] = user ? await Promise.all([getChatUnreadCount(user.id), getSettings()]) : [0, null];
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        {user && (
          <AppNav
            user={{ id: user.id, name: user.name, isAdmin: user.isAdmin, perms: [...userPerms(user)] }}
            unreadChat={unreadChat}
            tankTracking={!!settings?.tankTracking}
          />
        )}
        <main className="flex-1 w-full px-4 py-5 md:px-6 md:py-6">
          {children}
        </main>
        <SpeedInsights />
      </body>
    </html>
  );
}
