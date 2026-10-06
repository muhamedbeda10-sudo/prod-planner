import { getFinishedTanks, getBaseUrl } from "@/lib/server/tanks";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { BarcodeSheet } from "@/components/BarcodeSheet";

export const metadata = { title: "Barcode — ATC" };
export const dynamic = "force-dynamic";

// Tanks that finished welding, the leak test and painting end up here for
// their sticker. The QR on it opens the tank's own page, so whoever scans it
// sees the live record rather than a snapshot frozen at printing time.

function TrackingOff({ what }: { what: string }) {
  return (
    <div className="bg-surface border rounded-xl p-6 text-center">
      <p className="text-sm font-bold mb-1">Per-piece tank tracking is turned off</p>
      <p className="text-sm text-muted">
        {what} Tanks are being recorded as quantities on the worklists, like every other component.
        An admin can turn tracking on under Admin &rarr; Settings.
      </p>
    </div>
  );
}

export default async function BarcodePage() {
  await guardTab("/barcode");
  const [tanks, baseUrl, user, settings] = await Promise.all([
    getFinishedTanks(),
    getBaseUrl(),
    getCurrentUser(),
    getSettings(),
  ]);

  return (
    <div>
      <PageHeader title="🏷 Tank Barcodes" />
      {!settings.tankTracking && (
        <div className="mb-4">
          <TrackingOff what="No new tanks reach this tab while it is off; anything already here stays." />
        </div>
      )}
      <BarcodeSheet tanks={tanks} baseUrl={baseUrl} isAdmin={!!user?.isAdmin} />
    </div>
  );
}
