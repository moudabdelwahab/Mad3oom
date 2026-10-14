-- ============================================================================
-- 103_admin_hierarchy_followups.sql
--   إصلاحات أمامية لـ 099 (مطبَّق في الإنتاج منذ 2026-10-14): ملف 099 لا يُعدَّل، وكل تصحيح هنا.
--   المرجع: docs/tenancy/REVIEW_FOLLOWUPS_099_100.md (099 M1–M3، L1–L3).
--
--   M1  حذف حساب أو شركة لا يتعطل بسبب سجل الهيكل: أعمدة الهوية في admin_unit_members و
--       platform_delegations و admin_unit_companies بلا مفاتيح خارجية (اتفاقية 086/096/101/102).
--       الأسطر تبقى تاريخًا: حذف الحساب يُنهي عضوياته ويسحب تفويضاته، وحذف الشركة يُنهي إسنادها.
--   M2  فقد الأهلية (تغيير الرتبة، الحظر، ملكية أو عضوية أو دور في شركة) يُنهي العضويات ويسحب التفويضات
--       فورًا ونهائيًا، فلا يعود تفويض قديم للحياة بإعادة الترقية أو رفع الحظر.
--   M3  المفوَّض: (أ) يوقف ولا يعيد التفعيل — إعادة التفعيل لمالك المنصة وحده؛ (ب) كل فعل كتابة للمفوَّض
--       يتطلب جلسة aal2 من Supabase Auth (ادعاء aal في الـ JWT، لا علم في الملف الشخصي).
--   L1  قرار المراجعة بعد تطبيقه نهائي.
--   L2  مانع التحويل يعدّ تذاكر مدعوم المفتوحة وحدها (ما تنقله دالة التسليم)؛ تذاكر الشركات معروضة للعلم.
--   L3  التفويض المنتهي غير نشط في كل مكان: يُغلق قبل منح جديد أو أرشفة وحدة، ولا يظهر في لوحة المالك؛
--       المنح بلا تاريخ انتهاء يأخذ 7 أيام، وأقصاه 90 يومًا.
--
-- المفتاحان delegation_enabled و company_suspension_enforced يبقيان مطفأين (يرفض الترحيل إن كان أحدهما
-- مفعّلًا). قابل لإعادة التشغيل. التراجع: migrations/_rollback/103_admin_hierarchy_followups.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  if to_regclass('public.admin_units') is null or to_regclass('public.platform_delegations') is null then
    raise exception '103 يتطلب 099_admin_hierarchy';
  end if;
  foreach f in array array['public._hierarchy_eligible(uuid)', 'public._hierarchy_event(text,uuid,uuid,uuid,jsonb)',
                           'public._delegate_can(text,uuid)', 'public._company_unit(uuid)', 'public.owner_critical_ok()'] loop
    if to_regprocedure(f) is null then
      raise exception '103 يتطلب % (099)', f;
    end if;
  end loop;
  if exists (select 1 from public.platform_feature_switches
              where key in ('delegation_enabled', 'company_suspension_enforced') and enabled) then
    raise exception '103: مفتاح التفويض أو الإيقاف مفعّل — أطفئه قبل الترحيل';
  end if;
end $$;


-- ============================================================================
-- 1) M1 — بلا مفاتيح خارجية إلى الحسابات والشركات
-- ============================================================================
alter table public.admin_unit_members   drop constraint if exists admin_unit_members_user_id_fkey;
alter table public.platform_delegations drop constraint if exists platform_delegations_delegate_id_fkey;
alter table public.admin_unit_companies drop constraint if exists admin_unit_companies_company_id_fkey;


-- ============================================================================
-- 2) M2 — فقد الأهلية والحذف ينهيان العضويات ويسحبان التفويضات (التاريخ يبقى)
-- ============================================================================
create or replace function public._hierarchy_release_user(p_user uuid, p_cause text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_members     integer;
  v_delegations integer;
begin
  if p_user is null then
    return;
  end if;
  update public.admin_unit_members
     set ended_at = now(), ended_by = auth.uid(), end_reason = 'eligibility_lost:' || p_cause
   where user_id = p_user and ended_at is null;
  get diagnostics v_members = row_count;
  update public.platform_delegations
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'eligibility_lost:' || p_cause
   where delegate_id = p_user and revoked_at is null;
  get diagnostics v_delegations = row_count;
  if v_members + v_delegations > 0 then
    perform public._hierarchy_event('eligibility.lost', null, null, p_user,
                                    jsonb_build_object('cause', p_cause, 'memberships_ended', v_members,
                                                       'delegations_revoked', v_delegations));
  end if;
end $$;

-- الرتبة أو الحظر أو حذف الحساب
create or replace function public._hierarchy_on_profile_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    perform public._hierarchy_release_user(old.id, 'account_deleted');
    return old;
  end if;
  if (new.role is distinct from old.role or new.ban_status is distinct from old.ban_status)
     and not public._hierarchy_eligible(new.id) then
    perform public._hierarchy_release_user(new.id,
      case when new.ban_status is distinct from old.ban_status then 'ban' else 'role_change' end);
  end if;
  return new;
end $$;
drop trigger if exists trg_hierarchy_eligibility on public.profiles;
create trigger trg_hierarchy_eligibility after update of role, ban_status or delete on public.profiles
  for each row execute function public._hierarchy_on_profile_change();

-- ملكية شركة أو عضوية فيها أو دور في فريقها (الفصل، القيمة الافتراضية 7)
create or replace function public._hierarchy_on_company_tie()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := (to_jsonb(new) ->> 'user_id')::uuid;
begin
  if v_user is not null
     and (exists (select 1 from public.admin_unit_members where user_id = v_user and ended_at is null)
          or exists (select 1 from public.platform_delegations where delegate_id = v_user and revoked_at is null))
     and not public._hierarchy_eligible(v_user) then
    perform public._hierarchy_release_user(v_user, 'company_tie');
  end if;
  return new;
end $$;
drop trigger if exists trg_hierarchy_company_tie on public.company_staff;
create trigger trg_hierarchy_company_tie after insert or update on public.company_staff
  for each row execute function public._hierarchy_on_company_tie();
drop trigger if exists trg_hierarchy_company_tie on public.company_memberships;
create trigger trg_hierarchy_company_tie after insert or update on public.company_memberships
  for each row execute function public._hierarchy_on_company_tie();
drop trigger if exists trg_hierarchy_company_tie on public.companies;
create trigger trg_hierarchy_company_tie after insert or update of user_id on public.companies
  for each row execute function public._hierarchy_on_company_tie();

-- حذف الشركة: إسنادها النشط يُنهى ويبقى تاريخًا
create or replace function public._hierarchy_on_company_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.admin_unit_companies set ended_at = now(), ended_by = auth.uid(), end_reason = 'company_deleted'
   where company_id = old.id and ended_at is null;
  if found then
    perform public._hierarchy_event('company.deleted', null, old.id, null, '{}'::jsonb);
  end if;
  return old;
end $$;
drop trigger if exists trg_hierarchy_company_deleted on public.companies;
create trigger trg_hierarchy_company_deleted after delete on public.companies
  for each row execute function public._hierarchy_on_company_deleted();


-- ============================================================================
-- 3) L3 — التفويض المنتهي يُغلق
-- ============================================================================
create or replace function public._delegations_close_expired(p_delegate uuid, p_unit uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  update public.platform_delegations
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'expired'
   where revoked_at is null and expires_at is not null and expires_at <= now()
     and (p_delegate is null or delegate_id = p_delegate)
     and (p_unit is null or unit_id = p_unit);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform public._hierarchy_event('delegation.expired_closed', p_unit, null, p_delegate,
                                    jsonb_build_object('count', v_count));
  end if;
  return v_count;
end $$;


-- ============================================================================
-- 4) M3 — جلسة aal2 للمفوَّض
-- ============================================================================
-- ادعاء aal في JWT من Supabase Auth: aal2 بعد تحقق MFA في الجلسة نفسها. لا يُقرأ من الملف الشخصي.
create or replace function public._session_aal2()
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

do $$
declare f text;
begin
  foreach f in array array['public._hierarchy_release_user(uuid,text)', 'public._hierarchy_on_profile_change()',
                           'public._hierarchy_on_company_tie()', 'public._hierarchy_on_company_deleted()',
                           'public._delegations_close_expired(uuid,uuid)', 'public._session_aal2()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;


-- ============================================================================
-- 5) أفعال المفوَّض
-- ============================================================================
create or replace function public.unit_member_set(p_unit uuid, p_user uuid, p_role text default 'member')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id    uuid;
  v_owner boolean := coalesce(public.owner_critical_ok(), false);
begin
  if not (v_owner or public._delegate_can('units.manage_members', p_unit)) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if not v_owner and not public._session_aal2() then
    raise exception 'أفعال المفوَّض تحتاج جلسة بتحقق ثنائي (aal2)' using errcode = '42501', detail = '{"code":"aal2_required"}';
  end if;
  if p_user = auth.uid() and not v_owner then
    raise exception 'لا يضيف المفوَّض نفسه' using errcode = '42501';
  end if;
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة' using errcode = 'P0002';
  end if;
  if p_role not in ('lead', 'member') then
    raise exception 'دور غير معروف' using errcode = '22023';
  end if;
  insert into public.admin_unit_members (unit_id, user_id, member_role, assigned_by)
  values (p_unit, p_user, p_role, auth.uid())
  returning id into v_id;
  perform public._hierarchy_event('member.added', p_unit, null, p_user, jsonb_build_object('role', p_role));
  return jsonb_build_object('membership_id', v_id);
end $$;

create or replace function public.unit_member_end(p_unit uuid, p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_owner  boolean := coalesce(public.owner_critical_ok(), false);
begin
  if not (v_owner or public._delegate_can('units.manage_members', p_unit)) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if not v_owner and not public._session_aal2() then
    raise exception 'أفعال المفوَّض تحتاج جلسة بتحقق ثنائي (aal2)' using errcode = '42501', detail = '{"code":"aal2_required"}';
  end if;
  update public.admin_unit_members set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   where unit_id = p_unit and user_id = p_user and ended_at is null;
  if not found then
    raise exception 'لا عضوية نشطة' using errcode = 'P0002';
  end if;
  perform public._hierarchy_event('member.ended', p_unit, null, p_user, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ended', true);
end $$;

-- الإيقاف: المفوَّض يوقف فقط وبجلسة aal2؛ إعادة التفعيل لمالك المنصة وحده (إيقافه يعلو).
create or replace function public.delegate_set_company_status(p_company uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_unit   uuid := public._company_unit(p_company);
  v_owner  boolean := coalesce(public.owner_critical_ok(), false);
  v_old    text;
begin
  if p_status not in ('active', 'suspended') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  if v_unit is null or not (v_owner or public._delegate_can('companies.suspend', v_unit)) then
    -- نفس الرد لشركة خارج النطاق وغير موجودة
    raise exception 'الشركة غير موجودة أو خارج نطاقك' using errcode = 'P0002';
  end if;
  if not v_owner then
    if not public._session_aal2() then
      raise exception 'إيقاف الشركات يحتاج جلسة بتحقق ثنائي (aal2)' using errcode = '42501', detail = '{"code":"aal2_required"}';
    end if;
    if p_status <> 'suspended' then
      raise exception 'إعادة تفعيل الشركة لمالك المنصة وحده' using errcode = '42501', detail = '{"code":"owner_only_reactivation"}';
    end if;
  end if;
  select status into v_old from public.companies where id = p_company for update;
  if v_old = p_status then
    return jsonb_build_object('company_id', p_company, 'status', p_status, 'changed', false);
  end if;
  perform set_config('app.company_status_write', 'on', true);
  update public.companies set status = p_status where id = p_company;
  perform set_config('app.company_status_write', 'off', true);
  perform public._hierarchy_event(case when p_status = 'suspended' then 'company.suspended' else 'company.reactivated' end,
                                  v_unit, p_company, null,
                                  jsonb_build_object('reason', v_reason, 'from', v_old, 'as', case when v_owner then 'owner' else 'delegate' end));
  perform public.log_privileged('company.status.' || p_status, null, jsonb_build_object('status', v_old),
                                jsonb_build_object('company_id', p_company, 'status', p_status, 'reason', v_reason));
  return jsonb_build_object('company_id', p_company, 'status', p_status, 'changed', true);
end $$;


-- ============================================================================
-- 6) أفعال المالك: المنح والأرشفة واللوحة (L3، M1)
-- ============================================================================
create or replace function public.owner_grant_delegation(p_delegate uuid, p_unit uuid, p_capabilities text[], p_reason text,
                                                         p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason  text := public._reason_check(p_reason);
  v_expires timestamptz := coalesce(p_expires_at, now() + interval '7 days');
  v_id      uuid;
begin
  perform public._owner_write_check();
  if p_capabilities is null or cardinality(p_capabilities) = 0
     or exists (select 1 from unnest(p_capabilities) c where c not in (select key from public.delegation_capabilities)) then
    raise exception 'قدرة غير معروفة' using errcode = '22023';
  end if;
  if v_expires <= now() or v_expires > now() + interval '90 days' then
    raise exception 'مدة التفويض من الآن حتى 90 يومًا' using errcode = '22023', detail = '{"field":"expires_at"}';
  end if;
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._delegations_close_expired(p_delegate, p_unit);
  insert into public.platform_delegations (delegate_id, unit_id, capabilities, reason, granted_by, expires_at)
  values (p_delegate, p_unit, (select array_agg(distinct c order by c) from unnest(p_capabilities) c), v_reason,
          auth.uid(), v_expires)
  returning id into v_id;
  perform public._hierarchy_event('delegation.granted', p_unit, null, p_delegate,
                                  jsonb_build_object('delegation_id', v_id, 'capabilities', p_capabilities, 'expires_at', v_expires));
  perform public.log_privileged('delegation.granted', p_delegate, null,
                                jsonb_build_object('delegation_id', v_id, 'unit_id', p_unit, 'capabilities', p_capabilities));
  return jsonb_build_object('delegation_id', v_id, 'expires_at', v_expires);
end $$;

create or replace function public.owner_unit_archive(p_unit uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
begin
  perform public._owner_write_check();
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة أو مؤرشفة' using errcode = 'P0002';
  end if;
  perform public._delegations_close_expired(null, p_unit);
  if exists (select 1 from public.admin_units where parent_id = p_unit and archived_at is null)
     or exists (select 1 from public.admin_unit_members where unit_id = p_unit and ended_at is null)
     or exists (select 1 from public.admin_unit_companies where unit_id = p_unit and ended_at is null)
     or exists (select 1 from public.platform_delegations where unit_id = p_unit and revoked_at is null) then
    raise exception 'انقل الوحدات الفرعية والأعضاء والشركات والتفويضات أولًا' using errcode = '23514';
  end if;
  update public.admin_units set archived_at = now(), archived_by = auth.uid() where id = p_unit;
  perform public._hierarchy_event('unit.archived', p_unit, null, null, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('unit_id', p_unit, 'archived', true);
end $$;

create or replace function public.owner_hierarchy()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'enabled', public._feature_on('delegation_enabled'),
    'capabilities', (select jsonb_agg(jsonb_build_object('key', key, 'label', label_ar, 'description', description_ar) order by key)
                       from public.delegation_capabilities),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id, 'parent_id', u.parent_id, 'name', u.name, 'description', u.description,
        'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id,
                                                                 'name', coalesce(p.full_name, p.email, 'حساب محذوف'),
                                                                 'role', m.member_role, 'since', m.assigned_at))
                               from public.admin_unit_members m left join public.profiles p on p.id = m.user_id
                              where m.unit_id = u.id and m.ended_at is null), '[]'::jsonb),
        'companies', coalesce((select jsonb_agg(jsonb_build_object('company_id', uc.company_id,
                                                                   'name', coalesce(c.company_name, 'شركة محذوفة'), 'status', c.status))
                                 from public.admin_unit_companies uc left join public.companies c on c.id = uc.company_id
                                where uc.unit_id = u.id and uc.ended_at is null), '[]'::jsonb),
        'delegations', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'delegate_id', d.delegate_id,
                                                                     'name', coalesce(p.full_name, p.email, 'حساب محذوف'),
                                                                     'capabilities', d.capabilities, 'expires_at', d.expires_at))
                                   from public.platform_delegations d left join public.profiles p on p.id = d.delegate_id
                                  where d.unit_id = u.id and d.revoked_at is null
                                    and (d.expires_at is null or d.expires_at > now())), '[]'::jsonb))
        order by u.created_at)
        from public.admin_units u where u.archived_at is null), '[]'::jsonb),
    'unassigned_companies', coalesce((select jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.company_name, 'status', c.status)
                                                       order by c.company_name)
                                        from public.companies c
                                       where not exists (select 1 from public.admin_unit_companies uc
                                                          where uc.company_id = c.id and uc.ended_at is null)), '[]'::jsonb));
end $$;


-- ============================================================================
-- 7) مراجعة الإداريين (L1، L2)
-- ============================================================================
create or replace function public._admin_review_facts(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'role', p.role,
    'authority', (select a.level from public.platform_authority a where a.user_id = p.id),
    'two_factor', coalesce(p.two_factor_enabled, false) or coalesce(p.mfa_enabled, false),
    -- ما تنقله owner_reassign_admin_tickets: تذاكر مدعوم وحدها
    'open_assigned_tickets', (select count(*) from public.tickets t
                               where t.assigned_to = p.id and t.status in ('open', 'in-progress')
                                 and t.scope = 'mad3oom_support'),
    -- للعلم فقط (لا تمنع التطبيق): تذاكر شركات مسندة إليه — لا يملك أحد من طاقم المنصة نقلها من هنا
    'open_company_tickets', (select count(*) from public.tickets t
                              where t.assigned_to = p.id and t.status in ('open', 'in-progress')
                                and t.scope is distinct from 'mad3oom_support'),
    'open_continuity_owned', (select count(*) from public.continuity_records c
                               where c.owner_id = p.id and c.status not in ('resolved', 'cancelled')),
    'active_delegations', (select count(*) from public.platform_delegations d
                            where d.delegate_id = p.id and d.revoked_at is null
                              and (d.expires_at is null or d.expires_at > now())),
    'capability_grants', (select count(*) from public.platform_capability_grants g where g.user_id = p.id))
  from public.profiles p where p.id = p_user;
$$;

create or replace function public.owner_decide_admin_review(p_user uuid, p_decision text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_note text := public._reason_check(p_note);
begin
  perform public._owner_write_check();
  if p_decision not in ('keep', 'convert_support', 'convert_user', 'revoke_authority') then
    raise exception 'قرار غير معروف' using errcode = '22023';
  end if;
  if exists (select 1 from public.admin_account_reviews where user_id = p_user and applied_at is not null) then
    raise exception 'القرار طُبِّق وصار نهائيًا — أي تغيير لاحق بالمسار الرسمي للرتب' using errcode = '55000',
      detail = '{"code":"review_final"}';
  end if;
  update public.admin_account_reviews
     set decision = p_decision, decision_note = v_note, decided_by = auth.uid(), decided_at = now()
   where user_id = p_user;
  if not found then
    raise exception 'الحساب ليس ضمن المراجعة' using errcode = 'P0002';
  end if;
  perform public._hierarchy_event('review.decided', null, null, p_user, jsonb_build_object('decision', p_decision, 'note', v_note));
  return jsonb_build_object('user_id', p_user, 'decision', p_decision);
end $$;


-- ============================================================================
-- 8) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches
              where key in ('delegation_enabled', 'company_suspension_enforced') and enabled) then
    raise exception '103: مفتاح التفويض أو الإيقاف مفعّل';
  end if;
  if exists (select 1 from pg_constraint
              where contype = 'f'
                and conrelid in ('public.admin_unit_members'::regclass, 'public.platform_delegations'::regclass,
                                 'public.admin_unit_companies'::regclass)
                and confrelid in ('public.profiles'::regclass, 'public.companies'::regclass)) then
    raise exception '103: ما زال مفتاح خارجي من سجل الهيكل إلى الحسابات أو الشركات';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('trg_hierarchy_eligibility', 'trg_hierarchy_company_tie', 'trg_hierarchy_company_deleted')) <> 5 then
    raise exception '103: محفّزات فقد الأهلية والحذف غير مكتملة';
  end if;
  if exists (select 1 from pg_policies
              where coalesce(qual, '') || coalesce(with_check, '') ~ '(admin_unit|platform_delegations|_delegate_can)') then
    raise exception '103: سياسة وصول تعتمد على الهيكل الإداري';
  end if;
  if has_function_privilege('authenticated', 'public._hierarchy_release_user(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public._session_aal2()', 'execute') then
    raise exception '103: دالة داخلية مفتوحة';
  end if;
end $$;
