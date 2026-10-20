# 109: قراءة الزائر لوضع التسجيل — مراجعة قبل التطبيق في الإنتاج

**الحالة:** منفَّذ ومختبَر في المستودع. **غير مطبَّق في الإنتاج**، وينتظر موافقة المالك.

**الملفات:**
- `migrations/109_registration_mode_public_read.sql`
- `migrations/_rollback/109_registration_mode_public_read.down.sql`
- `assets/js/registration-mode.js`
- `login.html`
- `tests/sql/registration-mode-public-read.test.sql`
- `tests/registration-mode.test.mjs`
- `tests/login-registration-mode.render.test.mjs`
- `tests/company-navigation.test.mjs` (ترتيب الترحيلات)

## 1) السبب الجذري

مُثبت في الإنتاج في 2026-10-20 بقراءة فقط: صفحة الدخول الحقيقية على القاعدة الحقيقية، بلا أي إرسال.

| # | الحلقة | الحقيقة |
|---|---|---|
| 1 | `login.html` تقرأ `advanced_settings` حيث `key = 'registration_mode'` بمفتاح الزائر (`anon`) | الطلب يعود `401` برسالة `42501 permission denied for function has_elevated_authority` |
| 2 | على `advanced_settings` سياستان SELECT متساهلتان، ويقيّم Postgres كل سياسة تنطبق على الدور | `advanced_settings_public_read_registration_mode` من 004 (`anon, authenticated`)، **و** `Admins can manage advanced_settings` (`FOR ALL TO public`، فتشمل `anon`) |
| 3 | شرط سياسة الإدارة `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')` | قراءة `profiles` تخضع لـ `profiles_select_policy`، وهي تنادي `has_elevated_authority()` |
| 4 | `has_elevated_authority()` مسحوبة من `anon` منذ 038 و040، وهذا **صحيح ويبقى** | فيفشل الاستعلام كله بخطأ صلاحية، ولا يعود صفر صفوف |
| 5 | `login.html` كانت تعتبر **أي** فشل `mode: 'open'` | الزائر يرى «إنشاء حساب جديد / إنشاء الحساب» والإعداد `waitlist` |
| 6 | الحساب المنشأ يُلتقط على الخادم: 066 يضيفه للقائمة، و`my_account_gate` تحجبه بحالة `waiting_approval` | الضرر في الواجهة ورسالة التسجيل، لا في الحماية. لكن الزائر يُنشئ حسابًا لم يُعرض عليه أنه قائمة انتظار |

**ما ليس جزءًا من العطل:**
- `waitlist_entries_anon_insert` (من 004) سياسة INSERT لـ `anon` وحده، ولا تقرأ `profiles`. إدراج الانتظار يعمل للزائر.
- `my_account_gate()` دالة بامتياز المالك (definer)، تقرأ الإعداد بنجاح للمستخدم المسجَّل.

## 2) الإصلاح

### الترحيل `109_registration_mode_public_read.sql`

يتكوّن من فحص مسبق للشكل المتوقع، ثم ثلاثة أجزاء، في معاملة واحدة، وقابل لإعادة التشغيل:

```sql
-- ① سياسة الإدارة لـ authenticated وحده؛ شرطها لم يتغيّر حرفيًا
alter policy "Admins can manage advanced_settings" on public.advanced_settings to authenticated;

-- ② قائمة سماح من ثلاثة حقول عامة؛ mode خارج ('open','waitlist') ⇒ null؛ الصف الغائب ⇒ null
create or replace function public.get_public_registration_settings()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
           'mode', case when s.value->>'mode' in ('open', 'waitlist') then s.value->>'mode' end,
           'waitlist_message', s.value->>'waitlist_message',
           'expected_launch_date', s.value->>'expected_launch_date')
    from public.advanced_settings s
   where s.key = 'registration_mode';
$$;
revoke all on function public.get_public_registration_settings() from public;
grant execute on function public.get_public_registration_settings() to anon, authenticated, service_role;

-- ③ الزائر لا يملك على الجدول إلا SELECT
revoke insert, update, delete, truncate, references, trigger on public.advanced_settings from anon;
```

### الواجهة

**`assets/js/registration-mode.js`:** قرار خالص بلا DOM ولا شبكة:
- `open` و`waitlist` فقط من القاعدة.
- أي خطأ، أو رد فارغ، أو قيمة غير معروفة، أو مهلة منتهية، تعني `unavailable`. **لا تعني `open` أبدًا.**
- الموعد الغائب يُعرض «سيُعلَن قريبًا». أُزيل الموعد الاحتياطي الثابت «أكتوبر 2026».

**`login.html`:**
- تنادي `get_public_registration_settings()` بدل قراءة الجدول.
- زر الإرسال معطّل بنص «جارٍ التحقق من حالة التسجيل…» حتى يصل القرار.
- **`unavailable`:** عنوان «التسجيل غير متاح مؤقتًا»، ويُخفى النموذج وأزرار التسجيل عبر Google وGitHub وPi، ويظهر زر «إعادة المحاولة».
- **معالج الإرسال** يرفض أي إرسال بلا وضع مؤكد، حتى لو استُدعي برمجيًا متجاوزًا الواجهة المخفية.

## 3) نتائج الاختبارات

نُفِّذت في هذه الجلسة على 2026-10-20.

| الحزمة | النتيجة |
|---|---|
| `tests/sql/registration-mode-public-read.test.sql` | **كل المجموعات ناجحة (11).** ⓪ العطل مُعاد إنتاجه قبل 109، ①ب التراجع يعيد الشكل والعطل، ①ج التطبيق مرتين |
| كل حزمة SQL (`tests/run-sql-tests.sh`) | **78 ملفًا ناجحًا**، رمز الخروج 0، في 4 دقائق و55 ثانية |
| `tests/registration-mode.test.mjs` | **7/7** |
| `tests/login-registration-mode.render.test.mjs` (Chromium) | **8/8**. على `login.html` القديمة: **0/8** |
| كل حزمة Node | انظر خلاصة المراجعة |

**تغطية المطلوب:**

| المطلوب | أين يُقاس |
|---|---|
| الزائر يقرأ الإعداد العام وحده | SQL ②: صف واحد فقط، والإعداد الخاص صفر، والدالة تعيد 3 مفاتيح بلا تسريب |
| الزائر لا يقرأ ولا يعدّل الإعدادات الخاصة ولا `profiles` | SQL ②③: تحديث وإدراج وحذف وتفريغ كلها `42501`، والقيمة سليمة، ولا صفوف `profiles` |
| الزائر لا ينفّذ دوال الإدارة | SQL ③: `has_elevated_authority` و`is_admin` و`my_account_gate` كلها `42501`، ولا منحة جديدة |
| المستخدم العادي لا يعدّل الإعدادات | SQL ④: تحديث وحذف = 0 صفوف، وإدراج = `42501` |
| الأدمن يدير الإعدادات | SQL ⑤: يرى ويضيف ويعدّل ويحذف |
| `waitlist` و`open` يعطيان الواجهة الصحيحة | Render 1 و2: العنوان والزر والإدراج أو `signUp` الصحيح |
| الفشل لا يفتح التسجيل | Render 3 إلى 7 (`42501`، شبكة، `null`، قيمة غير صالحة، قيمة مجهولة)، والوحدة 3 و4. لا `signUp` ولا إدراج حتى بإرسال قسري |
| البوابة بعد الدخول | SQL ⑦: الحساب الجديد `waiting_approval` بالموعد والرسالة، والأدمن `active` |
| نموذج الانتظار يعمل للزائر | SQL ③: إدراج `pending` ينجح، و`approved` مرفوض، ولا قراءة للقائمة |

## 4) الأثر الأمني

- **لا صلاحية جديدة على أي دالة مميزة:**
  - `has_elevated_authority` و`is_admin` و`my_account_gate` تبقى ممنوعة على `anon`.
  - `profiles` وسياساته بلا تغيير.
- **سياسة الإدارة:** الزائر لا يملك `auth.uid()`، فلم يكن يطابق شرطها أصلًا. قصرها على `authenticated` لا يسحب صلاحية شرعية من أحد، والشرط للمستخدم المسجَّل حرفيًا كما هو.
- **الدالة الجديدة `get_public_registration_settings`:**
  - بامتياز المالك (definer)، ومسار بحث ثابت، وبلا معاملات، فلا مدخلات قابلة للحقن.
  - تقرأ صفًا واحدًا وتعيد ثلاثة حقول **معروضة للزائر أصلًا** على الصفحة.
  - لا تعيد أي حقل يضاف لاحقًا إلى هذا الصف دون تعديل صريح للدالة.
- **سحب صلاحيات الكتابة من `anon`:**
  - كانت شكلية، فلا توجد سياسة تسمح بها.
  - `TRUNCATE` لا تخضع لـ RLS، فسحبها يغلق مسارًا نظريًا.
  - `SELECT` يبقى للتوافق.
- **ما يبقى مكشوفًا عمدًا:**
  - سياسة 004 للقراءة العامة تبقى، حتى تعمل `login.html` المنشورة حاليًا فور تطبيق الترحيل.
  - ستكشف كامل `value` لصف `registration_mode`، وهو اليوم ثلاثة حقول عامة فقط.
  - **متابعة مقترحة (ليست في 109):** حذف تلك السياسة بعد نشر الواجهة الجديدة، فلا يبقى للزائر إلا الدالة.
- **تغيّر سلوكي للزوار بعد التطبيق:** ما دام الإعداد `waitlist`، سيرى الزائر نموذج «الانضمام لقائمة الانتظار». يتوقف إنشاء الحسابات بالبريد مباشرة من النموذج. أزرار التسجيل عبر Google وGitHub وPi تبقى في وضع الانتظار كما كانت، وتلتقطها البوابة و066 على الخادم.
- **الحماية الحقيقية لا تزال على الخادم:** `my_account_gate` و066 والسياسات المقيِّدة من 042. الواجهة لا تقرّر الصلاحية، بل تعرض الوضع الصحيح ولا تفتح التسجيل عند الشك.

## 5) ترتيب النشر

1. **تطبيق 109 في الإنتاج**، بموافقة المالك:
   - الطريقة: `apply_migration` أو محرر SQL. الملف لا يحتوي `DROP`.
   - ثم تسجيله في `supabase_migrations.schema_migrations`.
   - **أثر فوري:** `login.html` المنشورة حاليًا تقرأ الجدول بنجاح وتعرض نموذج الانتظار.
2. **التحقق بعد التطبيق، قراءة فقط:**
   - طلب الزائر إلى `advanced_settings?key=eq.registration_mode` يعود 200 بصف واحد.
   - النداء `rpc/get_public_registration_settings` يعيد الحقول الثلاثة.
   - الصفحة الحية تعرض «الانضمام لقائمة الانتظار».
3. **نشر الواجهة:** دمج الفرع في `main` (Vercel).
   - العكس آمن: الواجهة الجديدة قبل الترحيل تعرض «التسجيل غير متاح مؤقتًا» ولا تسجّل أحدًا، لكنه يوقف التسجيل حتى يُطبَّق الترحيل. لذلك الترحيل أولًا.
4. **(اختياري لاحقًا)** ترحيل يحذف `advanced_settings_public_read_registration_mode`.

**ترقيم الترحيلات:** الرقم 108 محجوز لفرع `claude/dazzling-hypatia-lh1o9i` (PR #143، غير مطبَّق في الإنتاج). لا تداخل في الكائنات. اختبار `tests/company-navigation.test.mjs` يثبّت آخر ترحيل، وأيهما دُمج ثانيًا يحتاج تحديث السطر نفسه.

## 6) خطة التراجع

**ملف التراجع:** `migrations/_rollback/109_registration_mode_public_read.down.sql`. يفعل ثلاثة أشياء:
- يعيد السياسة إلى `public`.
- يحذف الدالة.
- يعيد صلاحيات `anon` كما كانت.

**مُختبَر:** بصمة المخطط مطابقة لما قبل 109، والعطل يعود كما كان.

**الترتيب عند التراجع:** أرجِع الواجهة أولًا (revert للـ commit)، ثم شغّل ملف التراجع. وإلا عرضت الواجهة الجديدة «غير متاح مؤقتًا»، وهي حالة آمنة ولا تفتح التسجيل.

## 7) حالة الإنتاج

**في هذه المهمة: لم يُغيَّر شيء في الإنتاج.** التحقق بقراءة فقط في 2026-10-20 الساعة 13:34 بتوقيت UTC:

| البند | القيمة |
|---|---|
| السياسة | `Admins can manage advanced_settings` ما زالت `{public}` |
| الدالة | `get_public_registration_settings` غير موجودة |
| صلاحية `TRUNCATE` لـ `anon` على الجدول | ما زالت ممنوحة |
| آخر ترحيل في السجل | `107_isolation_readiness` |
| الإعداد | `mode = waitlist`، و`expected_launch_date = يناير 2027`، ونص الرسالة بلا تغيير |

**التعديل الوحيد على الإنتاج في هذه الجلسة كلها:** قبل هذه المهمة، وبموافقة صريحة، `expected_launch_date` من «أكتوبر 2026» إلى «يناير 2027» في 2026-10-20 الساعة 12:54:18 بتوقيت UTC. لم يُنشأ أي حساب ولا أي طلب انتظار حقيقي.
