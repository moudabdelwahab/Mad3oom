# تثبيت طلبات حساب الشركة (068) على Production — 2026-10-09

الهدف: «فرد أم شركة؟» عند «اشترك الآن»، وحساب الشركة لا يتكوّن إلا بموافقة الإدارة.
المشروع: `srnelrdpqkcntbgudyto`. الملف: `migrations/068_company_account_requests.sql`
(md5 `c9fabd071894c35ccf923f0c8f622676`) كما هو، بدون أي تعديل. الموافقة: «طبق التعديل علي قاعدة
بيانات الانتاج».

## BEFORE (قراءة فقط)

- آخر migration مسجّل: `20261008185130 067_conversation_core_gate` — 344 صف في السجل.
- بصمات الدوال اللي 068 بيلمسها أو بيعتمد عليها **مطابقة حرفيًا** لنسخة `tests/fixtures/prod-shape`
  اللي الاختبارات اشتغلت عليها (md5 لـ `pg_get_functiondef`):
  `guard_profile_role_change d6daacea…`، `upsert_my_company fb87ca74…`، و `sync_company_owner_role`،
  `sync_company_role`، `owns_a_company`، `belongs_to_a_company`، `account_is_active`، `is_admin`،
  `guard_preview_read_only`، `current_company_id`، `link_subscription_to_my_company`.
- سياسات `companies`: الأربعة المتوقعة (منها `Users can insert their own company`). لا جدول
  `company_account_requests`. لا أقفال exclusive ولا معاملات طويلة.
- البيانات: 39 مستخدم، 1 شركة، 0 company_admin، 1 company_user، 1966 إشعار، 395 سياسة.

## APPLIED

| الطريقة | الوقت (UTC) | النتيجة |
|---|---|---|
| SQL Editor (المالك) — الملف كامل | 2026-10-09 06:22:30 | «Success. No rows returned» |

مثبت في `postgres_logs` (`statement: -- 068_company_account_requests.sql …`، `source: dashboard`)، ومعاه
`rls_auto_enable: enabled RLS on public.company_account_requests` (الـ RLS مفعّل أصلًا في الملف).

محاولات قبلها من غير أي أثر (اتأكد بعد كل واحدة إن مفيش جدول ولا دالة ولا تغيير):
- `apply_migration` و `execute_sql` (الملف كامل، ثم جزء أول منه) انتهت مهلتها 60 ثانية.
- السبب متثبت: أداة Supabase بتوقف أي نص فيه `DROP` لتأكيد ما بيظهرش في الجلسة — حتى
  `drop table if exists pg_temp.<غير موجود>` انتهت مهلته. الملف محتاج `DROP POLICY` لقفل الإنشاء
  الذاتي، فاتطبّق من SQL Editor زي 064/067، من غير أي تحايل على التأكيد.

**السجل (`schema_migrations`)**: لسه مش متسجّل — نفس السبب (النص المخزّن نفسه فيه `DROP`).
`scripts/ledger/register_068.sql` جاهز بنفس شكل `register_064_067.sql`: صف واحد
`20261009062230 / 068_company_account_requests`، بيتضاف بس لو md5 النص = md5 الملف، ومتحقق في الآخر.
يتشغّل من SQL Editor.

## VERIFIED

**تطابق الكائنات** مع نفس الملف متطبّق محليًا على `prod-shape`:

- الدوال الست الجديدة/المعدّلة — **md5 مطابق**:
  `submit_company_account_request 7d4e444c…`، `my_company_account_request 91666c39…`،
  `admin_list_company_account_requests 4ae5f257…`، `admin_review_company_account_request 5db2500f…`،
  `guard_profile_role_change 5a2dc72f…`، `upsert_my_company 899a06ab…`.
  والتسع اللي مالهاش دعوة بالتغيير بصمتها زي ما هي.
- `company_account_requests`: 8 قيود (PK، 3 FK، 4 CHECK)، 3 فهارس (منها الفريد الجزئي
  `one_pending`)، RLS مفعّل، سياسة واحدة `select_own` (SELECT، authenticated، `user_id = auth.uid()`)،
  محفّز `trg_preview_read_only`.
- الصلاحيات: `anon` مالوش أي حاجة على الجدول ولا الدوال. `authenticated`: SELECT بس على الجدول،
  وتنفيذ الدوال الخمس العامة. `guard_profile_role_change` مش متاحة لحد.
- `companies`: 3 سياسات (سياسة الإدراج الذاتي اتشالت). إجمالي السياسات 395 (−1 +1).
- البيانات زي ما هي: 39 / 1 شركة / 1966 إشعار، ولا صف في الطلبات.

**السلوك على Production** (`scripts/prod-smoke/company-account-requests.sql`، 06:30 UTC) — معاملة واحدة
بحسابات اصطناعية وبترجع كلها — **11/11 PASS**:

| البند | الفحص |
|---|---|
| SETUP | عميل اصطناعي نشط في البوابة، ومالوش طلب |
| C1a | `upsert_my_company` بترفض الإنشاء برسالة الطلب، والإدراج المباشر في `companies` ⇒ 42501 |
| C1b | الطلب بيتسجّل `pending` والحساب لسه فرد |
| C1c | طلب تاني وهو عنده طلب قيد المراجعة ⇒ مرفوض |
| C1d | تعديل حالة الطلب مباشرةً ⇒ 42501، دالة الإدارة ⇒ 42501، بيشوف صفه بس |
| C1e | رقم سجل محجوز بطلب عميل تاني ⇒ مرفوض |
| C2a | الأدمن بيشوف الطلب في القائمة واتخطر بإشعار |
| C2b | منح دور شركة يدويًا حتى من الأدمن ⇒ 42501 |
| C2c | الموافقة ⇒ شركة ببيانات الطلب، `company_admin` بالاشتقاق ومتسجّل في `privileged_audit` باسم الأدمن، `user_type = company`، إخطار العميل بإكمال الاشتراك |
| C2d | الرفض من غير سبب ⇒ مرفوض؛ بسبب ⇒ الحساب ماتغيّرش والسبب وصل للعميل |
| C3 | الحساب المعتمد شركة لكل دوال الشركة، ومايقدرش يطلب تاني |

بعد الفحص: نفس الأعداد بالظبط (39 مستخدم/39 بروفايل/1 شركة/0 طلبات/1966 إشعار/15 قائمة انتظار/
16 تدقيق/39 SIE)، `ticket_number_seq` = 1118، مفيش حسابات `company-smoke-*`، طابور pg_net فاضي،
مفيش معاملات معلّقة.

**Logs** (06:20 → 06:31): مفيش أخطاء. الموجود: نص الـ migration نفسه، ورسالة `COMPANY_SMOKE_RESULT`
المقصودة.

## TESTS

- `tests/run-sql-tests.sh`: 41 ملف، exit 0، منهم `company-account-requests.test.sql` (الخلل قبل 068
  متثبت، المسار كامل، العزل، الحرّاس، التراجع وإعادة التطبيق).
- `npm run test:node`: 839 اختبار، 37 فشل — نفس مجموعة الفشل بالظبط قبل التغيير (صفحة الشات
  وويدجت الشات)، و 10 اختبارات متصفح جديدة لنافذة «فرد أم شركة؟» وصفحة الإدارة كلها PASS.

## PRODUCTION IMPACT

- مفيش بيانات عملاء اتعدّلت. الشركة الوحيدة الموجودة وأعضاؤها زي ما هم.
- الواجهة الحالية على `main` لسه بتنادي `upsert_my_company` لإنشاء شركة: بدل خطأ
  «لا يمكنك تغيير صلاحية حسابك بنفسك» (المسار كان معطوب أصلًا) هتظهر «إنشاء حساب شركة يتم بطلب
  يراجعه فريق الإدارة». الواجهة الجديدة (PR #102) هي اللي بتسأل «فرد أم شركة؟» وبتبعت الطلب.
- تعديل مالك شركة قائمة لبياناتها من لوحة الشركة شغال زي ما هو.

## ROLLBACK

`migrations/_rollback/068_company_account_requests.down.sql` في معاملة واحدة: بيرجّع نص الإنتاج
الأصلي لـ `guard_profile_role_change` و `upsert_my_company` وسياسة الإدراج، وبيشيل الجدول والدوال.
مابيمسحش الشركات اللي اتوافق عليها. متجرّب على النسخة المطابقة (RB1/RB2). مش مطلوب دلوقتي.

## FINAL STATE

```
068 installed      = YES (SQL Editor, 06:22:30 UTC)
068 in ledger      = NO  (register_068.sql جاهز)
Customer data      = unchanged
New UI live        = NO  (PR #102 لسه ما اندمجش)
```
