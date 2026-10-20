-- ============================================================================
-- تراجع 109: يعيد الشكل الذي كان في الإنتاج قبل 109 حرفيًا
--   • سياسة الإدارة على advanced_settings تعود FOR ALL TO public (ومعها عطل قراءة الزائر).
--   • تُحذف get_public_registration_settings().
--   • تعود صلاحيات anon على الجدول كما كانت (الافتراضي في Supabase).
--
-- قبل التشغيل: login.html بعد 109 تنادي get_public_registration_settings؛ بحذفها تعرض
-- للزائر «تعذّر التحقق من حالة التسجيل» (آمن، لا تفتح التسجيل). أرجِع الواجهة أولًا إن
-- أردت سلوك ما قبل 109 كاملًا.
-- ============================================================================
begin;

alter policy "Admins can manage advanced_settings" on public.advanced_settings to public;

drop function if exists public.get_public_registration_settings();

grant insert, update, delete, truncate, references, trigger on public.advanced_settings to anon;

commit;
