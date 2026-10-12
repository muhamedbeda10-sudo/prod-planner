// Client-side photo shrinking before upload: a 10 MB phone photo becomes a
// ~200-600 KB JPEG nobody can tell apart on a worklist screen. This is what
// keeps photos working even when the server stores them INSIDE the database
// (no Blob storage configured) — the server caps that path at 2 MB.

const MAX_DIMENSION = 1600; // px, longest side
const QUALITY = 0.82;

/** Downscale + re-encode an image file. Non-images and GIFs (animation would
 *  be lost) pass through untouched, as does anything that fails to decode —
 *  the server-side size caps still apply either way. A picture someone has to
 *  READ (a handwritten sheet for the assistant) asks for more pixels. */
export async function compressImage(file: File, o: { maxDimension?: number; quality?: number } = {}): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  const maxDimension = o.maxDimension ?? MAX_DIMENSION;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    // small files that need no resizing skip the round-trip entirely
    if (scale === 1 && file.size < 400 * 1024) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    // JPEG has no transparency: a see-through picture goes on white, not black
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", o.quality ?? QUALITY));
    if (!blob || blob.size >= file.size) return file; // re-encoding didn't help
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
