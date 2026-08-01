import { NextResponse } from "next/server";
import { buildMorningDigest, renderMorningEmail } from "@/lib/server/morningReport";
import { sendMail } from "@/lib/server/smtp";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

/** Fired by the Vercel cron every morning (vercel.json). Builds the digest
 *  and emails it; without SMTP configured it still answers — the in-app page
 *  at /report/morning shows the same brief either way. */
export async function GET(req: Request) {
  // Vercel sends the CRON_SECRET as a bearer token when the env var exists —
  // with one set, nobody else can trigger the email
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const digest = await buildMorningDigest();
  const mail = await sendMail(
    `ATC morning brief — ${toDisplayDate(parseISODate(digest.dayISO)!)}`,
    renderMorningEmail(digest)
  );

  return NextResponse.json({
    day: digest.dayISO,
    emailed: mail.ok,
    ...(mail.skipped ? { note: "SMTP not configured (SMTP_USER / SMTP_PASS) — digest built but not emailed" } : {}),
    ...(mail.error ? { error: mail.error } : {}),
  });
}
