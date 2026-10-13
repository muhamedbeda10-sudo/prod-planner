import { serveUpload } from "@/lib/server/uploads";

// Chat attachments uploaded at runtime WITHOUT Vercel Blob (local /
// self-hosted). They cannot live in public/ — production only serves public
// assets that existed at build time. Mirrors the note-photo route.

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return serveUpload("chat", name);
}
