# توحيد MCP/OAuth على `mad3oom.com` — الدليل والخطة

هذا المستند مخرَج **Phase C/D**. **لم يُنفَّذ منه شيء في الإنتاج.**
كل ما فيه قياسات فعلية + خطة تنتظر موافقة.

يكمّل `docs/DOMAIN-MIGRATION.md` ويصحّح نقطتين فيه (§5).

---

## 1. القياس: السلسلة كاملة، مقيسة لا مُستنتَجة

كل الطلبات أدناه نُفِّذت من شبكة Supabase عبر امتداد `http` في Postgres
(البيئة المحلية محجوبة عن الدومين بسياسة المؤسسة)، بتاريخ 2026-09-16.

### حلقة الفشل، خطوة بخطوة

| # | الطلب | النتيجة | الدلالة |
|---|---|---|---|
| 1 | `POST https://mad3oom.com/mcp` بلا توكن | `401` + `WWW-Authenticate: Bearer resource_metadata="https://mad3oom.online/.well-known/oauth-protected-resource"` | الخادم يوجّه العميل إلى **`.online`** |
| 2 | `GET https://mad3oom.online/.well-known/oauth-protected-resource` | `301` → `.com` (الـGET ينجو) | — |
| 3 | محتوى PRM | `authorization_servers: ["https://mad3oom.online"]` | **`.online`** مرة أخرى |
| 4 | `GET .../.well-known/oauth-authorization-server` | `registration_endpoint: "https://mad3oom.online/oauth/register"` | **`.online`** مرة ثالثة |
| 5 | `POST https://mad3oom.online/oauth/register` | **`405`** + `Location: https://mad3oom.com/oauth/register` + `{"error":"invalid_request","error_description":"Only POST is supported"}` | **السلسلة تموت هنا** |

الخطوة 5 هي التوقيع القاطع: الدالة نفسها تقول «Only POST is supported»
ردًّا على ما أرسله العميل كـ`POST`. السبب أن إعادة التوجيه 301 حوّلت
الطريقة إلى `GET` — وهذا سلوك مواصفة Fetch نفسها، لا خطأ في عميل بعينه:

> 301/302/303 تُحوِّل `POST` إلى `GET` عند المتابعة.

### المقابل: كل شيء يعمل على `.com` اليوم

| الطلب | النتيجة |
|---|---|
| `GET https://mad3oom.com/.well-known/oauth-authorization-server` | `200`، **بلا أي إعادة توجيه** |
| `GET https://mad3oom.com/.well-known/oauth-protected-resource` | `200`، بلا إعادة توجيه |
| `POST https://mad3oom.com/oauth/register` | **`201 Created`** — عميل مُسجَّل فعليًا |
| `POST https://mad3oom.com/mcp` | `401` صحيح (لا `405`) |

> عميل الاختبار الذي أنشأه الطلب أعلاه (`client_name: "probe"`) **حُذف
> فورًا** من `oauth_clients` بعد القياس. لم يبقَ أثر.

**الخلاصة المقيسة:** البنية التحتية على `.com` سليمة تمامًا وجاهزة.
لا ينكسر شيء إلا لأن **الاكتشاف يُعلن `.online`**.

`vercel.json` يستخدم `rewrites` لا `redirects` للمسارات الستة
(`/.well-known/*`, `/oauth/*`, `/mcp`) — فلا يوجد أي 301 داخل الدومين
الواحد. إعادة التوجيه الوحيدة هي على مستوى الدومين: `.online → .com`.

---

## 2. الخلل الثاني: `resource` لا يطابق (RFC 9728 §3.3)

PRM تُعلن اليوم:

```json
"resource": "https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/mcp"
```

بينما العميل يتصل بـ`https://mad3oom.com/mcp`. ونصّ RFC 9728 §3.3 يُلزم
العميل بالتحقق من تطابق `resource` مع المورد الذي يصل إليه. عميل صارم
يرفض البيانات الوصفية كلها عند هذا الاختلاف.

### لماذا تغييره آمن — بدليل لا بترجيح

بحثٌ في كامل سلسلة MCP/OAuth عن أي ربط جمهور:

- `oauth-token` **لا يقرأ** المعامل `resource` إطلاقًا.
- لا وجود لـ`aud` ولا `audience` ولا أي مؤشّر مورد في
  `mcp/_shared/api-auth.ts` ولا في `oauth-authorize` ولا `oauth-token`.
- التوكنات غير شفّافة (`mad3oom_bt_*`) ويُتحقَّق منها بمطابقة SHA-256
  في `api_tokens` — لا ادّعاء جمهور في أي مسار.

أي أن `resource` اليوم **قيمة مُعلَنة لا مُتحقَّق منها خادميًا**. تغييرها
لا يكسر شيئًا في الخادم، والمواصفة تفرض تغييرها للعميل. لذلك: **CHANGE**.

> **تنبيه على عدم كفاية التغيير وحده:** `docs/DOMAIN-MIGRATION.md` يقول إن
> `resource` «مشتق من `SUPABASE_URL` وكان آمنًا للترحيل أصلًا». هذا صحيح
> لسؤال الترحيل، وخطأ لسؤال المطابقة: الاشتقاق من `SUPABASE_URL` هو
> بالضبط ما يجعله لا يطابق ما يراه العميل. يجب أن يصير `${PUBLIC_SITE_ORIGIN}/mcp`.

---

## 3. الخلل الثالث: دالة خامسة لم تُحصَ

`docs/DOMAIN-MIGRATION.md` §3 يعدّ **أربع** دوال ترتبط بـ`PUBLIC_SITE_ORIGIN`.
العدد **خمسة**:

```
supabase/functions/mcp/index.ts:33
const PROTECTED_RESOURCE_METADATA_URL =
  "https://mad3oom.online/.well-known/oauth-protected-resource";
```

هذه هي ترويسة `WWW-Authenticate` التي يردّ بها خادم MCP على 401، أي
**أول ما يتبعه أي عميل** لبدء الاكتشاف (الخطوة 1 في جدول §1). ما لم
تتغيّر، يظل كل عميل يُرسَل إلى `.online` حتى لو قُلبت الدوال الأربع.

`mcp/` لقطة إنتاج حرفية (`mcp/README.md`) نصّت صراحةً على أن ترويسة
`WWW-Authenticate` **لم تُمسّ**. تعديلها يحوّل المجلد من لقطة إلى نسخة
عمل، وهو قرار يخصّ صاحب المشروع — **لم يُنفَّذ**.

---

## 4. ما يجب أن يتغيّر، ولماذا، وكيف يُتراجَع عنه

لا شيء ممّا يلي مُنفَّذ. كله ينتظر موافقة صريحة.

| # | التغيير | لماذا | التراجع |
|---|---|---|---|
| C1 | نشر النسخ الموجودة في المستودع من `oauth-discovery`, `oauth-authorize`, `oauth-protected-resource`, `mcp-oauth-callback` | النسخ المنشورة لا تعرف `PUBLIC_SITE_ORIGIN` أصلًا، فضبط المتغيّر وحده **لا يفعل شيئًا**. النشر وحده **لا يغيّر سلوكًا** لأن القيمة الافتراضية هي `.online` الحالية | إعادة نشر نسخة الإنتاج المحفوظة |
| C2 | ضبط `PUBLIC_SITE_ORIGIN=https://mad3oom.com` | يقلب الأربع معًا: issuer + نقاط الاكتشاف + صفحة الموافقة + صفحة عودة MCP | **حذف المتغيّر** وإعادة نشر الأربع. الافتراضي يستعيد `.online` بالحرف |
| C3 | تغيير `PROTECTED_RESOURCE_METADATA_URL` في `mcp/index.ts` إلى `${PUBLIC_SITE_ORIGIN}/.well-known/oauth-protected-resource` | بدونه يبقى أول ما يتبعه العميل `.online` (§3) | إعادة نشر لقطة `mcp` v31 المحفوظة |
| D1 | `resource` في `oauth-protected-resource` → `${PUBLIC_SITE_ORIGIN}/mcp` | RFC 9728 §3.3 (§2) | جزء من نفس إعادة النشر |

### ترتيب إلزامي

C1 و C3 و D1 **نشر كود** بقيم افتراضية تحفظ السلوك الحالي — تُنشر أولًا
ويُتحقَّق أن شيئًا لم يتغيّر. ثم C2 **متغيّر واحد** يقلب كل شيء دفعة
واحدة. هذا ما يجعل التراجع سطرًا واحدًا لا خمس عمليات نشر.

استثناء واحد: **D1 ليس no-op**. اليوم `resource` هو رابط Supabase؛ بعد
النشر يصير `${PUBLIC_SITE_ORIGIN}/mcp`، أي `.online/mcp` قبل C2 و`.com/mcp`
بعده. كلتا القيمتين أصحّ من الحالية (كلتاهما تطابق ما يتصل به العميل على
ذلك الدومين)، لكن يجب ألّا يُقال إنه بلا أثر.

### ما يحدث للعملاء المربوطين

- **توكنات الوصول**: لا تتأثر — غير شفّافة، بلا فحص issuer.
- **تسجيلات العملاء (18 صفًا)**: تبقى صالحة — البحث بـ`client_id` فقط.
- **إعادة الموافقة**: مطلوبة عمليًا. تغيّر الـissuer يعني «خادم تفويض
  جديد» من منظور العميل، فيعيد التسجيل والموافقة. هذا **إعادة ربط
  مرئية للمستخدم، لا عطل** — والوضع الحالي أسوأ: لا ربط أصلًا.

---

## 5. تصحيحان على `docs/DOMAIN-MIGRATION.md`

1. §3 يقول إن `resource` «كان آمنًا للترحيل أصلًا». آمن للترحيل نعم،
   لكنه **غير مطابق** لما يراه العميل — انظر §2.
2. §3 يعدّ أربع دوال. العدد خمسة: `mcp/index.ts` منها — انظر §3.

كما أن §4 Stage 0 يطلب «التأكد أن `mad3oom.com` حيّ ويخدم نفس البناء».
**مقيس ومؤكَّد:** يخدم، بـ200 وبلا إعادة توجيه، والتسجيل عليه ينجح فعلًا.
