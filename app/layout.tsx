import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/AppNav";

const inter = Inter({
  variable: "--font-sans-latin",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ATC — Production Planning & Tracking",
  description:
    "Arabian Transformers Co. — transformer production planning & tracking",
};

// Applied before paint so there is no light/dark flash on load.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <AppNav />
        <main className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-[1600px] w-full mx-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
