# التصميم المعماري — وحدة الموارد البشرية والإدارة المؤسسية في مدعوم (HR)

**الحالة:** تصميم فقط (Step B) — لا كود، لا SQL ترحيل، لا كود واجهة.
**التاريخ:** 25 نوفمبر 2026
**الأساس:** تقرير المراجعة الإلزامي للمرحلة الأولى `HR-audit-report-2026-11-25.md` + تقارير المسارات الثلاثة التفصيلية في `hidden_files/` + قرارات محمود الملزمة بتاريخ 2026-11-25 ~23:54 EET.
**خط الأساس:** المستودع على `main` عند `4897b72`؛ فرع العمل `hr-module` (worktree `~/workspace/Mad3oom-hr-module`).
**الترحيل المقصود:** `143_hr_module_phase2_employees.sql` (انظر §0.3 — الرقم 142 محجوز).

---

## 0. ملاحظات تصحيحية على تقرير التدقيق (قبل القراءة)

هذه الوثيقة متسقة مع تقرير التدقيق، وفيما يلي مواضع صحّحتُ فيها التقرير أو دقّقتُه — أي موضع آخر لم يُذكر هنا فهو كما ورد في التقرير:

1. **رقم الترحيل: 143 لا 142.** الرقم 142 مستخدم بالفعل في فرعين غير مدمجين (`142_trial_request_notification.sql` و`142_ultimate_cancel_refund.sql`). ترحيل HR للمرحلة 2 هو **`143_hr_module_phase2_employees.sql`**. أي إشارة في تقرير التدقيق إلى «ترحيل 142» تُقرأ 143.
2. **حالة الترحيلات 136–141 حيًا:** التقرير قال إنها «غير مطبقة حيًا (مؤكد)» وقت كتابته (~22:30 EET). **طُبّقت حيًا لاحقًا في 2026-11-25 ~23:10 EET** (136: 33/33، 137: 30/30، 138: 38/38، 139: 22/22، 140: 24/24، 141: 55 في معاملة واحدة، كلها بفحوصات ذاتية + تحقق حي مستقل). هذا التصميم يفترض أنها مطبقة، لكن **خطوة خط الأساس (العامل الموازي) يجب أن تعيد التحقق من ذلك حيًا** قبل كتابة الترحيل 143.
3. **ترقيم المراحل:** تقرير التدقيق رقّم المراحل 0–6 (0 = التأهيل/التدقيق، 1 = الأساسيات والموظفون، 2 = الإجازات، 3 = المهام، 4 = الخدمة الذاتية، 5 = المالية، 6 = المتقدمة). في هذه الوثيقة أعيد الترقيم بحيث تكون **المرحلة 1 = التدقيق (مكتملة بهذا التقرير والتصميم)**، و**المرحلة 2 = الأساسيات والموظفون (هذا التصميم)**، ثم 3 = الإجازات، 4 = المهام، 5 = الخدمة الذاتية، 6 = الرواتب، 7 = المتقدمة (§8). المحتوى نفسه لم يتغير، الترقيم فقط.
4. **تصحيح في توقيع الاستيراد المقترح:** تقرير مسار المستخدمين اقترح `hr_import_employees(p_company, p_rows jsonb, p_idempotency_key)`. **هذا خطأ يُصحَّح هنا:** لا يُقبل أي `p_company` من العميل إطلاقًا — الشركة تُشتق داخل الدالة من الجلسة عبر `current_company_id()` (§1.4، §5). التوقيع الصحيح في §5.
5. **تصحيح في مصدر الحقيقة للانجراف:** التقرير ذكر في موضع أن `paused_at` غير موجود في `customer_subscriptions` — وهو نفسه صحّح ذلك داخل التقرير (العمود الوحيد المسمى `paused_at` في القاعدة كلها في `whatsapp_subscriptions`). لا أثر لهذا على تصميم HR، ويُذكر هنا فقط لمنع إعادة فتحه.
6. **توضيح مصطلح «المالك»:** في كل موضع في هذه الوثيقة، «مالك المنصة» = `platform_owner` (محمود / إدارة مدعوم)، و«مالك الشركة» = `company_admin` (صاحب الشركة العميلة). القاعدتان مختلفتان تمامًا (§1.5): مالك المنصة يتحكم في الإتاحة ولا يرى أي بيانات موظفين؛ مالك الشركة يملك كل صلاحيات HR في شركته بما فيها الرواتب.
7. **تصحيح/تحديث عن `emp_ops` (مراجعة رابط الحضور 2026-11-25 ~23:58 EET):** `emp-mad3oom` ليس نظامًا خارجيًا — هو نظام الحضور/النشاط الداخلي الخاص بمدعوم نفسه، على نفس مشروع Supabase ونفس Auth، وله 18 ترحيلًا و18 جدول `emp_ops` و35 دالة `eo_*` عامة. الرابط المصمم هو SDK ‏`sdk/mad3oom-activity-client.js` (موجود في مستودع Mad3oom ويستدعي `eo_ingest_activity`) لكنه **غير موصول**: لا يوجد أي استدعاء `Mad3oomActivity.init` / `track()` في أي موضع آخر، فلا يتدفق أي نشاط من Mad3oom اليوم. مفتاح ربط الهوية فيه هو البريد عبر `try_link_current_user()` مع `user_id` اختياري UNIQUE؛ والبيانات الحية قديمة/اختبارية (موظفان كلاهما محمود، آخر work_date ‏2026-09-12، ‏`shift_assignments` صفر رغم وجود ورديتين). هذا لا يغيّر القرار 1 (HR للشركات نظام جديد مستقل) — لكنه يعني أن مرحلة الحضور (المرحلة 7) يجب أن تدرس **إعادة استخدام SDK غير الموصول** كقناة ingest، لا بناء قناة جديدة، مع إعادة التحقق حيًا من قيد UNIQUE على البريد قبل الاعتماد عليه.

---

## 1. نظرة عامة + القرارات الملزمة + مبادئ البنية

### 1.1 ما هي الوحدة

وحدة HR هي نظام إدارة موظفين **متعدد الشركات** داخل لوحة الشركة في مدعوم: ملفات موظفين إدارية مستقلة، أقسام وفروع ومسميات وظيفية، استيراد جماعي، ثم على مراحل: إجازات واستئذان، مهام، خدمة ذاتية، رواتب، حضور ومستندات وتقييم. لا تعديل على أي وظيفة قائمة في المرحلة 2 (لا `profiles`، لا `auth.users`، لا `company_memberships`، لا `company_staff`، لا مرآة `super_user_id`، لا `company_of()`، لا مسار الدعوات، لا `create-sub-user`، لا مسارات طلبات الحسابات، لا RPCs الاشتراكات).

### 1.2 القرارات الملزمة من محمود (2026-11-25 ~23:54 EET)

| # | القرار | الأثر التصميمي |
|---|---|---|
| 1 | نظام موظفين **جديد مستقل**: جداول `public.hr_*` جديدة؛ `emp_ops` يبقى داخليًا فقط | §2 — لا امتداد لـ `emp_ops`، لا خلط بيانات، لا بادئة `eo_*` |
| 2 | مفتاح تكرار الموظف = `employee_number` فريد **داخل كل شركة** | `UNIQUE(company_id, employee_number)` في `hr_employees` (§2.1) + كشف التكرار في الاستيراد (§6) |
| 3 | تفعيل HR على **ثلاثة مستويات معًا**: مفتاح عام للمنصة + ميزة في الباقة (اشتراك) + استثناء/تجاوز لكل شركة | §3 — البوابة الكاملة `hr_gate()`؛ لا مستوى وحده يكفي |
| 4 | الرواتب والحضور والمهام **قابلة للتفعيل كل على حدة** (مفاتيح فرعية لكل قسم) | §3.2 — مصفوفة مفاتيح لكل قسم؛ كل RPC يفحص مفتاح قسمه |
| 5 | **توثيق قاعدة البيانات (خط أساس الانجراف) مطلوب قبل أي تعديل جديد** | §1.6 — شرط مسبق ينفذه عامل موازٍ؛ هذا التصميم لا يكرره ولا يغني عنه |

### 1.3 مبادئ البنية (ملزمة لكل مرحلة)

1. **الموظف ≠ حساب دخول.** سجل الموظف ملف إداري مستقل. لا يوجد أي مسار — لا إنشاء يدوي، لا استيراد، لا trigger، لا دعوة، لا Edge Function — ينشئ `auth.users` أو `profiles` أو `company_memberships` أو `company_staff` كنتيجة جانبية لإنشاء موظف. الدليل من التدقيق (§3.5 في تقرير المستخدمين): كل جدول مجاور للعضوية يفرض FK إلى `profiles(id)`، و`profiles.id` نفسه FK إلى `auth.users(id)`؛ لذلك كان لا بد من جدول جديد.
2. **`hr_employees.user_id` اختياري NULL دائمًا عند الإنشاء.** نوعه `uuid NULL REFERENCES profiles(id) ON DELETE SET NULL`. يُملأ فقط بالإجراء الصريح الموثّق `hr_link_employee_account` (§5.5)، ويُفرَّغ بفك الربط دون حذف سجل الموظف. لا trigger يكتب فيه، ولا الاستيراد يلمسه، ولا أي دالة أخرى.
3. **الرفض الافتراضي (deny-by-default).** كل جدول `hr_*`: RLS مفعّل، كل الصلاحيات مسحوبة من `public, anon, authenticated, service_role`، وسياسة تقييدية واحدة فقط `gate_account_active` (على نمط 096/113). كل الوصول عبر RPCs من نوع `SECURITY DEFINER` فقط. لا قراءة مباشرة `supabase.from('hr_*')` من الواجهة إطلاقًا.
4. **الشركة من الجلسة، لا من العميل.** كل RPC يشتق `company_id` داخل قاعدة البيانات من `current_company_id()` (السياق الحالي للمتصل)، ويتحقق من دور HR للمتصل **في تلك الشركة**. لا معامل `p_company_id` في أي RPC موجَّه للشركة (الاستثناء الوحيد: RPCs مالك المنصة التي تأخذ `p_company` صراحةً لأن المالك خارج كل شركة — §5.6). لا نسخ لنمط `supervises` في أي قراءة HR.
5. **العزل بنيوي لا مشروط بمفتاح.** عزل HR على نمط 096/113 (رفض افتراضي + RPCs فقط)، لا على نمط التذاكر (سياسات تقييدية مشروطة بعلم `company_isolation_enforced` يمكن إطفاؤه). إطفاء مفتاح عام لا يفتح قراءة عبر الشركات أبدًا.
6. **فحص الحظر في كل RPC.** بما أن `account_is_active()` لا تستدعي `is_banned()` (ثغرة HIGH موثقة في التدقيق)، كل RPC في HR يفحص `is_banned()` صراحةً (على نمط `_inbox_account_active` / `conv_account_active`)، ولا يعتمد على سياسة `gate_account_active` وحدها. أي مستخدم محظور يُرفض قبل أي فحص آخر.
7. **التدقيق إلحاقي (append-only).** `hr_audit_logs` بلا UPDATE/DELETE/TRUNCATE (حرّاس trigger)، بحقول `old_values/new_values jsonb` + `reason` + `actor`. كل تغيير في موظف أو استحقاق أو ربط أو إتاحة يُسجَّل. لا يكفي `activity_logs` العام للرواتب.
8. **تحكم المالك ≠ قراءة المالك.** مالك المنصة يتحكم في الإتاحة (مفاتيح/خطط/تجاوزات) عبر RPCs مالك موثقة، لكنه **لا يقرأ إطلاقًا** رواتب أو مستندات أو بيانات شخصية (PII) لأي شركة — عكس سابقة `accounting_invoices` («مالكه أو إدارة المنصة») التي يجب ألا تُنسخ. RPCs المالك للإتاحة ترجع حالات ومفاتيح وعدّادات فقط، لا صفوف موظفين. حتى `owner_account_details()` لا يُوسَّع ليشمل HR.
9. **الرواتب معزولة عموديًا.** لا أمن على مستوى العمود في المنصة (RLS صفّي فقط)، لذلك لا توجد أي أعمدة مالية في `hr_employees` إطلاقًا. الرواتب في جداول مستقلة (`hr_salary_records` + تاريخها) بمفاتيح صلاحية مستقلة (§4) وRPCs خاصة بها (المرحلة 6). مدير قسم لا يرى رواتب فريقه افتراضيًا أبدًا (§4.3).
10. **لا أزرار وهمية.** كل إجراء في الواجهة له مسار خلفية يعمل (§7). الإخفاء في الواجهة تجميلي فقط — القرار في قاعدة البيانات (`company-model.js:1-14`).
11. **لا ترحيل بلا تسجيل.** الترحيل 143 يُسجَّل رسميًا في `supabase_migrations.schema_migrations` عند تطبيقه، ويُحدَّث `tests/fixtures/prod-shape/` في نفس التغيير، وإلا تكرر الانجراف.
12. **النمط المعماري للواجهة:** نماذج عرض خالصة (`hr-*-model.js`، بلا DOM وبلا شبكة، تُختبَر في Node) + ملفات ربط/عرض، على نمط `company-model.js` / `store-model.js` (§7).

### 1.4 الدوال المساعدة الموجودة التي تُبنى عليها HR (لا إعادة اختراع)

`current_company_id()` (السياق الحالي — لا `company_of()` أحادية الأساس)، `company_has_feature(p_feature_key)` (البوابة المرجعية للميزات — لا قائمة استحقاقات اللوحة التي تتجاهل التجاوزات)، `is_banned()`، `owner_critical_ok()` (تحقق بخطوتين، نافذة 10 دقائق)، `log_privileged()`، `account_is_active()` (مع قيدها المعروف في المبدأ 6)، `can_manage_company_members()` كنموذج لجمع (دور + علاقة + استحقاق) في فحص واحد.

### 1.5 حدود الصلاحيات: من يرى ماذا (الخلاصة)

| الطرف | يرى / يفعل |
|---|---|
| مالك المنصة | الإتاحة فقط (مفاتيح/خطط/تجاوزات/حالات). لا موظفين، لا رواتب، لا مستندات، لا PII، لا أسماء إلا في عدّادات مجمعة إن لزم |
| مالك الشركة | كل صلاحيات HR في شركته، بما فيها الرواتب (هو صاحب العمل) |
| مدير HR / موظف HR | حسب مفاتيح §4؛ بلا رواتب إلا بمفتاح `hr.payroll.*` الصريح |
| مدير قسم | موظفو قسمه فقط؛ بلا رواتب افتراضيًا |
| موظف (مرتبط) | بياناته وطلباته ومهامه فقط (المرحلة 5) |
| موظف بلا حساب | لا وصول داخل التطبيق إطلاقًا؛ إشعاراته تذهب لمالك/مسؤول الشركة فقط |

### 1.6 شروط مسبقة قبل كتابة أي كود (خارج هذا التصميم)

1. **خط أساس الانجراف** (عامل موازٍ — لا يكرره هذا التصميم): توثيق الكائنات اليتيمة (128–135 بلا سجل ترحيل، مخطط `emp_ops` كاملًا بلا ملفات، `agent_activity_log`، `muse_account_activations`) + إعادة التحقق حيًا من تطبيق 136–141 + التحقق حيًا من اتساع قيد CHECK في `company_feature_overrides` بعد 092 (السؤال المفتوح في التدقيق: هل وُسّع حيًا ليشمل `shopify_integration` و`store_support`؟) + إثبات العزل حيًا بأدوار عادية على `company_memberships` / `company_documents` / `tickets` + فحص `pg_policies` لـ `api_tokens` و`whatsapp_subscriptions`. لا يُكتب الترحيل 143 قبل اكتمال هذا.
2. **خط أساس الاختبارات:** تشغيل `npm test` كاملًا وتثبيت النتيجة **بالاسم** قبل أي تغيير (آخر نتيجة مبلغة: Node 2049 ناجح / 28 فاشل كلها سابقة، SQL 100/9، HTTP 24 متخطى — يجب إعادة القياس لا الاعتماد على الرقم).
3. فرع عمل مستقل `hr-module` + بيئة اختبار معزولة. لا تطبيق حي ولا نشر ولا تفعيل تجاري دون موافقة صريحة من محمود على كل خطوة.

---

## 2. مخطط قاعدة البيانات — المرحلة 2 (الأساسيات + الموظفون)

كل الجداول في مخطط `public` ببادئة `hr_`، وكلها تحمل `company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` (عدا `hr_import_runs` و`hr_audit_logs` — فيهما أيضًا، انظر أدناه)، وRLS مفعّل + كل الصلاحيات مسحوبة + سياسة `gate_account_active` التقييدية فقط، وحرّاس إلحاقية حيث يُذكر. الفهارس جزء من تعريف الجدول في الترحيل، لا لاحقة. لا تُستخدم بادئة `eo_*` ولا مخطط `emp_ops` في أي اسم.

اتفاقيات عامة: المعرّفات `uuid PRIMARY KEY DEFAULT gen_random_uuid()`؛ الطوابع `created_at timestamptz NOT NULL DEFAULT now()`؛ `updated_at timestamptz NOT NULL DEFAULT now()` مع trigger تحديث (عدا الجداول الإلحاقية التي بلا `updated_at`)؛ النصوص العربية `text`؛ البريد `text` يُحفظ بصيغته الأصلية ويُقارن بـ `lower()`؛ الأرقام الوظيفية `text NOT NULL` (قد تحوي حروفًا/شرطات حسب الشركة).

### 2.1 `hr_employees` — ملف الموظف (قلب الوحدة)

| العمود | النوع / القيد | ملاحظات |
|---|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` | |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` | جذر العزل |
| `employee_number` | `text NOT NULL` | **مفتاح التكرار (قرار محمود 2)**. `UNIQUE(company_id, employee_number)`. لا يُعاد استخدامه بعد أرشفة صاحبه إلا بقرار صريح (انظر §2.1.1) |
| `full_name` | `text NOT NULL CHECK (char_length(btrim(full_name)) >= 2)` | الاسم الكامل كما في العقد |
| `phone` | `text NULL CHECK (phone IS NULL OR char_length(btrim(phone)) BETWEEN 7 AND 20)` | هاتف إداري؛ ليس معرّف حساب ولا يُستخدم للدخول |
| `email` | `text NULL` | **معلوماتي فقط** — لا يُعامل أبدًا كمعرّف حساب، ولا يُبحث به حساب عند الإنشاء أو الاستيراد |
| `national_id` | `text NULL` | الرقم القومي/الهوية. يُخفى في قوائم السرد (يُرجع مُقنّعًا) ولا يظهر كاملًا إلا في تفاصيل الموظف لحاملي `hr.employees.view`؛ قرار التشفير/التجزئة سؤال مفتوح (§9.6) |
| `department_id` | `uuid NULL REFERENCES hr_departments(id) ON DELETE SET NULL` | |
| `branch_id` | `uuid NULL REFERENCES hr_branches(id) ON DELETE SET NULL` | |
| `position_id` | `uuid NULL REFERENCES hr_positions(id) ON DELETE SET NULL` | |
| `manager_employee_id` | `uuid NULL REFERENCES hr_employees(id) ON DELETE SET NULL` | المدير المباشر **سجل موظف آخر**، لا حساب دخول |
| `job_title` | `text NULL` | مسمى حر (للتوافق مع الاستيراد)؛ `position_id` هو المرجع الهيكلي |
| `hire_date` | `date NULL CHECK (hire_date <= CURRENT_DATE)` | |
| `contract_type` | `text NULL CHECK (contract_type IS NULL OR contract_type IN ('full_time','part_time','contract','intern','temporary'))` | |
| `employment_status` | `text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','on_leave','suspended','terminated','pending_data'))` | **CHECK من اليوم الأول** (درس `ban_status` بلا CHECK). `pending_data` = ملف ناقص البيانات من الاستيراد بلا اسم/هاتف كاملين — لا يُقبل إلا عبر الاستيراد وبحقول إلزامية دنيا (§6.2) |
| `user_id` | `uuid NULL REFERENCES profiles(id) ON DELETE SET NULL` | **الربط الاختياري فقط** (§1.3.2). NULL عند كل إنشاء؛ لا trigger ولا استيراد يكتبه |
| `notes` | `text NULL` | ملاحظات إدارية داخلية |
| `created_by` | `uuid NULL` | `auth.uid()` المنشئ (بلا FK — قد يكون مالك المنصة عبر RPC مالك؛ لا FK إلى `profiles` هنا لتجنب تشابك الحذف) |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `archived_at` | `timestamptz NULL` | الأرشفة لا الحذف (§2.1.1) |
| `archived_by` | `uuid NULL` | |
| `archive_reason` | `text NULL CHECK (archived_at IS NULL OR char_length(btrim(archive_reason)) >= 10)` | سبب الأرشفة ≥ 10 أحرف، على نمط أسباب المالك |

**الفهارس:** `UNIQUE(company_id, employee_number)`؛ `idx_hr_employees_company_status (company_id, employment_status)`؛ `idx_hr_employees_company_dept (company_id, department_id)`؛ `idx_hr_employees_company_branch (company_id, branch_id)`؛ `idx_hr_employees_user (user_id) WHERE user_id IS NOT NULL`؛ `idx_hr_employees_company_name (company_id, full_name)` للبحث بالاسم (يُستخدم مع `ilike` خادمًا)؛ فهرس فريد جزئي `(company_id, lower(email)) WHERE email IS NOT NULL` — يمنع بريدين متماثلين داخل الشركة الواحدة (معلوماتي لكن التكرار فيه مصدر خلط عند الربط لاحقًا)؛ فهرس فريد جزئي `(company_id, national_id) WHERE national_id IS NOT NULL`.

#### 2.1.1 الأرشفة لا الحذف

- لا يوجد `DELETE` على `hr_employees` في أي RPC. إنهاء موظف = `employment_status='terminated'` + `archived_at=now()` + سبب ≥ 10 أحرف + سطر في `hr_audit_logs` + سطر في `hr_employee_status_history`.
- الموظف المؤرشف: لا يظهر في القوائم الافتراضية (فلتر `employment_status <> 'terminated'` افتراضيًا مع خيار صريح لعرض المؤرشفين)، لا تُسند إليه مهام جديدة، لا يُربط بحساب، لا يُستورد رقمه الوظيفي مرة أخرى إلا بإجراء صريح «إعادة تفعيل رقم مؤرشف» يسجَّل في التدقيق.
- إعادة التفعيل: `terminated → active` مسموح عبر RPC الأرشفة نفسه (مع سبب)، ويُسجَّل في التاريخ. لا حذف فعلي أبدًا — حتى طلب حذف بيانات الشركة ذاتيًا (140) لا يحذف سجلات HR إلا بقرار مالك منصة منفصل وموثق (سؤال مفتوح §9.9).

### 2.2 `hr_departments` / `hr_branches` / `hr_positions` — الهيكل الهرمي

الجداول الثلاثة بنفس الشكل؛ الفروق في الأعمدة الخاصة مذكورة:

| العمود | النوع / القيد |
|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| `parent_id` | `uuid NULL REFERENCES <same table>(id) ON DELETE SET NULL` — هرمية ذاتية |
| `name` | `text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120)` |
| `description` | `text NULL CHECK (description IS NULL OR char_length(description) <= 1000)` |
| `manager_employee_id` | `uuid NULL REFERENCES hr_employees(id) ON DELETE SET NULL` — مدير القسم/الفرع (سجل موظف) |
| `is_active` | `boolean NOT NULL DEFAULT true` |
| `sort_order` | `integer NOT NULL DEFAULT 0` |
| `created_by` / `created_at` / `updated_at` | كما في §2 |
| `archived_at` | `timestamptz NULL` — أرشفة لا حذف، كالموظفين |

- **`hr_positions` فقط:** `level integer NULL CHECK (level BETWEEN 1 AND 10)` (درجة المسمى)، و`department_id uuid NULL REFERENCES hr_departments(id) ON DELETE SET NULL` (المسمى ينتمي لقسم اختياريًا).
- **حد العمق:** العمق الأقصى **6 مستويات** (على نمط `admin_units` في 099 — حارس إجرائي يمشي سلسلة `parent_id` ويرفض تجاوز 6 أو الحلقة الذاتية `self-ancestor`). يُفرض بـ trigger حارس في الترحيل 143، لا بعمود `depth` (لا عمود `depth` — كما في `admin_units`).
- **حارس الأرشفة:** لا يُلغى أرشفة أبٍ تحته أبناء غير مؤرشفين؛ لا يُنشأ ابن تحت أبٍ مؤرشف؛ لا يُغيَّر `id`.
- **الفهارس:** `idx_hr_departments_company_parent (company_id, parent_id)`؛ `(company_id, name)` فريد جزئي حيث `parent_id IS NULL`؟ — **قرار:** الاسم فريد داخل نفس الأب فقط: `UNIQUE(company_id, parent_id, name)` لا يمنع التكرار عند `parent_id NULL` في Postgres (NULL ≠ NULL)، لذلك يُستخدم فهرس فريد تعبيري `UNIQUE(company_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)`. نفس القاعدة للفروع والمسميات.
- **لا يُبنى الهيكل على `admin_units`:** شجرة `admin_units` (099) شجرة حوكمة للمنصة (وحدات ← شركات)، لا هيكل تنظيمي داخل الشركة. HR له هيكله الخاص؛ الشركة الواحدة قد تظهر في وحدة إدارية واحدة، لكن أقسامها الداخلية `hr_*`.

### 2.3 `hr_settings` — إعدادات لكل شركة (صف واحد لكل شركة)

| العمود | النوع / القيد |
|---|---|
| `company_id` | `uuid PK REFERENCES companies(id) ON DELETE CASCADE` |
| `employee_number_prefix` | `text NOT NULL DEFAULT '' CHECK (char_length(employee_number_prefix) <= 10)` — بادئة اختيارية لأرقام الموظفين الجديدة |
| `employee_number_next` | `integer NOT NULL DEFAULT 1 CHECK (employee_number_next >= 1)` — عدّاد الترقيم التلقائي (يُستخدم فقط عند طلب رقم تلقائي؛ لا يفرض نفسه على الاستيراد) |
| `default_probation_months` | `integer NOT NULL DEFAULT 3 CHECK (default_probation_months BETWEEN 0 AND 12)` |
| `audit_retention_months` | `integer NOT NULL DEFAULT 24 CHECK (audit_retention_months BETWEEN 6 AND 120)` — مدة الاحتفاظ بسجل `hr_audit_logs` (لا حذف تلقائي قبلها؛ الحذف بعدها بقرار موثق فقط) |
| `updated_by` / `updated_at` | كما في §2 |

يُنشأ الصف تلقائيًا (بالقيم الافتراضية) عند أول تفعيل لـ HR في الشركة عبر RPC المالك أو أول RPC إعدادات؛ لا صف = الإعدادات الافتراضية.

### 2.4 `hr_audit_logs` — سجل التدقيق الإلحاقي

| العمود | النوع / القيد |
|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| `employee_id` | `uuid NULL REFERENCES hr_employees(id) ON DELETE SET NULL` — الموظف موضوع الحدث (قد يكون NULL لأحداث على مستوى الشركة/القسم) |
| `actor_user_id` | `uuid NULL` — `auth.uid()` الفاعل (NULL لأحداث النظام/المهام المجدولة) |
| `actor_role` | `text NULL` — دور الفاعل وقت الحدث (لقطة، لا FK) |
| `action` | `text NOT NULL` — مثال `employee.created`، `employee.archived`، `employee.linked`، `employee.unlinked`، `import.completed`، `entitlement.changed`، `salary.changed` (لاحقًا) |
| `entity_type` | `text NOT NULL` — `employee` / `department` / `branch` / `position` / `import_run` / `entitlement` / `settings` |
| `entity_id` | `uuid NULL` |
| `old_values` / `new_values` | `jsonb NULL` — على نمط `subscription_audit_log` |
| `reason` | `text NULL` — السبب حيث يلزم (إلزامي لأرشفة/ربط/تغيير استحقاق) |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

- **إلحاقي بالحرّاس:** trigger يمنع UPDATE/DELETE/TRUNCATE (على نمط `hierarchy_events` 099 و`login_locations` 131). لا `updated_at`.
- **الفهارس:** `(company_id, created_at DESC)`؛ `(company_id, employee_id, created_at DESC)`؛ `(company_id, action, created_at DESC)`.
- ملاحظة: `activity_logs` الحالي بلا `company_id` فلا يصلح بديلًا — هذا الجدول هو سجل HR الرسمي. أحداث تغييرات الإتاحة من المالك تُسجَّل هنا **أيضًا** في `privileged_audit` + سجل الاشتراكات (§3.4) — التدقيق المزدوج نمط قائم (133).

### 2.5 `hr_import_runs` — تشغيلات الاستيراد (منع التكرار + التقرير)

| العمود | النوع / القيد |
|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| `idempotency_key` | `uuid NOT NULL` — `UNIQUE(company_id, idempotency_key)` |
| `initiated_by` | `uuid NOT NULL` — `auth.uid()` المبادر (جزء من نطاق المفتاح منطقيًا؛ القيد الفريد على الشركة + المفتاح، والمبادر يُسجَّل ويُفحص عند إعادة التشغيل) |
| `file_name` | `text NULL` |
| `status` | `text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','partial','failed'))` — التشغيل ذريّ من جهة التنفيذ (معاملة واحدة) لكن نتيجته قد تكون جزئية الصفوف (صفوف صالحة أُدخلت + صفوف مرفوضة) |
| `total_rows` / `inserted_count` / `duplicate_count` / `invalid_count` | `integer NOT NULL DEFAULT 0 CHECK (... >= 0)` |
| `results` | `jsonb NOT NULL DEFAULT '[]'::jsonb` — نتائج كل صف `{line, employee_number, status, reason}` (انظر §6.5) |
| `created_at` / `completed_at` | `timestamptz` |

- **إعادة التشغيل ≠ إعادة التحقق:** إعادة إرسال نفس `(company_id, idempotency_key)` ترجع نتيجة التشغيل المخزنة دون إعادة تنفيذ أو إعادة تحقق (على نمط `owner_account_transfer` 129 و`owner_transfer_exceptional` 101) — ويُوثَّق ذلك في رد RPC (§5.4). المفتاح يُولَّد في العميل (`crypto.randomUUID()`) لكل تشغيل جديد، ويُحفظ في نموذج الواجهة حتى اكتمال التشغيل.
- **الفهارس:** `UNIQUE(company_id, idempotency_key)`؛ `(company_id, created_at DESC)`.

### 2.6 `hr_employee_status_history` — تاريخ حالات الموظف

| العمود | النوع / القيد |
|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| `employee_id` | `uuid NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE` |
| `from_status` / `to_status` | `text NULL` / `text NOT NULL` — نفس تعداد `employment_status` |
| `reason` | `text NOT NULL CHECK (char_length(btrim(reason)) >= 10)` |
| `changed_by` | `uuid NULL` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

إلحاقي (بلا UPDATE/DELETE). يُكتب من RPCs تغيير الحالة فقط. فهرس `(employee_id, created_at DESC)`.

### 2.7 `hr_role_assignments` — أدوار HR داخل الشركة (النطاقية)

| العمود | النوع / القيد |
|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `company_id` | `uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| `user_id` | `uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE` — صاحب الدور (حساب دخول؛ الدور يُمنح لحساب لا لملف موظف، لأن الفحص يتم للمتصل) |
| `employee_id` | `uuid NULL REFERENCES hr_employees(id) ON DELETE SET NULL` — ملف الموظف المرتبط بصاحب الدور (يُملأ عند الربط؛ يُستخدم لتحديد «الذات» ونطاق القسم) |
| `role` | `text NOT NULL CHECK (role IN ('hr_manager','hr_officer','dept_manager','payroll_officer'))` |
| `department_id` | `uuid NULL REFERENCES hr_departments(id) ON DELETE SET NULL` — نطاق الدور (إلزامي لـ `dept_manager`، اختياري لغيره) |
| `granted_by` / `granted_at` | `uuid NULL` / `timestamptz NOT NULL DEFAULT now()` |
| `revoked_at` / `revoked_by` / `revoke_reason` | `timestamptz NULL` / `uuid NULL` / `text NULL` — الإبطال لا الحذف |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

- `UNIQUE(company_id, user_id, role, COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL` — دور نشط واحد لكل (شركة، مستخدم، دور، قسم).
- **لماذا جدول جديد لا `company_role_permissions`؟** لأن أدوار 098 (`supervisor`/`agent`) مربوطة بمرآة `super_user_id` الأساسية (§2.5.5 في تقرير المستخدمين: صف طاقم في شركة ثانوية صف ميت)، ولأن `profiles.role` مغلق ولا يعبر عن «مدير HR في شركة X وعضو عادي في شركة Y». هذا الجدول مفتاحه (شركة + مستخدم) مباشرةً، بلا مرآة. مفاتيح الصلاحية نفسها تُسجَّل في `company_permission_catalog` (§4) — الجدول هنا هو **التعيين**، والكتالوج هو **السجل**؛ لا نظام صلاحيات ثانٍ.
- `employee-self` ليس دورًا في هذا الجدول: يُشتق من `hr_employees.user_id = auth.uid()` مباشرةً (§4.2).

### 2.8 الأعمدة المحجوزة للمراحل اللاحقة (تُذكر هنا فقط — بلا تصميم كامل)

لا يُصمَّم في المرحلة 2 أيٌّ مما يلي تصميمًا كاملًا؛ تُذكر أسماء الجداول المستقبلية فقط لمنع تعارض التسمية ولتثبيت حدود المرحلة 2:

- **المرحلة 3 (إجازات):** `hr_leave_types`، `hr_leave_balances`، `hr_leave_requests`، `hr_permission_requests` (استئذان)، `hr_holidays`، `hr_work_calendars`.
- **المرحلة 4 (مهام):** `hr_tasks`، `hr_task_assignments`، `hr_task_templates`.
- **المرحلة 5 (خدمة ذاتية):** لا جداول جديدة (ربط + دعوة اختيارية + عرض ذاتي على الجداول القائمة)؛ `hr_announcements` + `hr_announcement_reads` (إعلانات داخلية).
- **المرحلة 6 (رواتب):** `hr_salary_records`، `hr_salary_history` (إلحاقي: قيمة سابقة/جديدة/تاريخ سريان/صاحب صلاحية)، `hr_payroll_periods`، `hr_payroll_lines`.
- **المرحلة 7 (متقدمة):** `hr_attendance` (أو ربط بنمط `emp_ops` — بلا دمج)، `hr_documents` (على نموذج 100، مستودع `hr-documents`)، `hr_evaluations`، `hr_admin_decisions`.
- **أعمدة محجوزة داخل `hr_employees` للمراحل اللاحقة (لا تُضاف في 143):** لا شيء — المراحل اللاحقة تضيف جداولها الخاصة؛ لا تُضاف أعمدة راتب أو رصيد إجازة إلى `hr_employees` أبدًا (المبدأ 9).

---

## 3. مفاتيح الميزات — التفعيل على ثلاثة مستويات

### 3.1 القرار: توسيع `company_feature_overrides` (لا جدول `hr_module_entitlements` جديد)

**القرار: توسيع جدول `company_feature_overrides` القائم** — توسيع قيد CHECK ليشمل مفاتيح HR + إضافة عمود حالة للإيقاف — **ولا يُنشأ جدول `hr_module_entitlements`**.

**الأسباب (مقابل الجدول الجديد):**

1. **البوابة جاهزة وتقرأه أصلًا.** `company_has_feature()` = (اشتراك نشط ← `plan_features.enabled`) **OR** (صف تجاوز غير منتهٍ في `company_feature_overrides`). جدول جديد يعني بوابة ثانية يجب أن تُقرأ في كل RPC، وخطر الانقسام نفسه الموثق بين `company_has_feature()` وقائمة استحقاقات اللوحة (§6.4 في تقرير المستخدمين). مصدر واحد للحقيقة.
2. **لا انجراف إضافي.** الجدول موجود حيًا (3 صفوف على شركة مدعوم) وله FK إلى `feature_flags`؛ توسيعه تعديل قيد لا كيان جديد بلا سجل.
3. **النمط القائم للاستثناءات.** التجاوز لكل شركة هو بالضبط ما صُمم له الجدول (092)؛ و`owner_store_test_entitlements` يكتب فيه برمجيًا أصلًا (لثلاثة مفاتيح) — أي أن الكتابة البرمجية عبر RPC مالك ليست بدعة.
4. **الجدول الجديد لا يضيف شيئًا لا يقدر عليه التوسيع:** الحالة (نشط/موقوف) وسبب الإيقاف وتاريخه تُضاف كأعمدة على الجدول القائم بنفس الترحيل 143.

**مقابل ذلك (ما يجب إصلاحه في التوسيع):**

- **السؤال المفتوح من التدقيق يبقى قائمًا:** قيد CHECK في 092 يقصر المفاتيح على `('integrations_hub')`، بينما `owner_store_test_entitlements` يكتب `shopify_integration` و`store_support` أيضًا — ولم يُتحقق حيًا إن كان القيد قد وُسّع بعد 092. **خطوة خط الأساس يجب أن تحسم هذا حيًا قبل كتابة 143.** الترحيل 143 نفسه يُكتب بطريقة آمنة ضد الحالتين: يفحص `pg_constraint`، فإن كان القيد ما زال ضيقًا أزاله وأعاد إنشاءه موسعًا، وإن كان موسعًا أصلًا تخطى الإزالة (نمط `DROP CONSTRAINT IF EXISTS` + إعادة إنشاء بشرط مسبق `to_regclass`، على نمط الترحيلات القائمة).
- الجدول بلا صلاحيات لأي دور (حتى `service_role`) — الكتابة فيه حصرًا عبر RPCs مالك من نوع `SECURITY DEFINER` (كما اليوم). لا تُمنح صلاحيات جدول مباشرة.
- **القيد الموسع الجديد** (يُعاد إنشاؤه في 143): `feature_key IN ('integrations_hub','shopify_integration','store_support','hr','hr_employees','hr_leave','hr_payroll','hr_tasks','hr_attendance','hr_reports')` — أي أن التوسيع يغطي مفاتيح HR كلها دفعة واحدة، ولا يُفتح قيد جديد لكل قسم لاحقًا.
- **أعمدة جديدة على `company_feature_overrides` (في 143):** `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))`، `suspended_at timestamptz NULL`، `suspended_by uuid NULL`، `suspend_reason text NULL CHECK (status = 'active' OR char_length(btrim(suspend_reason)) >= 10)`.

### 3.2 المفاتيح

**المستوى 1 — مفتاح المنصة العام** (جدول `platform_feature_switches`، بلا جدول جديد):

| المفتاح | المعنى |
|---|---|
| `hr_module_enabled` | الإتاحة العامة لوحدة HR على المنصة كلها. إطفاؤه يوقف كل HR في كل شركة (البيانات محفوظة). يُدار عبر `owner_set_feature_switch()` القائم (مالك + تحقق بخطوتين + `privileged_audit`) |

**المستوى 2 — ميزات الباقة** (جدول `plan_features`، صف لكل خطة × مفتاح؛ `feature_flags` سجل المفاتيح فقط):

| مفتاح `plan_features` | القسم | ملاحظات |
|---|---|---|
| `hr` | الوحدة ككل (بوابة رئيسية) | يجب أن يكون مفعّلًا في الباقة (أو بتجاوز) لأي قسم HR أن يعمل |
| `hr_employees` | الموظفون والهيكل والاستيراد | المرحلة 2 |
| `hr_leave` | الإجازات والاستئذان | المرحلة 3 |
| `hr_tasks` | المهام | المرحلة 4 |
| `hr_attendance` | الحضور والانصراف | المرحلة 7 |
| `hr_payroll` | الرواتب وكشوفها | المرحلة 6 — **آخر مرحلة مالية لخطورتها** |
| `hr_reports` | التقارير والتصدير المتقدم | يُفعَّل مع أول قسم يحتاجه؛ التصدير الأساسي للقوائم يتبع مفتاح القسم نفسه |

**المستوى 3 — التجاوز لكل شركة** (جدول `company_feature_overrides` الموسع، §3.1): صف `(company_id, feature_key)` مع `reason` (3–300 حرف، إلزامي) + `granted_by` + `expires_at` (اختياري؛ بلا انتهاء = دائم حتى إبطال صريح) + `status` الجديد. التجاوز يمنح المفتاح **لشركة واحدة دون تغيير باقتها** — وهو الطريق الطبيعي للتجربة المجانية الموافق عليها من المالك أولًا (على نمط تجربة SaaS 3 أيام في 137: طلب → موافقة مالك → استحقاق مؤقت؛ لا تجربة ذاتية).

**مصفوفة التفعيل لكل قسم (الخلاصة):**

| القسم | مفتاح المنصة | مفتاح الباقة/التجاوز | ملاحظة |
|---|---|---|---|
| الموظفون/الهيكل/الاستيراد | `hr_module_enabled` | `hr` + `hr_employees` | كلاهما مطلوب |
| الإجازات | `hr_module_enabled` | `hr` + `hr_leave` | المرحلة 3 |
| المهام | `hr_module_enabled` | `hr` + `hr_tasks` | المرحلة 4 |
| الحضور | `hr_module_enabled` | `hr` + `hr_attendance` | المرحلة 7 |
| الرواتب | `hr_module_enabled` | `hr` + `hr_payroll` | المرحلة 6 + مفاتيح الصلاحية §4 |
| التقارير | `hr_module_enabled` | `hr` + `hr_reports` | |

### 3.3 منطق البوابة — الدالة التي يجب أن تستخدمها كل RPC

كل RPC في HR (بلا استثناء) تبدأ بهذا الفحص، بالترتيب:

```text
hr_gate(p_section_key text) RETURNS boolean  -- دالة داخلية (بلا GRANT)، تُستدعى من كل RPC
1. إن كان المتصل محظورًا is_banned() = true → ارفض (P0001 / 42501).
2. إن كان مفتاح المنصة hr_module_enabled مطفأً → ارفض (الوحدة متوقفة على مستوى المنصة).
3. اشتق الشركة v_company := current_company_id()؛ إن كانت NULL → ارفض.
4. إن كانت الشركة suspended (companies.status = 'suspended') وكان مفتاح company_suspension_enforced مفعّلًا → ارفض
   (على نمط company_has_feature في 099:716-748؛ إن كان المفتاح مطفأً فالشركة الموقوفة تبقى خاضعة لقرار منفصل — لا يفتح HR بابًا أغلقه غيره).
5. إن لم يكن company_has_feature('hr') → ارفض (لا استحقاق للوحدة أصلًا).
6. إن لم يكن company_has_feature(p_section_key) → ارفض (القسم غير مفعّل لهذه الشركة).
   - company_has_feature تقرأ: اشتراك نشط غير منتهٍ ← plan_features.enabled، OR صف تجاوز
     (company_id, feature_key) بحالة active وغير منتهي الصلاحية (expires_at IS NULL OR > now()).
   - صف تجاوز بحالة suspended يُعامل كأنه غير موجود (لا يمنح الميزة)، ويُسجَّل سبب الإيقاف في الرد.
7. افحص صلاحية HR للمتصل (hr_has_permission) حسب RPC (§4) — تُفحص بعد الاستحقاق لا قبله،
   حتى لا تُسرَّب معلومة «القسم مفعّل لكنك بلا صلاحية» مقابل «القسم غير مفعّل»؛ الرد الموحد: «الوحدة/القسم غير متاح».
```

**قاعدة ذهبية:** بوابات HR تبني على `company_has_feature()` (المرجعية) — لا على قائمة `entitlements` في `get_my_company_dashboard()` التي تتجاهل التجاوزات (التعارض الموثق §6.4 في تقرير المستخدمين). قائمة اللوحة **عرض فقط**؛ تُستخدم لإظهار/إخفاء الروابط تجميليًا، لا للقرار.

**أين يُفحص المفتاح العام؟** `hr_gate()` تقرأ `platform_feature_switches` عبر `_feature_on('hr_module_enabled')` (الدالة الداخلية القائمة في 096:88-93) — لا قراءة مباشرة للجدول من RPCs الشركة.

### 3.4 حالات الإيقاف/التعليق — مصفوفة السلوك (ما يُحجب وما يُحفَظ)

| الحالة | كيف تحدث | القراءة | الكتابة | ما يُحفَظ | العودة |
|---|---|---|---|---|---|
| **المنصة مطفأة** (`hr_module_enabled=false`) | مالك المنصة عبر `owner_set_feature_switch()` | محجوبة لكل الشركات (عدا صفحات المالك نفسها) | محجوبة | كل البيانات + الاستحقاقات + التجاوزات | إعادة تشغيل المفتاح تعيد كل شيء فورًا |
| **لا استحقاق** (لا ميزة في الباقة ولا تجاوز) | انتهاء اشتراك / خطة بلا HR / إبطال التجاوز | محجوبة (قسم HR لا يظهر) | محجوبة | كل البيانات | منح ميزة (باقة/تجاوز/تجربة) يعيد الظهور كاملًا |
| **تجاوز منتهي الصلاحية** (`expires_at <= now()`) | مرور الوقت | محجوبة | محجوبة | كل البيانات | تجديد التجاوز بتاريخ جديد يعيدها |
| **قسم موقوف** (تجاوز `status='suspended'`) | مالك المنصة عبر RPC الإيقاف (§5.6) مع سبب ≥ 10 | **مسموحة** (قراءة + تصدير) — حتى تتمكن الشركة من مراجعة بياناتها وتصديرها | **محجوبة** (لا إنشاء/تعديل/أرشفة/استيراد/ربط) | كل البيانات + سجل التدقيق | إلغاء الإيقاف يعيد الكتابة فورًا؛ الإيقاف لا يحذف شيئًا |
| **اشتراك موقوف `paused`** | إيقاف اشتراك الشركة (نمط المتجر 133) | محجوبة كحالة «لا استحقاق» (لأن `company_has_feature` يتطلب اشتراكًا نشطًا غير منتهٍ) | محجوبة | كل البيانات | استئناف الاشتراك يعيد الاستحقاق تلقائيًا؛ **لا حالة `paused` خاصة بـ HR** — حالة الإيقاف الخاصة بـ HR هي `suspended` على صف التجاوز فقط (درس التعارض 4 في تقرير التدقيق: `paused` عمليًا خاص باشتراكات المتجر) |
| **شركة موقوفة** (`companies.status='suspended'`) | حوكمة المنصة (099) | تخضع لقاعدة الإيقاف العامة للشركة (099:716-748) | تخضع لها | كل البيانات | إعادة تفعيل الشركة |
| **تجربة منتهية** | انتهاء 3 أيام (نمط 137) | محجوبة بعد الانتهاء | محجوبة | كل البيانات + طلب التجربة | شراء الباقة أو تجاوز جديد |

**قواعد عامة على كل الحالات:** الإيقاف/التعليق/انتهاء الاستحقاق **لا يحذف ولا يؤرشف** أي سجل HR أبدًا؛ سجل `hr_audit_logs` يبقى قابلًا للقراءة من مالك الشركة حتى في حالة الإيقاف (للمراجعة)؛ RPCs المالك لقراءة حالة الإتاحة لا تُحجب بأي حالة (المالك يرى حالة الإتاحة دائمًا).

### 3.5 ما الذي يُسجَّل عند كل تغيير إتاحة

كل تغيير (تفعيل/إيقاف/تعليق/تجديد/إبطال تجاوز، تشغيل/إطفاء المفتاح العام، منح ميزة في باقة) يُسجَّل في **ثلاثة** أماكن (نمط 133 المزدوج + سجل HR): `log_privileged()` في `privileged_audit` (الفاعل/القديم/الجديد/السبب/التحقق بخطوتين) + سجل اشتراكات على نمط `subscription_audit_log` (عبر دالة `_hr_audit` داخلية) + سطر `hr_audit_logs` (`action='entitlement.changed'`) في الشركة المعنية. سبب ≥ 10 أحرف إلزامي لكل تغيير مالك.

---

## 4. مفاتيح الصلاحيات

### 4.1 المفاتيح الجديدة في `company_permission_catalog` (098)

تُضاف صفوف جديدة إلى الكتالوج القائم (لا جدول صلاحيات ثانٍ). الكتالوج اليوم فيه 22 مفتاحًا كلها تذاكر/محادثات/متجر — لا مفتاح HR. المفاتيح الجديدة (بالعربية في حقل الوصف):

| المفتاح | المعنى |
|---|---|
| `hr.employees.view` | عرض قوائم وتفاصيل الموظفين (بلا PII كامل: الرقم القومي مقنّع، وبلا رواتب) |
| `hr.employees.manage` | إنشاء/تعديل/أرشفة/إعادة تفعيل موظف + إدارة الأقسام/الفروع/المسميات |
| `hr.departments.manage` | إدارة الأقسام والفروع والمسميات (يُمنح مستقلًا لمن يدير الهيكل دون إدارة الموظفين) |
| `hr.import` | تنفيذ الاستيراد الجماعي + عرض تشغيلاته |
| `hr.link_account` | ربط موظف بحساب دخول / فك الربط |
| `hr.roles.manage` | منح/إبطال أدوار HR داخل الشركة (`hr_role_assignments`) |
| `hr.settings.manage` | تعديل `hr_settings` |
| `hr.audit.view` | قراءة `hr_audit_logs` وسجل حالات الموظف |
| `hr.payroll.view` | عرض الرواتب وكشوفها (مستقل تمامًا عن `hr.employees.view`) |
| `hr.payroll.manage` | إنشاء/تعديل/اعتماد الرواتب وكشوفها (المرحلة 6) |
| `hr.leave.view` | عرض طلبات الإجازات والأرصدة (المرحلة 3) |
| `hr.leave.manage` | اعتماد/رفض طلبات الإجازات وإدارة الأنواع والأرصدة (المرحلة 3) |
| `hr.leave.request` | تقديم طلب إجازة/استئذان عن النفس (المرحلة 3؛ للموظف المرتبط) |
| `hr.tasks.view` | عرض المهام (المرحلة 4) |
| `hr.tasks.manage` | إنشاء/إسناد/إغلاق المهام (المرحلة 4) |
| `hr.self.view` | عرض بياناتي وطلباتي ومهامي (المرحلة 5؛ للموظف المرتبط فقط) |

**قرار تصميمي:** مفاتيح الرواتب (`hr.payroll.*`) منفصلة عن مفاتيح HR العامة من اليوم الأول — حتى قبل وجود جداول الرواتب (المرحلة 6) — حتى لا يُبنى أي كود لاحقًا يفترض أن `hr.employees.view` يشمل الرواتب. أي RPC يقرأ عمودًا ماليًا يجب أن يفحص `hr.payroll.view` لا غيره.

### 4.2 من يحمل ماذا افتراضيًا (مصفوفة الأدوار)

- **مالك الشركة** (`company_admin` — مشتق، يملك الشركة): كل المفاتيح، بما فيها `hr.payroll.*` و`hr.roles.manage` و`hr.settings.manage`. (مالك الشركة هو صاحب العمل؛ القيد على قراءة الرواتب يخص **مالك المنصة** لا مالك الشركة — §1.6.6.)
- **مدير HR** (`hr_manager` في `hr_role_assignments`): كل المفاتيح عدا `hr.payroll.manage` (الاعتماد المالي يبقى لمالك الشركة أو مسؤول رواتب معتمد) — ويحمل `hr.payroll.view` فقط إن منحه مالك الشركة صراحةً (افتراضيًا **لا**). يحمل: `view/manage/departments/import/link_account/roles.manage/audit.view/settings.manage` + مفاتيح الإجازات والمهام في مرحلتيها.
- **موظف HR** (`hr_officer`): `hr.employees.view` + `hr.employees.manage` (بلا أرشفة نهائية؟ — الأرشفة تتطلب `hr.employees.manage` نفسه؛ القرار: الأرشفة لمدير HR ومالك الشركة فقط، وتُنفَّذ داخل RPC بفحص إضافي على الدور) + `hr.import` + `hr.leave.view/manage` + `hr.tasks.view/manage` + `hr.audit.view`. بلا `hr.link_account` (ربط الحسابات إجراء حساس)، بلا `hr.roles.manage`، بلا `hr.payroll.*`، بلا `hr.settings.manage`.
- **مدير قسم** (`dept_manager` + `department_id`): `hr.employees.view` **مقيد بقسمه فقط** (انظر §4.3) + `hr.leave.view/manage` لطلبات قسمه + `hr.tasks.view/manage` لمهام قسمه. بلا `hr.employees.manage`، بلا `hr.import`، بلا `hr.link_account`، بلا `hr.payroll.*`، بلا `hr.audit.view` (يرى سجل موظفي قسمه فقط عبر RPC القائمة المقيدة، لا السجل العام).
- **مسؤول رواتب** (`payroll_officer`): `hr.payroll.view` + `hr.payroll.manage` (المرحلة 6) + `hr.employees.view` (بيانات تعريفية فقط: الاسم/الرقم/القسم — بلا هاتف/بريد/رقم قومي كامل). بلا `hr.employees.manage`، بلا `hr.import`، بلا `hr.link_account`.
- **الموظف نفسه** (مشتق، لا دور مخزن): `hr.self.view` + `hr.leave.request` (المرحلة 3) — مقيد بـ `hr_employees.user_id = auth.uid()`، أي بملفه هو فقط. لا يرى أي موظف آخر، ولا أي راتب لغيره؛ كشف راتبه هو (المرحلة 6) يُمنح بمفتاح `hr.payroll.view` المقيد بالذات داخل RPC الكشف (يفحص `employee_id = my_employee_id`).

**كيف يُفحص الدور؟** دالة داخلية `hr_has_permission(p_key text)` (بلا GRANT): ترجع true إن كان المتصل مالك الشركة (`is_company_admin()` + الشركة = السياق الحالي)، أو له صف نشط في `hr_role_assignments` (الشركة الحالية + `user_id = auth.uid()` + `revoked_at IS NULL`) بدور يحمل المفتاح حسب المصفوفة أعلاه، أو (للمفاتيح الذاتية) كان مرتبطًا بملف موظف. **الدور يُعاد فحصه في كل استدعاء** (بلا cache، بلا JWT claim) — فإبطال الدور يسري على الاستدعاء التالي فورًا (درس §5.5 في تقرير المستخدمين: لا إبطال جلسة؛ الفحص الحي هو الضمان).

### 4.3 قاعدة نطاق مدير القسم (تُفرض في قاعدة البيانات لا في الواجهة)

- مدير القسم يرى فقط الموظفين حيث `hr_employees.department_id = <قسم المدير>` (من `hr_role_assignments.department_id`)، أو الموظفين الذين `manager_employee_id` = ملف الموظف المرتبط بالمدير. يُنفَّذ كشرط `WHERE` داخل RPCs القوائم والتفاصيل، لا بإخفاء تبويب.
- **مدير القسم لا يرى الرواتب أبدًا افتراضيًا** — حتى لو كان مسؤول رواتب في شركة أخرى؛ `hr.payroll.*` مفاتيح مستقلة ولا تُمنح ضمن دور `dept_manager`.
- المدير المباشر (line manager عبر `manager_employee_id`) يرى موظفيه المباشرين فقط بالقراءة (`hr.employees.view` مقيد)، وطلبات إجازاتهم (المرحلة 3)، ومهامهم (المرحلة 4) — بلا تعديل ملفاتهم وبلا رواتب.
- تجاوز النطاق: مالك الشركة ومدير HR بلا قيد قسم (نطاق الشركة كلها).
- **شركة ثانوية:** لأن الدور مفتاحه (شركة + مستخدم) مباشرةً (§2.7)، مدير قسم في شركة يكون فيها عضوًا ثانويًا يعمل فيها — على عكس `company_staff` (صف ميت في الثانوية). الشركة تُؤخذ من السياق الحالي `current_company_id()` لا من `company_of()`.

---

## 5. كتالوج دوال RPC — المرحلة 2

كل الدوال `SECURITY DEFINER`، `GRANT EXECUTE TO authenticated` فقط (سحب من `public, anon` صراحةً)، وكلها تبدأ بـ `hr_gate(p_section_key)` (§3.3) ثم فحص الصلاحية (§4). لا دالة تقبل `company_id` من العميل (عدا RPCs المالك في §5.6). كل دالة كتابة تُسجَّل في `hr_audit_logs` (والمالك أيضًا في `privileged_audit`). أسماء الدوال الداخلية تبدأ بشرطة سفلية `_hr_*` وتُسحب منها صلاحية التنفيذ (`REVOKE EXECUTE FROM authenticated`).

### 5.1 الموظفون

| الدالة | التوقيع | الحماية والسلوك |
|---|---|---|
| `hr_employee_create` | `(p_full_name text, p_employee_number text, p_phone text DEFAULT NULL, p_email text DEFAULT NULL, p_national_id text DEFAULT NULL, p_department_id uuid DEFAULT NULL, p_branch_id uuid DEFAULT NULL, p_position_id uuid DEFAULT NULL, p_manager_employee_id uuid DEFAULT NULL, p_job_title text DEFAULT NULL, p_hire_date date DEFAULT NULL, p_contract_type text DEFAULT NULL)` → `jsonb` `{employee_id}` | بوابة `hr_employees` + `hr.employees.manage`. تحقق خادمًا: الاسم ≥ حرفين، الرقم الوظيفي غير فارغ وفريد في الشركة (خرق القيد → `23505` برسالة عربية «الرقم الوظيفي مستخدم بالفعل»)، القسم/الفرع/المسمى/المدير ينتمون لنفس الشركة (أي مرجع من شركة أخرى → رفض دون تسريب وجوده)، `user_id` يبقى NULL دائمًا. رقم تلقائي: إن كان `p_employee_number` فارغًا يُولَّد من `hr_settings` (البادئة + العدّاد، مع زيادة العدّاد في نفس المعاملة). يُسجَّل `employee.created` |
| `hr_employee_update` | `(p_employee_id uuid, p_full_name text DEFAULT NULL, p_phone text DEFAULT NULL, p_email text DEFAULT NULL, p_national_id text DEFAULT NULL, p_department_id uuid DEFAULT NULL, p_branch_id uuid DEFAULT NULL, p_position_id uuid DEFAULT NULL, p_manager_employee_id uuid DEFAULT NULL, p_job_title text DEFAULT NULL, p_hire_date date DEFAULT NULL, p_contract_type text DEFAULT NULL)` → `jsonb` | بوابة + `hr.employees.manage`. لا يغيّر `employee_number` ولا `user_id` ولا `employment_status` (لكل منها RPC خاص). يمنع جعل الموظف مديرًا لنفسه أو إنشاء حلقة إدارة (يمشي سلسلة `manager_employee_id`). القيم NULL تعني «بلا تغيير» عدا الحقول القابلة للمسح صراحةً (تُمرَّر كسلسلة فارغة). يسجل `old/new` في التدقيق |
| `hr_employee_archive` | `(p_employee_id uuid, p_reason text)` → `jsonb` | بوابة + `hr.employees.manage` **+ الدور مالك شركة أو مدير HR فقط** (موظف HR العادي لا يؤرشف — §4.2). سبب ≥ 10 أحرف. يضبط `employment_status='terminated'` + `archived_at=now()` + سطر في `hr_employee_status_history` + تدقيق. رفض إن كان مؤرشفًا أصلًا |
| `hr_employee_reactivate` | `(p_employee_id uuid, p_reason text)` → `jsonb` | بوابة + `hr.employees.manage` + (مالك شركة أو مدير HR). يعيد `active` ويُصفّر `archived_at`، ويسجل في التاريخ والتدقيق. لا يعيد رقمًا وظيفيًا أُعيد استخدامه — إن أُعيد استخدام الرقم أثناء الأرشفة يُرفض مع رسالة صريحة |
| `hr_employee_set_status` | `(p_employee_id uuid, p_status text, p_reason text)` → `jsonb` | بوابة + `hr.employees.manage`. انتقالات مسموحة فقط: `active ↔ on_leave`، `active → suspended`، `suspended → active`، وأي حالة → `terminated` (عبر الأرشفة فقط — هذه الدالة ترفض `terminated` مباشرةً). سبب ≥ 10 أحرف + سطر تاريخ + تدقيق |
| `hr_employee_detail` | `(p_employee_id uuid)` → `jsonb` | بوابة + `hr.employees.view` (أو `hr.self.view` لملفه هو). يطبق نطاق القسم (§4.3): مدير قسم خارج قسم الموظف → «غير موجود» (لا تسريب). الرقم القومي كامل فقط لحاملي `view`؛ المدير المباشر يرى نسخة مقنّعة. يرجع الملف + القسم/الفرع/المسمى/المدير (أسماء) + حالة الربط (هل له `user_id`؟ بلا كشف بيانات الحساب) + آخر 10 أحداث من `hr_employee_status_history` |
| `hr_employees_list` | `(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_search text DEFAULT NULL, p_department_id uuid DEFAULT NULL, p_branch_id uuid DEFAULT NULL, p_status text DEFAULT NULL, p_include_archived boolean DEFAULT false)` → `jsonb` `{rows, total, page, page_size}` | بوابة + `hr.employees.view`. **ترقيم خادم + بحث خادم فقط** (نمط `.range()` / `tickets-page-model.js`: افتراضي 20، حد أقصى 100 — `p_page_size` يُقصّ إلى 100 خادمًا). البحث `ilike` على الاسم والرقم الوظيفي والهاتف (`%...%` مع هروب `%`/`_`) — لا تصفية على العميل بعد الجلب (مضاد-النمط الموثق في `admin/tickets.js:485-495`). نطاق القسم يُطبق في `WHERE`. الصفوف بلا رقم قومي كامل (مقنّع) وبلا بريد إلا لحاملي `view`؛ العدّ `total` محسوب في SQL لا بجلب الكل |
| `hr_employees_count` | `()` → `jsonb` `{total, active, on_leave, suspended, terminated}` | بوابة + `hr.employees.view`. عدّادات مجمعة في SQL للوحة (لا جلب صفوف) |

### 5.2 الأقسام والفروع والمسميات (CRUD هرمي)

| الدالة | التوقيع | الحماية والسلوك |
|---|---|---|
| `hr_department_create` / `hr_branch_create` / `hr_position_create` | `(p_name text, p_parent_id uuid DEFAULT NULL, p_description text DEFAULT NULL, p_manager_employee_id uuid DEFAULT NULL, ...)` → `jsonb` | بوابة `hr_employees` + `hr.departments.manage` (أو `hr.employees.manage`). حارس العمق ≤ 6 + منع الحلقة + الأب من نفس الشركة + الاسم فريد داخل الأب (§2.2). `hr_position_create` يأخذ أيضًا `p_department_id` و`p_level` |
| `hr_department_update` / `hr_branch_update` / `hr_position_update` | `(p_id uuid, p_name text DEFAULT NULL, p_parent_id uuid DEFAULT NULL, p_description text DEFAULT NULL, p_manager_employee_id uuid DEFAULT NULL, p_is_active boolean DEFAULT NULL)` → `jsonb` | نفس الحماية. تغيير `parent_id` يعيد فحص العمق والحلقة للشجرة كلها تحت العقدة؛ لا نقل عقدة تحت أحد أحفادها؛ لا نقل تحت عقدة مؤرشفة |
| `hr_department_archive` / `hr_branch_archive` / `hr_position_archive` | `(p_id uuid, p_reason text)` → `jsonb` | نفس الحماية + سبب ≥ 10. يرفض إن كانت تحته عقد غير مؤرشفة أو موظفون نشطون مرتبطون (يُرجع عددهم في رسالة الرفض) — لا أرشفة متتالية صامتة |
| `hr_departments_tree` / `hr_branches_tree` / `hr_positions_list` | `(p_include_archived boolean DEFAULT false)` → `jsonb` | بوابة + `hr.employees.view`. الشجرة تُبنى في SQL بـ CTE متكرر (لا تجميع في العميل)؛ تُرجع العقد مع `depth` و`children_count` و`employees_count` لكل عقدة |

### 5.3 الإعدادات والأدوار

| الدالة | التوقيع | الحماية والسلوك |
|---|---|---|
| `hr_settings_get` | `()` → `jsonb` | بوابة + `hr.employees.view`. تُرجع صف `hr_settings` أو الافتراضيات إن لم يوجد |
| `hr_settings_update` | `(p_employee_number_prefix text DEFAULT NULL, p_default_probation_months integer DEFAULT NULL, p_audit_retention_months integer DEFAULT NULL)` → `jsonb` | بوابة + `hr.settings.manage`. تحقق من النطاقات (§2.3) + تدقيق `settings.changed` |
| `hr_role_grant` | `(p_user_id uuid, p_role text, p_department_id uuid DEFAULT NULL, p_employee_id uuid DEFAULT NULL)` → `jsonb` | بوابة + `hr.roles.manage` (مالك الشركة أو مدير HR). يتحقق: الهدف له عضوية نشطة في الشركة أو هو مالكها، وليس من طاقم المنصة؛ `dept_manager` يتطلب `p_department_id`؛ يرفض الدور المكرر النشط. تدقيق |
| `hr_role_revoke` | `(p_assignment_id uuid, p_reason text)` → `jsonb` | بوابة + `hr.roles.manage`. إبطال (ختم `revoked_at`) لا حذف + تدقيق. يسري على الاستدعاء التالي |
| `hr_roles_list` | `()` → `jsonb` | بوابة + `hr.roles.manage` أو `hr.audit.view`. قائمة التعيينات النشطة + السجل المبطل |

### 5.4 الاستيراد الجماعي (RPC دفعي واحد)

| الدالة | التوقيع | الحماية والسلوك |
|---|---|---|
| `hr_import_employees` | `(p_rows jsonb, p_idempotency_key uuid, p_file_name text DEFAULT NULL)` → `jsonb` | بوابة `hr_employees` + `hr.import`. **التنفيذ الكامل في §6.** ملخص السلوك: حد الصفوف مفروض خادمًا (100 — §6.4)؛ تحقق خادمًا لكل صف؛ إدخال الصالحين في **معاملة واحدة**؛ نتائج لكل صف `{line, employee_number, status: inserted/duplicate/invalid, reason}`؛ `idempotency_key` (إعادة تشغيل ترجع النتيجة المخزنة دون إعادة تنفيذ — §2.5)؛ **لا يكتب أبدًا في `profiles` / `company_memberships` / `company_membership_invitations` / `auth.users`**، ولا يستدعي `company_invite_customer` أو `create-sub-user` أو أي دالة auth-admin؛ `user_id` يبقى NULL لكل صف مستورد. يُسجَّل تشغيل في `hr_import_runs` + تدقيق `import.completed` |
| `hr_import_runs_list` | `(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20)` → `jsonb` | بوابة + `hr.import`. تشغيلات الشركة مرتبة زمنيًا تنازليًا مع العدّادات (بلا `results` الكامل في القائمة) |
| `hr_import_run_detail` | `(p_run_id uuid)` → `jsonb` | بوابة + `hr.import`. التشغيل كاملًا مع `results` لكل صف |

### 5.5 الربط الاختياري بالحساب (صريح وموثّق فقط)

| الدالة | التوقيع | الحماية والسلوك |
|---|---|---|
| `hr_link_employee_account` | `(p_employee_id uuid, p_user_id uuid, p_reason text)` → `jsonb` | بوابة `hr_employees` + `hr.link_account` + سبب ≥ 10 أحرف. **التحقق (بالترتيب، وكل فشل برسالة لا تسرّب):** (1) الموظف في الشركة الحالية وغير مؤرشف؛ (2) الهدف `profiles` موجود (صف فعلي — لا ملف مختلق `is_fallback`؛ الدالة تقرأ الجدول مباشرةً)؛ (3) الهدف له عضوية نشطة في **نفس الشركة** أو هو مالك الشركة؛ (4) الهدف ليس من طاقم المنصة (`role` ليس `platform_owner/admin/support` ولا `owner_capability`)؛ (5) الهدف غير محظور (`is_banned`)؛ (6) الهدف غير مرتبط بموظف آخر في نفس الشركة (موظف واحد لكل حساب داخل الشركة)؛ (7) الموظف غير مرتبط بحساب آخر أصلًا. عند النجاح: يضبط `user_id` + يملأ `hr_role_assignments.employee_id` لصاحب الحساب إن وُجد + تدقيق `employee.linked` (قديم/جديد) + إشعار داخل التطبيق للهدف إن كان له حساب (عبر `notifications` — الموظف بلا حساب لا يستلم إشعارًا). **لا موافقة العميل تُفحص هنا؟** — سؤال مفتوح (§9.5): التدقيق حذّر من نسخ مسار 105/106 الذي يضيف العميل دون موافقته؛ القرار المؤقت: الربط إجراء إداري من الشركة لحساب موظفها، ويُشعَر به الموظف فورًا، ويستطيع فك الربط عن نفسه؟ — يُحسم مع محمود قبل البناء |
| `hr_unlink_employee_account` | `(p_employee_id uuid, p_reason text)` → `jsonb` | بوابة + `hr.link_account` + سبب ≥ 10. يضبط `user_id=NULL` (لا يحذف الموظف ولا الحساب) + تدقيق `employee.unlinked`. فك الربط يسري على الاستدعاء التالي (لا إبطال جلسة — المبدأ من §5.5 في تقرير المستخدمين) |
| `hr_my_employee` | `()` → `jsonb` | بوابة `hr_employees` + (أي مستخدم مرتبط). يرجع ملف الموظف المرتبط بـ `auth.uid()` أو NULL — أساس الخدمة الذاتية (المرحلة 5). لا معامل إطلاقًا |

### 5.6 RPCs المالك (التحكم في الإتاحة)

كلها `SECURITY DEFINER` + `owner_critical_ok()` (تحقق بخطوتين، نافذة 10 دقائق) + سبب ≥ 10 أحرف + تدقيق مزدوج (`log_privileged` + سجل اشتراكات عبر `_hr_audit` + `hr_audit_logs` في الشركة المعنية) + `GRANT EXECUTE TO authenticated` فقط. لا واحدة منها ترجع صفوف موظفين أو PII — الحالات والمفاتيح والعدّادات فقط.

| الدالة | التوقيع | السلوك |
|---|---|---|
| `owner_hr_set_platform_switch` | `(p_enabled boolean, p_reason text)` → `jsonb` | التفاف على `owner_set_feature_switch('hr_module_enabled', ...)` القائم — لا دالة جديدة إن أمكن؛ تُذكر هنا كإجراء لا كـ RPC جديد (قرار: إعادة استخدام القائم) |
| `owner_hr_set_plan_features` | `(p_plan_key text, p_features text[], p_reason text)` → `jsonb` | على نمط `owner_set_store_plan_quota_features` (133:845-879) لكن بمفتاح خطة متغير (لا `key='store'` الثابت — درس التعارض 3). يتحقق من المفاتيح المعروفة (§3.2) ويرفض المجهول `22023`؛ يحدّث `plan_features.enabled` للخطة؛ يسجل التدقيق المزدوج؛ يستدعي `recompute_user_access` للمستخدمين المتأثرين حيث يلزم |
| `owner_hr_grant_override` | `(p_company_id uuid, p_feature_key text, p_expires_at timestamptz DEFAULT NULL, p_reason text)` → `jsonb` | منح/تجديد تجاوز لشركة (مفتاح من §3.2، `reason` 3–300). يرفض الشركة غير الموجودة أو الموقوفة؟ — **قرار:** يسمح للشركة الموقوفة (التجاوز قد يكون جزءًا من إعادة التفعيل) لكن يسجل تحذيرًا في الرد. يُدخل/يحدّث صف `company_feature_overrides` بحالة `active` |
| `owner_hr_revoke_override` | `(p_company_id uuid, p_feature_key text, p_reason text)` → `jsonb` | حذف صف التجاوز (إبطال) + تدقيق. البيانات في الشركة تبقى محفوظة (§3.4) |
| `owner_hr_suspend_section` | `(p_company_id uuid, p_feature_key text, p_reason text)` → `jsonb` | ضبط `status='suspended'` + `suspended_at/by/reason` على صف التجاوز (أو إنشاء صف موقوف إن لم يوجد؟ — **قرار:** يرفض إن لم يوجد صف تجاوز نشط؛ الإيقاف يفترض منحًا قائمًا). الكتابة في القسم تُحجب والقراءة تبقى (§3.4) |
| `owner_hr_resume_section` | `(p_company_id uuid, p_feature_key text, p_reason text)` → `jsonb` | إعادة `status='active'` + مسح حقول الإيقاف + تدقيق |
| `owner_hr_company_status` | `(p_company_id uuid)` → `jsonb` | قراءة حالة الإتاحة لشركة: المفتاح العام + مفاتيح الباقة (عبر `company_has_feature` لكل مفتاح §3.2) + التجاوزات (المفتاح/الحالة/الانتهاء/السبب) + عدّاد الموظفين الكلي والنشط **فقط** (لا أسماء، لا PII). تُستخدم في صفحة المالك |
| `owner_hr_companies_overview` | `(p_search text DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)` → `jsonb` | على نمط `owner_accounts_overview` (133:1103-1181): بحث بالاسم/البريد/اسم الشركة، ترقيم خادم (حد أقصى 100)، كل شركة مع حالة HR (مفعّل/موقوف/بلا استحقاق/تجربة) + عدّاد موظفين فقط |

### 5.7 دوال داخلية (بلا GRANT — `_hr_*`)

`_hr_gate(p_section_key)` (§3.3)؛ `_hr_has_permission(p_key)` (§4.2)؛ `_hr_in_my_scope(p_employee_id)` على نمط `ticket_in_my_scope()` (ترجع boolean عن المنادي فقط: الموظف في الشركة الحالية + ضمن نطاق قسم المنادي + غير مؤرشف إلا بصلاحية صريحة)؛ `_hr_audit(p_company, p_action, p_entity_type, p_entity_id, p_old, p_new, p_reason)` (كتابة `hr_audit_logs` + سجل الاشتراكات حيث يلزم)؛ `_hr_validate_employee_row(p_row jsonb)` (التحقق المشترك بين الإنشاء والاستيراد — قاعدة واحدة لا منطقين)؛ `_hr_check_depth(p_table, p_parent_id)` (حارس العمق ≤ 6).

### 5.8 ما لا يوجد في المرحلة 2 (عمدًا)

لا RPCs إجازات/مهام/رواتب/حضور/مستندات/تقييم (مراحلها الخاصة)؛ لا دعوة موظف (الدعوة الاختيارية الآمنة في المرحلة 5 فقط، على نموذج `company_membership_invitations` مع token_hash + استهلاك عند الاستخدام — لا نسخ شكل «المطالبة دون استهلاك»)؛ لا نقل موظف بين شركتين (إن طُلب يومًا: دلالة نقل واحدة موثقة، لا نسخ مساري 101/129 المتعارضين)؛ لا حذف فعلي لأي سجل.

---

## 6. تصميم الاستيراد الجماعي

### 6.1 المبدأ

إعادة استخدام **هيكل** الاستيراد الحالي للعملاء فقط (ملف → تحليل → معاينة → تقرير)، واستبدال **التنفيذ بالكامل** بـ RPC دفعي واحد خادمًا. الاستيراد الحالي: تحليل CSV في المتصفح + استدعاء Edge Function **لكل صف على حدة** (متسلسل، بلا معاملة، بلا معرّف دفعة، بلا استئناف؛ إغلاق التبويب يوقف التنفيذ في المنتصف) — هذا النمط ممنوع نسخه. استيراد HR: **استدعاء RPC واحد** `hr_import_employees` يحمل كل الصفوف، يتحقق خادمًا، ويُدخل الصالحين في **معاملة واحدة**، ويعيد نتائج كل صف.

**الممنوعات الصريحة:** لا يمر عبر `company-invite-customer` ولا `create-sub-user` ولا أي Edge Function دعوات؛ لا يكتب في `profiles` / `company_memberships` / `company_membership_invitations` / `auth.users`؛ لا يرسل بريدًا؛ لا ينشئ حسابات؛ `user_id` يبقى NULL لكل صف مستورد.

### 6.2 قالب الملف — الأعمدة

ملف CSV (فاصلة فقط، UTF-8، BOM مسموح) — أو XLSX يُقرأ في المتصفح عبر تبعية `xlsx` الموجودة أصلًا في `package.json` ثم يُرسل كمصفوفة صفوف JSON (الخادم لا يحلل ملفات؛ يستقبل `jsonb`). تنزيل القالب: زر «تنزيل القالب» يولّد Blob كما في `downloadBulkInviteTemplate`.

| العمود (يقبل المرادفات العربية/الإنجليزية) | مطلوب؟ | القاعدة |
|---|---|---|
| `employee_number` / `الرقم الوظيفي` | **مطلوب** (أو يُترك فارغًا فيُرقَّم تلقائيًا من `hr_settings` — قرار: الفراغ مسموح ويُرقم تلقائيًا؛ الرقم المكرر مرفوض) | نص، فريد داخل الشركة (§2.1) |
| `full_name` / `الاسم` / `اسم الموظف` | **مطلوب** | ≥ حرفين بعد القص |
| `phone` / `الهاتف` / `الجوال` | اختياري (مطلوب إن كان `employment_status` ليس `pending_data`) | 7–20 حرفًا، أرقام و`+` ومسافات و`-` فقط |
| `email` / `البريد الإلكتروني` | اختياري | صيغة بريد صالحة (نفس regex الاستيراد الحالي `^[^\s@]+@[^\s@]+\.[^\s@]+$`)؛ معلوماتي فقط |
| `national_id` / `الرقم القومي` | اختياري | 14 رقمًا (مصر) أو فارغ؛ يُقبل أي نص 10–20 حرفًا لغير المصريين — **قرار مؤقت** يُحسم في §9.6 |
| `department` / `القسم` | اختياري | اسم قسم موجود في الشركة (مطابقة بالاسم بعد القص؛ غير الموجود → الصف `invalid` مع السبب، لا يُنشأ قسم تلقائيًا) |
| `branch` / `الفرع` | اختياري | كالقسم |
| `position` / `المسمى الوظيفي` | اختياري | كالقسم |
| `manager_employee_number` / `الرقم الوظيفي للمدير` | اختياري | رقم موظف موجود (في الملف نفسه أو في قاعدة البيانات)؛ غير الموجود → `invalid` |
| `job_title` / `المسمى` | اختياري | نص حر |
| `hire_date` / `تاريخ التعيين` | اختياري | `YYYY-MM-DD`، ≤ اليوم |
| `contract_type` / `نوع العقد` | اختياري | من تعداد §2.1؛ غيره → `invalid` |

**قاعدة `pending_data`:** صف بلا هاتف ولا بريد ولا رقم قومي يُقبل كموظف `pending_data` **فقط** إن كان الاسم والرقم الوظيفي صحيحين — ويُميَّز في التقرير. أي صف بلا اسم أو بلا رقم وظيفي (ولا ترقيم تلقائي مطلوب) → `invalid`.

### 6.3 قواعد التحقق لكل صف (تُنفَّذ في الخادم — العميل يعرض تحققًا أوليًا فقط)

القاعدة الواحدة `_hr_validate_employee_row()` تُستخدم في الإنشاء اليدوي والاستيراد (لا منطقين). ترتيب الفحص: الصيغة → التكرار داخل الملف → التكرار ضد قاعدة البيانات → المراجع (قسم/فرع/مسمى/مدير).

1. الاسم موجود ≥ حرفين.
2. الرقم الوظيفي: غير فارغ (أو ترقيم تلقائي)؛ بلا مسافات داخلية؛ غير مكرر داخل الملف؛ غير موجود في الشركة (بما فيها المؤرشفون — الرقم المؤرشف محجوز، §2.1.1).
3. الهاتف (إن وُجد): الصيغة؛ غير مكرر داخل الملف لنفس الشركة؟ — **قرار:** الهاتف ليس مفتاح تكرار (قد يشترك موظفون في هاتف مؤسسي)؛ التكرار فيه تحذير في المعاينة فقط، لا رفض.
4. البريد (إن وُجد): الصيغة؛ غير مكرر داخل الملف؛ غير موجود في الشركة (الفهرس الفريد الجزئي §2.1).
5. الرقم القومي (إن وُجد): الصيغة؛ غير مكرر داخل الملف؛ غير موجود في الشركة.
6. القسم/الفرع/المسمى (إن وُجدت): موجودة ونشطة في الشركة.
7. المدير (إن وُجد): موجود (في الملف أو قاعدة البيانات)؛ ليس الموظف نفسه؛ بلا حلقة إدارة (تُفحص بعد الإدخال بترتيب الصفوف: صفوف المديرين تُدخل قبل مرؤوسيهم — تُرتَّب الصفوف طوبولوجيًا داخل المعاملة، والدورة → كل الصفوف المعنية `invalid`).
8. التاريخ والنوع: ضمن النطاقات.

### 6.4 كشف التكرار

- **المفتاح الرسمي: `employee_number` داخل الشركة** (قرار محمود 2). يُفحص داخل الملف (مجموعة `seen`) وضد قاعدة البيانات (استعلام واحد `WHERE employee_number = ANY(...)` لا استعلام لكل صف).
- **مفاتيح ثانوية (رفض أيضًا):** البريد (فريد جزئيًا داخل الشركة) والرقم القومي (فريد جزئيًا داخل الشركة). الهاتف **ليس** مفتاح تكرار (§6.3.3).
- **سباق المعاينة والتنفيذ:** لقطات العميل (القوائم الموجودة) قديمة لحظة التنفيذ — الخادم هو الحكم النهائي؛ المعاينة تقول «جاهز حسب آخر لقطة» لا «مضمون». (فجوة موثقة في الاستيراد الحالي §4.3.)

### 6.5 التدفق (إعادة استخدام هيكل الاستيراد الحالي)

1. **رفع الملف:** `<input type="file" accept=".csv,text/csv,.xlsx">`؛ حد الحجم 1MB (كما الحالي)؛ إصلاح ثغرة البوابة الحالية (`!nameOk && !typeOk` — تُرفض إن فشل **أي** من الاسم أو النوع)؛ فحص المحتوى لا الاسم فقط؛ الملف لا يغادر المتصفح (يُقرأ بـ `file.text()` أو `XLSX.read`).
2. **التحليل (عميل — دوال خالصة في `hr-import-model.js`):** إعادة استخدام شكل `parseCsvLine` (حقول مقتبسة، `""` للهروب، اقتباس غير مغلق → خطأ) و`parseCustomersCsv` (BOM/CRLF/سطور فارغة/ترويسة اختيارية، `{rows, errors}` بأرقام السطور) مع **استبدال** مفردات الترويسة بأعمدة §6.2 ودعم حقول مقتبسة متعددة الأسطر (فجوة موثقة في الحالي: سطر مقتبس فيه سطر جديد كان يُقسَّم). لا حد للفاصلة فقط — الفاصلة المنقوطة والتاب تُرفضان برسالة صريحة لا بصمت.
3. **حد الصفوف: 100 — مفروض خادمًا.** الحد الحالي (100) موجود في العميل فقط؛ في HR يُفرض في RPC (`array_length(p_rows) > 100` → رفض كامل `54000`). الملف الأكبر يُقسَّم إلى دفعات 100 من العميل (كل دفعة `idempotency_key` مستقل).
4. **التحقق الأولي (عميل):** نفس شكل `validateBulkInviteRows` (لكل صف `{line, …, reason}` → `{valid, invalid}` + `seen` داخل الملف) بقواعد §6.3 على لقطة محلية؛ الترويسة صريحة: «تحقق أولي — القرار النهائي للخادم».
5. **المعاينة:** نفس شكل `renderBulkInvitePreview` (عدّاد `N جاهز · M مرفوض · K سطر غير صالح` + سطر لكل صف مع شارة)؛ الزر «تنفيذ الاستيراد (N موظفًا)» مفعّل فقط إن كان `valid.length > 0`؛ الصفوف المرفوضة لن تُرسل.
6. **التنفيذ:** **استدعاء RPC واحد** `hr_import_employees(p_rows, p_idempotency_key, p_file_name)` (لا حلقة N-call). تقدّم: «جارٍ التنفيذ…» ثم التقرير. إغلاق التبويب أثناء التنفيذ لا يلغي المعاملة الخادمية (بدأت وانتهت في الخادم) — ويمكن عرض نتيجتها لاحقًا من `hr_import_runs_list` بنفس المفتاح.
7. **التقرير النهائي:** ملخص (`أُدخل X · مكرر Y · مرفوض Z`) + سطر لكل صف مرسل بالحالة والسبب + زر تنزيل تقرير CSV. يُحفظ التشغيل في `hr_import_runs` (قابل للعرض لاحقًا) + تدقيق `import.completed`. تحديث القائمة بعد التنفيذ.

### 6.6 تصنيف الأخطاء (Error Taxonomy — رسائل عربية ثابتة)

| الرمز | المعنى | يظهر في |
|---|---|---|
| `missing_name` | الاسم مطلوب (أقل من حرفين) | معاينة + تقرير |
| `missing_employee_number` | الرقم الوظيفي مطلوب (والترقيم التلقائي غير مفعّل) | معاينة + تقرير |
| `duplicate_in_file` | الرقم الوظيفي/البريد/الرقم القومي مكرر داخل الملف | معاينة + تقرير |
| `duplicate_employee_number` | الرقم الوظيفي موجود في الشركة (بما فيه المؤرشف) | تقرير (الخادم) |
| `duplicate_email` / `duplicate_national_id` | البريد/الرقم القومي موجود في الشركة | تقرير (الخادم) |
| `invalid_phone` / `invalid_email` / `invalid_national_id` / `invalid_date` / `invalid_contract_type` | صيغة غير صالحة | معاينة + تقرير |
| `unknown_department` / `unknown_branch` / `unknown_position` / `unknown_manager` | المرجع غير موجود في الشركة | معاينة (من اللقطة) + تقرير |
| `manager_cycle` | حلقة إدارة (مدير يدير نفسه مباشرة أو عبر سلسلة) | تقرير |
| `parse_error` | سطر غير صالح (اقتباس غير مغلق، أعمدة ناقصة) | معاينة |
| `row_limit_exceeded` | الملف يتجاوز 100 صف (يُرفض كاملًا) | رفع |
| `import_replayed` | إعادة إرسال نفس المفتاح — أُعيدت النتيجة المخزنة دون تنفيذ | تقرير (مع شارة «أُعيد تشغيله») |
| `not_entitled` / `forbidden` | القسم غير مفعّل أو بلا صلاحية `hr.import` | تنفيذ |

---

## 7. تصميم الواجهة (UI)

### 7.1 لوحة الشركة — قسم HR

**التوجيه:** مجموعة جديدة في `COMPANY_GROUPS` في `assets/js/company/company-routes.js` باسم «الموارد البشرية»، تضم الصفحات: `hr-employees` (الموظفون)، `hr-departments` (الأقسام والفروع والمسميات)، `hr-import` (الاستيراد الجماعي)، `hr-settings` (إعدادات HR)، `hr-audit` (سجل HR). كل صفحة: حاوية `#<page>TabContent` في `company-dashboard/index.html` + محمّل في `LOADERS` + إدخال في `pageAvailable()` (تُخفى المجموعة كلها إن لم يكن `company_has_feature('hr')` و`hr_employees` — الإخفاء تجميلي؛ القرار في RPCs).

**الملفات (نماذج خالصة أولًا):**

| الملف | الدور |
|---|---|
| `assets/js/company/hr-employees-model.js` | دوال خالصة: بناء صف الموظف للعرض (تقنيع الرقم القومي/الهاتف حسب الصلاحية)، فلترة/فرز محلية **بعد** جلب خادم (لا بديل عن بحث الخادم)، قواعد التحقق الأولية للنموذج، تنسيق الحالات بالعربية |
| `assets/js/company/hr-org-model.js` | دوال خالصة: بناء الشجرة من مصفوفة مسطحة، فحص العمق والحلقة في العميل (تحقق أولي — الخادم يحسم)، تسميات الأقسام/الفروع/المسميات |
| `assets/js/company/hr-import-model.js` | دوال خالصة: تحليل CSV/XLSX، مفردات ترويسة §6.2، `validateHrImportRows`، `summarizeHrImportResults`، قالب CSV — على شكل `company-model.js:491-640` مع استبدال القواعد |
| `assets/js/company/hr-data.js` | طبقة RPC فقط (`supabase.rpc('hr_*', …)`) على نمط `company-data.js` — بلا DOM وبلا منطق عرض |
| `assets/js/company/hr-dashboard.js` | الربط/العرض: الصفحات الخمس + المعاينة والتقرير + القوائم المرقّمة (20/صفحة افتراضيًا) |
| `assets/js/company/hr-roles-model.js` | (لاحقًا مع الأدوار) دوال خالصة لمنح/عرض الأدوار |

**إعادة الاستخدام (لا إعادة بناء):** محلل CSV + نمط المعاينة/التقرير من الاستيراد الحالي (`company-model.js:491-580`، `company-dashboard.js:1370-1560`)؛ نمط الترقيم `.range()` + `tickets-page-model.js` (20 افتراضيًا، 100 حدًا أقصى)؛ `report-export.js` (تصدير CSV بترميز UTF-8 + BOM + حماية من حقن الصيغ، وXLSX عبر SheetJS) لقوائم الموظفين؛ مكونات القوائم والبطاقات والشارات القائمة في لوحة الشركة؛ `notifications-service.js` لإشعارات الربط/الأرشفة (للمستخدمين المرتبطين فقط).

**قواعد الواجهة:**

- عربي RTL بالكامل؛ كل الرسائل والأخطاء والتسميات عربية (لا أكواد إنجليزية خام للمستخدم — على نمط قرار محمود بتعريب سجل التدقيق).
- **لا أزرار وهمية:** كل زر في صفحات HR يستدعي RPC يعمل (§5). زر بلا خلفية لا يُدمج — يُحذف من الصفحة لا يُترك معطّلًا بصمت. (الاستثناء الوحيد المسموح: زر «قريبًا» لمرحلة لاحقة يُعلن صراحةً أنه غير متاح ويشرح متى يأتي — لا زر يبدو يعمل ولا يعمل.)
- البحث في القوائم خادمًا (`ilike`/`eq`) لا تصفية عميل بعد الجلب.
- مدير القسم يرى قسمه فقط لأن RPC يرجع قسمه فقط — لا فلترة إضافية في العميل (ولو عُدّل الطلب عاد الخادم بنفس النطاق).
- مبدّل شركة: لا مبدّل في لوحة الشركة اليوم (التبديل في البوابة فقط) — HR لا يبني مبدّلًا خاصًا في المرحلة 2؛ مدير شركتين يبدّل من البوابة (سؤال مفتوح §9.8 إن أراد محمود مبدّلًا داخل اللوحة).
- صفحة الموظفين: جدول (الرقم، الاسم، القسم، المسمى، الهاتف، الحالة، الربط) + بحث + فلاتر (قسم/فرع/حالة) + زر «موظف جديد» + زر «استيراد» + تصدير CSV. تفاصيل الموظف: بطاقة ملف + تاريخ الحالات + زر أرشفة/إعادة تفعيل + زر ربط/فك حساب (لمن يملك `hr.link_account`).

### 7.2 لوحة المالك — صفحة/قسم التحكم في HR

**المكان:** قسم «إدارة وحدات المنصة» في الحوكمة (`assets/js/owner/tenancy-governance.js`) أو صفحة `owner/` جديدة `owner/hr.html` + `assets/js/owner/pages/hr.js` — **القرار:** صفحة مستقلة `owner/hr.html` (لأن التحكم يشمل 3 مستويات + قوائم شركات + سجل عمليات، وهو أكبر من قسم فرعي)، مرتبطة من الحوكمة.

**الأقسام:**

1. **المفتاح العام:** حالة `hr_module_enabled` + زر تشغيل/إطفاء (عبر `owner_set_feature_switch()` القائم) مع سبب ≥ 10 أحرف + تحذير صريح بأن الإطفاء يوقف HR في كل الشركات دون حذف بيانات.
2. **ميزات الباقات:** جدول الخطط × مفاتيح §3.2 (مربعات اختيار لكل خطة) عبر `owner_hr_set_plan_features` + سبب؛ مع تحذير قبل تعطيل `hr` أو `hr_payroll` لخطة تحوي شركات مفعّلة (يُعرض عدد الشركات المتأثرة قبل التأكيد — يُحسب عبر `owner_hr_companies_overview`).
3. **التجاوزات لكل شركة:** بحث شركة + منح تجاوز (مفتاح + انتهاء اختياري + سبب) / إبطال / إيقاف قسم / استئناف — عبر RPCs §5.6 — مع عرض حالة كل شركة (مفعّل/موقوف/منتهٍ/بلا استحقاق) وعدّاد موظفين **فقط**.
4. **سجل العمليات:** على نمط `owner_store_operations_log` (133:885+) — اتحاد `privileged_audit` (`action like 'hr.%'`) + سجل الاشتراكات + `hr_audit_logs` للأحداث `entitlement.*`، بملخصات عربية، حد 30 افتراضيًا (1–100).
5. **تنبيهات داخل الصفحة فقط** (لا قناة دفع لتنبيهات المالك اليوم — §7 في تقرير المستخدمين): تنبيه عند تجاوز ينتهي خلال 7 أيام، وعند شركة بلا استحقاق طلبت HR.

**قاعدة صارمة:** صفحة المالك لا تعرض أي صف موظف ولا أي PII ولا أي راتب — عدّادات وحالات ومفاتيح فقط. أي رابط «عرض موظفي الشركة» ممنوع في هذه الصفحة.

### 7.3 الخدمة الذاتية للموظف (المرحلة 5 — تُذكر هنا كحدود فقط)

لا تُبنى في المرحلة 2. حدودها المثبتة من الآن: دخول عبر نفس بوابات المنصة (Turnstile + 2FA — لا مسار دخول مخفف)؛ العرض مقيد بملف الموظف المرتبط (`hr_my_employee`)؛ الدعوة الاختيارية على نموذج `company_membership_invitations` (token_hash + انتهاء + **استهلاك عند الاستخدام** — لا نسخ شكل «المطالبة دون استهلاك»).

---

## 8. خطة التنفيذ المرحلية + خطة الاختبارات

### 8.1 المراحل (الترقيم المصحح — §0.3)

| المرحلة | المحتوى | المخرج |
|---|---|---|
| **1 — التدقيق (مكتملة)** | تقرير المراجعة الإلزامي + 3 تقارير مسارات + هذا التصميم | هذا الملف + تقارير التدقيق |
| **2 — الأساسيات والموظفون (هذا التصميم)** | `feature_flags` لـ HR + توسيع قيد 092 + `hr_employees` + `hr_departments/branches/positions` + `hr_settings` + `hr_audit_logs` + `hr_import_runs` + `hr_employee_status_history` + `hr_role_assignments` + RPCs §5 + قسم `company-routes.js` + صفحة مالك + الاستيراد الدفعي + حالات الموظفين (أرشفة لا حذف) + الصلاحيات الأساسية | ترحيل **143** + واجهات §7.1–7.2 + اختبارات §8.2 |
| **3 — الإجازات والاستئذان** | `hr_leave_types` + `hr_leave_balances` + `hr_leave_requests` + `hr_permission_requests` + `hr_holidays` + `hr_work_calendars` + مسارات موافقة قابلة للتخصيص + فحص تداخل (GiST على `daterange`) + خصم رصيد عند الاعتماد فقط + إشعارات (فئات `hr_leave` في `derive_notification_category` + triggers على تغيير الحالة) | ترحيل 144 (أو التالي المتاح) |
| **4 — المهام والتشغيل** | `hr_tasks` + `hr_task_assignments` + `hr_task_templates` (متكررة بمفتاح منع تكرار على نمط `wf_scheduled_resumes`) + رابط قراءة فقط `ticket_id` + تقارير | ترحيل تالٍ |
| **5 — الخدمة الذاتية** | ربط الملف بحساب (إجراء صريح موثّق — §5.5) + دعوة اختيارية آمنة (token_hash + استهلاك) + تقديم الطلبات + متابعة المهام + `hr_announcements` + `hr_announcement_reads` + الوصول الآمن لمعلوماته | ترحيل تالٍ |
| **6 — الإدارة المالية (آخر مرحلة مالية)** | `hr_salary_records` + `hr_salary_history` (إلحاقي) + `hr_payroll_periods` + `hr_payroll_lines` + اعتماد منفصل عن الإدارة + تصدير — جداول معزولة وسياسات خاصة وسجل تعديلات append-only | ترحيل تالٍ |
| **7 — الوظائف المتقدمة** | الحضور والانصراف والورديات (`hr_attendance` — مع دراسة إعادة استخدام SDK ‏`sdk/mad3oom-activity-client.js` غير الموصول وقناة `eo_ingest_activity`، بلا دمج مع `emp_ops` وبلا خلط بيانات؛ §0.7) + المستندات والعقود (`hr_documents` على نموذج 100، مستودع `hr-documents` مستقل) + `hr_evaluations` + `hr_admin_decisions` + التقارير المتقدمة (`hr_reports`) | ترحيل تالٍ |

**قواعد ملزمة لكل مرحلة** (من تقرير التدقيق §10، تُعاد هنا لأنها جزء من التصميم): فرع عمل مستقل (لا عمل على `main` مباشرة)؛ ترحيل مسجل رسميًا في `schema_migrations`؛ تحديث `tests/fixtures/prod-shape/` في نفس التغيير؛ اختبارات مستقلة للمرحلة + اختبارات انحدار كاملة مقارنة بالأساس **بالاسم**؛ لا تطبيق حي ولا نشر ولا تفعيل تجاري دون موافقة صريحة من محمود؛ عند ظهور تحذير مخاطر أو طلب موافقة أمني، التوقف قبل التنفيذ الحي وشرح العملية والمخاطر والتأثير. **ولا ترحيلان بنفس الرقم أبدًا** — يُفحص الرقم التالي المتاح قبل كل مرحلة (درس 142).

### 8.2 خطة الاختبارات (المرحلة 2)

**قبل أي كود:** تثبيت خط أساس `npm test` كاملًا (Node + SQL + HTTP) والمقارنة **بالاسم لا بالعدد** (درس التقرير: العدّ بالأسطر أعطى 57 بدل 28 الحقيقي؛ والمقارنة بالعدد أخفت 11 فشلًا في `admin-subscription-details`).

**اختبارات Node (نماذج خالصة):**
- `hr-employees-model`: تقنيع الرقم القومي، تنسيق الحالات، بناء صف العرض حسب الصلاحية.
- `hr-org-model`: بناء الشجرة، فحص العمق والحلقة (تحقق أولي).
- `hr-import-model`: تحليل CSV (BOM/CRLF/حقول مقتبسة/اقتباس غير مغلق/حقول متعددة الأسطر)، مفردات الترويسة العربية/الإنجليزية، `validateHrImportRows` (كل رمز في §6.6)، `checkHrImportLimit` (الصفوف + سطور الأخطاء تُحسب)، `summarizeHrImportResults`.
- اختبارات routes: ظهور مجموعة HR في `COMPANY_GROUPS` + `pageAvailable()` تخفيها بلا استحقاق (عرض فقط — القرار في RPCs).
- اختبارات انحدار: لا تغيير في `company-model.js` / `company-routes.js` خارج إضافة المجموعة؛ لا تغيير في أي RPC قائم.

**اختبارات SQL (Postgres مؤقت — على نمط `tests/sql/`):**
- إنشاء الجداول + الفهارس + القيود (UNIQUE، CHECK الحالة، حارس العمق 6، حارس الإلحاق في `hr_audit_logs`).
- `hr_gate()`: كل حالة في §3.4 (منصة مطفأة / بلا استحقاق / تجاوز منتهٍ / قسم موقوف / اشتراك موقوف) — تُفحص كل حالة على حدة.
- العزل: حساب شركة ثانية (لا حساب المالك فقط — درس ثغرة IDOR في `ticket_replies` 033) يحاول قراءة/كتابة موظف شركة أولى عبر RPC وعبر PostgREST مباشر → يُرفض في الحالتين.
- `hr_employee_create/update/archive`: التكرار (`23505` → رسالة عربية)، المرجع من شركة أخرى → رفض، `user_id` يبقى NULL بعد الإنشاء والاستيراد، الأرشفة تتطلب سببًا ودورًا.
- `hr_import_employees`: 100 صف (حد خادم)، 101 → رفض كامل؛ صفوف مختلطة (صالح/مكرر/غير صالح) → نتائج لكل صف + إدخال الصالحين فقط في معاملة واحدة؛ إعادة نفس `idempotency_key` → نفس النتيجة دون إدخال مكرر؛ الاستيراد لا يكتب في `profiles`/`company_memberships` (عدّ الصفوف قبل/بعد = بلا تغيير).
- `hr_link_employee_account`: كل فشل في §5.5 على حدة (هدف غير موجود / بلا عضوية / من طاقم المنصة / محظور / مرتبط بموظف آخر / موظف مرتبط أصلًا) + النجاح + فك الربط.
- نطاق مدير القسم: مدير قسم يرى قسمه فقط في `hr_employees_list` و`hr_employee_detail`؛ بلا رواتب (لا RPC رواتب في المرحلة 2 — يُفحص غياب العمود المالي في رد القائمة).
- RPCs المالك: بلا `owner_critical_ok()` → رفض؛ سبب قصير → رفض؛ المنح/الإيقاف/الاستئناف + التدقيق المزدوج.
- تحديث `tests/fixtures/prod-shape/` في نفس التغيير (جداول/دوال/فهارس HR) وإلا اتّسع الانجراف.

**اختبارات HTTP:** 24 متخطى اليوم — لا اختبار متصفح حي (لا بيئة تجريبية؛ الاختبار الحي الوحيد هو الإنتاج، ويتم بموافقة صريحة فقط).

**معيار القبول للدمج:** صفر فشل جديد **بالاسم** مقارنة بخط الأساس المثبت؛ كل فشل سابق يبقى مطابقًا بالاسم؛ ملفات الترحيل 143 تحمل شروطًا مسبقة واختبارات ذاتية (DO blocks) على نمط 129/133.

---

## 9. أسئلة مفتوحة لمحمود (تحجب البناء)

1. **موافقة صريحة على بدء المرحلة 2** في فرع `hr-module` وبيئة اختبار معزولة (دون تطبيق حي أو نشر حتى موافقتك على كل خطوة)؟ — القرار 5 في تقرير التدقيق، ما زال بلا إجابة.
2. **الربط والموافقة (§5.5):** عند ربط موظف بحساب دخول، هل يُشترط موافقة صريحة من الموظف (صاحب الحساب) قبل الربط، أم يكفي إشعاره فورًا؟ وهل يستطيع الموظف فك الربط عن نفسه؟ (التدقيق حذّر من نسخ مسار 105/106 الذي يضيف العميل دون موافقته.)
3. **التجربة المجانية لـ HR:** هل تُتاح HR بتجربة 3 أيام على نمط SaaS (طلب من الشركة → موافقة مالك أولًا → استحقاق مؤقت)؟ وإن نعم، هل التجربة تشمل كل الأقسام أم الموظفين فقط؟ (فخ الترتيب في 137: الموافقة على التجربة تتطلب الخطة `is_active` — هل ينطبق على HR؟)
4. **أسعار HR:** هل HR ضمن باقات `support`/`ultimate` الحالية أم ميزة تُباع مستقلة؟ وإن مستقلة، ما سعرها الشهري/السنوي (على نمط 500/5000 للمتجر)؟ — يحجب `owner_hr_set_plan_features` (لا أسعار في التصميم).
5. **الرقم القومي (§2.1، §6.2):** هل يُخزَّن كنص صريح (كما في `profiles`) أم يُجزَّأ/يُشفَّر؟ وهل صيغته 14 رقمًا إلزامية (مصر) أم يُقبل أي نص 10–20 حرفًا؟ وهل هو مطلوب في الاستيراد أم اختياري؟
6. **إعادة استخدام الرقم الوظيفي المؤرشف (§2.1.1):** بعد أرشفة موظف، هل يُسمح بإعادة استخدام رقمه لموظف جديد في نفس الشركة (مع سجل تدقيق) أم يبقى محجوزًا للأبد؟
7. **مستودع المستندات (المرحلة 7):** مستودع `hr-documents` مستقل (الأنظف للعزل والاحتفاظ) أم أنواع جديدة داخل `company-documents`؟ — القرار المفتوح في التدقيق §2/§7، يؤثر على تصميم المرحلة 7 فقط.
8. **مبدّل الشركة في لوحة الشركة (§7.1):** مدير HR في شركتين يرى شركة واحدة (السياق الحالي) ولا مبدّل في اللوحة — هل يُضاف مبدّل شركة داخل لوحة الشركة في المرحلة 2 أم يبقى التبديل من البوابة؟
9. **حذف بيانات الشركة ذاتيًا (140) وHR:** طلب حذف حساب الشركة ذاتيًا — هل يشمل حذف سجلات `hr_*` (بما فيها سجل التدقيق) أم تُستثنى وتُحذف يدويًا بقرار مالك منصة؟ (التصميم الحالي: لا حذف فعلي أبدًا.)
10. **إصلاح `account_is_active()` (ثغرة الحظر HIGH):** هل يُصلح أولًا (ربط `is_banned()` فيه) بقرار منتج صريح — مع العلم أن الإصلاح يغيّر دلالات المسار المعفي للمالك — أم تبقى HR تفحص `is_banned()` في كل RPC (التصميم الحالي يفعل ذلك)؟ هذا خارج HR لكنه يحجب الثقة في أي سياسة `gate_account_active` جديدة.
11. **حد الاستيراد (100):** هل 100 صف/تشغيل مناسب، أم يُرفع (مثلًا 500) مع دفعات؟ — الحد الحالي مطابق للحد الأدنى المطلوب؛ أي ملف أكبر يحتاج دفعات.
12. **هل يُمنح مالك الشركة `hr.payroll.view` افتراضيًا؟** التصميم يقول نعم (هو صاحب العمل) — تأكيد مطلوب، لأن أي استثناء هنا يغيّر مصفوفة §4.2 كلها.

## 9ب. الإجابات المعتمدة (محمود، 2026-11-26 ~07:31 EET — موافقة على كل التوصيات مع تعديل السعر)

1. محسومة — المرحلة 2 وُوفق عليها ونُفذت في فرع `hr-module`.
2. **الربط:** إشعار فوري للموظف + حق فك الربط عن نفسه في أي وقت، بدون موافقة مسبقة؛ الفك يُسجل في التدقيق.
3. **التجربة:** 3 أيام، موافقة مالك أولًا، تشمل الموظفين والإجازات والمهام — بدون الرواتب؛ ولا تتطلب الخطة `is_active`.
4. **السعر (معدَّل بقرار محمود):** HR مشمولة **مجانًا في الفائقة والشاملة فقط**؛ لا سعر مستقل ولا بيع منفصل — خطة الدعم لا تحصل على HR إلا بالترقية.
5. **الرقم القومي:** نص صريح كما في `profiles`، مقنّع في القوائم وكامل في التفاصيل لحاملي الصلاحية؛ أي نص 10–20 حرفًا؛ اختياري في الاستيراد.
6. **الرقم الوظيفي المؤرشف:** محجوز للأبد، لا إعادة استخدام.
7. **المستندات:** مستودع `hr-documents` مستقل.
8. **مبدّل الشركة:** يتأجل؛ التبديل من البوابة.
9. **الحذف الذاتي:** سجلات HR مستثناة من الحذف التلقائي؛ حذف يدوي بقرار مالك منصة موثّق فقط؛ سجل التدقيق لا يُحذف أبدًا.
10. **`account_is_active()`:** يُصلح في ترحيل صغير منفصل قبل التفعيل التجاري (لا قبل الدمج)، مع الحفاظ على إعفاء المالك.
11. **حد الاستيراد:** 100 صف/تشغيل، مفروض خادمًا.
12. **مالك الشركة:** يحصل على `hr.payroll.view` افتراضيًا.

---

## 10. المراجع

- تقرير المراجعة الإلزامي — `workspace/goals/goal/files/HR-audit-report-2026-11-25.md`
- `hidden_files/audit-structure-2026-11-25.md` (البنية والتحكم والاستيراد-هيكل)
- `hidden_files/audit-users-permissions-bulk-import-2026-11-25.md` (المستخدمون والصلاحيات والاستيراد والدعوات والإيقاف والتحكم)
- `hidden_files/audit-tickets-tasks-notifications-security-2026-11-25.md` (التذاكر والمهام والإشعارات والسجل والأمان والأداء)
- مراجعة رابط الحضور 2026-11-25 ~23:58 EET (ملخصها في `MEMORY.md`: `emp-mad3oom` نظام داخلي، SDK غير موصول)

*تصميم فقط — لم يُكتب كود، ولم يُنفَّذ SQL، ولم تُلمس قاعدة بيانات حية في إعداد هذه الوثيقة.*
