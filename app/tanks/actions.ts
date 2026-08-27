"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { requireDeptEdit, requirePerm } from "@/lib/server/auth";
import { resolveWorker } from "@/lib/server/workers";
import { TANK_ITEM, blockedReason, isLeakTestResult, isQaResult, statusAfterLeakTest } from "@/lib/domain/tanks";

// Everything that happens to a tank AS A PIECE: the welder's name, the leak
// test between welding and painting, the repair loop, painting by selection,
// and quality's verdict after scanning the printed barcode.
//
// The quantity ledger stays untouched by the leak test and the repair loop —
// a tank that fails is still a welded tank, it just cannot move on. Only
// painting writes to the ledger, because painting is a real stage the plan
// counts.

export interface TankActionResult {
  ok: boolean;
  error?: string;
  /** How many tanks the action actually moved (bulk painting says so). */
  count?: number;
}

const TANK_PATHS = [
  "/worklist/welding",
  "/worklist/leak-test",
  "/worklist/painting",
  "/barcode",
  "/handover",
  "/tracker",
  "/trace",
  "/report",
  "/",
];

function revalidateTanks(extra: string[] = []) {
  for (const p of [...TANK_PATHS, ...extra]) revalidatePath(p);
}

/** Read a worker id from the form: null when the field is absent or blank,
 *  NaN when it holds something that is not a positive id. Deliberately
 *  string-first — `Number(null)` is 0, which would sail through an integer
 *  check and credit the work to nobody. */
function workerIdFromForm(formData: FormData): number | null {
  const raw = String(formData.get("workerId") ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

/** Read a "serials" field: one serial, or several separated by commas. */
function serialsFromForm(formData: FormData): string[] {
  const raw = String(formData.get("serials") ?? formData.get("serial") ?? "");
  return [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

// ---- welding ----

/** Name (or re-name) the welder on ONE tank. The technician records the batch
 *  under a single name and then corrects the individual tanks that a different
 *  welder actually made. */
export async function assignTankWelder(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requireDeptEdit("Welding");
    if (guard.error) return { ok: false, error: guard.error };
    const [serial] = serialsFromForm(formData);
    const workerId = workerIdFromForm(formData);
    if (!serial) return { ok: false, error: "التانك غير محدد." };
    if (workerId === null || !Number.isInteger(workerId)) return { ok: false, error: "اختار اسم اللحّام." };

    const welder = await resolveWorker(workerId, "Welding");
    if (welder.error) return { ok: false, error: welder.error };

    const tank = await prisma.tankUnit.findUnique({ where: { serial } });
    if (!tank) return { ok: false, error: "السيريال ده مش موجود." };

    await prisma.$transaction(async (tx) => {
      await tx.tankUnit.update({
        where: { id: tank.id },
        data: { weldedById: welder.worker!.id, weldedBy: welder.worker!.name },
      });
      await tx.tankEvent.create({
        data: {
          tankId: tank.id,
          kind: "welded",
          workerId: welder.worker!.id,
          workerName: welder.worker!.name,
          byUser: guard.user?.name ?? null,
          note: tank.weldedBy && tank.weldedBy !== welder.worker!.name ? `اتغير من ${tank.weldedBy}` : null,
        },
      });
    });
    revalidateTanks();
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The welder confirms a tank the leak test sent back is fixed — it returns to
 *  the leak-test queue for a re-test. The ledger never moved, so nothing to
 *  put back. */
export async function markTankRepaired(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requireDeptEdit("Welding");
    if (guard.error) return { ok: false, error: guard.error };
    const [serial] = serialsFromForm(formData);
    const workerId = workerIdFromForm(formData);
    const note = String(formData.get("note") ?? "").trim();
    if (!serial) return { ok: false, error: "التانك غير محدد." };
    if (workerId === null || !Number.isInteger(workerId)) return { ok: false, error: "اختار مين اللى صلّح التانك." };

    const welder = await resolveWorker(workerId, "Welding");
    if (welder.error) return { ok: false, error: welder.error };

    const tank = await prisma.tankUnit.findUnique({ where: { serial } });
    if (!tank) return { ok: false, error: "السيريال ده مش موجود." };
    const blocked = blockedReason("repair", tank.status);
    if (blocked) return { ok: false, error: blocked };

    await prisma.$transaction(async (tx) => {
      await tx.tankUnit.update({
        where: { id: tank.id },
        // back to "welded": it re-enters the leak-test queue for another go
        data: { status: "welded", testResult: null },
      });
      await tx.tankEvent.create({
        data: {
          tankId: tank.id,
          kind: "repaired",
          workerId: welder.worker!.id,
          workerName: welder.worker!.name,
          byUser: guard.user?.name ?? null,
          note: note || null,
        },
      });
    });
    revalidateTanks();
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- leak test ----

/** Record the leak test on one or more tanks: pass (they go on to painting) or
 *  repair (they go back to welding), always with the tester's name. A failing
 *  test needs a reason — the welder has to know what to fix. */
export async function recordLeakTest(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requireDeptEdit("LeakTest");
    if (guard.error) return { ok: false, error: guard.error };
    const serials = serialsFromForm(formData);
    const result = String(formData.get("result") ?? "").trim();
    const workerId = workerIdFromForm(formData);
    const note = String(formData.get("note") ?? "").trim();
    const dateISO = String(formData.get("date") ?? "").trim();

    if (serials.length === 0) return { ok: false, error: "اختار التانكات الأول." };
    if (!isLeakTestResult(result)) return { ok: false, error: "قول النتيجة: عدّى ولا محتاج إصلاح." };
    if (workerId === null || !Number.isInteger(workerId)) return { ok: false, error: "اختار مين اللى عمل الاختبار." };
    if (result === "repair" && !note) {
      return { ok: false, error: "اكتب المشكلة — اللحام محتاج يعرف بيصلّح إيه." };
    }

    const tester = await resolveWorker(workerId, "LeakTest");
    if (tester.error) return { ok: false, error: tester.error };

    const date = parseISODate(dateISO) ?? parseISODate(toISODate(new Date()))!;
    const tanks = await prisma.tankUnit.findMany({ where: { serial: { in: serials } } });
    if (tanks.length !== serials.length) {
      const found = new Set(tanks.map((t) => t.serial));
      const missing = serials.filter((s) => !found.has(s));
      return { ok: false, error: `سيريالات مش موجودة: ${missing.join("، ")}` };
    }
    for (const t of tanks) {
      const blocked = blockedReason("leak-test", t.status);
      if (blocked) return { ok: false, error: `${t.serial}: ${blocked}` };
    }

    const status = statusAfterLeakTest(result);
    await prisma.$transaction(async (tx) => {
      for (const t of tanks) {
        await tx.tankUnit.update({
          where: { id: t.id },
          data: {
            status,
            testedAt: date,
            testedById: tester.worker!.id,
            testedBy: tester.worker!.name,
            testResult: result,
            testNote: note || null,
          },
        });
        await tx.tankEvent.create({
          data: {
            tankId: t.id,
            kind: result === "pass" ? "leak-pass" : "leak-repair",
            at: date,
            workerId: tester.worker!.id,
            workerName: tester.worker!.name,
            byUser: guard.user?.name ?? null,
            note: note || null,
          },
        });
      }
    });
    revalidateTanks();
    return { ok: true, count: tanks.length };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- painting ----

/** Paint the chosen tanks and credit one painter. This is the only path that
 *  paints a tank, so the leak-test gate holds everywhere: a tank that has not
 *  passed cannot be selected here, and the quantity boxes on the other screens
 *  refuse tanks outright.
 *  One ledger row per MO keeps the daily log reading exactly as it always did. */
export async function paintTanks(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requireDeptEdit("Painting");
    if (guard.error) return { ok: false, error: guard.error };
    const serials = serialsFromForm(formData);
    const workerId = workerIdFromForm(formData);
    const dateISO = String(formData.get("date") ?? "").trim();

    if (serials.length === 0) return { ok: false, error: "اختار التانكات اللى اتدهنت." };
    if (workerId === null || !Number.isInteger(workerId)) return { ok: false, error: "اختار مين اللى دهن التانكات دى." };

    const painter = await resolveWorker(workerId, "Painting");
    if (painter.error) return { ok: false, error: painter.error };

    const date = parseISODate(dateISO) ?? parseISODate(toISODate(new Date()))!;
    const tanks = await prisma.tankUnit.findMany({ where: { serial: { in: serials } } });
    if (tanks.length !== serials.length) {
      const found = new Set(tanks.map((t) => t.serial));
      const missing = serials.filter((s) => !found.has(s));
      return { ok: false, error: `سيريالات مش موجودة: ${missing.join("، ")}` };
    }
    for (const t of tanks) {
      const blocked = blockedReason("paint", t.status);
      if (blocked) return { ok: false, error: `${t.serial}: ${blocked}` };
    }

    // one ledger row per MO — the same shape the painting worklist always wrote
    const byMo = new Map<string, typeof tanks>();
    for (const t of tanks) {
      const list = byMo.get(t.mo) ?? [];
      list.push(t);
      byMo.set(t.mo, list);
    }
    // the physical chain still has the final say (painted ≤ welded ≤ cut)
    for (const [mo, list] of byMo) {
      const chainError = await checkOutputChain({
        dept: "Painting", bom: list[0].bom, mo, item: TANK_ITEM, qty: list.length,
      });
      if (chainError) return { ok: false, error: chainError };
    }

    await prisma.$transaction(async (tx) => {
      for (const [mo, list] of byMo) {
        const planNo = list[0].planNo;
        await tx.plan.upsert({ where: { planNo }, create: { planNo, startDate: date }, update: {} });
        await tx.handoverEntry.create({
          data: {
            date, dept: "Painting", bom: list[0].bom, mo, item: TANK_ITEM,
            qty: list.length, planNo, source: "worklist",
            note: `تانكات: ${list.map((t) => t.serial).join("، ")}`,
            createdBy: guard.user?.name ?? null,
          },
        });
        for (const t of list) {
          await tx.tankUnit.update({
            where: { id: t.id },
            data: {
              status: "painted",
              paintedAt: date,
              paintedById: painter.worker!.id,
              paintedBy: painter.worker!.name,
            },
          });
          await tx.tankEvent.create({
            data: {
              tankId: t.id,
              kind: "painted",
              at: date,
              workerId: painter.worker!.id,
              workerName: painter.worker!.name,
              byUser: guard.user?.name ?? null,
            },
          });
        }
      }
    });
    revalidateTanks();
    return { ok: true, count: tanks.length };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Painting found a tank that is not actually sound: send THAT tank back to
 *  welding by its serial. It lands in the repair list and, once fixed, goes
 *  through the leak test again. The ledger is untouched — the tank was never
 *  painted, and it is still a welded tank. */
export async function sendTankBackToWelding(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requireDeptEdit("Painting");
    if (guard.error) return { ok: false, error: guard.error };
    const [serial] = serialsFromForm(formData);
    const reason = String(formData.get("reason") ?? "").trim();
    if (!serial) return { ok: false, error: "التانك غير محدد." };
    if (!reason) return { ok: false, error: "اكتب السبب — اللحام محتاج يعرف بيصلّح إيه." };

    const tank = await prisma.tankUnit.findUnique({ where: { serial } });
    if (!tank) return { ok: false, error: "السيريال ده مش موجود." };
    if (tank.status === "painted") return { ok: false, error: "التانك ده اتدهن خلاص — اتكلم مع الأدمن." };
    if (tank.status === "repair") return { ok: false, error: "التانك ده مرجّع للّحام بالفعل." };

    await prisma.$transaction(async (tx) => {
      await tx.tankUnit.update({
        where: { id: tank.id },
        data: { status: "repair", testResult: "repair", testNote: reason },
      });
      await tx.tankEvent.create({
        data: {
          tankId: tank.id,
          kind: "leak-repair",
          byUser: guard.user?.name ?? null,
          note: `مرجّع من الدهان: ${reason}`,
        },
      });
    });
    revalidateTanks();
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- quality ----

/** Quality scans the sticker and signs the tank off — OK, or not OK with what
 *  is wrong. A verdict can be recorded again later; every one of them stays in
 *  the tank's history. */
export async function recordTankQa(formData: FormData): Promise<TankActionResult> {
  try {
    const guard = await requirePerm("quality.qa");
    if (guard.error) return { ok: false, error: guard.error };
    const [serial] = serialsFromForm(formData);
    const result = String(formData.get("result") ?? "").trim();
    const workerId = workerIdFromForm(formData); // optional here — quality often has its own login
    const note = String(formData.get("note") ?? "").trim();

    if (!serial) return { ok: false, error: "التانك غير محدد." };
    if (!isQaResult(result)) return { ok: false, error: "قول النتيجة: تمام ولا مش تمام." };
    if (workerId !== null && !Number.isInteger(workerId)) return { ok: false, error: "اختيار الفاحص غير صحيح." };
    if (result === "not-ok" && !note) return { ok: false, error: "اكتب المشكلة اللى شوفتها." };

    const inspector = await resolveWorker(workerId, "Quality");
    if (inspector.error) return { ok: false, error: inspector.error };

    const tank = await prisma.tankUnit.findUnique({ where: { serial } });
    if (!tank) return { ok: false, error: "السيريال ده مش موجود." };

    // the app account is the fallback name — quality often has its own login
    const name = inspector.worker?.name ?? guard.user?.name ?? null;
    await prisma.$transaction(async (tx) => {
      await tx.tankUnit.update({
        where: { id: tank.id },
        data: {
          qaAt: new Date(),
          qaById: inspector.worker?.id ?? null,
          qaBy: name,
          qaResult: result,
          qaNote: note || null,
        },
      });
      await tx.tankEvent.create({
        data: {
          tankId: tank.id,
          kind: result === "ok" ? "qa-ok" : "qa-not-ok",
          workerId: inspector.worker?.id ?? null,
          workerName: name,
          byUser: guard.user?.name ?? null,
          note: note || null,
        },
      });
    });
    revalidateTanks([`/tank/${serial}`]);
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, error: `فشل الحفظ: ${e instanceof Error ? e.message : String(e)}` };
  }
}
