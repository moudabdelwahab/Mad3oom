# تثبيت Conversation Core على Production — 2026-10-08

الهدف الوحيد: **Install Conversation Core infrastructure in Production** والأعلام مقفولة.
المشروع: `srnelrdpqkcntbgudyto`. الملفات: `064_conversation_core.sql` ثم `067_conversation_core_gate.sql`
من commit `fbeb976` كما هي، بدون أي تعديل.

## BEFORE (18:36 UTC، قراءة فقط)

- آخر migration مسجّل: `066c_waitlist_source_for_042_rows` — مطابق للـ baseline.
- لا دوال `conv_*`، لا أعمدة Core، لا أعلام، لا أقفال exclusive، لا معاملات معلّقة.
- البيانات: 540 رسالة، 48 جلسة، 37 تذكرة، 0 أحداث inbox، 39 مستخدم، `ticket_number_seq` = 1118.
- بصمات دوال المسار القديم (`enforce_ticket_quota`, `_handoff_set`, `guard_ai_reply_handoff`,
  `chat_post_notice`, `has_elevated_authority`) مسجّلة للمقارنة.

## APPLIED

| الملف | الطريقة | الوقت (UTC) | النتيجة |
|---|---|---|---|
| 064 | SQL Editor (المالك) — الملف كامل | 18:47:55 | نجح، ورسالة التحقق الداخلية ظهرت |
| 067 | SQL Editor (المالك) — بعد التحقق من 064 فقط | 18:51:30 | نجح، ورسالة التحقق الداخلية ظهرت |

محاولات قبلها مافيهاش أي أثر:
- `apply_migration` من الأداة انتهت مهلتها (60 ثانية) أربع مرات، ولم يُطبَّق شيء (اتأكد بعد كل مرة).
- محاولة أولى من SQL Editor وصلها نص ناقص (جزء متحدد) ⇒ parse error قبل التنفيذ، ولم يُطبَّق شيء.

ملاحظة: التشغيل من SQL Editor مابيكتبش في `supabase_migrations.schema_migrations`. تسجيل 064 و 067
هناك مستني موافقة.

## VERIFIED

**تطابق الكائنات**: نفس الملفين اتطبّقوا على نسخة محلية مطابقة لشكل الإنتاج، وبصمات الإنتاج اتقارنت بيها:

- 17 دالة (11 من 064 + 6 من 067، ونسختا ingest/claim القديمتين اتشالوا): **md5 لكل دالة مطابق**.
- 18 محفّز على `chat_messages` و `chat_sessions` (9 قديمة + 7 من 064 + 2 من 067): مطابق.
- 11 سياسة RLS (منها `core_single_writer` RESTRICTIVE على الجدولين): مطابق.
- `inbox_events_kind_check` (فيه `ticket_failed`) و 4 قيود 064: validated ومطابقة.
- 3 فهارس فريدة و 13 عمود (النوع/NULL/القيمة الافتراضية): مطابقة.
- الصلاحيات: anon و authenticated مالهمش تنفيذ على أي دالة كتابة في Core. authenticated عنده بس
  `conv_channel_enabled` و `conv_client_may_write` (للسياسات). service_role بينفّذ الدوال العامة.
  الفرق الوحيد عن النسخة المحلية: Supabase بيدي service_role تنفيذ تلقائي على الدوال المساعدة
  ودوال المحفّزات (default privileges) — مفيش أثر أمني (service_role صلاحيته كاملة أصلًا،
  ودوال المحفّزات مابتتندهش مباشرة).
- الأعلام: `core_ingest_website=false`, `core_ingest_telegram=false`, `agent_runtime_enabled=false`.
- المسار القديم: بصمات دواله زي ما هي، وعدد السياسات القديمة زي ما هو، ولا صف قديم اتغيّر
  (كل الأعمدة الجديدة `NULL` / `0`).

**السلوك على Production** (`scripts/prod-smoke/conversation-core.sql`، 18:57 UTC) — معاملة واحدة
بحسابات اصطناعية وبترجع كلها — **19/19 PASS**:

| البند | الفحص |
|---|---|
| F1 | الأعلام مقفولة لكل القنوات لعميل |
| G1 | `conv_account_active`: نشط ⇒ true، محظور ⇒ false؛ ingest لمحظور ⇒ 42501 |
| Legacy chat | عميل بيفتح جلسة ويبعت رسالة من المتصفح ⇒ مقبول، seq=1، أحداث `source=legacy`، `channel` NULL |
| Legacy bot | رد بوت بـ service_role (زي chat-bot-reply) ⇒ مقبول، seq=2، حدث `agent_replied` |
| Handoff | `_handoff_set` ⇒ وضع يدوي، `state_version` زاد، رد البوت اترفض (55000) |
| Legacy close | العميل يقفل جلسته القديمة ⇒ مسموح + حدث `closed` |
| Attachments | مرفق في مجلد مستخدم تاني ⇒ مرفوض (42501) من المتصفح ومن Core؛ نوع غير مدعوم ⇒ 22023 قبل أي كتابة |
| Idempotency | نفس `external_id` مرتين ⇒ رسالة واحدة؛ نفس `turn_key` مرتين ⇒ رد واحد |
| N1 | `external_id` يبدأ بـ `turn:` ⇒ مرفوض |
| Version | commit بنسخة قديمة ⇒ `version_conflict` |
| R1 | محاولتين إرسال فاشلتين بحد 2 ⇒ مفيش مطالبة تالتة (dead letter) |
| Human owner | commit أثناء ملكية إنسان ⇒ `human_owner`؛ سياسة الخمول ماقفلتش محادثة الإنسان |
| D4 (علم مقفول) | كاتب الخادم القديم وكتابة المتصفح مقبولين؛ تغيير صاحب جلسة Core من المتصفح ⇒ 42501 |
| Flags | لسه false في الآخر |

بعد الفحص: نفس الأعداد بالظبط (540/48/37/0 أحداث/39 مستخدم/15 قائمة انتظار/1966 إشعار)،
`ticket_number_seq` = 1118، مفيش حسابات `core-smoke-*`، طابور pg_net فاضي، مفيش معاملات معلّقة.

**حصة التذاكر** مااتختبرتش بإنشاء تذاكر على Production عن قصد: أي محاولة إدراج (حتى المرفوضة من
الحصة) بتحرّك `ticket_number_seq` فأرقام تذاكر العملاء تتنط. السلوك متثبت على النسخة المطابقة
بنفس md5 للدوال (D1, D1b, D1c, L1, T10, T11 في اختبار البوابة)، والدالة نفسها
(`enforce_ticket_quota`) بصمتها على Production ما اتغيرتش.

## TESTS

- `tests/run-sql-tests.sh`: 39 ملف، exit 0، و«ALL CONVERSATION CORE GATE TESTS PASSED» (منها
  التراجع RB وإعادة التطبيق RB5).
- `npm run test:node`: 790 pass / 37 fail — نفس مجموعة الفشل بالظبط قبل التثبيت
  (كلها Playwright: نسخة المتصفح المطلوبة مش موجودة في البيئة).

## PRODUCTION IMPACT

- مفيش بيانات عملاء اتعدّلت، ومفيش traffic اتحوّل. مفيش أي نداء لدوال Core من الإنتاج.
- سلوك جديد واحد على المسار القديم (متصمّم في 064): أي رسالة جديدة بتاخد `seq`، وبيتكتب لها حدث
  في `inbox_events` (`source=legacy`)؛ الجلسة الجديدة ⇒ `conversation_created`؛ الإقفال ⇒ `closed`؛
  التسليم بيزوّد `state_version`. محتوى الرسالة مابيتكتبش في الحدث.
- Logs (18:40 → 19:04): مفيش أخطاء مرتبطة. الموجود قديم ومش مرتبط:
  `employee_daily_stats.had_open_session` NOT NULL (96 مرة في آخر 24 ساعة، قبل التثبيت) و
  PostgREST `Thread killed by timeout manager` (~150 مرة من 05:14). الـ ERROR الوحيد الجديد هو
  رسالة `CORE_SMOKE_RESULT` المقصودة.

## ROLLBACK

بالترتيب، كل ملف في معاملة واحدة:
1. `migrations/_rollback/067_conversation_core_gate.down.sql` (md5 `1ef99e96…`)
2. `migrations/_rollback/064_conversation_core.down.sql` (md5 `092b0d9f…`)

التراجع مابيمسحش بيانات (الأعمدة والصفوف بتفضل، والقيد بيرجع NOT VALID). متجرّب على النسخة المطابقة
(RB / RB5). مش مطلوب دلوقتي.

## FINAL STATE

```
Conversation Core installed = YES
Conversation Core enabled = NO
Production traffic changed = NO
```

لم يتم: إنشاء `conversation-turn`، تعديل `chat-bot-reply`، فتح أي علم، أي تغيير في SIE أو WhatsApp.
