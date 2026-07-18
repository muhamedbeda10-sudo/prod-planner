import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in — ATC Steel Fabrication" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return (
    <div className="min-h-[78vh] flex items-center justify-center">
      <div className="w-full max-w-sm bg-surface border rounded-2xl p-8" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="flex justify-center mb-6">
          <Image
            src="/brand/atc-logo-horizontal.svg"
            alt="ATC — Arabian Transformers Co."
            width={220}
            height={48}
            priority
          />
        </div>
        <h1 className="text-lg font-bold text-center mb-1">Steel Fabrication</h1>
        <p className="text-sm text-muted text-center mb-6">Sign in with your account</p>
        <LoginForm />
      </div>
    </div>
  );
}
