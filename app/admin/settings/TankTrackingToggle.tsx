"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTankTracking } from "./actions";

// The master switch for per-piece tank tracking. It is deliberately wordy: it
// changes how four screens behave and what the shop floor is asked to do, so
// whoever flips it should be able to read exactly what changes without going
// to find someone.

export function TankTrackingToggle({ initialOn }: { initialOn: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function flip(next: boolean) {
    if (
      next === false &&
      !window.confirm(
        "Turn per-piece tank tracking OFF?\n\n" +
          "Tanks go back to being recorded as quantities everywhere, with no serial and no leak test. " +
          "The Leak Test and Barcode tabs disappear.\n\n" +
          "Nothing is deleted — the tanks already recorded stay in the database and pick up where they left off when you turn it back on."
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("on", String(next));
    setMsg(null);
    startTransition(async () => {
      const res = await setTankTracking(fd);
      if (res.ok) {
        setOn(next);
        setMsg({ ok: true, text: next ? "Tank tracking is on." : "Tank tracking is off." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Failed to save." });
      }
    });
  }

  return (
    <div className="border rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-[260px]">
          <h2 className="text-sm font-extrabold flex items-center gap-2">
            🛢 Tank tracking (per piece)
            <span className={`pill ${on ? "pill-ok" : "pill-muted"}`}>{on ? "ON" : "OFF"}</span>
          </h2>
          <p className="text-sm text-muted mt-1">
            Tracks every tank as its own piece: a serial minted at welding, a leak test between welding
            and painting, painting recorded by picking the tanks, and a barcode sticker at the end.
          </p>
        </div>
        <button
          type="button"
          onClick={() => flip(!on)}
          disabled={pending}
          className={`rounded-md px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${
            on ? "bg-bad-fg hover:opacity-90" : "bg-brand hover:bg-brand-dark"
          }`}
        >
          {pending ? "Saving…" : on ? "Turn OFF" : "Turn ON"}
        </button>
      </div>

      {msg && (
        <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 border-t pt-3 text-sm">
        <div>
          <div className="font-bold mb-1">While it is ON</div>
          <ul className="text-muted space-y-0.5 list-disc pl-4">
            <li>Welding a tank mints a serial and asks who welded it</li>
            <li>Every tank must pass the leak test before it can be painted</li>
            <li>Painting is recorded by picking tanks, not by typing a quantity</li>
            <li>The Leak Test and Barcode tabs are available</li>
          </ul>
        </div>
        <div>
          <div className="font-bold mb-1">While it is OFF</div>
          <ul className="text-muted space-y-0.5 list-disc pl-4">
            <li>A tank is a quantity like every other component</li>
            <li>No serial, no leak test, no gate on painting</li>
            <li>The Leak Test and Barcode tabs are hidden</li>
            <li>Tanks already recorded stay saved and resume when you turn it back on</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
