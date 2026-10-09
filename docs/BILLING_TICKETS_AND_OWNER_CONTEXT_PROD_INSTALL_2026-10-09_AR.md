# تثبيت تذاكر الفوترة (069) على Production — 2026-10-09

الهدف: تذكرة «اشتراك» يفتحها العميل بنفسه تُحسب من رصيد التذاكر (20 للمجانية)، والإعفاء
يفضل لطلبات الاشتراك والتجديد والترقية اللي النظام بيعملها بس. الموافقة: «أخلي التذاكر اللي
العميل بيفتحها بنفسه بتصنيف «اشتراك» تتحسب من الـ 20…» ← «اعمل كدا».
المشروع: `srnelrdpqkcntbgudyto`. الملف: `migrations/069_billing_ticket_quota.sql`
(md5 `c807448bf2e6166e9d263c87dc38170f`) كما هو.

## BEFORE (قراءة فقط)

- آخر migration: `20261009062230 068_company_account_requests`.
- بصمات الدوال اللي 069 بيبدّلها أو بيناديها **مطابقة حرفيًا** لـ `tests/fixtures/prod-shape`:
  `enforce_ticket_quota cc092fc6…`، `ticket_quota_status 40028d9d…`،
  `request_subscription_purchase bed453f8…`، `request_subscription_upgrade 6f851d85…`،
  و `my_ticket_wallet`، `ticket_account_owner`، `account_is_active`، `is_admin`.
- لا دوال `submit_subscription_*` ولا فهرس `idx_whatsapp_subscriptions_ticket_id`.
- الحالة اللي اتشكى منها: التذكرة #1120 (تصنيف subscription، فتحها العميل يدويًا) ⇒
  `used = 0`، `billing_used = 1`.

## APPLIED

| الطريقة | الوقت (UTC) | السجل |
|---|---|---|
| `apply_migration` من الأداة | 2026-10-09 07:15:12 | `20261009071512 069_billing_ticket_quota`، md5(statements[1]) = md5 الملف |

(الملف مافيهوش `DROP`، فالأداة ماوقفتهوش زي 068.)

## VERIFIED

- الدوال الخمس الجديدة/المعدّلة بصمتها مطابقة للنسخة المحلية بعد 069:
  `enforce_ticket_quota 9a909947…`، `ticket_quota_status f11361a9…`،
  `_open_billing_request_ticket 228c963e…`، `submit_subscription_request dd15fb10…`،
  `submit_subscription_upgrade ffc97e72…`. ودالتا الشراء/الترقية القائمتان زي ما هما.
- الصلاحيات: `_open_billing_request_ticket` مش متاحة لـ anon ولا authenticated؛
  `submit_subscription_*` لـ authenticated بس.
- الفهرس `idx_whatsapp_subscriptions_ticket_id` موجود.
- **على بيانات الإنتاج**: نفس حساب #1120 ⇒ `used = 1`، `remaining = 19`، `billing_used = 0`.

السلوك متثبت على نسخة بشكل الإنتاج بنفس البصمات (`tests/sql/billing-ticket-quota.test.sql`:
⓪ الخلل قبل 069، B1–B9، التراجع وإعادة التطبيق). ماتعملش فحص سلوكي بإنشاء تذاكر على Production
عن قصد: أي إدراج في tickets (حتى المرفوض) بيحرّك `ticket_number_seq` فأرقام التذاكر تتنط.

## التوافق أثناء النشر

- الواجهة المنشورة دلوقتي (`main`) لسه بتفتح تذكرة الطلب من المتصفح ثم تنادي
  `request_subscription_purchase` — شغالة (B9): التذكرة تُفحص من الـ 20 وقت الإدراج، وتتحسب
  فوترة بمجرد ارتباطها بالطلب. الاستثناء الوحيد لحد دمج الواجهة الجديدة: عميل مستهلك الـ 20
  كاملة مش هيقدر يبعت طلب اشتراك من الواجهة القديمة.
- الواجهة الجديدة (`whatsapp-subscription-service.js` في PR #103) بتنادي
  `submit_subscription_request` / `submit_subscription_upgrade` — التذكرة والطلب معاملة
  واحدة، ومعفاة من الـ 20 (سقف الفوترة 5 بس).

## ROLLBACK

`migrations/_rollback/069_billing_ticket_quota.down.sql` — بيرجّع الدالتين لنص الإنتاج (العدّ
بالتصنيف) ويشيل الدوال الجديدة والفهرس. ⚠️ لازم الواجهة ترجع قبله للنسخة اللي بتنادي
`request_subscription_purchase` مباشرةً. مفيش بيانات بتتمسح.

## FINAL STATE

```
069 installed = YES (07:15:12 UTC، في السجل)
Manual «اشتراك» tickets count toward the quota = YES
New subscription UI live = NO (PR #103)
```

---

# 070 — المالك في سياق الإدارة وتذاكر العملاء — 2026-10-09

البلاغ: «لما دخلت من حساب المالك علي لوحة الادارة التذاكر بتاعت العملا مظهرتش». الموافقة:
«طبق 070 على الانتاج». الملف: `migrations/070_owner_admin_context_tickets.sql`
(md5 `8a3ae4d3e67d2395d97adb7aad80c808`).

**BEFORE:** المالك في سياق admin (منذ 06:57، ساري لحد 18:57 UTC) — `is_admin()` = true لكن
33 تذكرة عميل مخفية. بصمات المحفّزين (`01c4702b…`، `2c02f958…`) والسياسات الخمس مطابقة لـ
`prod-shape`. لا أقفال.

**APPLIED:** `apply_migration` 2026-10-09 07:27:18 UTC ⇒ `20261009072718 070_owner_admin_context_tickets`
في السجل، md5 = الملف.

**VERIFIED:**
- المحفّزان (`3449b6db…`، `f429ca27…`) والسياسات الخمس مطابقة للنسخة المحلية بعد 070.
  إجمالي السياسات 395 (نفس العدد — ALTER بس).
- `scripts/prod-smoke/owner-admin-context-tickets.sql` (07:27 UTC، معاملة بترجع كلها) ⇒
  **PASS** المالك (سياق admin): 33/33 تذكرة عميل، 25 رد، تعديل ورد ناجحين؛
  **PASS** عميل حقيقي: 3 من تذاكره الـ 3 بس، وتغيير الحالة مرفوض (P0001).
- بعدها: 38 تذكرة، 25 رد، مفيش رد تجريبي، طابور pg_net فاضي، `ticket_number_seq` = 1120.
- Logs (07:10 → 07:28): مفيش أخطاء غير رسالة الفحص المقصودة.

**ROLLBACK:** `migrations/_rollback/070_owner_admin_context_tickets.down.sql` (نص الإنتاج
للسياسات والمحفّزين). مش مطلوب.
