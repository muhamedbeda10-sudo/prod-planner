import "server-only";
import type { AiPlaybookEntry, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PLAYBOOK_BODY_MAX, PLAYBOOK_TITLE_MAX, isPlaybookTopic, playbookText } from "@/lib/domain/aiPlaybook";

// The playbook's reads and writes. The writes are the admins' — checked by
// the callers (the playbook page's actions, the assistant's tools through
// them) — and every one leaves a revision.

/** The playbook as the assistant is handed it ("" when there is none). */
export async function getPlaybookText(): Promise<string> {
  try {
    const rows = await prisma.aiPlaybookEntry.findMany({ where: { active: true }, select: { id: true, topic: true, title: true, body: true } });
    return playbookText(rows).text;
  } catch (e) {
    // a question still gets answered without the playbook
    console.error("AI: could not read the playbook", e);
    return "";
  }
}

export interface PlaybookInput {
  topic: string;
  title: string;
  body: string;
}

/** The input cleaned, or what is wrong with it. */
export function checkPlaybookInput(i: PlaybookInput): PlaybookInput | { error: string } {
  const topic = i.topic.trim();
  const title = i.title.trim().replace(/\s+/g, " ");
  const body = i.body.trim();
  if (!isPlaybookTopic(topic)) return { error: "Unknown topic." };
  if (!title) return { error: "Give the rule a short title." };
  if (title.length > PLAYBOOK_TITLE_MAX) return { error: `Keep the title under ${PLAYBOOK_TITLE_MAX} characters.` };
  if (!body) return { error: "Write the rule itself." };
  if (body.length > PLAYBOOK_BODY_MAX) return { error: `Keep one rule under ${PLAYBOOK_BODY_MAX} characters — split it.` };
  return { topic, title, body };
}

const snap = (e: AiPlaybookEntry) => ({ topic: e.topic, title: e.title, body: e.body, active: e.active }) as Prisma.InputJsonValue;

/** Add a rule, or rewrite one (id). */
export async function savePlaybookEntry(id: number | null, input: PlaybookInput, by: string): Promise<{ ok: true; entry: AiPlaybookEntry } | { ok: false; error: string }> {
  const clean = checkPlaybookInput(input);
  if ("error" in clean) return { ok: false, error: clean.error };
  if (id === null) {
    const entry = await prisma.$transaction(async (tx) => {
      const e = await tx.aiPlaybookEntry.create({ data: { ...clean, createdBy: by, updatedBy: by } });
      await tx.aiPlaybookRevision.create({ data: { entryId: e.id, action: "create", after: snap(e), by } });
      return e;
    });
    return { ok: true, entry };
  }
  const before = await prisma.aiPlaybookEntry.findUnique({ where: { id } });
  if (!before) return { ok: false, error: `Rule #${id} is not in the playbook.` };
  if (before.topic === clean.topic && before.title === clean.title && before.body === clean.body && before.active) return { ok: true, entry: before };
  const entry = await prisma.$transaction(async (tx) => {
    const e = await tx.aiPlaybookEntry.update({ where: { id }, data: { ...clean, active: true, updatedBy: by } });
    await tx.aiPlaybookRevision.create({ data: { entryId: id, action: before.active ? "update" : "restore", before: snap(before), after: snap(e), by } });
    return e;
  });
  return { ok: true, entry };
}

/** Take a rule off (it stays, inactive, with its history) — or put it back. */
export async function setPlaybookEntryActive(id: number, active: boolean, by: string): Promise<{ ok: true; entry: AiPlaybookEntry } | { ok: false; error: string }> {
  const before = await prisma.aiPlaybookEntry.findUnique({ where: { id } });
  if (!before) return { ok: false, error: `Rule #${id} is not in the playbook.` };
  if (before.active === active) return { ok: true, entry: before };
  const entry = await prisma.$transaction(async (tx) => {
    const e = await tx.aiPlaybookEntry.update({ where: { id }, data: { active, updatedBy: by } });
    await tx.aiPlaybookRevision.create({ data: { entryId: id, action: active ? "restore" : "retire", before: snap(before), after: snap(e), by } });
    return e;
  });
  return { ok: true, entry };
}
