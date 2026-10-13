import { serveUpload } from "@/lib/server/uploads";

// A task's photos and files kept without Vercel Blob (local / self-hosted).

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return serveUpload("tasks", name);
}
