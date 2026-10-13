import "server-only";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { put } from "@vercel/blob";

// Photos and files people attach — on a chat message, a task, a task's
// update — stored one way for all of them. Vercel Blob when the deployment
// has a store (an unguessable public address; the app itself stays behind
// its login); on a machine without one, a folder of the app's own, served
// by app/uploads/<folder>/[name]; and on Vercel before a store is set up,
// photos only, kept inline in the row.

export interface StoredFile {
  url: string;
  name: string;
  size: number;
  type: string;
}

export type UploadFolder = "chat" | "tasks";

// the allowed set, by extension (browser MIME strings are too inconsistent to
// gate on): images render inline, the documents render as file cards
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".xls", ".xlsx", ".csv", ".doc", ".docx"]);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — same ceiling as note photos
const MAX_DB_IMAGE_BYTES = 2 * 1024 * 1024; // DB fallback: compressed images only

/** The files of a form, the empty slots left out. */
export function filesOf(fd: FormData, field = "files"): File[] {
  return fd.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
}

/** Store the files — all of them, or none: the first one refused stops it
 *  before anything is written. */
export async function storeUploads(files: readonly File[], folder: UploadFolder): Promise<{ ok: true; files: StoredFile[] } | { ok: false; error: string }> {
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) {
      return { ok: false, error: `"${f.name}" — only images, PDF, Excel, Word and CSV files are allowed.` };
    }
    if (f.size > MAX_FILE_BYTES) return { ok: false, error: `"${f.name}" is larger than 10 MB.` };
  }
  const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN; // cloud + any machine with the token
  const dbImagesOnly = !useBlob && !!process.env.VERCEL; // ephemeral filesystem — images inline, documents refused
  if (dbImagesOnly) {
    for (const f of files) {
      if (!IMAGE_EXTENSIONS.has(path.extname(f.name).toLowerCase())) {
        return { ok: false, error: `"${f.name}" — document storage is not configured yet (Vercel Blob); photos still work.` };
      }
      if (f.size > MAX_DB_IMAGE_BYTES) return { ok: false, error: `"${f.name}" is too large to store without Blob storage — max 2 MB per photo.` };
    }
  }
  const stored: StoredFile[] = [];
  if (files.length === 0) return { ok: true, files: stored };
  const dir = path.join(process.cwd(), "uploads", folder);
  if (!useBlob && !dbImagesOnly) await mkdir(dir, { recursive: true });
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    const type = f.type || "application/octet-stream";
    const bytes = Buffer.from(await f.arrayBuffer());
    let url: string;
    if (useBlob) {
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const blob = await put(`${folder}/${name}`, bytes, { access: "public", contentType: type, addRandomSuffix: true });
      url = blob.url;
    } else if (dbImagesOnly) {
      url = `data:${type};base64,${bytes.toString("base64")}`;
    } else {
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await writeFile(path.join(dir, name), bytes);
      url = `/uploads/${folder}/${name}`;
    }
    stored.push({ url, name: f.name, size: f.size, type });
  }
  return { ok: true, files: stored };
}

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

/** A file kept in the app's own folder (no Blob store) — they cannot live in
 *  public/: production serves only the public files that existed at build. */
export async function serveUpload(folder: UploadFolder, name: string): Promise<Response> {
  if (!/^[\w][\w.-]*$/.test(name)) return new Response("Not found", { status: 404 });
  const ext = path.extname(name).toLowerCase();
  try {
    const buf = await readFile(path.join(process.cwd(), "uploads", folder, name));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Disposition": INLINE.has(ext) ? "inline" : `attachment; filename="${name}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/** Stored files read back from a JSON column — anything malformed left out. */
export function storedFilesOf(json: unknown): StoredFile[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((f) =>
    f && typeof f === "object" && typeof f.url === "string" && typeof f.name === "string"
      ? [{ url: f.url, name: f.name, size: Number(f.size) || 0, type: typeof f.type === "string" ? f.type : "application/octet-stream" }]
      : [],
  );
}
