"use client";

import { useState, useTransition } from "react";
import { WORKER_DEPTS, WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { createWorker, updateWorker, setWorkerActive, deleteWorker } from "./actions";

// The list behind every "who did this?" dropdown. Kept deliberately plain: a
// name, an optional badge number, and the stages the person can be credited in.

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function run(
    fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    fd: FormData,
    okText: string,
    after?: () => void
  ) {
    startTransition(async () => {
      const res = await fn(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "فشلت العملية." });
      if (res.ok) after?.();
    });
  }
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

function DeptChecks({ defaults, disabled }: { defaults: Set<string>; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {WORKER_DEPTS.map((d) => (
        <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="checkbox"
            name="depts"
            value={d}
            defaultChecked={defaults.has(d)}
            disabled={disabled}
            className="accent-[var(--brand,#1b7a43)]"
          />
          <span className="font-semibold">{WORKER_DEPT_LABEL[d]}</span>
        </label>
      ))}
    </div>
  );
}

function WorkerCard({ worker }: { worker: WorkerDTO }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  const depts = new Set(worker.depts);

  return (
    <div className={`border rounded-xl p-4 ${worker.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="font-bold flex items-center gap-2">
            {worker.name}
            {!worker.active && <span className="pill pill-muted">موقوف</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {worker.code ? `كود ${worker.code} · ` : ""}
            {worker.depts.length > 0 ? worker.depts.map((d) => WORKER_DEPT_LABEL[d]).join(" · ") : "من غير قسم"}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
          {editing ? "إغلاق" : "تعديل"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={act.pending}
          onClick={() => {
            const fd = new FormData();
            fd.set("id", String(worker.id));
            fd.set("active", worker.active ? "false" : "true");
            act.run(setWorkerActive, fd, worker.active ? "اتوقف." : "رجع تاني.");
          }}
        >
          {worker.active ? "إيقاف" : "تفعيل"}
        </button>
        <button
          type="button"
          className="btn btn-sm text-bad-fg"
          disabled={del.pending}
          onClick={() => {
            if (!confirm(`مسح ${worker.name} نهائياً؟`)) return;
            const fd = new FormData();
            fd.set("id", String(worker.id));
            del.run(deleteWorker, fd, "اتمسح.");
          }}
        >
          مسح
        </button>
      </div>

      <Msg msg={act.msg} />
      <Msg msg={del.msg} />

      {editing && (
        <form
          className="mt-3 space-y-2.5 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("id", String(worker.id));
            edit.run(updateWorker, fd, "اتحفظ.", () => setEditing(false));
          }}
        >
          <div className="grid sm:grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-xs font-bold text-muted">الاسم</span>
              <input name="name" defaultValue={worker.name} required className={inputCls} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-muted">الكود (اختياري)</span>
              <input name="code" defaultValue={worker.code ?? ""} className={inputCls} />
            </label>
          </div>
          <DeptChecks defaults={depts} disabled={edit.pending} />
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>
              حفظ
            </button>
            <Msg msg={edit.msg} />
          </div>
        </form>
      )}
    </div>
  );
}

export function WorkersManager({ workers }: { workers: WorkerDTO[] }) {
  const add = useAction();
  const [open, setOpen] = useState(workers.length === 0);

  return (
    <div className="space-y-5">
      <div className="border rounded-xl p-4">
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "إغلاق" : "➕ إضافة عامل"}
        </button>
        {open && (
          <form
            className="mt-3 space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              add.run(createWorker, new FormData(form), "اتضاف.", () => form.reset());
            }}
          >
            <div className="grid sm:grid-cols-2 gap-2.5">
              <label className="block">
                <span className="text-xs font-bold text-muted">الاسم</span>
                <input name="name" required placeholder="اسم العامل" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-muted">الكود (اختياري)</span>
                <input name="code" placeholder="رقم البادچ" className={inputCls} />
              </label>
            </div>
            <DeptChecks defaults={new Set()} disabled={add.pending} />
            <div className="flex items-center gap-3">
              <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>
                إضافة
              </button>
              <Msg msg={add.msg} />
            </div>
          </form>
        )}
      </div>

      {workers.length === 0 ? (
        <p className="text-sm text-muted">
          مفيش عمال مسجلين لسه. من غير الأسامي دى، الفني مش هيقدر يسجل مين لحم أو اختبر أو دهن التانك.
        </p>
      ) : (
        <div className="space-y-3">
          {workers.map((w) => (
            <WorkerCard key={w.id} worker={w} />
          ))}
        </div>
      )}
    </div>
  );
}
