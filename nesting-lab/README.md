# Nesting Lab — نموذج محلي مستقل للنيستينج (CAD / True-Shape Nesting)

نموذج تجريبي **محلي بالكامل** ومنفصل عن تطبيق تخطيط الإنتاج: يقرأ ملفات DXF، يحلّل الهندسة
والـ Layers والثقوب، يميّز ملف القطع عن ملف النيستينج الجاهز، يشغّل محرك True-Shape
Nesting حتمي (لا يعتمد على AI)، يتحقق من النتيجة بفاحص مستقل، يرشّح المكن من ملف إعداد
محلي، ويصدّر DXF / SVG / CSV / JSON ويعيد قراءة ما صدّره للتأكد من الأبعاد.

- لا يلمس كود التطبيق ولا قاعدة بياناته ولا يرسل شغلًا لأي ماكينة.
- كل شيء يعمل في المتصفح (الملفات لا تغادر جهازك) أو من سطر الأوامر.
- التقرير التفصيلي (الدعم الفعلي، القيود، الدقة، الأزمنة، نتائج المراجعات): [`docs/REPORT.md`](docs/REPORT.md).
- **قبل أي دمج:** إعدادات جذر الريبو (`tsconfig`/`eslint`) تشمل هذا المجلد — انظر REPORT.md §7.
- تصور الدمج المستقبلي مع BOMs والخامات والمكن والـ AI: [`docs/INTEGRATION.md`](docs/INTEGRATION.md).
- نتائج العينتين المرفقتين: [`out/samples/SUMMARY.md`](out/samples/SUMMARY.md) والملفات بجانبه.

## التثبيت والتشغيل

المتطلبات: Node.js 22 (نفس إصدار التطبيق). لا يحتاج Python ولا قاعدة بيانات.

```bash
cd nesting-lab
npm install          # مرة واحدة
npm run dev          # الواجهة على http://localhost:5180
```

في الواجهة: **1 Files & parts** (ارفع DXF، اختر الوحدة لو الملف Unitless، حدد دور كل Layer،
راجع القطع وعدّل الكمية/رقم القطعة/BOM) → **2 Settings** (اللوح، الخامة، السُّمك، المسافات،
الدوران، المناطق المحظورة) → **3 Nest & review** (المعاينة بـ zoom/pan، الاستغلال، غير
الموزّع وأسبابه، نتيجة الفاحص المستقل) → **4 Machines** (ترتيب المكن مع الأسباب وما يحتاج
تأكيدًا) → **5 Export** (DXF لكل لوح + إعادة قراءة، SVG، كشف قطع CSV، تقرير JSON، مكتبة القطع).

نسخة إنتاج ثابتة (بدون dev server):

```bash
npm run build        # typecheck + vite build → dist/
npm run preview      # يخدم dist/ محليًا
```

## الاختبارات والفحص

```bash
npm run typecheck    # TypeScript strict
npm run test:run     # vitest: 91 اختبارًا (parser, topology, classification, nesting, verifier, export round-trip, hardening, العينتان)
npm test             # نفس الاختبارات في وضع المراقبة
```

## تشغيل العينتين وأي ملفات من سطر الأوامر

```bash
npm run samples      # يحلل العينتين في samples/ ويعيد نيستينج قطعهما ويكتب كل شيء في out/samples/ (حتمي: نفس الملفات بايت-بايت)
# فحص مستقل للملفات المصدَّرة بـ ezdxf (Python، اختياري): scripts/ezdxf-audit.py، السجل في out/samples/ezdxf-audit.txt
npm run cli -- --file path/to/file.dxf --unit mm --sheet 1220x2440 --material Steel \
   --thickness 5 --spacing 5 --margin 5 --rotations 0,90,180,270 --out out/my-run
# خيارات أخرى: --file (يتكرر) --qty F1-T2=10 --exclude F1-T5 --mark-layer NAME --ignore-layer NAME
#               --mirror --sheets N (عدد الألواح المتاحة) --budget 30 (ثانية)
# الافتراضات لو ما ذكرتش الخيار: لوح 1220x2440، Steel، سُمك 5 مم، فراغ 5، حافة 5، 4 دورانات، بلا mirror
```

كل تشغيل يكتب: `sheet-NN.dxf` + `sheet-NN.svg` لكل لوح، `cutlist.csv`، `report.json`
(المدخلات، الإعدادات، إصدار المحرك، كل placement، نتيجة الفاحص، نتيجة إعادة القراءة، ترتيب المكن)،
ومجلد `parts/` فيه DXF لكل نوع قطعة.

## بنية المشروع (مفصولة حتى يسهل دمج كل جزء على حدة)

```
src/engine/dxf/        قراءة DXF: tokenize → parse → primitives (وحدات، Layers، Blocks) → analyze
src/engine/geometry/   الهندسة: أقواس/bulges، مضلعات، topology (planar faces, common-line cuts)،
                       classify (sheet boundary / parts / holes)، dedupe (قطع متطابقة ومعكوسة)
src/engine/nesting/    المحرك: NFP بـ convex decomposition + Clipper، placer (bottom-left fill)،
                       nest (استراتيجيات، ألواح متعددة)، placement (معنى الـ placement)، verify (فاحص مستقل)
src/engine/parts.ts    بانٍ واحد للقطع من التحليل (يستخدمه الـ UI والـ CLI)
src/engine/machines/   ترتيب المكن من config/machines.local.json (عقد القواعد بشكل MachineRuleLike)
src/engine/export/     DXF writer (R2000, mm)، SVG، CSV، JSON report، round-trip، exportRun (كل الملفات بلا I/O)، export profiles
src/ui/                واجهة React (Vite) + Web Worker للنيستينج
config/                نسخة محلية من بيانات المكن/الخامات/مقاسات الألواح من التطبيق (للقراءة فقط)
samples/               العينتان المرفقتان
scripts/               run-samples.ts و nest-cli.ts وطبقة pipeline مشتركة
out/samples/           النتائج والتصدير من العينتين
```

---

## English summary

Standalone local prototype of the CAD / automatic-nesting module: DXF analysis (units,
layers, blocks, entity accounting, planar topology that reconstructs parts from
common-line-cut nestings), identical-part grouping, a deterministic true-shape nesting
engine (no-fit polygons from convex decompositions, bottom-left fill, several
orderings/objectives, multi-sheet, no-go zones), an independent geometric verifier,
machine ranking from a local read-only copy of the planner's machine list, and exports
(DXF R2000 in mm with arcs preserved, SVG, CSV cut list, JSON report) that are read back
and compared with the source. `npm install && npm run dev` for the UI, `npm run test:run`
for the 67 tests, `npm run samples` to regenerate `out/samples/`. Nothing here touches the
production app, its database or any machine queue.
