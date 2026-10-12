import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- a person's own photo ---------------------------------------------------
// Only ever their own account (the session's, never the form's), only a small
// picture of a safe type, stored in the Blob store, and the photo it replaces
// deleted once the account points at the new one.

const h = vi.hoisted(() => ({
  me: null as { id: number; avatarUrl: string | null } | null,
  update: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: h.update } } }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => h.me }));
vi.mock("@vercel/blob", () => ({ put: h.put, del: h.del }));

import { removeAvatar, setAvatar } from "@/app/profile/actions";

const photo = (type = "image/jpeg", bytes = 2_000) => {
  const fd = new FormData();
  fd.set("photo", new File([new Uint8Array(bytes)], "photo", { type }));
  return fd;
};

const OLD = "https://store.public.blob.vercel-storage.com/avatars/u7-old.jpg";
const NEW = "https://store.public.blob.vercel-storage.com/avatars/u7-new.jpg";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
  h.me = { id: 7, avatarUrl: OLD };
  h.put.mockResolvedValue({ url: NEW });
  h.update.mockResolvedValue({});
  h.del.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("setAvatar", () => {
  it("puts the photo on the signed-in account and deletes the one it replaces", async () => {
    expect(await setAvatar(photo())).toEqual({ ok: true });
    expect(h.put).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^avatars\/u7-\d+\.jpg$/), expect.any(Buffer), expect.objectContaining({ access: "public", contentType: "image/jpeg", addRandomSuffix: true }));
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 7 }, data: { avatarUrl: NEW } });
    expect(h.del).toHaveBeenCalledExactlyOnceWith(OLD);
    expect(h.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("deletes nothing on a first photo", async () => {
    h.me = { id: 7, avatarUrl: null };
    expect(await setAvatar(photo())).toEqual({ ok: true });
    expect(h.del).not.toHaveBeenCalled();
  });

  it("refuses without a session, a non-picture, an SVG and an oversized file — storing nothing", async () => {
    h.me = null;
    expect((await setAvatar(photo())).error).toMatch(/not logged in/);
    h.me = { id: 7, avatarUrl: OLD };
    expect((await setAvatar(new FormData())).error).toMatch(/Choose a photo/);
    expect((await setAvatar(photo("image/svg+xml"))).error).toMatch(/JPEG, PNG or WebP/);
    expect((await setAvatar(photo("image/jpeg", 600 * 1024))).error).toMatch(/too large/);
    expect(h.put).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("refuses on Vercel with no Blob store rather than lose the photo with the next deployment", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "1");
    expect((await setAvatar(photo())).error).toMatch(/not configured/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("keeps the old photo when the account cannot be updated", async () => {
    h.update.mockRejectedValue(new Error("db down"));
    expect((await setAvatar(photo())).ok).toBe(false);
    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("removeAvatar", () => {
  it("clears the account's photo and deletes the file", async () => {
    expect(await removeAvatar()).toEqual({ ok: true });
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 7 }, data: { avatarUrl: null } });
    expect(h.del).toHaveBeenCalledExactlyOnceWith(OLD);
  });

  it("has nothing to do without a photo, and refuses without a session", async () => {
    h.me = { id: 7, avatarUrl: null };
    expect(await removeAvatar()).toEqual({ ok: true });
    expect(h.update).not.toHaveBeenCalled();
    h.me = null;
    expect((await removeAvatar()).error).toMatch(/not logged in/);
  });
});
