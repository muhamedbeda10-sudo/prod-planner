"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getActiveLine } from "@/lib/server/line";
import { importNestingTracker, type MaterialImportResult } from "@/lib/server/material";
import { userMessage } from "@/lib/server/errors";

// The MATERIAL tab's one write: uploading the sheet. The tab is the planner's
// nesting sheet as one living table, and the sheet is its only source — no
// line is typed, edited or deleted by hand, here or by the assistant. A line
// is keyed on its MO × BOM × part × material × thickness × sheet size, so
// uploading again updates it, never doubles it.

function revalidateMaterial() {
  revalidatePath("/material");
}

export async function importMaterialAction(formData: FormData): Promise<MaterialImportResult> {
  const guard = await requirePerm(linePermKey(await getActiveLine(), "material"));
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the material sheet (Excel)." };
  const preview = formData.get("preview") === "true";
  const prune = formData.get("prune") === "on" || formData.get("prune") === "true";
  try {
    const res = await importNestingTracker(await file.arrayBuffer(), guard.user?.name ?? null, preview, prune);
    if (res.ok && !preview) revalidateMaterial();
    return res;
  } catch (e) {
    return { ok: false, error: userMessage(e, "import the sheet") };
  }
}
