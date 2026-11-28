-- ============================================================================
-- 160_my_account_gate_banned_branch.sql — فرع 'banned' في my_account_gate().
--
-- المشكلة (أ) من البند 6: `my_account_gate()` بلا فرع 'banned'، فالمستخدم
-- المحظور — موثَّق الهاتف وفي القائمة البيضاء — يرى حالة 'needs_phone'
-- المضللة: مشكلته الحظر لا الهاتف. والبوابة الحقيقية (144) تمنعه فعلًا
-- من كل الجداول المبوَّبة، فالرسالة وحدها هي الكاذبة.
--
-- التغيير — في `my_account_gate()` وحدها، لا شيء غيرها:
--   • فرع أول في CASE الحالة: `when public.is_banned() then 'banned'`،
--     قبل فحص 'active'، فلا يصل المحظور إلى أي فرع آخر مهما كانت بقية
--     حالته (هاتف/قائمة بيضاء/إعفاء).
--   • حقلان جديدان في JSON: `banned_until` و`ban_reason` من profiles،
--     لتعرضهما شاشة البوابة (account-gate.html) بدل رسالة عامة.
--   • لا يُمسّ `account_is_active()` (144) ولا `is_banned()` (029) ولا
--     الإعفاء `gate_is_exempt_account` ولا أي سياسة ولا أي منح: المنح
--     كما في 042 (authenticated وحده، بلا public/anon).
--
-- ملاحظة عن المالك: الفرع يطابق 144 حرفيًا — `NOT is_banned` فوق
-- الإعفاء — فمالكٌ محظورٌ افتراضًا يرى 'banned' أيضًا (موثَّق في اختبار
-- 144 §6). وهذا لا يقفل المالك خارج حسابه: حظر المالك مرفوض من المنبع
-- أصلًا — محفِّز guard_privileged_accounts (053) لجلسة أخرى، ورفض صريح
-- في Edge Function `ban-user` لمسار الخدمة — فإن وُضع حظر على المالك
-- خارج هذين المسارين فاسترداده موثَّق في supabase/functions/ban-user/README.md
-- (رفع الحظر عبر service_role يعيد الجلسات دون إعادة دخول).
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/160_my_account_gate_banned_branch.down.sql
-- (يعيد جسم 042: المحظور يرى 'needs_phone' ثانيةً — للطوارئ فقط).
-- ============================================================================

begin;

-- ── 0) الشروط المسبقة ────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_banned(uuid)') is null then
    raise exception '160 يتطلب public.is_banned(uuid) من الترحيل 029';
  end if;
  if to_regprocedure('public.my_account_gate()') is null then
    raise exception '160 يتطلب public.my_account_gate() من الترحيل 042';
  end if;
  if to_regprocedure('public.account_is_active()') is null then
    raise exception '160 يتطلب public.account_is_active() من الترحيل 042/144';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'ban_status') then
    raise exception '160 يتطلب العمود profiles.ban_status الذي تقرأه is_banned()';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'ban_until') then
    raise exception '160 يتطلب العمود profiles.ban_until الذي تقرأه is_banned()';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'ban_reason') then
    raise exception '160 يتطلب العمود profiles.ban_reason الذي تعرضه البوابة';
  end if;
end $$;

-- ── 1) الجسم — نسخة 042 حرفيًا + فرع 'banned' أولًا + الحقلان ───────────
-- أي تعديل لاحق هنا يجب أن يحافظ على: الفرع قبل 'active'، والحقلين،
-- وبقية الحقول كما في 042 بلا حذف ولا إعادة تسمية (الواجهة تقرأها).
create or replace function public.my_account_gate()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case
    when auth.uid() is null then jsonb_build_object('status','anonymous')
    else jsonb_build_object(
      'status', case
                  when public.is_banned()                 then 'banned'
                  when public.account_is_active()          then 'active'
                  when not public.account_is_whitelisted() then 'waiting_approval'
                  else 'needs_phone' end,
      'has_phone',   public.normalize_phone((select p.phone from public.profiles p where p.id = auth.uid())) is not null,
      'whitelisted', public.account_is_whitelisted(),
      'role',        (select p.role from public.profiles p where p.id = auth.uid()),
      'banned_until', (select p.ban_until from public.profiles p where p.id = auth.uid()),
      'ban_reason',   (select p.ban_reason from public.profiles p where p.id = auth.uid()),
      'launch_date', (select value->>'expected_launch_date' from public.advanced_settings where key='registration_mode'),
      'message',     (select value->>'waitlist_message'     from public.advanced_settings where key='registration_mode'))
  end;
$$;

comment on function public.my_account_gate() is
  'حالة البوابة للواجهة: active / waiting_approval / needs_phone / banned. فرع banned أُضيف في 160: المحظور يرى حظره (مع ban_until وban_reason) بدل needs_phone المضللة. البوابة الحقيقية في account_is_active() (144) لم تُمسّ.';

-- ── 2) المنح — كما في 042 تمامًا ────────────────────────────────────────
revoke execute on function public.my_account_gate() from public, anon;
grant execute on function public.my_account_gate() to authenticated;

-- ── 3) تحقق ذاتي ─────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_active_def text;
  v_banned_def text;
  v_volatile "char";
  v_secdef boolean;
begin
  -- (أ) التعريف الجديد يحوي فرع 'banned' أولًا، قبل 'active'.
  select pg_get_functiondef('public.my_account_gate()'::regprocedure) into v_def;
  if v_def is null then
    raise exception '160: تعريف my_account_gate() مفقود بعد الترحيل';
  end if;
  if v_def !~ 'is_banned' then
    raise exception '160: تعريف my_account_gate() لا يحوي is_banned';
  end if;
  -- القيمة الحرفية 'banned' (بين علامتي تنصيص) قبل 'active': فحص
  -- position('banned') وحده لا يكفي لأن is_banned تحوي banned أيضًا.
  if position('''banned''' in v_def) = 0 or position('''active''' in v_def) = 0
     or position('''banned''' in v_def) > position('''active''' in v_def) then
    raise exception '160: فرع banned ليس قبل active في my_account_gate()';
  end if;
  if v_def !~ 'banned_until' or v_def !~ 'ban_reason' then
    raise exception '160: حقلا banned_until/ban_reason غائبان من my_account_gate()';
  end if;
  -- الحقول القديمة باقية كما في 042 (الواجهة تقرأها).
  if v_def !~ 'has_phone' or v_def !~ 'whitelisted' or v_def !~ 'waiting_approval'
     or v_def !~ 'needs_phone' or v_def !~ 'launch_date' then
    raise exception '160: حقل أو حالة قديمة اختفت من my_account_gate()';
  end if;

  -- (ب) خصائص الدالة لم تتغير: STABLE + SECURITY DEFINER كما في 042.
  select p.provolatile, p.prosecdef into v_volatile, v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'my_account_gate'
     and p.pronargs = 0;
  if v_volatile <> 's' then
    raise exception '160: my_account_gate() لم تعد STABLE (%)', v_volatile;
  end if;
  if not v_secdef then
    raise exception '160: my_account_gate() فقدت SECURITY DEFINER';
  end if;

  -- (ج) 144 و029 لم يُمسَّا: تعريفا account_is_active() وis_banned()
  -- ما زالا يحملان علامتيهما، فلا انحراف عن h04 ولا عن 029.
  select pg_get_functiondef('public.account_is_active()'::regprocedure) into v_active_def;
  if v_active_def is null or v_active_def !~ 'not public\.is_banned\(auth\.uid\(\)\)'
     or v_active_def !~ 'gate_is_exempt_account' then
    raise exception '160: تعريف account_is_active() انحرف عن 144/h04';
  end if;
  select pg_get_functiondef('public.is_banned(uuid)'::regprocedure) into v_banned_def;
  if v_banned_def is null or v_banned_def !~ 'ban_status' or v_banned_def !~ 'ban_until' then
    raise exception '160: تعريف is_banned() انحرف عن 029';
  end if;

  raise notice 'OK 160: my_account_gate() بفرع banned أولًا + banned_until/ban_reason — 144 و029 بلا مساس';
end $$;

commit;
