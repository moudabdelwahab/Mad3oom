-- ============================================================================
-- 038_platform_authority.sql
--   سلطة المنصة كبيانات صريحة، والسياق كمُرشِّح عليها.
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا جدول سلطة جديد، وقد كانت القاعدة «لا مصدر سلطة جديد»
-- ════════════════════════════════════════════════════════════════════════════
--
-- التدقيق سبق التصميم. بحثنا في الإنتاج عن أي علاقة قائمة تُميّز الحسابين
-- المرتفعَين (support@ و info@) عن الأدمنز الأربعة الآخرين، فلم نجد:
--
--   • profiles.role        → ستة حسابات تحمل 'admin'، لا فرق بينها
--   • custom_roles         → جدول صلاحيات عام أُنشئ و**صفر صفوف** فيه، لم يُستعمل قط
--   • whatsapp_billing_admins → مفتاحه الإيميل، ونطاقه الفوترة وحدها
--
-- أي أن المعنى «هذا الحساب مرتفع السلطة» لم يكن مخزَّنًا في أي مكان — كان
-- مُشفَّرًا في سلسلة نصية داخل أجساد الدوال. فالجدول هنا ليس توسيعًا للمعمار،
-- بل **نقل معنى قائم من الكود إلى البيانات**، وهو الشرط الذي لا غنى عنه
-- لإزالة الإيميل من التفويض دون إسقاط صلاحية أحد.
--
-- ولهذا بالضبط لا يوجد هنا user_secondary_roles ولا user_context_access:
-- السياقات الأربعة غير الـowner تسندها علاقات موجودة بالفعل
-- (companies.user_id · profiles.super_user_id · صف الحساب ذاته)، وإضافة
-- جدول منح عام لها كانت ستُنشئ مصدرًا ثانيًا للملكية يناقض 024/035.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ثلاثة محاور — امتدادًا لثلاثية 024/035 لا معمارًا موازيًا
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① الهوية    profiles.role = 'platform_owner'        ثابت، لا يتغير أبدًا
--   ② السلطة    platform_authority + companies + profiles   لا يكتبها المستخدم
--   ③ السياق    owner_context_state                     حالة جلسة، الخادم وحده
--
-- القاعدة الحاكمة، وهي ما يجعل تزوير السياق عديم الأثر:
--
--       effective(cap) ≡ grant(cap) ∧ cap ∈ capabilities(active_context())
--
-- تقاطع لا اتحاد. السياق **مُرشِّح لا مصدر**. فمن زوّر سياقًا لا يملك منحه
-- حصل على صفر، ومن زوّر سياقًا يملك منحه ضيّق على نفسه. التصعيد مستحيل
-- بنيويًا لا ممنوعًا فحسب — وهذا الفرق هو كل الفرق.
--
-- والافتراضي fail-closed: بلا سياق سارٍ، active_context() = NULL فكل قدرة
-- سياقية = false. فالمالك لا يملك شيئًا حتى يختار، وشاشة الاختيار تصير
-- إلزامية **بنيويًا** لا اصطلاحًا.
--
-- ما لا يفعله هذا الترحيل
--   • لا يمسّ دالة تفويض قائمة ولا سياسة RLS واحدة — إضافي بحت (040 يفعل ذلك)
--   • لا يمنح أحدًا شيئًا: الجدول يُزرَع في 039
--   • لا يقترب من emp_ops ولا من مسار تسجيل الدخول
-- ============================================================================

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.owns_a_company(uuid)') is null then
    raise exception 'يجب تطبيق migrations/035 أولًا (is_platform_staff أو owns_a_company غير معرَّفة)';
  end if;
end $$;


-- ============================================================================
-- 1) سلطة المنصة — المصدر الوحيد، ولا يُكتب من جلسة مستخدم أبدًا
-- ============================================================================

create table if not exists public.platform_authority (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  level       text not null check (level in ('owner', 'elevated_admin')),
  granted_at  timestamptz not null default now(),
  note        text
);

comment on table public.platform_authority is
  'سلطة المنصة كبيانات. owner = مالك المنصة الوحيد. elevated_admin = السلطة '
  'المرتفعة التي كانت تُشتق من الإيميل قبل 040. لا تُكتب إلا من ترحيل.';

-- مالك واحد لا اثنان — مفروضًا من المحرّك لا من انضباط الكاتب.
create unique index if not exists platform_authority_single_owner
  on public.platform_authority ((true)) where level = 'owner';

alter table public.platform_authority enable row level security;

-- قراءة صفّه هو فقط. ولا سياسة كتابة البتة ⇒ الكتابة مرفوضة لكل دور.
drop policy if exists platform_authority_select_self on public.platform_authority;
create policy platform_authority_select_self on public.platform_authority
  for select using (user_id = auth.uid());

revoke all on table public.platform_authority from public, anon, authenticated;
grant select on table public.platform_authority to authenticated;

-- حزام ثانٍ فوق الحمّالة: حتى لو مُنحت صلاحية كتابة يومًا بالخطأ، الجلسة
-- المستخدِمة لا تمرّ. الترحيلات تعمل بلا auth.uid() فتمرّ وحدها.
create or replace function public.guard_platform_authority_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is not null then
    raise exception 'platform_authority لا تُكتب من جلسة مستخدم — الترحيل وحده'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.guard_platform_authority_write() from public, anon, authenticated;

drop trigger if exists trg_guard_platform_authority on public.platform_authority;
create trigger trg_guard_platform_authority
  before insert or update or delete on public.platform_authority
  for each row execute function public.guard_platform_authority_write();


-- ============================================================================
-- 2) مُسنَدا السلطة — الرتبة والسلطة معًا، لا أحدهما
-- ============================================================================
--
-- الاشتراط المزدوج التزام حرفي بعقيدة 035: «من زوّر الرتبة يفتقد العلاقة،
-- ومن زوّر العلاقة تفتقده الرتبة». وأثره العملي هنا جوهري:
--
--   منح رتبة 'platform_owner' لحساب — وهو ما يستطيعه حامل السلطة المرتفعة —
--   يبقى **عديم الأثر تمامًا** ما لم يوجد صف سلطة، والصف لا تكتبه أي جلسة.
--
-- أي أن أخطر ترقية في النظام صارت بلا مفعول ما لم يمرّ ترحيل بمراجعة بشرية.

create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from public.platform_authority a
      join public.profiles p on p.id = a.user_id
     where a.user_id = auth.uid()
       and a.level   = 'owner'
       and p.role    = 'platform_owner'
  );
$$;

comment on function public.is_platform_owner() is
  'مالك المنصة: صف owner في platform_authority **و** رتبة platform_owner. '
  'لا يقرأ بريدًا إطلاقًا. المصدر الوحيد لكل صلاحية owner-only.';

revoke all on function public.is_platform_owner() from public, anon;
grant execute on function public.is_platform_owner() to authenticated;


-- السلطة المرتفعة — ما كان is_main_admin() يمنحه بالإيميل قبل 040.
-- تشمل المالك لأن سلطته تعلوها؛ ولا تشمل أدمنًا بلا صف سلطة صريح.
create or replace function public.has_elevated_authority()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from public.platform_authority a
      join public.profiles p on p.id = a.user_id
     where a.user_id = auth.uid()
       and (   (a.level = 'owner'          and p.role = 'platform_owner')
            or (a.level = 'elevated_admin' and p.role = 'admin') )
  );
$$;

comment on function public.has_elevated_authority() is
  'السلطة المرتفعة بمنح صريح لا ببريد. تحلّ محل is_main_admin() في 040 '
  'مع الحفاظ على صلاحيات الحسابين القائمين كما هي.';

revoke all on function public.has_elevated_authority() from public, anon;
grant execute on function public.has_elevated_authority() to authenticated;


-- ============================================================================
-- 3) حالة السياق وسجلّه — حالة جلسة، ليست سلطة
-- ============================================================================
--
-- السياق في **جدول**، لا في رأس HTTP ولا claim في JWT ولا cookie ولا
-- localStorage. وهذا اختيار أمني لا تفصيلة تنفيذ: كل ناقل من تلك يتحكم فيه
-- العميل، فيصير السياق مُدخَلًا لا حالة. وقد رُفض بديلان صراحةً:
--   • request.headers GUC في PostgREST — يكتبه العميل
--   • custom_access_token_hook — يستلزم إعادة تسجيل دخول (مسار Phase 2 محظور)

create table if not exists public.owner_context_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  context     text not null check (context in
                ('owner', 'admin', 'company_admin', 'company_user_preview', 'customer')),
  entered_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.owner_context_state is
  'السياق الساري لمالك المنصة. حالة لا سلطة: وجود صف هنا لا يمنح شيئًا، '
  'والقدرة تُحسب دائمًا بتقاطع المنح مع السياق.';

alter table public.owner_context_state enable row level security;

drop policy if exists owner_context_state_select_self on public.owner_context_state;
create policy owner_context_state_select_self on public.owner_context_state
  for select using (user_id = auth.uid());

revoke all on table public.owner_context_state from public, anon, authenticated;
grant select on table public.owner_context_state to authenticated;


-- سجلّ التبديل — append-only بقوة المحرّك لا بالاتفاق.
create table if not exists public.owner_context_audit (
  id            bigserial primary key,
  actor_id      uuid not null,
  event         text not null check (event in ('enter', 'exit', 'expire', 'denied')),
  from_context  text,
  to_context    text,
  at            timestamptz not null default now(),
  expires_at    timestamptz,
  user_agent    text,
  detail        text
);

comment on table public.owner_context_audit is
  'سجل تبديل السياق. from→to لا لقطات، فيُقرأ المسار كاملًا. append-only: '
  'لا UPDATE ولا DELETE لأي دور، ولا حتى لمالك الدوال.';

create index if not exists owner_context_audit_actor_at
  on public.owner_context_audit (actor_id, at desc);

alter table public.owner_context_audit enable row level security;

-- القراءة لحامل السلطة المرتفعة وحده (والمالك منه).
drop policy if exists owner_context_audit_select on public.owner_context_audit;
create policy owner_context_audit_select on public.owner_context_audit
  for select using (public.has_elevated_authority());

revoke all on table public.owner_context_audit from public, anon, authenticated;
grant select on table public.owner_context_audit to authenticated;

-- append-only مفروضًا على الجميع بلا استثناء — مالك الدوال داخل فيه.
create or replace function public.guard_owner_context_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'owner_context_audit سجل غير قابل للتعديل أو الحذف'
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_owner_context_audit_immutable on public.owner_context_audit;
create trigger trg_owner_context_audit_immutable
  before update or delete on public.owner_context_audit
  for each row execute function public.guard_owner_context_audit_immutable();


-- الكتابة في حالة السياق تمرّ من enter/exit وحدهما. الدالتان SECURITY DEFINER
-- فلا ينفع حارس «auth.uid() is null» هنا (هو موجود وقت ندائهما) — فالعلامة
-- راية محلية بالمعاملة يرفعها الطريق المشروع وحده وتسقط تلقائيًا بانتهائها.
create or replace function public.guard_owner_context_state_write()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.owner_context_write', true), '') <> 'on' then
    raise exception 'owner_context_state تُكتب عبر enter_context/exit_context فقط'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_guard_owner_context_state on public.owner_context_state;
create trigger trg_guard_owner_context_state
  before insert or update or delete on public.owner_context_state
  for each row execute function public.guard_owner_context_state_write();


-- ============================================================================
-- 4) مفردات السياق — المنح، وخريطة القدرات، والتقاطع بينهما
-- ============================================================================

-- ① شرط **دخول** السياق. لاحظ أن كل سياق يشترط ملكية المنصة: آلية السياقات
--    owner-only بالكامل، فلا يملك أي حساب آخر سياقًا قط. وهذا وحده يُسقط
--    سؤال «هل يزوّر مستخدم عادي سياق company_admin؟» — لا صف له، ولو وُجد
--    لسقط هنا.
--    وشرط owns_a_company مطلق: سياق الشركة لا يُدخِل شركة لا يملكها المنادي.
create or replace function public.context_grants(p_context text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case p_context
    when 'owner'                then public.is_platform_owner()
    when 'admin'                then public.is_platform_owner()
    when 'customer'             then public.is_platform_owner()
    when 'company_admin'        then public.is_platform_owner() and public.owns_a_company(auth.uid())
    when 'company_user_preview' then public.is_platform_owner() and public.owns_a_company(auth.uid())
    else false
  end;
$$;

revoke all on function public.context_grants(text) from public, anon;
grant execute on function public.context_grants(text) to authenticated;


-- ② خريطة القدرات: أي قدرة يسمح بها أي سياق. دالة نقية بلا أي قراءة.
--    سياق owner وحده بلا تضييق؛ والأربعة الباقية تضييق تدريجي.
create or replace function public.context_allows(p_context text, p_capability text)
returns boolean
language sql
immutable
as $$
  select case p_capability
    when 'owner_only'     then p_context = 'owner'
    when 'admin'          then p_context in ('owner', 'admin')
    when 'staff'          then p_context in ('owner', 'admin')
    when 'company_admin'  then p_context in ('owner', 'company_admin')
    when 'company_member' then p_context = 'company_user_preview'
    when 'customer'       then p_context in ('owner', 'customer')
    else false
  end;
$$;

revoke all on function public.context_allows(text, text) from public, anon;
grant execute on function public.context_allows(text, text) to authenticated;


-- ③ السياق الساري. NULL إن لم يوجد صف، أو انتهت صلاحيته، أو لم يعد المنادي
--    مالكًا — ثلاثة مسارات تؤدي كلها إلى fail-closed.
create or replace function public.active_context()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.context
    from public.owner_context_state s
   where s.user_id = auth.uid()
     and s.expires_at > now()
     and public.is_platform_owner();
$$;

revoke all on function public.active_context() from public, anon;
grant execute on function public.active_context() to authenticated;


-- ④ هل السياق الفلاني سارٍ **ومُستحَق**؟ شرط المنح مُعاد هنا عمدًا: صف
--    مزروع بغير طريقه لا يكفي، فالفحص يتكرر عند كل استعمال لا عند الدخول فقط.
create or replace function public.in_context(p_context text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.active_context() = p_context
     and public.context_grants(p_context);
$$;

revoke all on function public.in_context(text) from public, anon;
grant execute on function public.in_context(text) to authenticated;


-- ⑤ وضع المعاينة — يُستعمل في 041 لنزع امتداد الملكية عن المالك داخلها.
create or replace function public.preview_mode()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.in_context('company_user_preview');
$$;

comment on function public.preview_mode() is
  'المالك داخل معاينة عضو الشركة. تُستعمل لنزع ما يمنحه إياه كونه مالكًا، '
  'حتى تكون المعاينة مجموعة جزئية من صلاحيات العضو الحقيقي لا أوسع منها.';

revoke all on function public.preview_mode() from public, anon;
grant execute on function public.preview_mode() to authenticated;


-- ⑥ **القاعدة الحاكمة مجسَّدة في دالة واحدة.** كل مُسنَد تفويض في 040/041
--    يمرّ من هنا، فالقاعدة تُطبَّق في موضع واحد لا في عشرين.
--
--        effective(cap) = ملكية المنصة ∧ يسمح السياق ∧ العلاقة المطلوبة
--
--    الشرط الثالث هو ما يمنع سياق الشركة من فتح شركة لا يملكها المنادي.
create or replace function public.owner_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_platform_owner()
     and public.context_allows(public.active_context(), p_capability)
     and case p_capability
           when 'company_admin'  then public.owns_a_company(auth.uid())
           when 'company_member' then public.owns_a_company(auth.uid())
           else true
         end;
$$;

comment on function public.owner_capability(text) is
  'تقاطع المنح مع السياق. السياق مُرشِّح لا مصدر: لا يمنح قدرة لا يملكها '
  'الحساب أصلًا، فتزويره لا يُصعِّد بل يُضيِّق.';

revoke all on function public.owner_capability(text) from public, anon;
grant execute on function public.owner_capability(text) to authenticated;


-- ============================================================================
-- 5) واجهة السياق — الخادم يحسب القائمة، والواجهة ترسم ما وصلها
-- ============================================================================
--
-- ترجع الخمسة كاملةً مع راية granted لكل واحد، فتعرض الواجهة خمس نوافذ
-- وتُعطِّل ما لا يُستحَق. والغرض أن القائمة **صفة يحسبها الخادم** لا ثابتًا
-- مكتوبًا في الـJS: لا قائمة تفويض في الواجهة بأي حال.
create or replace function public.available_contexts()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_owns    boolean;
  v_company uuid;
begin
  if not public.is_platform_owner() then
    return '[]'::jsonb;
  end if;

  v_owns    := public.owns_a_company(auth.uid());
  v_company := public.company_of(auth.uid());

  return jsonb_build_array(
    jsonb_build_object(
      'key','owner', 'label','لوحة المالك', 'destination','/owner-dashboard.html',
      'granted', true, 'reason','platform_authority.owner'),
    jsonb_build_object(
      'key','admin', 'label','إدارة المنصة', 'destination','/admin-dashboard.html',
      'granted', true, 'reason','platform_authority.owner'),
    jsonb_build_object(
      'key','company_admin', 'label','لوحة الشركة — مدير', 'destination','/company-dashboard/',
      'granted', v_owns, 'reason','companies.user_id', 'company_id', v_company),
    jsonb_build_object(
      'key','company_user_preview', 'label','معاينة عضو الشركة', 'destination','/company-dashboard/',
      'granted', v_owns, 'reason','companies.user_id (قراءة فقط)', 'company_id', v_company),
    jsonb_build_object(
      'key','customer', 'label','بوابة العميل', 'destination','/customer-dashboard.html',
      'granted', true, 'reason','self')
  );
end;
$$;

revoke all on function public.available_contexts() from public, anon;
grant execute on function public.available_contexts() to authenticated;


-- وجهة كل سياق — مصدر واحد يستعمله enter_context والواجهة معًا.
create or replace function public.context_destination(p_context text)
returns text
language sql
immutable
as $$
  select case p_context
    when 'owner'                then '/owner-dashboard.html'
    when 'admin'                then '/admin-dashboard.html'
    when 'company_admin'        then '/company-dashboard/'
    when 'company_user_preview' then '/company-dashboard/'
    when 'customer'             then '/customer-dashboard.html'
    else null
  end;
$$;

revoke all on function public.context_destination(text) from public, anon;
grant execute on function public.context_destination(text) to authenticated;


-- رأس المتصفح للسجل — استرشادي بحت، ولا يُبنى عليه تفويض بأي حال.
-- ملفوف لأن request.headers قد يكون غائبًا أو غير صالح خارج PostgREST.
create or replace function public.request_user_agent()
returns text
language plpgsql
stable
as $$
begin
  return nullif(btrim(coalesce(
    (current_setting('request.headers', true))::jsonb ->> 'user-agent', '')), '');
exception when others then
  return null;
end;
$$;

revoke all on function public.request_user_agent() from public, anon, authenticated;


-- ── الدخول إلى سياق ───────────────────────────────────────────────────────
--
-- ترجع نتيجة مُهيكَلة عند الرفض بدل رفع استثناء. وهذا ليس تساهلًا بل شرط
-- لعمل السجل: في PL/pgSQL يُلغي الاستثناء أثر المعاملة كلها — بما فيه صف
-- التدقيق الذي كُتب قبله بسطر. فالرفض الذي يرفع استثناءً هو رفض **لا يُسجَّل
-- أبدًا**، ولا توجد في Postgres معاملة مستقلة تنقذه.
--
-- والضمان الأمني لا يتأثر بهذا إطلاقًا: الرفض يعني ألا صف سياق يُكتب، ولا
-- شيء بعده يقرأ قيمة الإرجاع ليقرر سلطة. وحتى لو تجاهل عميلٌ مهملٌ النتيجة
-- ومضى، فـ in_context() تُعيد فحص المنح عند كل استعمال — فلا يتغير شيء.
--
-- ويبقى الاستثناء لما هو استثناء فعلًا: بلا جلسة، أو مفتاح سياق لا وجود له.
create or replace function public.enter_context(p_context text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_from    text;
  v_expires timestamptz;
  v_standing boolean;
begin
  if auth.uid() is null then
    raise exception 'لا جلسة' using errcode = '42501';
  end if;

  if public.context_destination(p_context) is null then
    raise exception 'سياق غير معروف: %', p_context using errcode = '22023';
  end if;

  -- محاولة من حسابٍ له وقوف فعلي (طاقم أو سلطة) خبر أمني يستحق السجل. أما
  -- عابر بلا وقوف فيُردّ بلا صف: تسجيل كل نداء من أي حساب يفتح باب إغراق
  -- السجل، فيُدفن الخبر الحقيقي تحت الضجيج.
  v_standing := exists (select 1 from public.platform_authority a where a.user_id = auth.uid())
             or exists (select 1 from public.profiles p
                         where p.id = auth.uid()
                           and p.role in ('admin', 'support', 'platform_owner'));

  if not public.is_platform_owner() then
    if v_standing then
      insert into public.owner_context_audit (actor_id, event, to_context, user_agent, detail)
      values (auth.uid(), 'denied', p_context, public.request_user_agent(), 'ليس مالك المنصة');
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'not_platform_owner', 'context', null);
  end if;

  v_from := public.active_context();

  if not public.context_grants(p_context) then
    insert into public.owner_context_audit (actor_id, event, from_context, to_context, user_agent, detail)
    values (auth.uid(), 'denied', v_from, p_context, public.request_user_agent(),
            'شرط المنح غير متحقق');
    return jsonb_build_object('allowed', false, 'reason', 'grant_missing', 'context', v_from);
  end if;

  v_expires := now() + interval '12 hours';

  perform set_config('app.owner_context_write', 'on', true);

  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values (auth.uid(), p_context, now(), v_expires)
  on conflict (user_id) do update
    set context = excluded.context, entered_at = now(), expires_at = excluded.expires_at;

  insert into public.owner_context_audit (actor_id, event, from_context, to_context, expires_at, user_agent)
  values (auth.uid(), 'enter', v_from, p_context, v_expires, public.request_user_agent());

  return jsonb_build_object(
    'allowed',     true,
    'context',     p_context,
    'destination', public.context_destination(p_context),
    'expires_at',  v_expires);
end;
$$;

revoke all on function public.enter_context(text) from public, anon;
grant execute on function public.enter_context(text) to authenticated;


-- ── الخروج من السياق — العودة إلى fail-closed ─────────────────────────────
create or replace function public.exit_context()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_from text;
begin
  if auth.uid() is null then
    raise exception 'لا جلسة' using errcode = '42501';
  end if;

  select context into v_from from public.owner_context_state where user_id = auth.uid();

  perform set_config('app.owner_context_write', 'on', true);
  delete from public.owner_context_state where user_id = auth.uid();

  if v_from is not null then
    insert into public.owner_context_audit (actor_id, event, from_context, to_context, user_agent)
    values (auth.uid(), 'exit', v_from, null, public.request_user_agent());
  end if;

  return jsonb_build_object('context', null, 'destination', '/owner-contexts.html');
end;
$$;

revoke all on function public.exit_context() from public, anon;
grant execute on function public.exit_context() to authenticated;


-- ── حالة السياق للواجهة — الشريط الدائم يقرأ من هنا لا من التخزين المحلي ──
create or replace function public.owner_context_status()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'is_platform_owner', public.is_platform_owner(),
    'active_context',    public.active_context(),
    'expires_at',        (select s.expires_at from public.owner_context_state s
                           where s.user_id = auth.uid() and public.is_platform_owner()),
    'preview_mode',      public.preview_mode());
$$;

revoke all on function public.owner_context_status() from public, anon;
grant execute on function public.owner_context_status() to authenticated;
