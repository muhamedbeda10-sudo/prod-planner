"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Modal } from "@/components/Modal";
import { saveUserPref } from "@/app/prefs/actions";
import type { WhatsNewHead } from "@/lib/domain/whatsNew";

// the list is fetched when the window opens: the badge needs only its count
const WhatsNewList = dynamic(() => import("./WhatsNewList").then((m) => m.WhatsNewList), {
  loading: () => <p role="status" className="text-sm text-muted">Loading…</p>,
});

/** ✨ What's new — the count of entries this person has not opened the list
 *  on yet, the list itself, and `show` to open it. Opening it marks them all
 *  seen (on the account, so it holds on any computer). A hook, not a button:
 *  the list lives in the account menu, and its window has to outlive the
 *  menu that opened it. */
export function useWhatsNew({ unseen, newest, seen }: WhatsNewHead): { count: number; show: () => void; modal: React.ReactNode } {
  const [open, setOpen] = useState(false);
  // the newest entry opened here, ahead of the next server read of the pref
  const [readId, setReadId] = useState(seen);
  const count = newest !== null && newest === readId ? 0 : unseen;
  const show = () => {
    setOpen(true);
    if (newest && newest !== readId) {
      setReadId(newest);
      void saveUserPref("whatsnew:seen", newest);
    }
  };
  const modal = open && (
    <Modal title="✨ What's new" sub="What changed in the app, newest first." onClose={() => setOpen(false)} width="max-w-2xl">
      <WhatsNewList seen={seen} onNavigate={() => setOpen(false)} />
    </Modal>
  );
  return { count, show, modal };
}
