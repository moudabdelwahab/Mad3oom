# دالة `oauth-register` — لقطة من الإنتاج

**لقطة حرفية** للمصدر المنشور فعليًا في مشروع `srnelrdpqkcntbgudyto`،
حُفظت لأن الدالة لم تكن موجودة في المستودع. نفس أسلوب `supabase/functions/mcp/README.md`.

| | |
|---|---|
| النسخة المنشورة وقت اللقطة | **14** |
| `ezbr_sha256` | `a6e4587281924afbb188771a993a0365541aaf330f9b2e14d491ada936cbc4a9` |
| `verify_jwt` | `false` |
| عدد الملفات | 2 |
| المصدر | `mcp__Supabase__get_edge_function(project_id="srnelrdpqkcntbgudyto", function_slug="oauth-register")` |
| تاريخ اللقطة | 2026-09-15 |

الدور: تسجيل عملاء OAuth ديناميكيًا (RFC 7591) — أول طلب `POST` يرسله أي عميل MCP.

## لم يُعدَّل أي سلوك

اللقطة حرفية عمدًا. **لم يُغيَّر** أي دومين، أو `resource`، أو ترويسة،
أو منطق مصادقة/تفويض، أو أي إعداد إنتاج.

## حدّ المعدل (103) — انحراف مقصود عن اللقطة

أُزيلت نسخة `_shared/rate-limit.ts` المحلية لهذه الدالة. كانت تعدّ الصفوف ثم
تُدرج (سباق بين الطلبات المتزامنة)، وتأخذ الـIP من **أقصى يسار**
`X-Forwarded-For` — أي القيمة التي يكتبها المتصل — فيُتجاوز الحد بترويسة عشوائية
لكل طلب على عنوان `supabase.co` المباشر. الدالة الآن تستورد
`../_shared/rate-limit.js` (عدّاد ذرّي في القاعدة، IP من `cf-connecting-ip`،
سياسات `oauth.*` في `rate_limit_policies`). الردود ورموزها كما هي، مع ترويسة
`Retry-After` و`RateLimit-*`، و503 `temporarily_unavailable` إن تعذّر التحقق.
انظر `docs/security/RATE_LIMITING.md`.
