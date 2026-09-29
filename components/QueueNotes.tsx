"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import { addQueueNote, setQueueNoteStatus, updateQueueNote, deleteQueueNote } from "@/app/worklist/actions";
import { Modal } from "@/components/Modal";

/** The 📝 pill button that opens a line's notes panel. Red = open issues. */
export function NotesButton({ lineNotes, onClick }: { lineNotes: QueueNoteDTO[]; onClick: () => void }) {
  const openCount = lineNotes.filter((n) => n.status === "open").length;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pill ${openCount > 0 ? "pill-bad" : lineNotes.length > 0 ? "pill-muted" : "pill-ok"} cursor-pointer hover:opacity-80`}
      title={openCount > 0 ? `${openCount} open note(s) — check before trusting the numbers` : "Add a note / photo"}
    >
      📝 {lineNotes.length > 0 ? lineNotes.length : "+"}
    </button>
  );
}

/** Full-width notes panel (a table row): list with edit / delete / resolve,
 *  plus an add form — text is optional when photos are attached. Shared by
 *  the Cut, Welding and Painting worklists. */
export function NotesPanelRow({
  bom,
  mo,
  item,
  dept,
  lineNotes,
  canEdit = false,
  onClose,
}: {
  bom: string;
  mo: string;
  item: string;
  dept: string; // Cut | Welding | Painting — where the note is raised
  lineNotes: QueueNoteDTO[];
  canEdit?: boolean; // user holds this dept's edit permission — otherwise view-only
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [noteMsg, setNoteMsg] = useState("");
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  function submitNote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setNoteMsg("");
    startTransition(async () => {
      const res = await addQueueNote(fd);
      if (res.ok) {
        form.reset();
        router.refresh();
      } else {
        setNoteMsg(res.error ?? "Failed");
      }
    });
  }

  function toggleNoteStatus(id: number, next: "open" | "resolved") {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("status", next);
    startTransition(async () => {
      await setQueueNoteStatus(fd);
      router.refresh();
    });
  }

  function saveNoteEdit(id: number) {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("text", editText);
    setNoteMsg("");
    startTransition(async () => {
      const res = await updateQueueNote(fd);
      if (res.ok) {
        setEditingNote(null);
        router.refresh();
      } else {
        setNoteMsg(res.error ?? "Failed");
      }
    });
  }

  function removeNote(id: number) {
    if (!confirm("Delete this note (and its photos) permanently?")) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(async () => {
      const res = await deleteQueueNote(fd);
      if (res.ok) router.refresh();
      else setNoteMsg(res.error ?? "Failed");
    });
  }

  // a popup over the table, opened from the line's 📝 button
  return (
    <Modal title={`📝 Notes — ${mo || bom} · ${item}`} sub={lineNotes.length ? `${lineNotes.length} note${lineNotes.length === 1 ? "" : "s"}` : undefined} onClose={onClose} busy={pending} width="max-w-4xl">
        <div className="space-y-3">

          {lineNotes.length > 0 && (
            <div className="grid gap-2.5 lg:grid-cols-2">
              {lineNotes.map((n) => (
                <div
                  key={n.id}
                  className={`bg-surface border rounded-xl p-3 shadow-sm ${n.status === "resolved" ? "opacity-60" : "border-l-4"} `}
                  style={n.status === "open" ? { borderLeftColor: "var(--warn-fg)" } : undefined}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs mb-1.5">
                    <span className={`pill ${n.status === "open" ? "pill-warn" : "pill-ok"}`}>
                      {n.status === "open" ? "⚠ open" : "✓ resolved"}
                    </span>
                    <span className="font-bold">{n.dept}</span>
                    <span className="text-muted tabnum">{n.createdISO}</span>
                    {canEdit && (
                      <span className="ml-auto flex items-center gap-2.5">
                        {editingNote !== n.id && (
                          <button
                            type="button"
                            onClick={() => { setEditingNote(n.id); setEditText(n.text); setNoteMsg(""); }}
                            disabled={pending}
                            className="text-accent hover:underline"
                          >
                            ✏️ Edit
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleNoteStatus(n.id, n.status === "open" ? "resolved" : "open")}
                          disabled={pending}
                          className="text-accent hover:underline"
                        >
                          {n.status === "open" ? "Mark resolved" : "Reopen"}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeNote(n.id)}
                          disabled={pending}
                          className="text-bad-fg hover:underline"
                        >
                          🗑 Delete
                        </button>
                      </span>
                    )}
                  </div>

                  {editingNote === n.id ? (
                    <div className="space-y-1.5">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        autoFocus
                        className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
                        disabled={pending}
                      />
                      <div className="flex items-center justify-end gap-2 text-xs">
                        <button type="button" onClick={() => setEditingNote(null)} className="text-muted hover:underline">Cancel</button>
                        <button
                          type="button"
                          onClick={() => saveNoteEdit(n.id)}
                          disabled={pending}
                          className="rounded-md px-3 py-1 font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                        >
                          {pending ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    n.text && <p className="text-sm whitespace-pre-wrap leading-relaxed">{n.text}</p>
                  )}

                  {n.photos.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {n.photos.map((p) => (
                        <a key={p} href={p} target="_blank" rel="noreferrer" title="Open full size">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p} alt="note photo" className="h-20 w-20 object-cover rounded-lg border shadow-sm hover:opacity-80 transition-opacity" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {canEdit && (
          <form onSubmit={submitNote} className="bg-surface border rounded-xl p-3 shadow-sm">
            <input type="hidden" name="bom" value={bom} />
            <input type="hidden" name="mo" value={mo} />
            <input type="hidden" name="item" value={item} />
            <input type="hidden" name="dept" value={dept} />
            <div className="flex flex-col md:flex-row gap-2.5">
              <textarea
                name="text"
                rows={2}
                placeholder={`What's really going on with ${mo || bom} ${item}? (optional when attaching photos)`}
                className="flex-1 border rounded-md px-2 py-1.5 text-sm bg-surface"
                disabled={pending}
              />
              <div className="flex md:flex-col items-end justify-between gap-2 md:w-60">
                <label className="w-full text-xs text-muted border border-dashed rounded-md px-2 py-1.5 cursor-pointer hover:border-brand transition-colors">
                  📷 Attach photos
                  <input type="file" name="photos" accept="image/*" multiple className="block w-full text-xs mt-1" disabled={pending} />
                </label>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-md px-4 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {pending ? "Saving…" : "Save note"}
                </button>
              </div>
            </div>
            {noteMsg && <div className="text-[11px] text-bad-fg mt-1.5">{noteMsg}</div>}
          </form>
          )}
        </div>
    </Modal>
  );
}
