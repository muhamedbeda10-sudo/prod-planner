import { formatDate } from "@/lib/domain/format";
import { traceHref } from "@/lib/domain/links";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTankBySerial, getBaseUrl } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { PageHeader, Card } from "@/components/ui";
import { QrSvg } from "@/components/QrSvg";
import { TankQaPanel } from "@/components/TankQaPanel";
import { TANK_STATUS_LABEL, tankStatusTone, tankQrPayload, tankEventLook } from "@/lib/domain/tanks";

export const dynamic = "force-dynamic";

// Where a scanned barcode lands. Quality reads the whole life of the tank here
// — which order it belongs to, when each stage happened and who did it — and
// signs it off without leaving the page.

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm font-semibold">{value ?? "—"}</div>
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params;
  return { title: `${decodeURIComponent(serial)} — ATC` };
}

export default async function TankPage({ params }: { params: Promise<{ serial: string }> }) {
  await guardTab("/tank");
  const { serial: raw } = await params;
  const serial = decodeURIComponent(raw).trim().toUpperCase();

  const [found, user, inspectors, baseUrl] = await Promise.all([
    getTankBySerial(serial),
    getCurrentUser(),
    getWorkersFor("Quality"),
    getBaseUrl(),
  ]);
  if (!found) notFound();
  const { tank, events } = found;
  const canQa = !!user && hasPerm(user, "quality.qa");

  const lastQa =
    tank.qaResult && tank.qaISO
      ? { result: tank.qaResult, by: tank.qaBy, dateISO: tank.qaISO, note: tank.qaNote }
      : null;

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader label={`🛢 ${tank.serial}`}>
        <Link href="/barcode" className="btn btn-secondary btn-sm">
          ← Barcode
        </Link>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${tankStatusTone(tank.status)}`}>{TANK_STATUS_LABEL[tank.status]}</span>
            {tank.qaResult && (
              <span className={`pill ${tank.qaResult === "ok" ? "pill-ok" : "pill-bad"}`}>
                Quality: {tank.qaResult === "ok" ? "OK" : "Not OK"}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="MO" value={<Link href={traceHref({ mo: tank.mo, line: "TR" })} className="hover:underline">{tank.mo}</Link>} />
            <Field label="SO" value={tank.so} />
            <Field label="BOM" value={tank.bom} />
            <Field label="Customer" value={tank.customer} />
            <Field label="KVA" value={tank.kva} />
            <Field label="Rating" value={tank.rating} />
            <Field label="FG code" value={tank.fgCode} />
          </div>

          <div className="border-t pt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field
              label="Welding"
              value={
                tank.weldedISO
                  ? [tank.weldedISO, tank.weldedBy, tank.weldedStamp ? `stamp ${tank.weldedStamp}` : null]
                      .filter(Boolean)
                      .join(" · ")
                  : null
              }
            />
            <Field
              label="Leak test"
              value={tank.testedISO ? `${tank.testedISO}${tank.testedBy ? ` · ${tank.testedBy}` : ""}` : null}
            />
            <Field label="Painting" value={tank.paintedISO ? `${tank.paintedISO}${tank.paintedBy ? ` · ${tank.paintedBy}` : ""}` : null} />
          </div>

          <div className="border-t pt-3">
            <h2 className="text-sm font-extrabold mb-2">📜 Tank history</h2>
            {events.length === 0 ? (
              <p className="text-sm text-muted">No events recorded.</p>
            ) : (
              <ol className="space-y-1.5">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className={`pill ${tankEventLook(e.kind).tone}`}>{tankEventLook(e.kind).label}</span>
                    <span className="tabnum text-xs text-muted">{e.atISO}</span>
                    {e.workerName && <span className="font-semibold">{e.workerName}</span>}
                    {e.note && <span className="text-xs text-muted">— {e.note}</span>}
                    {e.byUser && <span className="text-[11px] text-muted ml-auto">recorded by {e.byUser}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>

        <Card className="p-4 h-fit text-center">
          <QrSvg value={tankQrPayload(baseUrl, tank.serial)} size={140} title={tank.serial} />
          <div className="ltr font-extrabold tabnum text-sm mt-2">{tank.serial}</div>
        </Card>
      </div>

      <div className="mt-4">
        {canQa ? (
          <TankQaPanel serial={tank.serial} inspectors={inspectors} last={lastQa} />
        ) : (
          lastQa && (
            <Card className="p-4">
              <div className={`pill ${lastQa.result === "ok" ? "pill-ok" : "pill-bad"}`}>
                Quality check: {lastQa.result === "ok" ? "OK" : "Not OK"} · {formatDate(lastQa.dateISO)}
                {lastQa.by ? ` · ${lastQa.by}` : ""}
              </div>
              {lastQa.note && <p className="text-sm mt-2">{lastQa.note}</p>}
            </Card>
          )
        )}
      </div>
    </div>
  );
}
