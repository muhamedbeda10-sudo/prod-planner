import { readFile } from "node:fs/promises";
import path from "node:path";
import { AVATAR_TYPES } from "@/lib/domain/avatar";

// Serves the photos people put on their own round button where there is no
// Blob store. They cannot live in public/ — production only serves public
// assets that existed at build time. Each upload is a new file name, so a
// photo can be cached for good.

const MIME: Record<string, string> = Object.fromEntries(Object.entries(AVATAR_TYPES).map(([type, ext]) => [ext, type]));

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const type = MIME[path.extname(name).toLowerCase()];
  if (!/^[\w][\w.-]*$/.test(name) || !type) return new Response("Not found", { status: 404 });
  try {
    const buf = await readFile(path.join(process.cwd(), "uploads", "avatars", name));
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
