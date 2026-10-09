# أزرار تأكيد/رفض الطلبات للمالك (071) ونشر accounting-sync على Production — 2026-10-09

المشروع: `srnelrdpqkcntbgudyto`. الموافقة: «الاتنين» (071 + نشر accounting-sync)، بعد البلاغين:

- «المفترض في تذاكر الاشتراك يكون في زر تاكيد الاشتراك او رفض … ملقيتش الزر موجود … من حساب مالك
  المنصه» (#1121).
- «لما اكدتها من حساب الادمن ظهرلي تعذر ارسال التذكره الي النظام المحاسبي … فشل إرفاق الفاتورة:
  تعذّر إرسال الاشتراك للنظام المحاسبي».

## السبب

| البلاغ | السبب على الإنتاج |
|---|---|
| مفيش أزرار للمالك | سياستا `whatsapp_subscriptions` و `whatsapp_wallet_topup_requests` بالرتبة الحرفية `'admin'`، فاللوحة ماتقراش صف الطلب. و `admin_recompute_user_access` اللي الواجهة بتناديها بعد التأكيد مش موجودة أصلًا |
| النظام المحاسبي | `accounting-sync` المنشورة v6 (أغسطس، = `git 8969b19^`) بتقبل `x-sync-secret` بس. وضع «اشتراك واحد بجلسة طاقم» اللي اللوحة بتستخدمه (من 051، و 051 مطبّق 2026-09-23) ماتنشرش، فكل نداء من اللوحة بيرجع 401 (4 نداءات 07:37 UTC من غير أي `console.error`) |

## BEFORE (قراءة فقط)

- آخر migration: `20261009072718 070_owner_admin_context_tickets`.
- بصمات الإنتاج **مطابقة حرفيًا** للنسخة المحلية (`prod-shape` + 070):
  - `is_admin da79a757…`، `owner_capability eef1a6c4…`، `recompute_user_access 556fa320…`.
  - `owned_feature_keys 6d45fee1…`، `wa_wallet_adjust df7403b9…`، `wa_wallet_is_staff 23efbe1f…`.
  - محفّزا الاشتراك `bd2aaf88…` / `e5c87291…`.
  - السياستان `e29bb56e…`.
- مفيش `admin_recompute_user_access`.
- 12 اشتراك (0 pending)، 1 طلب شحن، 395 سياسة. مفيش أقفال على الجدولين.

## APPLIED

| الخطوة | الطريقة | الوقت (UTC) |
|---|---|---|
| 071 | `apply_migration` (الملف حرفيًا، من غير `DROP`) | 07:59:32 |
| accounting-sync | `deploy_edge_function` من `supabase/functions/accounting-sync/index.ts`، `verify_jwt=false` زي ما كانت (الدالة بتفحص بنفسها) | v7 |

**السجل**: `20261009075932 / 071_owner_admin_context_billing_requests`، و md5(statements[1]) =
`75bc4d2f…` = md5 الملف.

## VERIFIED

- **البصمات بعد التطبيق** مطابقة للنسخة المحلية بعد 071:
  - السياستان `4ca46077…`، والباقي من غير تغيير.
  - `admin_recompute_user_access 8abca698…`: SECURITY DEFINER، تنفيذ `authenticated` بس (مش `anon`).
- **فحص Production**: `scripts/prod-smoke/owner-admin-context-billing-requests.sql`، معاملة واحدة بترجع كلها، **PASS/PASS**:
  - المالك (سياق admin): بيشوف 12/12 اشتراك و 1/1 شحن، تعديل صف = 1، وإعادة الحساب رجّعت الامتيازات.
  - عميل حقيقي: بيشوف 2 من 2 بتوعه، تعديله 0 صفوف، والدالة ⇒ 42501.
- **accounting-sync v7 شغّالة**: نداء من القاعدة (`pg_net`) بـ `subscription_id` غير صالح رجّع
  `400 {"error":"subscription_id غير صالح"}`. ده رد النسخة الجديدة؛ v6 كانت بترجع 401 قبل أي فحص.
  النداء ده مالوش أي أثر.
- **بعد الفحص**: نفس الأعداد (12/0/1، 395 سياسة)، `whatsapp_enabled` متسق مع الاشتراكات للأربعة، طابور
  pg_net فاضي، مفيش معاملات معلّقة.
- **Logs** (07:55 ←): مفيش أخطاء. الموجود هو نص الـ migration ورسالة `SMOKE_071_RESULT` المقصودة.

## TESTS

- `tests/sql/owner-admin-context-billing-requests.test.sql`: الخلل قبل 071، المسار كامل كمالك، الاحتواء،
  التراجع وإعادة التطبيق.
- `tests/run-sql-tests.sh`: 44 ملف، exit 0.
- `npm run test:node`: نفس مجموعة الفشل الموجودة قبل التغيير (38، صفحة الشات والويدجت).

## ما تبقّى

- اشتراك #1121 (`263fcdf9…`، support/yearly) اتأكّد 07:37 لكنه ماوصلش للنظام المحاسبي. زر «إرفاق
  فاتورة» في التذكرة بيبعته الأول وبعدين بيرفق الفاتورة. الباقة `support|yearly` موجودة في كتالوج `acc`.
- وضع «جلسة طاقم المنصة» بيتأكد من الهوية بنداء `is_platform_staff` من جوه الدالة. ده ماينفعش
  يتجرّب من غير جلسة حقيقية، فأول ضغطة على الزر هي اللي هتأكده.

## ROLLBACK

- 071: `migrations/_rollback/071_owner_admin_context_billing_requests.down.sql`. بيرجّع نص السياستين
  ويشيل الدالة. مفيش بيانات بتتأثر.
- accounting-sync: إعادة نشر `git show 8969b19^:supabase/functions/accounting-sync/index.ts` (v6).

## FINAL STATE

```
071 installed         = YES (apply_migration, 07:59:32 UTC, ledger md5 = file)
accounting-sync       = v7 (repo version; staff single-subscription mode live)
Customer data         = unchanged
```
