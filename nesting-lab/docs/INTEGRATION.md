# تصور دمج موديول النيستينج في تطبيق تخطيط الإنتاج (المرحلة التالية — لم يبدأ)

الهدف: نفس المحرك الذي تحقق منه هنا يعمل داخل التطبيق من غير إعادة كتابة، مع ربطه بالـ BOMs
والبلانات والخامات والمكن والـ AI assistant، وبقواعد التطبيق الحالية (صلاحيات، transactions،
سجل تعديلات، What's new).

## 1. ما يُنقل كما هو

`src/engine/**` كود TypeScript صافٍ بلا I/O ولا DOM (يعمل في Node وفي Web Worker). يُنقل إلى
`lib/domain/nesting/*` (أو package داخلي) مع اختباراته. الاعتمادية الوحيدة `clipper-lib`
(pure JS، BSL license) — لا Python ولا native.

## 2. قاعدة البيانات (migrations إضافية فقط، بلا مساس بالجداول الحالية)

- `Drawing` / `DrawingVersion`: الملف الأصلي (Vercel Blob — موجود بالفعل في التطبيق لملفات AI)،
  SHA-256، الوحدة المختارة، أدوار الـ Layers، JSON الهندسة المستخرجة، معاينة SVG، حالة
  الاعتماد، الإصدار (الإصدارات القديمة تبقى).
- `PartGeometry`: نوع قطعة (hash الهندسة، bbox، مساحة، ثقوب) مرتبط بـ DrawingVersion، وبـ
  (line, bom, item, partCode/partName, material, thicknessMm, qtyPerUnit).
- `NestingRun` (**جدول جديد**، لا يعيد إحياء `NestRun` القديم: README يقول صراحة "the nest runs are
  gone" وبدلته sheet jobs): status Queued/Running/Completed/Failed/Cancelled، settings JSON،
  engineVersion، النتيجة (placements)، تقرير الفاحص، createdBy، مرجع الـ DrawingVersion لكل قطعة.
- `NestingRunPart` / `NestingSheet`: الكميات لكل قطعة ولكل لوح، والحجز.
- Remnants (اختياري لاحقًا): شكل البقية، خامة، سُمك، مصدر.

## 3. حساب الاحتياج والحجز

- الاحتياج = (وحدات الـ BOM المطلوبة في البلان/MO) × (qtyPerUnit للقطعة) − المنتج (daily log /
  `HandoverEntry` و `SheetCutLog`) − المحجوز في NestingRuns مفتوحة.
- الحجز في transaction واحد مع قفل على (bom, mo, part) ومفتاح idempotency من الواجهة/الأداة
  حتى لا يتضاعف عند الضغط مرتين أو retry.

## 4. ربط المكن والطوابير (بوظائف التطبيق الحالية)

- اختيار الماكينة: `machineVerdict()` من `lib/domain/machineRules.ts` على بيانات
  `Machine`/`MachineRule` الحية + حقول جديدة اختيارية على Machine (process, bedMm, thickness
  range, materials, controller, exportProfile) بدل ملف `config/machines.local.json`.
- إرسال النيستينج المعتمد: `createManualJob` (sheet job: خامة/سُمك/مقاس/عدد ألواح + أجزاء
  `ManualJobPart` بالقطع والكميات الفعلية لكل لوح) ثم `assignLineMachine` — بنفس الصلاحيات
  (`cut.edit`) ونفس الـ actions، بلا نظام طوابير موازٍ، وبمفتاح idempotency.
- إغلاق الألواح المقطوعة يبقى كما هو (`SheetCutLog`)، وتسجيل الإنتاج عملية مستقلة.

## 5. التصدير

- Post-processors كـ registry (`EXPORT_PROFILES`): DXF R2000 mm مهيأ ومتحقق منه الآن. لكل
  ماكينة يُضاف profile فقط عند توفر مواصفة الكنترول وعينة برنامج صحيحة، مع اختبار يقارن الخرج
  بالعينة.
- حزمة التصدير: DXF + ورقة تشغيل + كشف قطع + معرف NestingRun وإصداره.

## 6. الواجهة

- تاب جديد في `lib/domain/tabs.ts` (مجموعة Production) بصلاحية `nesting.*` في
  `lib/domain/permissions.ts`؛ المكونات المشتركة (`DataTable`، `primitives`، `Modal`) بدل
  CSS النموذج؛ النيستينج الطويل في background job (Vercel: route handler + `after()`/queue)
  مع الحالات Queued/Running/Completed/Failed/Cancelled؛ المعاينة SVG نفسها (`sheetSvg`/`SheetView`).

## 7. الـ AI assistant

أدوات في `lib/server/ai/tools/` تستدعي نفس الـ backend: `get_drawings`, `get_part_requirements`,
`preview_nesting` (تشغيل + تقرير مختصر: عدد الألواح، الاستغلال، غير الموزّع وأسبابه)،
`suggest_machines`, `propose_nesting_jobs` (معاينة/اعتماد عبر آلية AiAction الحالية). لا تُرسل
ملفات CAD كاملة كنص؛ تُرسل بيانات هندسية مختصرة. الحساب الهندسي كله بالمحرك.

## 8. ما يحتاج قرارًا منك قبل الدمج

- أي Layers تُعدّ علامات (مثل `02___PRT_ALL_AXES`) كقاعدة افتراضية للمصنع.
- مصدر الحقيقة لكمية كل قطعة لكل وحدة (BOM في Odoo؟ ملف؟ إدخال يدوي؟).
- قيم bed/thickness/materials لكل ماكينة، ومواصفة كنترول كل ليزر + عينة برنامج.
- سياسة الفضلات: من يعتمد ما هو قطعة وما هو هالك في ملفات common-line cut.
