-- ============================================================================
-- 046 — تقوية التحقق من رمز تيليجرام (H-02)
-- ============================================================================
--
-- الحالة قبل هذه الهجرة (مُتحقَّق منها على Production في 2026-09-18):
--
--   • `admin_telegram_otps` عليها سياسة قراءة `auth.uid() = user_id`. أي أن
--     المستخدم يقرأ `otp_hash` الخاص به. الهاش هو SHA-256 لستة أرقام — فضاؤه
--     10⁶، يُكسر محليًا في أجزاء من الثانية. ومعنى ذلك أن العامل الثاني يسقط
--     أمام من يملك جلسة بالفعل: يقرأ الهاش، يستخرج الرمز، ويتخطى تيليجرام
--     تمامًا. (هذا اكتشاف جديد أثناء الإصلاح، لم يكن في التقرير الأصلي.)
--
--   • `increment_otp_attempts` ممنوحة لـanon وauthenticated وهي ليست
--     SECURITY DEFINER. فهي بلا أثر لهما اليوم (لا سياسة UPDATE على الجدول)،
--     لكن المنح نفسه بلا مبرر: المسار الشرعي الوحيد هو مفتاح الخدمة.
--
--   • لا فهرس على أي من عمودَي البحث. الجدولان صغيران الآن (3 صفوف و0 صفًا)،
--     لكن مسار التحقق الجديد يقرأ بـ(user_id) و(ip_address, created_at) في كل
--     محاولة، وهو بالتحديد المسار الذي يريد المهاجم إغراقه.
--
-- ما تفعله هذه الهجرة: تنقل قرار «هل يُسمح بهذه المحاولة؟» إلى القاعدة، حيث
-- يمكن اختباره بـSQL داخل transaction ويُتراجع عنه — لا فوق HTTP. ودالة الحافة
-- تصير مستهلكًا لهذا القرار لا مالكةً له.
--
-- ============================================================================

-- ============================================================================
-- 1) الهاش سرّ — لا يُقرأ من العميل
-- ============================================================================

drop policy if exists "Admins can view their own OTPs" on public.admin_telegram_otps;

comment on table public.admin_telegram_otps is
  'رموز تيليجرام لمرة واحدة. لا سياسة قراءة للعميل عمدًا (H-02): otp_hash هو
   SHA-256 لستة أرقام، فقراءته تعادل قراءة الرمز نفسه. الوصول الوحيد عبر
   مفتاح الخدمة من دالة verify-otp.';

-- ============================================================================
-- 2) عدّاد المحاولات لمفتاح الخدمة وحده
-- ============================================================================

revoke execute on function public.increment_otp_attempts(uuid) from public, anon, authenticated;

-- ============================================================================
-- 3) فهارس مسار التحقق
-- ============================================================================

create index if not exists admin_telegram_otps_live_lookup_idx
  on public.admin_telegram_otps (user_id, is_used, expires_at);

create index if not exists telegram_auth_logs_ip_recent_idx
  on public.telegram_auth_logs (ip_address, created_at desc);

create index if not exists telegram_auth_logs_user_recent_idx
  on public.telegram_auth_logs (user_id, created_at desc);

-- ============================================================================
-- 4) بوابة المحاولة — تُستشار **قبل** مطابقة الهاش
-- ============================================================================
--
-- الخلل الأصلي: `if (otpData.attempts >= 5)` كان يقع بعد نجاح المطابقة، فلا
-- يخنق شيئًا — المحاولة الخاطئة لا تصل إليه أصلًا. البوابة هنا لا تعرف الرمز
-- ولا تحتاجه: قرارها مبني على عدّاد المستخدم وعلى فشل الـIP، فيمكن استدعاؤها
-- أولًا.
--
-- عن عدّاد المستخدم: `increment_otp_attempts` تزيد **كل** الصفوف الحية للمستخدم،
-- فـmax(attempts) عبر تلك الصفوف = عدد المحاولات الفاشلة داخل النافذة الحالية.
-- لذلك لا حاجة لعمود جديد ولا لجدول جديد.
--
-- عن حدّ الـIP: `x-forwarded-for` يضبطه وسيط Supabase، لكنه يظل قيمة من
-- الشبكة. فهو حدّ «أفضل جهد» يرفع كلفة التخمين الموزّع ولا يُعتمد عليه وحده —
-- حدّ المستخدم هو الحدّ المُلزِم.

create or replace function public.otp_attempt_gate(
  p_user_id uuid,
  p_ip      text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_attempts int;
  v_ip_failures   int;
  v_max_user      constant int := 5;
  v_max_ip        constant int := 20;
  v_ip_window     constant interval := interval '15 minutes';
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'missing_user');
  end if;

  select coalesce(max(attempts), 0)
    into v_user_attempts
    from public.admin_telegram_otps
   where user_id = p_user_id
     and is_used = false
     and expires_at > now();

  if v_user_attempts >= v_max_user then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'user_attempts_exceeded',
      'user_attempts', v_user_attempts,
      'ip_failures', 0
    );
  end if;

  v_ip_failures := 0;
  if p_ip is not null and p_ip <> '' and p_ip <> 'unknown' then
    select count(*)
      into v_ip_failures
      from public.telegram_auth_logs
     where ip_address = p_ip
       and action = 'otp_failed'
       and created_at > now() - v_ip_window;

    if v_ip_failures >= v_max_ip then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'ip_attempts_exceeded',
        'user_attempts', v_user_attempts,
        'ip_failures', v_ip_failures
      );
    end if;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'reason', 'ok',
    'user_attempts', v_user_attempts,
    'ip_failures', v_ip_failures
  );
end;
$$;

revoke all on function public.otp_attempt_gate(uuid, text) from public, anon, authenticated;
grant execute on function public.otp_attempt_gate(uuid, text) to service_role;

-- ============================================================================
-- 5) تسجيل المحاولة
-- ============================================================================
--
-- `telegram_auth_logs` موجود أصلًا وبالأعمدة المطلوبة تمامًا (ip_address،
-- user_agent، action، created_at) وكان فارغًا تمامًا — أي أن المسار لم ينجح
-- ولا مرة في Production. نعيد استعماله بدل إنشاء جدول حدود جديد.
--
-- ملاحظة: لا نضيف CHECK على `action` لأن دوال أخرى (telegram-webhook) تكتب في
-- هذا الجدول بقيم لم نحصرها، وقيدٌ ضيّق قد يكسر مسارًا شرعيًا لا نراه هنا.

create or replace function public.otp_log_attempt(
  p_user_id    uuid,
  p_action     text,
  p_ip         text default null,
  p_user_agent text default null,
  p_details    jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_action not in ('otp_verified', 'otp_failed', 'otp_blocked') then
    raise exception 'إجراء غير معروف: %', p_action using errcode = '22023';
  end if;

  insert into public.telegram_auth_logs (user_id, action, ip_address, user_agent, details)
  values (
    p_user_id,
    p_action,
    nullif(btrim(coalesce(p_ip, '')), ''),
    left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
    p_details
  );
end;
$$;

revoke all on function public.otp_log_attempt(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.otp_log_attempt(uuid, text, text, text, jsonb) to service_role;
