"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/DataTable";

// When a page fails to load: say so plainly, keep the navigation, offer the
// retry. The detail stays in the server log (production hides the message);
// the digest is what to quote when reporting it.
export default function Error({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="bg-surface border rounded-[10px]">
      <ErrorState
        detail={<>Nothing was changed. Try again; if it keeps failing, send the admin this reference: <code className="ltr">{error.digest ?? "—"}</code></>}
        onRetry={unstable_retry}
      />
    </div>
  );
}
