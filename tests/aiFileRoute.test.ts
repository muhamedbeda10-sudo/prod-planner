import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/ai/files/[id] — a file attached in the assistant's chat, back to
// the person who attached it alone: a photo shown inline, anything else as a
// download, never run as a page — against a stubbed database and session.

const h = vi.hoisted(() => ({ user: null as { id: number } | null, findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { aiFile: { findFirst: h.findFirst } } }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => h.user }));

import { GET } from "@/app/api/ai/files/[id]/route";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const get = (id: string) => GET(new Request(`http://x/api/ai/files/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 1 };
  h.findFirst.mockResolvedValue(null);
});

describe("an attached file, opened again", () => {
  it("is found only for the person who attached it", async () => {
    expect((await get("12")).status).toBe(404);
    expect(h.findFirst).toHaveBeenCalledWith({ where: { id: 12, userId: 1 }, select: { name: true, kind: true, type: true, data: true } });
    h.user = null;
    expect((await get("12")).status).toBe(404);
    h.user = { id: 1 };
    for (const bad of ["0", "-3", "1.5", "abc"]) expect((await get(bad)).status).toBe(404);
    expect(h.findFirst).toHaveBeenCalledTimes(1);
  });

  it("shows a photo as itself, and never lets a file run as a page", async () => {
    h.findFirst.mockResolvedValue({ name: "sheet.jpg", kind: "image", type: "image/jpeg", data: JPEG });
    const r = await get("12");
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(JPEG);
    expect(Object.fromEntries(r.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "content-disposition": "inline; filename=\"sheet.jpg\"; filename*=UTF-8''sheet.jpg",
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  it("hands anything else over as a download, its name kept whatever its letters", async () => {
    h.findFirst.mockResolvedValue({ name: "تقرير (1) \"final\".pdf", kind: "pdf", type: "application/pdf", data: new TextEncoder().encode("%PDF-1.7") });
    const r = await get("13");
    expect(r.headers.get("content-disposition")).toBe(
      "attachment; filename=\"_____ (1) _final_.pdf\"; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20%281%29%20%22final%22.pdf",
    );
  });
});
