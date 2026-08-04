import { readFile } from "node:fs/promises";
import path from "node:path";

// Serves chat attachments uploaded at runtime WITHOUT Vercel Blob (local /
// self-hosted). They cannot live in public/ — production only serves public
// assets that existed at build time. Mirrors the note-photo route.

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// images and PDFs open in the browser; everything else downloads
const INLINE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!/^[\w][\w.-]*$/.test(name)) return new Response("Not found", { status: 404 });
  const ext = path.extname(name).toLowerCase();
  try {
    const buf = await readFile(path.join(process.cwd(), "uploads", "chat", name));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Disposition": INLINE.has(ext) ? "inline" : `attachment; filename="${name}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
