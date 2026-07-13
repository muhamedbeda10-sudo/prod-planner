import { readFile } from "node:fs/promises";
import path from "node:path";

// Serves note photos uploaded at runtime. They cannot live in public/ —
// production only serves public assets that existed at build time.

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!/^[\w][\w.-]*$/.test(name)) return new Response("Not found", { status: 404 });
  try {
    const buf = await readFile(path.join(process.cwd(), "uploads", "notes", name));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
