"use client";

import { useEffect } from "react";
import { Inter } from "next/font/google";
import { ErrorState } from "@/components/DataTable";
import { THEME_INIT_SCRIPT } from "@/components/themeInit";
import "./globals.css";

// When the root layout itself fails (a data load behind the navigation threw):
// Next replaces the whole layout with this file, so it carries its own <html>
// and <body>, the stylesheet, the font and the theme class the layout would
// have applied. Same words as app/error.tsx — plain, the digest to quote, the
// retry. The detail stays in the server log.

const inter = Inter({
  variable: "--font-sans-latin",
  subsets: ["latin"],
  display: "swap",
});

export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <title>ATC — Steel Fabrication (ERP System)</title>
        {/* The layout's theme script, repeated because the layout is gone. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <main className="flex-1 w-full px-3 py-3 md:px-5 md:py-4">
          <div className="bg-surface border rounded-[10px]">
            <ErrorState
              detail={<>Nothing was changed. Try again; if it keeps failing, send the admin this reference: <code className="ltr">{error.digest ?? "—"}</code></>}
              onRetry={unstable_retry}
            />
          </div>
        </main>
      </body>
    </html>
  );
}
