import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";

// A file someone attached in the assistant's chat, back to that person alone
// — the photo shown on their question, a sheet or PDF to download. A file is
// never changed once kept, so it can be cached by the browser; nothing else
// may open it (no other account, no frame, no script in it).

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not found", { status: 404 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const f = await prisma.aiFile.findFirst({ where: { id, userId: user.id }, select: { name: true, kind: true, type: true, data: true } });
  if (!f) return new Response("Not found", { status: 404 });
  const shown = f.kind === "image";
  // the name as it is for the browsers that read filename*, a plain one for the rest
  const plain = f.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.type,
      "Content-Disposition": `${shown ? "inline" : "attachment"}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
