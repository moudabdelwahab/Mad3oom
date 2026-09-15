-- ============================================================================
-- 041_preview_containment.sql
--   جعل «معاينة عضو الشركة» مجموعة جزئية فعلية من صلاحيات العضو الحقيقي.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الخطر الحقيقي في المعاينة ليس فيما تمنحه، بل فيما لا تنزعه
-- ════════════════════════════════════════════════════════════════════════════
--
-- مالك المنصة يملك شركته **بحكم العلاقة** لا بحكم الرتبة. فحين يدخل معاينة
-- العضو، تظل كل الدوال المبنية على العلاقة تراه مالكًا:
--
--   ticket_in_my_scope()     → تذاكر أعضائه كلها
--   is_owner_or_super_of()   → رموز API لأعضائه
--   super_user_id = auth.uid() → ملفات أعضائه وسجلات نشاطهم
--   companies UPDATE (user_id = auth.uid()) → تعديل بيانات الشركة
--
-- والعضو الحقيقي لا يملك أيًّا من ذلك. فالمعاينة بلا علاج تُنتج **أوسع** من
-- العضو لا أضيق منه — وهذا تصعيد صلاحية، لا محاكاة.
--
-- ولذلك العلاج هنا **نزعٌ** لا منح: كل ما يمنحه المالكَ كونُه مالكًا يُطفأ
-- داخل المعاينة، فلا يبقى له إلا ما يملكه أي عضو.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ثلاث طبقات، لأن طبقة واحدة لا تكفي
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① نزع امتداد الملكية   — في ثلاث دوال، فتلتقطه ست عشرة سياسة بلا لمسها
--   ② القراءة فقط عبر RLS  — سياسات RESTRICTIVE، تُضاف ولا تُعدّل شيئًا قائمًا
--   ③ القراءة فقط عبر المحفّزات — لأن SECURITY DEFINER **يتجاوز RLS**
--
-- الطبقة ③ ليست تكرارًا للثانية: دوال مثل upsert_my_company و
-- link_subscription_to_my_company تعمل بصلاحية مالكها وتتجاوز كل سياسة، فلا
-- يوقفها إلا محفّز على الجدول نفسه. وإسقاط هذه الطبقة كان يترك بابًا مفتوحًا
-- خلف باب مقفل.
--
-- ملاحظة على الأثر خارج المعاينة: preview_mode() تعود false لكل حساب ليس
-- مالكًا داخل سياق المعاينة — أي لكل مستخدمي المنصة بلا استثناء. فكل ما هنا
-- **عديم الأثر** عليهم، وهذا ما يثبته اختبار «عدم المساس».
-- ============================================================================

do $$
begin
  if to_regprocedure('public.preview_mode()') is null
     or to_regprocedure('public.supervises(uuid)') is null then
    raise exception 'يجب تطبيق migrations/038 و 040 أولًا';
  end if;
end $$;


-- ============================================================================
-- 1) نزع امتداد الملكية — موضع واحد، وستّ عشرة سياسة تتبعه
-- ============================================================================

-- ── علاقة الإشراف ─────────────────────────────────────────────────────────
-- 040 استخرجها من أربع سياسات كما هي. وهنا يُضاف الشرط الوحيد.
create or replace function public.supervises(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and not public.preview_mode()
     and exists (
           select 1 from public.profiles p
            where p.id = p_user_id
              and p.super_user_id = auth.uid()
         );
$$;

comment on function public.supervises(uuid) is
  'هل المنادي مالك شركة هذا الحساب؟ تُطفأ داخل معاينة العضو: العضو لا يشرف '
  'على أحد، فالمعاينة لا يجوز أن تشرف.';

revoke all on function public.supervises(uuid) from public, anon;
grant execute on function public.supervises(uuid) to authenticated;


-- ── نطاق التذاكر ──────────────────────────────────────────────────────────
-- فرع «تذاكر أعضائي» يمرّ الآن من supervises فيرث الإطفاء. وفرع «تذكرتي أنا»
-- يبقى — فالعضو الحقيقي يراها كذلك، والمساواة هي المطلوب لا التضييق دونه.
create or replace function public.ticket_in_my_scope(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (t.user_id = auth.uid() or public.supervises(t.user_id))
         );
$$;

revoke all on function public.ticket_in_my_scope(uuid) from public, anon;
grant execute on function public.ticket_in_my_scope(uuid) to authenticated;


-- ── الملكية أو الإشراف ────────────────────────────────────────────────────
create or replace function public.is_owner_or_super_of(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select target_id is not null
     and (auth.uid() = target_id or public.supervises(target_id));
$$;

revoke all on function public.is_owner_or_super_of(uuid) from public, anon;
grant execute on function public.is_owner_or_super_of(uuid) to authenticated;


-- ============================================================================
-- 2) القراءة فقط — محفّز على مستوى الجملة، لا سياسة RLS
-- ============================================================================
--
-- لماذا محفّز وليس سياسة RESTRICTIVE؟ سببان، والثاني هو الحاسم:
--
--   ① سياسة RESTRICTIVE تحتاج ثلاث سياسات لكل جدول (INSERT/UPDATE/DELETE)،
--      لأن FOR ALL مع USING تحكم SELECT أيضًا — فتُعمي المعاينة بدل أن
--      تجعلها قراءة-فقط، وهو نقيض الغرض. ثلاث سياسات × 148 جدولًا = 444
--      كائنًا مقابل 148 محفّزًا.
--
--   ② وأهم من ذلك: **SECURITY DEFINER يتجاوز RLS**. دوال مثل
--      upsert_my_company و link_subscription_to_my_company تعمل بصلاحية
--      مالكها، فلا توقفها أي سياسة مهما شُدّدت. المحفّز يعمل على الجدول
--      نفسه فيمسك المسارين معًا — المباشر عبر PostgREST، وغير المباشر عبر
--      الدوال. سياسة RLS وحدها كانت ستترك بابًا مفتوحًا خلف باب مقفل.
--
-- ومستوى الجملة لا الصف: يُقيَّم مرة واحدة لكل عبارة لا مرة لكل صف.
--
-- الاستثناءات أدناه مقصودة ومحدودة: جداول القياس والسجل يكتب فيها العضو
-- الحقيقي أيضًا كأثر جانبي لقراءاته، فحجبها يكسر صفحات المعاينة بلا أن
-- يضيف أمانًا — الكتابة فيها داخلة أصلًا في صلاحيات العضو، فلا تخرق
-- شرط الاحتواء.

create or replace function public.guard_preview_read_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة'
      using errcode = '42501';
  end if;
  return null;
end;
$$;

revoke all on function public.guard_preview_read_only() from public, anon, authenticated;

do $$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity
       and c.relname not in (
         -- جداول السلطة والسياق: لها حرّاسها في 038 ولا تُكتب من جلسة أصلًا
         'platform_authority', 'owner_context_state', 'owner_context_audit',
         -- قياس وسجل: أثر جانبي للقراءة، والعضو الحقيقي يكتبه كذلك
         'activity_logs', 'error_logs', 'page_views', 'user_flow_events'
       )
  loop
    execute format('drop trigger if exists trg_preview_read_only on public.%I', r.relname);
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', r.relname);
    v_count := v_count + 1;
  end loop;

  raise notice '041: محفّز قراءة-فقط للمعاينة على % جدولًا', v_count;
end $$;


-- ============================================================================
-- 3) تحقّق بَعدي — الاحتواء مُثبَت في التعريفات نفسها
-- ============================================================================
do $$
begin
  if pg_get_functiondef('public.supervises(uuid)'::regprocedure) !~ 'preview_mode' then
    raise exception 'supervises بلا إطفاء المعاينة — امتداد الملكية ما زال قائمًا';
  end if;
  if pg_get_functiondef('public.ticket_in_my_scope(uuid)'::regprocedure) !~ 'supervises' then
    raise exception 'ticket_in_my_scope لا تمرّ من supervises — الإطفاء لا يصلها';
  end if;
  if pg_get_functiondef('public.is_owner_or_super_of(uuid)'::regprocedure) !~ 'supervises' then
    raise exception 'is_owner_or_super_of لا تمرّ من supervises';
  end if;
  if pg_get_functiondef('public.has_elevated_authority()'::regprocedure) !~ 'owner_capability' then
    raise exception 'has_elevated_authority غير مقيَّدة بالسياق — المعاينة تفتح كل الحسابات';
  end if;
  raise notice '041 postflight: الاحتواء مثبَّت';
end $$;
