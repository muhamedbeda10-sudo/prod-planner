import { getFinishedTanks, getBaseUrl } from "@/lib/server/tanks";
import { PageHeader } from "@/components/ui";
import { BarcodeSheet } from "@/components/BarcodeSheet";

export const metadata = { title: "Barcode — ATC" };
export const dynamic = "force-dynamic";

// Tanks that finished welding, the leak test and painting end up here for
// their sticker. The QR on it opens the tank's own page, so whoever scans it
// sees the live record rather than a snapshot frozen at printing time.
export default async function BarcodePage() {
  const [tanks, baseUrl] = await Promise.all([getFinishedTanks(), getBaseUrl()]);

  return (
    <div>
      <PageHeader title="🏷 باركود التانكات" />
      <BarcodeSheet tanks={tanks} baseUrl={baseUrl} />
    </div>
  );
}
