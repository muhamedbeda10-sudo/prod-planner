"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { resolveLine, type ProductLine } from "@/lib/domain/lines";
import { LINE_COOKIE } from "@/lib/server/line";

/** Switch every screen to the other product line. The choice lives in a
 *  cookie for a year, so it survives the browser closing; the layout re-reads
 *  it on the next render, which `revalidatePath("/", "layout")` forces now. */
export async function setLineAction(line: string): Promise<{ ok: true; line: ProductLine }> {
  const next = resolveLine(line);
  (await cookies()).set(LINE_COOKIE, next, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  return { ok: true, line: next };
}
