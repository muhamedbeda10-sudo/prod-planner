"use server";

import { getCurrentUser, hiddenTabsOf } from "@/lib/server/auth";
import { getLossWaterfall } from "@/lib/server/kpis";
import { LOSS_DAYS } from "@/lib/domain/losses";
import { isWorkCentre } from "@/lib/domain/shifts";

// The Production dashboard's "Where the hours went" card: the shift log's
// figures, so — as the page — only for someone who sees the Shifts screen.

export type LossWaterfallData = Awaited<ReturnType<typeof getLossWaterfall>>;

export async function loadLossWaterfall(centre: string, days: number): Promise<({ ok: true } & LossWaterfallData) | { ok: false; error: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "You are not logged in — refresh the page." };
  const hidden = hiddenTabsOf(me);
  if (hidden.has("shifts")) return { ok: false, error: "The shift log's figures are not open to you." };
  if (centre !== "all" && !isWorkCentre(centre)) return { ok: false, error: "Unknown work centre." };
  if (!(LOSS_DAYS as readonly number[]).includes(days)) return { ok: false, error: "Choose 7, 14 or 30 days." };
  return { ok: true, ...(await getLossWaterfall({ centre: centre === "all" ? null : centre, days })) };
}
