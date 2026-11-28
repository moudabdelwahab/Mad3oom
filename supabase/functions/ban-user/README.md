# ban-user — حظر حساب ورفع الحظر (Edge Function)

تحلّ محلّ التحديث المباشر من `assets/js/admin/users.js` (PostgREST على
`profiles` وحده). ذلك المسار كان يكتب `ban_status` فقط: لا يُلغي جلسة ولا
يضبط `auth.users.banned_until`.

## مسارات الواجهة — كلها عبر هذه الدالة

- لوحة الأدمن `assets/js/admin/users.js` (حظر/رفع).
- صفحة المحظورين `assets/js/admin/banned.js` (رفع).
- لوحة المالك `assets/js/owner/owner-user-actions.js` (حظر/رفع).

دالة `owner_ban_user` (147) ما زالت موجودة في القاعدة للتوافق، لكن
الواجهة لم تعد تناديها — ومن يناديها مباشرةً يكتب `profiles` وحدها بلا
مرآة Auth (نفس فجوة المسار القديم؛ إهمالها لاحقًا قرار منفصل).

## الطلب والاستجابة

```
POST /functions/v1/ban-user
Authorization: Bearer <JWT المُنادي>
{ "user_id": "<uuid>", "action": "ban", "reason": "سبب واضح (5+ أحرف)", "ban_until": "<ISO اختياري — حظر مؤقت>" }
{ "user_id": "<uuid>", "action": "unban" }
```

الاستجابة (200):

```json
{
  "ok": true, "action": "ban", "user_id": "...",
  "ban_status": "permanent", "ban_until": null,
  "auth_ban_applied": true, "auth_error": null,
  "sessions": { "revoked": false, "reason": "no_admin_signout_endpoint", "note": "..." }
}
```

- `auth_ban_applied: false` تعني: `profiles` حُدِّثت لكن `updateUserById`
  فشل (`auth_error` يحمل الرسالة) — أعد المحاولة (استدعاء الحظر ثانيةً
  يعيد المحاولة؛ القيم نفسها فلا ضرر).
- `sessions.revoked` دائمًا `false` عمدًا — انظر «الجلسات» أدناه. لا
  تعاملها كفشل: الحظر نافذ فورًا عبر بوابة RLS (الترحيل 144).

## الجلسات — لماذا لا يوجد global signOut هنا

التصميم الأصلي افترض `auth.admin.signOut(userId, 'global')`. التحقق من
المصادر أثبت أن هذا النداء غير موجود بهذه الصيغة:

- مواصفات GoTrue OpenAPI (master): لا مسار
  `/admin/users/{id}/signout` — مسارات المشرف هي `GET /admin/users`،
  و`GET/PUT/DELETE /admin/users/{userId}`، وعوامل MFA، وSSO فقط.
- توثيق supabase-js: `auth.admin.signOut(jwt, scope)` يأخذ **JWT** لا
  معرّف مستخدم — أي أنه يلغي جلسة صاحب ذلك الرمز، ولا يصلح لإلغاء جلسات
  مستخدم آخر من الخادم بلا رمزه.
- ما يعمل بمعرّف المستخدم: `updateUserById({ ban_duration })` — يكتب
  `auth.users.banned_until` فيمنع الدخول وتحديث الرمز (refresh).

فالتنفيذ الفوري للحظر مكوّن من طبقتين موجودتين فعلًا:

1. **فوري على البيانات**: `profiles.ban_status` + بوابة RLS (144) —
   المحظور لا يرى صفًا ولا يكتب في أي جدول موبوَّب لحظة الحظر، حتى
   برمز وصول (access token) ما زال صالحًا.
2. **على المصادقة**: `banned_until` يمنع الدخول والتحديث؛ جلساته تموت
   عند أول تحديث (ساعة على الأكثر بالإعداد الافتراضي).

الرمز الصادر وحده لا يُلغى حتى انتهائه — هذه حدود Supabase نفسها
(«There is no way to revoke a user's access token jwt until it
expires»)، لا قصور في هذه الدالة. إن أراد محمود إلغاءً فوريًا للرموز
فالخياران هما تقصير مدة JWT في إعدادات المشروع، أو فحص جلسة في RLS —
وكلاهما خارج هذا البند.

## الصلاحية

- مالك المنصة: `is_platform_owner()` + `owner_critical_ok()` (تحقّق
  بخطوتين حديث — مرآة `users.ban` owner_step_up_default=true في 121).
- غيره: رتبة `admin`/`support` + `staff_write_ok('users.ban')`.
- حظر الذات مرفوض؛ حظر مالك المنصة مرفوض دائمًا (انظر أدناه).

## استرداد المالك — الحظر لا يقفل المالك خارج حسابه نهائيًا

1. **الوقاية**: الدالة ترفض حظر المالك (صف `platform_authority`
   level=owner، أو رتبة `platform_owner`، أو بريد `mahmoud@mad3oom.com`)،
   والمحفِّز `guard_privileged_accounts` (053) يرفض تغيير أعمدة حظر
   المالك من أي جلسة أخرى. فلا مسار معتاد يوصله إلى الحظر أصلًا.
2. **إن حُظر خارج المسارين** (SQL مباشر أو لوحة Supabase): فإن
   `account_is_active()` ترجع `false` حتى للمعفى (144: `NOT is_banned`
   فوق الإعفاء — موثَّق في اختبار 144 §6)، و`banned_until` في Auth يمنع
   الدخول. الاسترداد حينها بمفتاح service_role من لوحة Supabase
   (SQL Editor):
   ```sql
   update public.profiles
      set ban_status = 'none', ban_until = null, ban_reason = null
    where id = '<owner-uuid>';
   update auth.users set banned_until = null where id = '<owner-uuid>';
   ```
   أو عبر Admin API: `updateUserById(ownerId, { ban_duration: 'none' })`
   بعد تحديث `profiles` بالطريقة نفسها.
3. **بعد رفع الحظر تعود الجلسات دون إعادة دخول**: الجلسات لم تُحذف
   أصلًا — التحديث (refresh) كان ممنوعًا فقط أثناء الحظر، فينجح ثانيةً
   بالرمز نفسه. لا حاجة لإعادة تعيين كلمة مرور. (والقاعدة نفسها تسري
   على أي حساب يُرفع حظره من هذه الدالة.)

## النشر (بموافقة محمود — ليس في هذا الفرع)

```
supabase functions deploy ban-user --project-ref srnelrdpqkcntbgudyto
```

لا سرّ جديد: `SUPABASE_URL` و`SUPABASE_ANON_KEY` و
`SUPABASE_SERVICE_ROLE_KEY` موجودة في بيئة Edge Functions.

## الاختبار الحي (يحتاج موافقة محمود — حساب اختباري مؤقت)

1. أنشئ حسابًا اختباريًا وسجّل دخوله من متصفح ثانٍ.
2. من لوحة الأدمن احظر الحساب الاختباري (السبب 5+ أحرف).
3. تحقّق: صفحة الحساب الاختباري تتحول إلى شاشة «حسابك محظور» (فرع
   `banned` في `my_account_gate` — الترحيل 152)؛ وتحديث الصفحة لا يعيد
   الدخول؛ وتسجيل الدخول من جديد مرفوض.
4. ارفع الحظر: الحساب يعود نشطًا دون إعادة دخول (التحديث ينجح ثانيةً).
5. تحقّق من `auth.users.banned_until` للحساب قبل الحظر وبعده (لوحة
   Supabase → Authentication → Users) — للتأكد من مرآة Auth.
