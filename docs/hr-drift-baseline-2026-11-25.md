# خط أساس الانجراف الحي — وحدة HR، المرحلة 2، الخطوة أ

**تاريخ التحقق:** 2026-11-25 23:55 → 2026-11-26 00:00 EET (22:00 UTC)
**المشروع:** Mad3oom — Supabase `srnelrdpqkcntbgudyto` (`https://srnelrdpqkcntbgudyto.supabase.co`)
**الفرع:** `hr-module` — worktree `~/workspace/Mad3oom-hr-module` عند `4897b72`
**طبيعة المهمة:** قراءة فقط (read-only). لا كتابة في قاعدة البيانات الحية، لا DDL، لا ترحيلات مطبَّقة، لا نشر، لا دفع.

## المنهج

كل الاستعلامات `SELECT` فقط عبر موصّل `custom.supabase` (MCP) على المشروع الحي، مع التحقق أولًا من `get_project_url` (أعاد `https://srnelrdpqkcntbgudyto.supabase.co`). فُحص كل ترحيل من 136–141 من جهتين مستقلتين:

1. **السجل:** صف في `supabase_migrations.schema_migrations`.
2. **الكائنات:** وجود الدوال والجداول والأعمدة المعرَّفة في ملف الترحيل بالمستودع (`migrations/136…141`)، وحالة RLS و`SECURITY DEFINER` لعينة منها.

أيضًا فُحصت الكائنات اليتيمة (128–135، `emp_ops`)، والقيم الحية المؤثرة في تصميم HR، ولقطة أعداد الصفوف.

---

## 1. جدول الأحكام — الترحيلات 136–141

| الترحيل | السجل في `schema_migrations` | الكائنات حية؟ | الحكم |
|---|---|---|---|
| 136 تجديد/إلغاء/خفض الاشتراك ذاتيًا | ❌ لا سجل | ✅ كل الدوال الثماني موجودة | **مطبق جزئيًا — كائنات بلا سجل** |
| 137 تجربة مجانية 3 أيام | ❌ لا سجل | ✅ الجدول + الدوال الثماني موجودة | **مطبق جزئيًا — كائنات بلا سجل** |
| 138 طلب حساب شركة مستقل | ❌ لا سجل | ✅ الجدولان + الدوال الست موجودة | **مطبق جزئيًا — كائنات بلا سجل** |
| 139 تنبيهات مخزون Shopify | ❌ لا سجل | ✅ الجدولان + الدوال الست موجودة | **مطبق جزئيًا — كائنات بلا سجل** |
| 140 تصدير/حذف بيانات الشركة | ❌ لا سجل | ✅ الجدولان + الدوال الخمس موجودة | **مطبق جزئيًا — كائنات بلا سجل** |
| 141 مطورون/أسعار (Webhooks) | ❌ لا سجل | ✅ الجدولان + الدوال التسع موجودة | **مطبق جزئيًا — كائنات بلا سجل** |

**الحقيقة الحية الكلية:** سجل الترحيلات ما زال **398 صفًا**، وآخر سجل فيه هو `131_login_locations` (`20261124190430`، 2026-11-24 19:04) — **بلا أي تغيير منذ التدقيق**. لا يوجد أي سجل لـ 128–130 ولا لـ 132–141. في المقابل **كل الكائنات المفتاحية لـ 136–141 موجودة حيًا**. أي أن التطبيق الحي تم عبر SQL مباشر (`execute_sql`) دون تسجيل في `schema_migrations`، وهو نفس نمط الانجراف الذي وثّقه تدقيق المرحلة 1 لـ 128–135.

**التبعة العملية:** نظام الترحيلات يظن أن 136–141 لم تُطبَّق إطلاقًا. أي إعادة تطبيق عبر أداة الترحيلات ستعيد إنشاء كائنات موجودة (فشل أو كتابة فوقها حسب `CREATE OR REPLACE` / `IF NOT EXISTS`). قبل أي تطبيق حي مستقبلي يجب أولًا توثيق هذه الكائنات في سجلات ترحيل (backfill) أو التعامل معها صراحةً كـ baseline — لا تُعَد الترحيلات وحدها مصدرًا للحقيقة.

### 136 — تجديد/إلغاء/خفض الاشتراك ذاتيًا

الدوال الثماني كلها موجودة في `public`:

- `cancel_my_active_subscription` ✅
- `resume_my_subscription` ✅
- `request_subscription_downgrade` ✅
- `submit_subscription_downgrade` ✅
- `subscription_downgrade_quote` ✅
- `enforce_subscription_purchase_rules` ✅ (إعادة تعريف من 136)
- `expire_stale_subscriptions` ✅ (إعادة تعريف من 136)
- `get_my_company_dashboard` ✅ (إعادة تعريف من 136)

لا جداول جديدة في هذا الترحيل (حسب الملف). لا سجل ترحيل.

### 137 — تجربة مجانية 3 أيام

- الجدول `saas_trial_requests` ✅ — 14 عمودًا: `id, company_id, plan_key, requested_by, status, requested_at, decided_at, decided_by, decision_reason, trial_starts_at, trial_ends_at, subscription_id, created_at, updated_at`؛ RLS مفعّلة.
- الدوال الثماني ✅: `request_saas_trial`، `owner_decide_saas_trial`، `expire_saas_trials`، `cancel_saas_trial`، `my_saas_trial_status`، `owner_list_saas_trial_requests`، `_trial_plan_allowed`، `_trial_request_json`.
- عينة `SECURITY DEFINER`: `request_saas_trial` ✅، `owner_decide_saas_trial` ✅.
- **صف حي واحد:** طلب تجربة معلّق (`pending`) — `id 8d219b3a-64df-4ec8-a34f-e3a56a578b9b`، شركة «مدعوم» (`c01febcc-…`)، باقة `support`، أُنشئ `2026-11-25 21:41:18 UTC` (23:41 EET). `trial_starts_at` و`trial_ends_at` فارغان — التجربة لم تبدأ بعد، والطلب بانتظار قرار المالك. لا سجل ترحيل.

### 138 — طلب حساب شركة مستقل

- الجدولان ✅: `company_account_request_proof_uploads` (11 عمودًا، RLS مفعّلة)، و`company_account_requests` (28 عمودًا، RLS مفعّلة — الجدول نفسه من 105/106، ودوال 138 تعمل عليه).
- الدوال الست ✅: `submit_standalone_company_account_request`، `my_company_account_request`، `admin_list_company_account_requests`، `company_account_request_proof_begin`، `company_account_request_proof_commit_server`، `admin_company_account_request_proof_download`.
- عينة `SECURITY DEFINER`: `submit_standalone_company_account_request` ✅.
- الصفوف: `company_account_requests` = 0، `company_account_request_proof_uploads` = 0. لا سجل ترحيل.

### 139 — تنبيهات مخزون Shopify

- الجدولان ✅: `ihub_shopify_inventory_thresholds` (12 عمودًا: `id, company_id, connection_id, scope, inventory_item_id, variant_id, product_title, min_quantity, created_by, updated_by, created_at, updated_at`)، و`ihub_shopify_inventory_alerts` (12 عمودًا)؛ RLS مفعّلة على الاثنين.
- الدوال الست ✅: `ihub_shopify_threshold_set`، `ihub_shopify_thresholds_list`، `ihub_shopify_threshold_delete`، `ihub_shopify_inventory_alerts_list`، `ihub_shopify_inventory_alerts_report`، `_ihub_shopify_threshold_gate`.
- عينة `SECURITY DEFINER`: `ihub_shopify_threshold_set` ✅.
- الصفوف: العتبات = 0، التنبيهات = 0. لا سجل ترحيل.

### 140 — تصدير/حذف بيانات الشركة

- الجدولان ✅: `company_data_exports` (7 أعمدة، RLS مفعّلة)، و`company_deletion_requests` (9 أعمدة: `id, company_id, requested_by, reason, status, created_at, decided_at, decided_by, decision_note`، RLS مفعّلة).
- الدوال الخمس ✅: `company_request_account_deletion`، `company_export_data`، `company_data_exports_list`، `company_deletion_request_status`، `company_cancel_deletion_request`.
- عينة `SECURITY DEFINER`: `company_request_account_deletion` ✅، `company_export_data` ✅.
- الصفوف: الصادرات = 0، طلبات الحذف = 0. لا سجل ترحيل.

### 141 — مطورون/أسعار (Webhooks)

- الجدولان ✅: `company_webhooks` (14 عمودًا: `id, company_id, user_id, name, url, events, secret, is_active, deliveries_count, failed_count, last_delivery_at, last_delivery_status, created_at, updated_at`)، و`company_webhook_deliveries` (12 عمودًا)؛ RLS مفعّلة على الاثنين.
- الدوال التسع ✅: `company_webhook_create`، `company_webhook_list`، `company_webhook_update`، `company_webhook_delete`، `company_webhook_rotate_secret`، `company_webhook_deliveries`، `company_webhook_enqueue`، `company_webhook_json`، `company_webhook_scope`.
- عينة `SECURITY DEFINER`: `company_webhook_create` ✅، `company_webhook_enqueue` ✅.
- الصفوف: webhooks = 0، deliveries = 0. لا سجل ترحيل.

---

## 2. جرد الكائنات اليتيمة (128–135 + `emp_ops`)

| الكائن | المصدر (ملف) | حي؟ | ملاحظة |
|---|---|---|---|
| `owner_account_tree()` | 128 | ✅ موجودة | بلا سجل ترحيل |
| `owner_account_transfer()` | 129 | ✅ موجودة | بلا سجل ترحيل |
| `owner_account_details()` | 129 | ✅ موجودة | بلا سجل ترحيل |
| `owner_update_account_profile()` | 129 | ✅ موجودة | بلا سجل ترحيل |
| `owner_accounts_overview()` | 128/129 | ✅ موجودة | بلا سجل ترحيل |
| `_owns_a_company()` / `owns_a_company()` | 130 | ✅ موجودة | بلا سجل ترحيل |
| `_belongs_to_a_company()` / `belongs_to_a_company()` | 130 | ✅ موجودة | بلا سجل ترحيل |
| `guard_profile_role_change()` | 130 | ✅ موجودة | بلا سجل ترحيل |
| `owner_set_store_plan_price(numeric, numeric, boolean, boolean, text)` | 135 | ✅ موجودة — **التوقيع الجديد من 135** | توقيع 133 ذي الـ 3 معاملات أُسقط حسب الملف (سطر `drop function`)؛ لا توجد نسخة 3 معاملات حيًا |
| `owner_ihub_sync_request()` / `owner_ihub_events_retry()` / `owner_store_test_status()` | 133 | ✅ موجودة | بلا سجل ترحيل |
| جدول `suggestions` | 134 | ✅ موجود | بلا سجل ترحيل |
| جدول `agent_activity_log` | 132 (توثيق) | ✅ موجود | بلا تعريف ترحيل في المستودع |
| جدول `muse_account_activations` | 132 (توثيق) | ✅ موجود | بلا تعريف ترحيل في المستودع |
| جدول `muse_reply_claims` | 132 | ❌ **غائبة** | وكذلك الدالة `_muse_chat_reply_call()` غائبة — 132 ما زال مطبقًا جزئيًا كما وثّق التدقيق |
| مخطط `emp_ops` | بلا ملفات إطلاقًا | ✅ 18 جدولًا | أكبر فجوة انجراف — بلا أي ملف في المستودع |
| دوال `emp_ops` الداخلية | بلا ملفات | ✅ 35 دالة في مخطط `emp_ops` | أسماء بلا بادئة `eo_` (مثل `audit`، `can_manage`، `current_employee`، `try_link_current_user`) |
| دوال `eo_*` في `public` | بلا ملفات | ✅ **34 دالة** (عُدّت مرتين، والقائمة الكاملة أدناه) | واجهة API العامة فوق `emp_ops` |

**قائمة دوال `eo_*` الحية في `public` (34):** `eo_admin_adjust_attendance`، `eo_admin_assign_shift`، `eo_admin_audit_logs`، `eo_admin_employee_activity`، `eo_admin_employee_detail`، `eo_admin_employee_history`، `eo_admin_employee_timeline`، `eo_admin_employees_live`، `eo_admin_force_end_shift`، `eo_admin_list_employees`، `eo_admin_multi_device`، `eo_admin_overview`، `eo_admin_recompute`، `eo_admin_set_role`، `eo_admin_set_setting`، `eo_admin_set_status`، `eo_admin_settings`، `eo_admin_upsert_employee`، `eo_admin_upsert_shift`، `eo_admin_upsert_team`، `eo_close_device`، `eo_end_break`، `eo_end_shift`، `eo_ingest_activity`، `eo_lists`، `eo_log_auth`، `eo_log_export`، `eo_me`، `eo_my_activity`، `eo_my_history`، `eo_my_timeline`، `eo_report`، `eo_start_break`، `eo_start_shift`.

**ملاحظة عدّ:** مراجعة توازية (الحضور) سجّلت «35 دالة `eo_*` عامة»؛ هذا الفحص عدّ **34** مباشرةً من `pg_proc` مرتين (استعلام `count(*)` + سرد الأسماء). الفرق دالة واحدة — يُعاد التحقق منه في الفحص التالي قبل الاعتماد عليه؛ لا يؤثر في أي حكم هنا.

### عمود `paused_at` — تحقق حاسم

| الجدول | `paused_at`؟ |
|---|---|
| `whatsapp_subscriptions` | ✅ موجود (`timestamptz`) |
| `customer_subscriptions` | ❌ **غير موجود** |

البحث في كل أعمدة `public` عن اسم `paused_at` أعاد صفًا واحدًا فقط: `whatsapp_subscriptions.paused_at`. تأكيد لتصحيح التدقيق: إيقاف/استئناف اشتراكات الشركات (135) يعمل على `whatsapp_subscriptions` فقط؛ لا عمود إيقاف في `customer_subscriptions`.

---

## 3. القيم الحية المؤثرة في تصميم HR

### مفاتيح المنصة `platform_feature_switches` — 12 صفًا

**مفعّلة (9):** `account_request_execution_enabled`، `company_documents_enabled`، `company_inbox_enabled`، `company_isolation_enforced`، `company_permissions_enabled`، `customer_transfers_enabled`، `delegation_enabled`، `multi_company_memberships_enabled`، `ticket_carry_enabled` — كلها منذ 2026-10-21 20:41–20:43 UTC.

**مطفأة (3):** `company_suspension_enforced`، `data_access_grants_enabled`، `historical_access_enabled` (الأخير ما زال مطفأً كما وثّق التدقيق).

**لا يوجد أي مفتاح `hr_*` بعد** — مفتاح `hr_module` العام والمفاتيح الفرعية (`hr_salaries`، `hr_attendance`، `hr_tasks`…) ما زالت قرارات تصميم لم تُنفذ.

### تجاوزات الشركات `company_feature_overrides` — 3 صفوف

كلها على شركة «مدعوم» (`c01febcc-d4c4-4fbd-8a6a-6ac5b35fb3d7`)، بالسبب نفسه «اختبار امتيازات المتجر على شركة المالك»، مُنحت `2026-11-25 05:52:53 UTC`، وتنتهي **2026-12-02 05:52:53 UTC**:

| `feature_key` | تنتهي |
|---|---|
| `integrations_hub` | 2026-12-02 |
| `shopify_integration` | 2026-12-02 |
| `store_support` | 2026-12-02 |

**القيد CHECK — مؤكد الاتساع:** القيد `company_feature_overrides_pilot_only` تعريفه الحي:

```sql
CHECK ((feature_key = ANY (ARRAY['integrations_hub'::text, 'shopify_integration'::text, 'store_support'::text, 'shopify_management'::text])))
```

أي أن القيد لم يعد مقصورًا على `integrations_hub` — وُسّع إلى 4 مفاتيح (إضافة `shopify_management` غير مستخدمة بعد في أي صف). قيد السبب `company_feature_overrides_reason_check` ما زال `char_length(reason)` بين 3 و300. **التبعة لـ HR:** مفاتيح `hr_*` ما زالت مرفوضة من القيد — إعادة استخدام هذا الجدول لإتاحة HR تتطلب تعديل القيد صراحةً في ترحيل HR (كما أوصى التدقيق).

### خطط الاشتراك `subscription_plans` — 5 خطط

| `key` | الاسم | مفعّلة؟ | شهري | سنوي | العملة |
|---|---|---|---|---|---|
| `support` | Advanced / الخطة المتقدمة | ✅ | 999.00 | 9999.00 | EGP |
| `ultimate` | Ultimate / الخطة الفائقة | ✅ | 1999.00 | 19999.00 | EGP |
| `whatsapp` | WhatsApp Business / واتساب بيزنس | ✅ | 1299.00 | 12999.00 | EGP |
| `bundle` | Bundle / الباقة الشاملة | ✅ | 2099.00 | 22999.00 | EGP |
| `store` | E-commerce Store / باقة المتاجر الإلكترونية | ❌ **غير مفعّلة** | **NULL** | **NULL** | EGP |

**باقة المتجر ما زالت غير مفعّلة وبأسعار NULL** — لم يتغير شيء منذ التدقيق؛ السعر (500/5000) والتفعيل ما زالا خطوة واجهة منفصلة بيد محمود. الأسعار الأخرى بلا تغيير (ultimate 1999/19999 كما هي).

### كتالوج صلاحيات الشركة `company_permission_catalog` — 22 مفتاحًا، **صفر مفاتيح `hr.*`**

المفاتيح الحية: `conversations.*` (6: view، view_assigned، reply، assign، close، internal_notes)، `customers.view` (1)، `store.*` (9: catalog، customers_manage، discounts، fulfillment، inventory، orders، orders_manage، requests، returns)، `tickets.*` (6: view، view_assigned، reply، assign، status، internal_notes). لا شيء باسم HR بعد — مفاتيح `hr.*` ستُضاف مع ترحيل HR الأول.

---

## 4. لقطة أعداد الصفوف (قاعدة صغيرة — كما في التدقيق)

| الجدول | الصفوف |
|---|---|
| `companies` | **1** — «مدعوم» (`c01febcc-d4c4-4fbd-8a6a-6ac5b35fb3d7`)، `status=active`، `account_kind=ecommerce_store` |
| `profiles` | **59** |
| `company_memberships` | **2** |
| جداول HR (`hr_*`) | **0 جداول، 0 دوال** — لم يُبنَ شيء من HR بعد |
| جداول 136–141 الجديدة | كلها **0 صفوف**، ما عدا `saas_trial_requests` = **1** (طلب معلّق، انظر §1 — 137) |

---

## 5. تصحيحات صريحة لتدقيق المرحلة 1 (2026-11-25)

> **ادعاء التدقيق (§9):** «136 تجديد/إلغاء/خفض — لا دوال جديدة ولا جداول جديدة — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الدوال الثماني كلها موجودة حيًا (`cancel_my_active_subscription`، `resume_my_subscription`، `request_subscription_downgrade`، `submit_subscription_downgrade`، `subscription_downgrade_quote`، إضافة إلى إعادة تعريف `enforce_subscription_purchase_rules` و`expire_stale_subscriptions` و`get_my_company_dashboard`)، وكلها `SECURITY DEFINER` في العينة المفحوصة. **التصحيح: الكائنات مطبَّقة؛ ما ما زال غائبًا هو سجل الترحيل فقط.**

> **ادعاء التدقيق (§9):** «137 تجربة 3 أيام — لا `saas_trial_requests` ولا أي دالة `*_saas_trial` — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الجدول موجود (14 عمودًا، RLS مفعّلة) والدوال الثماني موجودة، وفيه **صف حي واحد**: طلب تجربة معلّق لباقة `support` على شركة «مدعوم» أُنشئ 2026-11-25 21:41:18 UTC. **التصحيح: مطبَّق ككائنات بلا سجل ترحيل، وبدأ استخدامه فعليًا (طلب معلّق بانتظار قرار المالك).**

> **ادعاء التدقيق (§9):** «138 طلب حساب شركة مستقل — لا `company_account_request_proof_uploads` ولا دوال الإثبات — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الجدول موجود (11 عمودًا، RLS مفعّلة) والدوال الست موجودة؛ الصفوف 0. **التصحيح: مطبَّق ككائنات بلا سجل ترحيل.**

> **ادعاء التدقيق (§9):** «139 تنبيهات مخزون Shopify — لا `ihub_shopify_inventory_thresholds/alerts` ولا دوالها — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الجدولان موجودان (12 عمودًا لكل منهما، RLS مفعّلة) والدوال الست موجودة؛ الصفوف 0. **التصحيح: مطبَّق ككائنات بلا سجل ترحيل.**

> **ادعاء التدقيق (§9):** «140 تصدير/حذف بيانات الشركة — لا `company_data_exports`/`company_deletion_requests` ولا دوالها — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الجدولان موجودان (RLS مفعّلة) والدوال الخمس موجودة؛ الصفوف 0. **التصحيح: مطبَّق ككائنات بلا سجل ترحيل.**

> **ادعاء التدقيق (§9):** «141 مطورون/أسعار (Webhooks) — لا `company_webhooks`/`company_webhook_deliveries` ولا أي دالة `company_webhook_*` — **غير مطبق حيًا (مؤكد)**»
> **الحقيقة الحية الآن:** الجدولان موجودان (RLS مفعّلة) والدوال التسع موجودة؛ الصفوف 0. **التصحيح: مطبَّق ككائنات بلا سجل ترحيل.**

> **ادعاء التدقيق (§9):** «سجل الترحيلات الحي `supabase_migrations.schema_migrations`: **398 ترحيلًا**، آخرها `131_login_locations` (2026-11-24 19:04)»
> **الحقيقة الحية الآن:** **مؤكد بلا تغيير** — ما زال 398 صفًا وآخرها `131_login_locations`. التطبيق الحي لـ 136–141 لم يسجَّل إطلاقًا في سجل الترحيلات.

> **ادعاء التدقيق (§6، بند 11):** «قيد CHECK في `company_feature_overrides` يقصر المفاتيح على `integrations_hub` (092)… لم يُتحقق حيًا إن كان القيد قد وُسّع بعد 092»
> **الحقيقة الحية الآن:** **مؤكد الاتساع.** القيد `company_feature_overrides_pilot_only` يسمح بـ 4 مفاتيح: `integrations_hub`، `shopify_integration`، `store_support`، `shopify_management`. والصفوف الثلاثة الحية نفسها تثبت ذلك (مفاتيح `shopify_integration` و`store_support` ما كانت لتدخل لولا الاتساع). **التصحيح: القيد وُسّع فعلًا؛ مفاتيح `hr_*` ما زالت مرفوضة وتحتاج تعديلًا صريحًا.**

> **ادعاء التدقيق (§3):** «مخطط `emp_ops`… مع ~35 دالة `eo_*` في `public` + 35 في المخطط»
> **الحقيقة الحية الآن (تصحيح دقيق في التوزيع):** 18 جدولًا ✅؛ **35 دالة في مخطط `emp_ops`** لكن أسماؤها **بلا بادئة `eo_`**؛ و**34 دالة `eo_*` في `public`** (عُدّت مرتين وسُردت أسماؤها كاملة في §2). الإجمالي 69 دالة في المنظومة، لا «35+35» بالمعنى الحرفي. (فرق دالة واحدة مع مراجعة توازية سجّلت 35 عامة — يُعاد التحقق منه في الفحص التالي.)

> **ادعاءات التدقيق المؤكدة بلا تغيير:** `paused_at` في `whatsapp_subscriptions` فقط (وليس في `customer_subscriptions`) ✅؛ `muse_reply_claims` غائبة و`_muse_chat_reply_call()` غائبة (132 ما زال جزئيًا) ✅؛ شركة واحدة «مدعوم» و59 ملفًا وعضويتا شركة ✅؛ تجاوزات المتجر الثلاثة تنتهي 2026-12-02 ✅؛ باقة المتجر غير مفعّلة وبأسعار NULL ✅؛ `historical_access_enabled` ما زال مطفأً ✅؛ لا جداول/دوال `hr_*` إطلاقًا ✅.

---

## 6. ما لم يُفحص في هذه المهمة (خارج النطاق)

- محتوى تعريفات الدوال (لم تُقارن نصوص `pg_get_functiondef` مع ملفات الترحيل سطرًا بسطر) — الفحص هنا وجود الكائنات + عينة `SECURITY DEFINER` + RLS + الأعمدة المعرِّفة فقط. تطابق نص التعريف مع الملف يحتاج مقارنة مخصصة قبل أي backfill.
- `pg_policies` التفصيلية للجداول الجديدة (اكتُفي بحالة `relrowsecurity=true`).
- تقرير التدقيق عن «891 من 1,264 دالة `SECURITY DEFINER`» لم يُعَد إحصاؤه.
- عدد صفوف `agent_activity_log` (التدقيق قال 846 صفًا) لم يُعَد قياسه — اكتُفي بإثبات وجود الجدول.

---

## 7. الخلاصة والتحذير قبل أي تطبيق حي مستقبلي

1. **136–141 مطبَّقة ككائنات بالكامل، وغائبة كسجلات ترحيل بالكامل.** هذا هو الانجراف نفسه الذي وثّقه التدقيق لـ 128–135، ممتدًا الآن إلى 136–141. آخر سجل ترحيل ما زال 131 (2026-11-24 19:04).
2. **قبل أي تطبيق حي قادم (بما فيه ترحيلات HR):** يجب تثبيت هذه الحالة كـ baseline رسمي — إما backfill لسجلات 128–141 في `schema_migrations`، أو توثيقها في سجل انجراف رسمي — وإلا فأي ترحيل جديد يعتمد على «الترحيلات وحدها مصدرًا للحقيقة» سيعيد إنشاء كائنات موجودة أو يفترض غياب كائنات موجودة.
3. **هذا الأساس يجب إعادة فحصه حيًا قبل أي تطبيق حي مستقبلي** — القاعدة تتحرك (طلب التجربة المعلق أُنشئ قبل ساعتين من هذا الفحص). لا تعتمد على هذا الملف بعد مرور أيام دون إعادة التحقق من `schema_migrations` والكائنات المفتاحية.
4. **نقاط انتباه فورية (بلا إجراء من هذه المهمة):** طلب تجربة `support` معلّق على شركة «مدعوم» منذ 2026-11-25 23:41 EET بانتظار قرار المالك؛ تجاوزات المتجر الثلاثة تنتهي 2026-12-02؛ باقة المتجر ما زالت غير مفعّلة.
5. **لتصميم HR:** لا مفاتيح `hr_*` في أي مكان بعد (لا في `platform_feature_switches`، ولا في `company_feature_overrides` — قيدها يرفضها — ولا في `company_permission_catalog`)؛ و`paused_at` ليس نموذجًا يُحتذى لاشتراكات الشركات؛ و`emp_ops` يبقى نموذجًا تصميميًا فقط لا يُوسَّع.

---

*أُعدّ هذا الملف قراءةً فقط — لم يُنفَّذ أي تغيير على قاعدة البيانات الحية أثناء إعداده.*
