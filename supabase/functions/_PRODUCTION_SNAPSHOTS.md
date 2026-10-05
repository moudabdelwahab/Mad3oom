# لقطات الإنتاج وفجوة المستودع ↔ المنشور (سلسلة MCP/OAuth)

هذا المستند هو مخرَج **Phase A**. مسؤوليته شيئان فقط:

1. جرد اللقطات الحرفية المحفوظة من الإنتاج (ما هي، من أي نسخة، بأي hash).
2. إثبات **أين يختلف المستودع عن المنشور فعليًا** في سلسلة MCP/OAuth.

التقييم الأمني لكل دالة موجود في `_AUDIT_NOTES.md` — لا يُكرَّر هنا.

---

## 1. اللقطات المحفوظة في هذه الدفعة

كلها مأخوذة عبر `mcp__Supabase__get_edge_function` من مشروع
`srnelrdpqkcntbgudyto` بتاريخ **2026-09-15**، **بلا أي تعديل سلوك**.

| الدالة | النسخة | `ezbr_sha256` | `verify_jwt` | ملفات |
|---|---|---|---|---|
| `oauth-register` | 14 | `a6e4587281924afbb188771a993a0365541aaf330f9b2e14d491ada936cbc4a9` | `false` | 2 |
| `oauth-token` | 17 | `b3d268f3b31ed57ca0da174c4492f5e01856b6da48464ab1add100a267c3024e` | `false` | 2 |
| `oauth-authorize-approve` | 15 | `4f37ce2eb2d9ab62d807805d1cedc661d8056c0022ab092d45f9b6ea0dd058e5` | `true` | 1 |
| `mcp-oauth-start` | 12 | `4d402aedd0d5b5012245c338a6d0591b09e092363459b4fef4658f9c9899015e` | `true` | 1 |
| `mcp-server-info` | 16 | `46a6ff482d17a168097c5a25bb92732929d51bfb53bd98089823002e6e8a9486` | `true` | 2 |
| `save-mcp-credentials` † | 16 | `12e441cd456964dcc60d616d3214ac5098d7e3a8df0a81cfc816bb2f314e1d87` | `true` | 3 |

† لم تكن ضمن القائمة المطلوبة؛ ظهرت عند مقارنة `list_edge_functions`
بمحتوى المستودع. منشورة، غير محفوظة، وتقع مباشرة في مسار MCP.

تفاصيل كل لقطة في `README.md` داخل مجلدها. سبقتها لقطة `mcp` (v31)
في `mcp/README.md` بنفس الأسلوب.

### ما جرى التحقق منه في هذه الدفعة

- ✅ كل `import` نسبي يشير إلى ملف موجود فعلًا داخل اللقطة (9/9).
- ✅ الملفات كلها تُحلَّل بـ`tsc --strict` بلا أي خطأ بنيوي
  (بعد استثناء `jsr:` و`Deno` غير القابلَين للحل خارج Deno).
- ✅ الفروق البايتية المقصودة موثَّقة، لا موحَّدة — أهمها أن
  `oauth-register/_shared/rate-limit.ts` و`oauth-token/_shared/rate-limit.ts`
  **ليسا متطابقَين** في الإنتاج (تعليقان عربيان إضافيان في الأول).

### ما لم يجرِ التحقق منه

**المطابقة بايت-لبايت مع الحزمة المنشورة** — نفس القيد المذكور في
`mcp/README.md`: لا `supabase` CLI في بيئة العمل، والشبكة إلى
`supabase.co` محجوبة بسياسة المؤسسة، فلا سبيل لتنزيل الحزمة الأصلية
ومقارنتها. اللقطات منسوخة من مخرَج واجهة الإدارة كما هو.

للتحقق من جهازك:

```bash
for f in oauth-register oauth-token oauth-authorize-approve \
         mcp-oauth-start mcp-server-info save-mcp-credentials; do
  supabase functions download "$f" --project-ref srnelrdpqkcntbgudyto
  diff -r "supabase/functions/$f" "<المجلد_المنزَّل>/$f"
done
```

---

## 2. فجوة المستودع ↔ المنشور في سلسلة MCP/OAuth

| الدالة | في المستودع؟ | الحالة |
|---|---|---|
| `mcp` | ✅ | لقطة v31 مطابقة للمنشور |
| `mcp-invoke-tool` | ✅ | نُشر من المستودع → متطابق |
| `test-mcp-server` | ✅ | نُشر من المستودع → متطابق |
| `oauth-register` | ✅ (هذه الدفعة) | لقطة v14 |
| `oauth-token` | ✅ (هذه الدفعة) | لقطة v17 |
| `oauth-authorize-approve` | ✅ (هذه الدفعة) | لقطة v15 |
| `mcp-oauth-start` | ✅ (هذه الدفعة) | لقطة v12 |
| `mcp-server-info` | ✅ (هذه الدفعة) | لقطة v16 |
| `save-mcp-credentials` | ✅ (هذه الدفعة) | لقطة v16 |
| `oauth-discovery` | ✅ | ⚠️ **المستودع متقدّم على الإنتاج** |
| `oauth-authorize` | ✅ | ⚠️ **المستودع متقدّم على الإنتاج** |
| `oauth-protected-resource` | ✅ | ⚠️ **المستودع متقدّم على الإنتاج** |
| `mcp-oauth-callback` | ✅ | ⚠️ **المستودع متقدّم على الإنتاج** |

### الانحراف الأربعة: تفصيله

نسخة المستودع من هذه الدوال الأربع تقرأ الأصل العام من متغيّر بيئة
`PUBLIC_SITE_ORIGIN` مع `mad3oom.online` كقيمة افتراضية، أي أن **نشرها
وحده لا يغيّر أي سلوك**. نسخة **الإنتاج** المنشورة حاليًا لا تعرف
`PUBLIC_SITE_ORIGIN` إطلاقًا وتُثبّت `mad3oom.online` في الكود.

النتيجة العملية — وهي نقطة مهمة تصحّح افتراضًا شائعًا:

> **ضبط `PUBLIC_SITE_ORIGIN` في لوحة Supabase وحده لن يفعل شيئًا**،
> لأن الكود المنشور لا يقرؤه أصلًا. التحوّل إلى `mad3oom.com` يتطلّب
> **نشر** هذه الدوال الأربع أولًا، ثم ضبط المتغيّر.

هذا هو مدخل **Phase C** (التوحيد على `mad3oom.com`)، ولم يُنفَّذ منه شيء
في Phase A.

### لماذا هذا حاجب فعلي (Phase A / الدليل)

سلسلة الاكتشاف العامة تُعلن `https://mad3oom.online` كهوية المُصدِر
(issuer). أي عميل MCP متوافق يتبع هذا الإعلان فيرسل أول `POST` (تسجيل
العميل، RFC 7591) إلى `.online`، فيردّ 301 إلى `.com`. ووفق مواصفة
Fetch، إعادة التوجيه 301/302/303 **تحوّل POST إلى GET**، فيصل الطلب
إلى النقطة الصحيحة بالطريقة الخاطئة ويُردّ بـ`405`.

أي أن **كل POST في سلسلة OAuth ميت حاليًا**، وتموت السلسلة عند أول
خطوة (DCR). هذا يصيب ChatGPT وClaude وأي عميل متوافق بالتساوي — ليس
سلوكًا خاصًا بعميل بعينه، ولا يُحَل بمعالجة خاصة لعميل بعينه.

---

## 3. الدوال المنشورة غير المحفوظة (خارج نطاق MCP)

تسعة عشر دالة منشورة أخرى ليست محفوظة في المستودع، وكلها خارج سلسلة
MCP/OAuth. **لم تُلمس** ولا تدخل في هذا النطاق. قائمتها تُستخرَج وقت
الحاجة بمقارنة `list_edge_functions` بمحتوى `supabase/functions/`،
وتقييمها الأمني في `_AUDIT_NOTES.md`.

> لا تُسرَد أسماؤها هنا عمدًا: `tests/remediation-static.test.mjs` يمنع
> ظهور اسم إحدى الدوال المحذوفة في أي ملف خارج قائمة الاستثناء، وهذا
> الملف ليس ضمنها.


---

## 4. P0 — الدوال المنشورة من غير مصدر (2026-09-29)

مخرَج **P0** من خطة Conversation Core + Agent Runtime: كل دالة منشورة على الإنتاج مالهاش
مصدر في **أي** من المستودعات الثلاثة (`Mad3oom` و`whatsapp-mad3oom` و`sie`) اتحفظت هنا
**حرفيًا، من غير أي تعديل سلوك**. الهدف تحويل كود الإنتاج لمصدر تحت التحكم، مش إعادة تصميمه.

**طريقة الحصر:** `list_edge_functions` (60 دالة منشورة) ناقص كل مجلدات
`supabase/functions/` في المستودعات الثلاثة. النتيجة 14 دالة بلا مصدر خالص، و`gemini-proxy`
اللي مصدرها الوحيد كان النسخة الضعيفة المؤرشفة (v46) بينما الإنتاج شغّال بالبديل المتقاعد (v48).

**طريقة النسخ:** مخرَج `get_edge_function` اتكتب على القرص **آليًا** (سكربت بيقرا نتيجة الأداة
كما هي) — مش منسوخ باليد. كل ملف ليه sha256 في `README.md` بتاع مجلده.

| الدالة | النسخة | `ezbr_sha256` | `verify_jwt` | ملفات | المجلد |
|---|---|---|---|---|---|
| `telegram-webhook` | 37 | `69d1687d92ba5bd7f1950cc7bba53cbd92e208528f33e784d15963ae302ebcea` | `false` | 1 | `telegram-webhook/` |
| `exchange-token` | 41 | `127aaa0cdda336a9b6f88bfe3c5d9058491430e4c78fe2f8bcd4642ac7d2c5a8` | `true` | 2 | `exchange-token/` |
| `manage-subdomain` | 27 | `13eb269796962cd320cce72d549f64f89f695100c30abcbca9733ea498dc7a2a` | `false` | 1 | `manage-subdomain/` |
| `subdomain-auth-check` | 16 | `593e28cec83d6f59ed5866cd93c133f12f4506e13b161d52e0560928172c8f51` | `false` | 1 | `subdomain-auth-check/` |
| `inbound-email-webhook` | 16 | `230b21242a2f1d851235c522091801b9f558628a7019431813e43642e1ac66e6` | `false` | 1 | `inbound-email-webhook/` |
| `resend-inbound-webhook` | 16 | `dece3cc0693e640a229aca8e1ec3dfd25529794dc0613a4dd4a7e27d90c05431` | `false` | 1 | `resend-inbound-webhook/` |
| `telegram-connect-bot` | 15 | `cd2a2e9c2f1173e62264cd28e2daea8e615dc5feb298d72e03ad2fadf88e3b06` | `true` | 1 | `telegram-connect-bot/` |
| `regenerate-api-token-secret` | 18 | `ed608ea3f9f2022785755b21579413dc1683c78797f2c5a645452f36d73c2240` | `true` | 1 | `regenerate-api-token-secret/` |
| `test-integration-connection` | 17 | `0692e29566d93e93854d9de268fed7e56054400426e4367f9232e0ae63e8aa63` | `true` | 1 | `test-integration-connection/` |
| `whatsapp-phone-status` | 13 | `1b5cfb2c8ba4f56dca1f6e8f0b9af8289446ada4023c2e2e7d88e5fee3bca7d8` | `true` | 2 | `whatsapp-phone-status/` |
| `wf-executor` | 45 | `fe51f82a224a9038745b2b33d58477a6c7219ac2ed54cfe8e5b1a41d03bceb57` | `false` | 1 | `wf-executor/` |
| `chat-bot-reply` | 14 | `8022f314f729de0ed21f060fe858908ff74a55d56342ea634ad0041c1812c7f6` | `true` | 1 | `chat-bot-reply/` |
| `agent-manager` | 15 | `6de59bbc5e00183c9996307a45bbb53945b7fbea5cb8092a74033383b25fe575` | `true` | 1 | `agent-manager/` |
| `aqar-auth` | 10 | `bbbc89619f079e78b1033ae9b9b07fedc457ee50747e5c04c944c239877bc106` | `false` | 3 | `aqar-auth/` |
| `gemini-proxy` | 48 | `7597780475e3d870afdb38002cecb94cdbcccc7ba563fb4046a5b21619b8a53c` | `true` | 1 | `_retired/gemini-proxy/deployed/` |

ملاحظات:

- `gemini-proxy` اتحفظ جوه `_retired/gemini-proxy/deployed/` مش في مجلد فعّال: قرار التقاعد (C-07)
  واختبار `remediation-static` بيمنعوا مجلد `supabase/functions/gemini-proxy`. الإنتاج فيه البديل
  اللي بيرد 410 بس، فده اللي اتحفظ.
- `drift-baseline.json` اتقلّص من 19 لـ5: الـ14 دول بقالهم مصدر. الباقيين (`gemini-proxy` و`integrations-api`
  و`register-whatsapp` و`sie-api` و`whatsapp-webhook`) مصدرهم في مستودعات تانية أو في `_retired/`
  — والكاشف بيعدّ مستودع Mad3oom بس.
- **ما لم يُتحقق منه:** المطابقة البايتية مع حزمة eszip المنشورة نفسها (نفس قيد القسم ١). المطابقة
  هنا مع مخرَج واجهة الإدارة للنسخة المذكورة.
- أي ملاحظة على الكود ده (مثلًا `SYSTEM_FALLBACK_USER_ID` ومعرّف أدمن مكتوب في `wf-executor`) مكانها
  PR منفصل بعد مراجعة: اللقطة بتسجّل الواقع، مش بتصلّحه.
