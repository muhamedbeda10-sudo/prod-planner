"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/server/auth";
import { savePlaybookEntry, setPlaybookEntryActive } from "@/lib/server/ai/playbook";

// The plant's playbook — the rules the assistant is told with every question
// and every automation's run. An admin's to keep (from this page, or through
// the assistant's tools, which come here); every change leaves a revision.

export interface PlaybookActionResult {
  ok: boolean;
  error?: string;
  id?: number;
}

const idOf = (v: FormDataEntryValue | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Add a rule, or (with an id) rewrite one — a retired one comes back. */
export async function savePlaybookRule(fd: FormData): Promise<PlaybookActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const raw = fd.get("id");
  const id = raw ? idOf(raw) : null;
  if (raw && id === null) return { ok: false, error: "Invalid rule." };
  const r = await savePlaybookEntry(id, { topic: String(fd.get("topic") ?? ""), title: String(fd.get("title") ?? ""), body: String(fd.get("body") ?? "") }, guard.user!.name);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/ai/playbook");
  return { ok: true, id: r.entry.id };
}

/** Retire a rule (it stays, with its history) or bring it back. */
export async function setPlaybookRuleActive(fd: FormData): Promise<PlaybookActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const id = idOf(fd.get("id"));
  if (id === null) return { ok: false, error: "Invalid rule." };
  const r = await setPlaybookEntryActive(id, fd.get("active") === "true", guard.user!.name);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/ai/playbook");
  return { ok: true, id };
}
