import { redirect } from "next/navigation";
import { getCurrentUser, hiddenTabsOf } from "@/lib/server/auth";
import { firstVisiblePath } from "@/lib/domain/tabs";

export const metadata = { title: "No screens — ATC" };
export const dynamic = "force-dynamic";

/** Where an account lands when every screen is switched off for it. */
export default async function NoAccessPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const next = firstVisiblePath(hiddenTabsOf(user));
  if (next) redirect(next);
  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-2">
      <h1 className="page-title">No screens open to your account</h1>
      <p className="text-sm text-muted">The owner has not switched any screen on for {user.name}. Ask them to tick the ones you need on Users &amp; Permissions.</p>
    </div>
  );
}
