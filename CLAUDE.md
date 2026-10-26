@AGENTS.md

# تعليمات العمل على الريبو ده — تنطبق على كل جلسة جديدة

التطبيق ده بيستخدمه مصنع حقيقي (ATC) كل يوم. أي تعديل بيتعمله merge على `master`
بيروح للإنتاج على Vercel علطول، والـ build بيشغّل `prisma migrate deploy` على
قاعدة البيانات الحية. فالسرعة عمرها ما تيجي على حساب الصحة.

## 1. اللغة

- **كلامك معايا في الشات بالعربي** (مصري مفهوم). المصطلحات التقنية وأسماء الملفات
  والدوال والجداول تفضل بالإنجليزي زي ما هي.
- **نصوص الواجهة** تفضل بنفس لغة التطبيق الحالية (إنجليزي، `lang="en"` في
  `app/layout.tsx`)، إلا لو طلبت غير كده صراحةً.
- رسائل الـ commit وعنوان ووصف الـ PR والتعليقات جوه الكود بالإنجليزي، بنفس أسلوب
  الـ commits اللي في `git log`: عنوان بيوصف النتيجة اللي المستخدم هيشوفها،
  وتحته فقرة بتشرح إيه اللي اتغير، ولو فيه migration تتكتب باسمها.

## 2. الـ merge تلقائي، من غير ما ترجع تسألني

عندك إذن دائم إنك تعمل merge لأي تعديل تخلّصه. **متسألنيش "أعمل merge؟"**. اتبع
الخطوات دي بالترتيب، ومتعديش خطوة:

1. **قبل ما تبدأ:** `git fetch origin master`. لو الـ PR بتاع الـ branch اللي
   شغال عليه اتعمله merge قبل كده، ابدأ الـ branch من جديد من `origin/master`
   بنفس الاسم، ومتحطش commits جديدة فوق تاريخ اتعمله merge خلاص.
2. **اتأكد إن الكود سليم على جهازك قبل الـ push.** دي نفس الأوامر اللي الـ CI
   بيشغّلها (`.github/workflows/ci.yml`):
   ```bash
   npm ci            # لو node_modules مش موجودة
   npx prisma generate
   npm run lint
   npm run typecheck
   npm run test:run
   ```
   لو أي أمر فشل، صلّحه الأول. ممنوع تعمل skip أو disable لأي test عشان يعدّي.
3. **راجع الـ diff بتاعك بعين ناقدة** على الأقل مرة: bugs، null cases، صلاحيات،
   أماكن تانية نسيتها (شوف القسم 3). المراجعة دي بتتعمل بالـ skills والـ agents
   اللي في القسم 6، مش بالعين بس.
4. اعمل **commit** و**push** على الـ branch المحدد للجلسة.
5. افتح **PR على `master`** (`mcp__github__create_pull_request`)، وخلّي العنوان
   هو عنوان الـ commit.
6. **استنى الـ CI** (`Lint, types and tests`) لحد ما يبقى أخضر على آخر commit.
   اعمل subscribe على الـ PR (`subscribe_pr_activity`) ومتعملش polling بـ
   `sleep`. لو الـ CI طلع أحمر، صلّح واعمل push تاني، وكرر لحد ما يخضر.
   **عمرك ما تعمل merge لـ PR الـ CI بتاعه أحمر أو لسه شغال.**
   كل تشغيلة بتصرف من دقايق الـ Actions الشهرية: متعملش push غير لما الفحوصات
   المحلية تعدّي، وجمّع التصليحات في push واحد.
7. **اعمل merge بطريقة squash** (`mcp__github__merge_pull_request` مع
   `merge_method: "squash"`)، بنفس عنوان ووصف الـ commit. ده نفس اللي بيحصل
   مع كل الـ PRs اللي فاتت.
8. بعد الـ merge قولّي بالعربي في سطور قليلة: إيه اللي اتغير، فين في التطبيق،
   الأماكن اللي طبّقت فيها نفس التعديل (القسم 3)، ولينك الـ PR.

### استثناءات: هنا بس توقف وتسألني قبل الـ merge
- migration بتمسح أو بتغيّر بيانات موجودة: `DROP TABLE`/`DROP COLUMN`، أو
  rename لعمود فيه بيانات، أو `DELETE`/`UPDATE` على بيانات حقيقية، أو تغيير نوع
  عمود ممكن يضيّع بيانات. (migration بتضيف حاجة بس، زي جدول أو عمود nullable أو
  عمود بـ default أو index، عادي تعمل merge علطول.)
- تغيير في منطق تسجيل الدخول أو الصلاحيات بيوسّع صلاحيات حد
  (`lib/server/auth.ts`، `lib/domain/permissions.ts`).
- تغيير في أي حاجة ليها علاقة بالـ secrets.
- لو الطلب نفسه مش واضح. وقتها اسأل **قبل ما تبدأ تنفّذ**، مش قبل الـ merge.

## 3. أي تعديل يتطبّق في كل مكان يخصه، مش في مكان واحد

ممنوع تصلّح حاجة في شاشة وتسيب نفس الحاجة غلط في شاشة تانية. قبل ما تعتبر
التعديل خلص:

1. **دوّر على كل الأماكن اللي بتستخدم نفس الحاجة** بـ Grep: نفس الـ component،
   ونفس الـ CSS class، ونفس الدالة في `lib/domain`، ونفس اسم العمود أو الحقل،
   ونفس النص أو الـ label. وطبّق التعديل عليهم كلهم.
2. **راجع الأسطح دي لكل feature:**
   - كل الأقسام اللي بيمسّها التعديل: Cut / Welding / Painting / Oven، وخطوط
     المنتجات (Tank, Top Cover, Core Frame, Cable Box, ...)، وشاشات LV (`app/lv`،
     `components/Lv*`). لو التعديل في worklist قسم، شوف هل نفس الكلام ينفع في
     باقي الأقسام.
   - الموبايل: الـ drawer في `components/AppNav.tsx`، والشاشات تحت 640px.
   - الطباعة والتصدير: `PrintHeader`، `PrintButton`، `ExportButton`، `AiPrint`.
   - الـ AI assistant: الأدوات في `lib/server/ai/`. لو أضفت أو غيّرت action أو
     حقل، الـ assistant لازم يعرفه هو كمان، وشغّل `npm run ai:schema` لو الـ
     schema اتغيّرت.
   - الصلاحيات والتابات: `lib/domain/permissions.ts` و`lib/domain/tabs.ts`.
   - الـ automations والـ events (`lib/domain/appEvents.ts`) لو فيه action جديدة
     المستخدم بيعملها.
   - **What's new**: أي تغيير المستخدم هيلاحظه يتضاف له entry في **أول**
     `WHATS_NEW` في `lib/domain/whatsNew.ts`، بـ `id` جديد عمره ما اتستخدم.
   - `README.md` لو الـ feature موصوفة فيه.
3. **الـ tests:** أي منطق جديد أو متغيّر في `lib/domain` يتكتب أو يتعدّل له test في
   الـ `*.test.ts` اللي جنبه.
4. في رسالتك الأخيرة اذكر الأماكن اللي طبّقت فيها التعديل، والأماكن اللي قررت
   متطبقهوش فيها وليه.

## 4. الشكل والواجهة

الشكل جزء من الشغل مش حاجة إضافية. التطبيق ليه design system واحد، والتزم بيه:

- **استخدم المكونات المشتركة** ومتعملش نسخة جديدة منها:
  - `components/primitives.tsx`: `EmptyState`، `Switch`، `Tabs`، `SettingRow`،
    `SectionCard`، `Note`
  - `components/DataTable.tsx`: `TableFrame`، `Th`، `GroupBand`، `CellEditor`،
    `useConfirm`/`ConfirmDialog`، `useAsk`، `TableEmpty`، `ErrorState`
  - `components/Modal.tsx`، `components/Badge.tsx`، `components/Tooltip.tsx`،
    `components/ViewTabs.tsx`
  - رأس الصفحة: `.page-head` / `.page-title` / `.page-sub`
- **الألوان والمسافات من الـ tokens اللي في `app/globals.css` بس:** `--sp-*`،
  `--fs-*`، `--r-*`، `--brand*`، `--surface*`، `--ok/warn/bad-*`، `--prod-*`،
  `--viz-*`. ممنوع hex مكتوب مباشرة في الـ components، وممنوع `style={{}}` لحاجة
  ليها token أو class.
- **الثيم الفاتح والغامق (`html.dark`) الاتنين** لازم يبانوا صح. أي لون جديد يتعرف
  كـ token في الاتنين.
- **استغل مساحة الشاشة:**
  - الجداول والداشبوردات تاخد عرض الصفحة كله. متحطهاش في عمود ضيق في النص
    وفراغ على الجنبين في الشاشات العريضة.
  - الكروت والـ KPIs في grid بيتوزع على العرض المتاح (`auto-fit` / `minmax`)،
    مش عمود واحد طويل.
  - متسيبش padding أو margins كبيرة من غير سبب، ولا فراغ ميت بين الأقسام. خلّي
    البيانات كثيفة ومقروءة: `--fs-body` (13px) هو أصغر مقاس للبيانات.
  - الفلاتر والأزرار في toolbar واحد بيعمل wrap، مش كل واحد في سطر لوحده.
- **المحاذاة والاتساق:** نفس نوع العنصر بنفس الشكل والمقاس والمكان في كل
  الشاشات: الأزرار، والـ badges، والأرقام (محاذاة ومقاس ثابتين)، والتواريخ
  (بالتنسيق اللي في `lib/domain/format.ts` و`dates.ts`).
- **الريسبونسيف:** جرّب على تلات مقاسات: موبايل (≤639px)، ولابتوب، وشاشة عريضة
  (≥1600px). مينفعش يبقى فيه scroll أفقي للصفحة كلها على الموبايل؛ الجداول العريضة
  تعمل scroll جوه الـ `TableFrame` بتاعها.
- **الحالات كلها:** loading (`TableSkeleton` / `app/loading.tsx`)، ومفيش بيانات
  (`EmptyState` / `TableEmpty`)، وخطأ (`ErrorState`)، وفلتر مرجّعش نتايج.
- لو تقدر تشغّل التطبيق، شوف التعديل بعينك (screenshot بـ Playwright و Chromium
  الموجود في البيئة). لو مش قادر (مثلًا مفيش `DATABASE_URL`)، قولّي إنك متأكدتش
  منه بالشكل.

## 5. جودة الكود

- المنطق الصافي في `lib/domain/*` (من غير I/O، وليه tests)، والوصول للداتا في
  `lib/server/*` (`server-only`)، والصفحات والـ server actions في `app/*`،
  والواجهة المشتركة في `components/*`.
- أي action بتكتب في الداتا: تتأكد من الصلاحية على الـ server، وتعمل validate
  للمدخلات، وتستخدم transaction لما فيه أكتر من كتابة مرتبطين ببعض.
- أي تغيير في `prisma/schema.prisma` ليه migration في `prisma/migrations/` باسم
  بتاريخ ووقت، بنفس أسلوب الموجود.
- متسيبش TODO ولا كود placeholder.

## 6. استخدم الـ plugins والـ skills في المراجعة وتحسين الواجهة

الـ plugins والـ skills دي متاحة في كل جلسة من حساب claude.ai. استخدمها من نفسك
في الخطوات دي من غير ما أطلبها، وقبل الـ commit (القسم 2، خطوة 3):

**مراجعة الكود — لكل تعديل في الكود:**
1. `/code-review` (الـ skill `code-review`) على الـ diff، وصلّح كل finding حقيقي.
2. لو التعديل أكبر من تصليح صغير (أكتر من ملف، أو server action، أو schema، أو
   صلاحيات): شغّل الـ agents دي **مع بعض في رسالة واحدة** على الـ diff:
   `review-council:correctness-reviewer`، `review-council:security-reviewer`،
   `review-council:architecture-reviewer`، `review-council:test-evidence-reviewer`،
   `review-council:policy-boundary-reviewer` (ده بيراجع الـ diff على الـ CLAUDE.md ده)،
   و`review-council:interface-reviewer` لو فيه تغيير في API أو schema أو export.
3. `/security-review` لو التعديل بيمس `lib/server/auth.ts` أو
   `lib/domain/permissions.ts` أو server action بتكتب داتا أو input جاي من المستخدم.
4. `/simplify` في الآخر على الكود اللي اتغيّر (تكرار، تبسيط، كفاءة).
5. لو طلبت audit شامل للريبو أو لجزء كبير منه: `finecomb:finecomb`.

**الواجهة — لأي تعديل في `app/*` أو `components/*` أو `app/globals.css`:**
1. قبل التصميم: `frontend-design:frontend-design`، في حدود الـ design system اللي
   في القسم 4 (مش بدله).
2. `design:design-system` على الملفات اللي اتغيّرت: hex مكتوب مباشرة، tokens
   ناقصة، component اتعمل له نسخة جديدة بدل المشترك.
3. `a11y-enforcer:a11y-check` على الملفات اللي اتغيّرت، و`a11y-enforcer:contrast`
   لأي لون جديد في الثيم الفاتح والغامق الاتنين.
4. `design:ux-copy` لأي نص جديد: زرار، رسالة خطأ، empty state، confirm dialog.
5. لو تقدر تشغّل التطبيق: `/run` وخد screenshots بالتلات مقاسات اللي في القسم 4،
   وبعدها `design:design-critique` على الـ screenshots، وصلّح اللي يطلع.

**القواعد:**
- الـ finding ادعاء لازم تتأكد منه، مش أمر. صلّح اللي ليه مسار حقيقي يوصّل للمشكلة،
  واللي مش حقيقي اذكره وقول ليه سبته.
- لو skill أو agent مش متاح في الجلسة، أو فشل، كمّل بالمراجعة اليدوية وقولّي
  في الرسالة الأخيرة إنه مااشتغلش. متوقفش الشغل عشانه.
- في رسالتك الأخيرة اذكر الـ skills والـ agents اللي شغّلتها، وأهم اللي طلع منها
  واتصلّح.
