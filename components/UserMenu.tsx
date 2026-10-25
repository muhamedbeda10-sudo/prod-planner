"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, LogOut, Sparkles, Trash2 } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { InstallApp } from "@/components/InstallApp";
import { MENU_ROW } from "@/components/ui";
import { useWhatsNew } from "@/components/WhatsNew";
import { AVATAR_PX, avatarColor, initials } from "@/lib/domain/avatar";
import { signOut } from "@/lib/signOut";
import { removeAvatar, setAvatar } from "@/app/profile/actions";

// The account's round button at the end of the bar: the person's photo, or
// their initials until they add one. It opens the account menu — who is
// signed in, their photo, what's new in the app, dark mode, installing the
// app, and signing out.

/** A person's photo in a circle, or their initials on their colour. */
export function Avatar({ id, name, url, size = 32 }: { id: number; name: string; url?: string | null; size?: number }) {
  const box = { width: size, height: size };
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- runtime uploads
    return <img src={url} alt={name} style={box} className="shrink-0 rounded-full object-cover bg-surface-2" />;
  }
  return (
    <span
      aria-hidden
      style={{ ...box, background: avatarColor(id), fontSize: Math.round(size * 0.38) }}
      className="shrink-0 rounded-full grid place-items-center font-extrabold text-white select-none"
    >
      {initials(name)}
    </span>
  );
}

/** The picked photo, cropped to its middle square and made AVATAR_PX wide —
 *  a phone's 5 MB picture leaves as a few dozen KB of JPEG. */
async function shrink(file: File): Promise<File> {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx || side <= 0) throw new Error("This file cannot be read as a picture.");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.85));
    if (!blob) throw new Error("This file cannot be read as a picture.");
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function UserMenu({ user, whatsNewSeen }: {
  user: { id: number; name: string; avatarUrl?: string | null; isAdmin: boolean; isOwner?: boolean };
  whatsNewSeen: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const news = useWhatsNew(whatsNewSeen);

  // close on a click outside it, or on Escape
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr("");
    start(async () => {
      try {
        const res = await work();
        if (res.ok) router.refresh();
        else setErr(res.error ?? "Failed.");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed.");
      }
    });
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    run(async () => {
      const fd = new FormData();
      fd.set("photo", await shrink(file));
      return setAvatar(fd);
    });
  };

  const role = user.isOwner ? "Owner" : user.isAdmin ? "Administrator" : "Signed in";
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={news.count > 0 ? `${user.name} — account menu, ${news.count} new in the app` : `${user.name} — account menu`}
        title={user.name}
        className={`relative block rounded-full ring-2 transition-shadow ${open ? "ring-white/70" : "ring-transparent hover:ring-white/40"}`}
      >
        <Avatar id={user.id} name={user.name} url={user.avatarUrl} />
        {news.count > 0 && <span className="count-badge count-badge-alert absolute -top-1 -end-1">{news.count}</span>}
      </button>

      {open && (
        <div role="menu" className="nav-drop absolute right-0 top-[calc(100%+10px)] w-64 bg-surface text-foreground border rounded-xl shadow-xl p-1.5 z-40">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Avatar id={user.id} name={user.name} url={user.avatarUrl} size={44} />
            <div className="min-w-0">
              <div className="text-sm font-bold truncate">{user.name}</div>
              <div className="text-xs text-muted">{role}</div>
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <button type="button" role="menuitem" className={MENU_ROW} disabled={pending} onClick={() => fileRef.current?.click()}>
            <Camera size={17} className="shrink-0 text-muted" />
            {pending ? "Saving…" : user.avatarUrl ? "Change photo" : "Add your photo"}
          </button>
          {user.avatarUrl && (
            <button type="button" role="menuitem" className={MENU_ROW} disabled={pending} onClick={() => run(removeAvatar)}>
              <Trash2 size={17} className="shrink-0 text-muted" />
              Remove photo
            </button>
          )}
          {err && <div className="px-3 pb-1 text-xs text-bad-fg">{err}</div>}
          <div className="border-t my-1" />
          <button type="button" role="menuitem" className={MENU_ROW} onClick={() => { setOpen(false); news.show(); }}>
            <Sparkles size={17} className="shrink-0 text-muted" />
            What&apos;s new
            {news.count > 0 && <span className="count-badge count-badge-alert ms-auto">{news.count}</span>}
          </button>
          <ThemeToggle row />
          <InstallApp row />
          <div className="border-t my-1" />
          <form action={signOut}>
            <button type="submit" role="menuitem" className={`${MENU_ROW} text-bad-fg`}>
              <LogOut size={17} className="shrink-0" />
              Sign out
            </button>
          </form>
        </div>
      )}
      {news.modal}
    </div>
  );
}
