import { BrandLogo } from "@/components/BrandLogo";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in — ATC Steel Fabrication (ERP System)" };

// The door: the company's own green behind one card — the logo, what this
// is, and the form. Nothing else to read.
export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return (
    <div className="min-h-[78vh] flex items-center justify-center">
      {/* full-bleed ATC-branded backdrop — login page only: the brand-green
          gradient (--login-gradient, one per theme) with the company logo
          repeating as a subtle watermark */}
      <div aria-hidden className="login-backdrop fixed inset-0 -z-10" />
      {/* the tile is taller than the logo needs, so the SVG letterboxes and
          the rows get breathing room; the second offset layer staggers them */}
      <div
        aria-hidden
        className="fixed -inset-[30%] -z-10 opacity-[0.07] -rotate-6"
        style={{
          backgroundImage: "url(/brand/atc-logo-horizontal-white.svg), url(/brand/atc-logo-horizontal-white.svg)",
          backgroundSize: "250px 190px, 250px 190px",
          backgroundRepeat: "repeat, repeat",
          backgroundPosition: "0 0, 125px 95px",
        }}
      />
      <div className="login-card">
        <div className="flex justify-center mb-6">
          <BrandLogo eager className="w-[220px] h-auto" />
        </div>
        <h1 className="text-lg font-bold text-center leading-tight">Steel Fabrication</h1>
        <p className="text-sm text-muted text-center mt-1 mb-6">ERP System · sign in with your account</p>
        <LoginForm />
        <p className="mt-6 text-center text-[11px] text-muted">Arabian Transformers Co. · Steel Fabrication</p>
      </div>
    </div>
  );
}
