# gemini-proxy — retired 2026-09-18

## لماذا أُوقفت

ثغرة **C-07** في `FULL_PROJECT_AUDIT.md`: قراءة عابرة للمستأجرين (IDOR).

الدالة كانت منشورة على الإنتاج بالنسخة **v46** بـ`verify_jwt = true`، وبلا أي
مصدر في المستودع. وكان `userId` يُقرأ من **جسم الطلب** ثم يُستعمل عميل
`service_role` (يتجاوز RLS) لقراءة:

- `profiles.full_name` لذلك المعرّف
- آخر 3 تذاكر له (`ticket_number`, `status`, `priority`, `created_at`)

ثم تُحقن النتيجة في `systemPrompt` ويُعاد ردّ النموذج إلى المنادي. **لا مطابقة
إطلاقًا** بين `userId` في الجسم والهوية في الـJWT.

أي أن أي حساب مسجَّل كان يقرأ اسم وبيانات تذاكر أي مستخدم آخر على المنصة.
ومعرّفات الضحايا ليست سرًّا: `check-subdomain-status` يعيد `user_id` المالك
لأي مجهول لكل نطاق فرعي نشط.

## سجل التعامل

`supabase/functions/_AUDIT_NOTES.md` كان قد شخّص هذه الثغرة في مراجعة سابقة
وحذف الدالة من المستودع، ونصّ صراحةً:

> the production function still exists and must be removed from the Supabase
> dashboard — that step is NOT done

ولم يُنفَّذ الحذف. فبقيت الثغرة حيّة من وقتها حتى هذه الدفعة.

## ما نُفِّذ في هذه الدفعة

واجهة Supabase MCP المتاحة لا تحتوي `delete_edge_function`، فلا سبيل لحذف
الدالة برمجيًا. لذلك:

1. أُرشِف نصّها الأصلي (v46) في `index.ts.retired` بجانب هذا الملف، للتوثيق.
2. نُشرت مكانها نسخة **لا تلمس قاعدة البيانات إطلاقًا** وترفض كل طلب بـ
   `410 Gone` — نفس نمط `ai-probe-temp` القائم في المشروع.

الثغرة مغلقة بذلك: لا قراءة، ولا `service_role`، ولا `userId` من الجسم.

## الخطوة المتبقية (تحتاج مالك المشروع)

احذف الدالة نهائيًا من لوحة Supabase:

**Dashboard → Edge Functions → gemini-proxy → Delete**

الحذف تنظيف لا إغلاق ثغرة — التحييد أعلاه هو ما أغلقها.
