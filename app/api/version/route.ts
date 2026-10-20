// Which version of the app this server runs — open pages ask now and then to
// notice a new one (components/UpdateNotice.tsx). The version is baked in at
// build (next.config.ts) and sits in every page's script anyway, so the proxy's
// cookie gate is all it has and no database is touched. Keep it to the version
// alone — nothing about anyone or their data belongs here.

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ version: process.env.APP_VERSION ?? "" }, { headers: { "Cache-Control": "no-store" } });
}
