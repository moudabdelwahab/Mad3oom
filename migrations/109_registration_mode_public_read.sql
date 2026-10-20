-- ============================================================================
-- 109_registration_mode_public_read.sql — الزائر يقرأ وضع التسجيل فعلًا، ولا شيء غيره
--
-- العطل (مُثبت في الإنتاج 2026-10-20، قراءة فقط)
--   صفحة login.html تقرأ advanced_settings (key = 'registration_mode') بمفتاح الزائر
--   لتعرف: قائمة انتظار أم تسجيل مفتوح. القراءة تفشل للزائر بـ
--     42501 permission denied for function has_elevated_authority
--   السلسلة:
--     • على advanced_settings سياستان SELECT متساهلتان، فيقيّم Postgres الاثنتين:
--         advanced_settings_public_read_registration_mode  (anon, authenticated) ← المقصودة
--         "Admins can manage advanced_settings"            (FOR ALL TO public)   ← تشمل anon خطأً
--     • سياسة الإدارة تستعلم profiles، وسياسة القراءة على profiles تنادي
--       has_elevated_authority()، والدالة مسحوبة من anon منذ 038 (وهذا صحيح).
--     • فيفشل الاستعلام كله للزائر، و login.html كانت تعتبر أي فشل «تسجيلًا مفتوحًا»:
--       الزائر يرى «إنشاء حساب جديد» بينما الإعداد waitlist (066 كانت تلتقط الحساب
--       بعدها في القائمة، فالضرر كان في الواجهة لا في البوابة).
--
-- الإصلاح (لا يمنح الزائر أي دالة مميزة ولا أي صف من profiles)
--   ① سياسة الإدارة لـ authenticated وحده. الزائر لا يملك auth.uid() فلم يكن يطابقها
--     أصلًا؛ تقييمها له كان العطل نفسه. شرطها للمستخدم المسجَّل بلا تغيير حرفيًا.
--   ② get_public_registration_settings(): قائمة سماح من ثلاثة حقول عامة فقط
--     (mode · waitlist_message · expected_launch_date). mode خارج ('open','waitlist')
--     يعود null، فالواجهة لا تخمّن وضعًا. الصف الغائب يعود null.
--   ③ سحب صلاحيات الكتابة الشكلية (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER)
--     من anon على advanced_settings: لا سياسة تسمح بها أصلًا، و TRUNCATE لا تخضع لـ RLS.
--     SELECT يبقى لأن سياسة القراءة العامة (004) تبقى للتوافق مع الواجهة المنشورة حاليًا.
--
-- الترتيب: هذا الترحيل أولًا، ثم نشر login.html الجديدة (تنادي ②). العكس يُظهر للزائر
-- حالة «تعذّر التحقق» (آمنة) حتى يُطبَّق الترحيل.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/109_registration_mode_public_read.down.sql
-- ============================================================================
begin;

do $$
begin
  if to_regclass('public.advanced_settings') is null then
    raise exception '109: advanced_settings غير موجود';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'advanced_settings'
                    and policyname = 'Admins can manage advanced_settings') then
    raise exception '109: سياسة "Admins can manage advanced_settings" غير موجودة — الشكل يختلف عن المتوقع';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'advanced_settings'
                    and policyname = 'advanced_settings_public_read_registration_mode') then
    raise exception '109: سياسة القراءة العامة لـ registration_mode (004) غير موجودة';
  end if;
end $$;

-- ① ─────────────────────────────────────────────────────────────────────────
alter policy "Admins can manage advanced_settings" on public.advanced_settings to authenticated;

-- ② ─────────────────────────────────────────────────────────────────────────
create or replace function public.get_public_registration_settings()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
           'mode', case when s.value->>'mode' in ('open', 'waitlist') then s.value->>'mode' end,
           'waitlist_message', s.value->>'waitlist_message',
           'expected_launch_date', s.value->>'expected_launch_date')
    from public.advanced_settings s
   where s.key = 'registration_mode';
$$;

comment on function public.get_public_registration_settings() is
  'إعداد التسجيل العام لصفحة الدخول: mode (open|waitlist|null) ونص الانتظار وموعد الإطلاق فقط. '
  'لا يقرأ غير صف registration_mode ولا يعيد غير هذه الحقول. null = غير قابل للتحقق، والواجهة لا تفتح التسجيل.';

revoke all on function public.get_public_registration_settings() from public;
grant execute on function public.get_public_registration_settings() to anon, authenticated, service_role;

-- ③ ─────────────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger on public.advanced_settings from anon;

commit;
