-- ============================================================================
-- 078_continuity_policies.sql
--   مدعوم — الاستمرارية (Mad3oom Continuity)، المرحلة 0: السياسات ومفاتيح الإيقاف
--   (docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md §5.1 و §14.6 و §16)
--
-- قرارات المالك 2026-10-12
--   D1–D4  القيم الافتراضية: تذكير قبل الموعد بـ60 دقيقة، وإشعار عند الموعد،
--          وتصعيد للمشرفين بعد 240 دقيقة تأخير، وتذكير تسليم معلّق بعد 60 دقيقة
--          وتصعيده بعد 240. قيم قابلة للضبط، لا قواعد مكتوبة في الكود.
--   R1     تغيير السياسات لمالك المنصة فقط (مثل T2/T3 في 076). القراءة لكل عضو.
--
-- ما يضيفه
--   continuity_policies          صف لكل مساحة (المنصة الآن). كل مفاتيح القدرات = false.
--   continuity_policy_history    سجل تغيير للإلحاق فقط (قيم مكتوبة الأنواع، بلا نص حر).
--   continuity_get_policies()                      للأعضاء.
--   continuity_set_policies(patch, expected_version) للمالك فقط، بفحص النسخة.
--   continuity_my_access()       يضيف capabilities (مثبتة ومفعّلة)؛ كل المفاتيح القديمة كما هي.
--
-- القدرة لا تُفعَّل قبل وجود كودها: تفعيل X يتطلب وجود الدالة العلامة
--   public._continuity_capability_<X>() التي تنشئها هجرة تلك القدرة. في 078 لا توجد
--   أي علامة، فكل تفعيل يُرفض بـ feature_not_enabled.
--
-- لا يغيّر أي سلوك قائم: الدوال الـ18 الأخرى كما هي حرفيًا، ولا يلمس chat_* أو
--   inbox_* أو tickets أو profiles أو notifications.
--
-- تحذير تشغيل: لا تُعِد تشغيل 073 أو 074 أو 076 أو 077 بعد 078 (077 يعيد تعريف
--   continuity_my_access بنسخة أقدم، والأقدم تنشئ كائنات relay_* من جديد).
--
-- يتطلب 077 (المساحة الداخلية continuity). الأغلفة relay_* من 077 لا تُلمس: الغلاف
--   relay_my_access ينادي continuity_my_access فيرجع capabilities أيضًا.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/078_continuity_policies.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات (073 + 074 + 076)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_require_member()', 'public._continuity_require_owner()', 'public._continuity_workspace(text)',
    'public._continuity_is_member()', 'public._continuity_is_supervisor()', 'public._continuity_can_assign()',
    'public._continuity_is_owner()', 'public._continuity_validation(text, text)', 'public._continuity_forbidden(text)',
    'public._continuity_guard_append_only()', 'public.continuity_my_access()', 'public.guard_preview_read_only()',
    'public.account_is_active()'] loop
    if to_regprocedure(f) is null then
      raise exception '078 يتطلب 073 و074 و076 و077 (%)', f;
    end if;
  end loop;
  if to_regclass('public.continuity_records') is null or to_regclass('public.relay_records') is not null then
    raise exception '078 يتطلب 077 (المساحة الداخلية continuity)';
  end if;
  if pg_get_functiondef('public.continuity_my_access()'::regprocedure) not like '%''owner''%' then
    raise exception '078 يتطلب 076 (continuity_my_access بمفتاح owner)';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.continuity_policies (
  workspace_id                    uuid primary key references public.continuity_workspaces(id),
  -- مفاتيح القدرات: كلها مطفأة. تفعيل أي منها قرار إنتاج منفصل.
  handovers_enabled               boolean not null default false,
  reminders_enabled               boolean not null default false,
  escalation_enabled              boolean not null default false,
  monitor_enabled                 boolean not null default false,
  attachments_enabled             boolean not null default false,
  ai_enabled                      boolean not null default false,
  -- D1: دقائق قبل due_at (0 إلى 5 قيم، كل قيمة 5 دقائق إلى 7 أيام).
  reminder_offsets_minutes        int[] not null default '{60}',
  -- D1: إشعار عند حلول الموعد.
  due_alert                       boolean not null default true,
  -- D2 (لم يُقرَّر): تكرار أثناء التأخير، مطفأ افتراضيًا.
  overdue_repeat_minutes          int,
  overdue_repeat_max              int not null default 3,
  -- D3: تصعيد بعد 240 دقيقة تأخير؛ null = بلا تصعيد.
  escalate_after_minutes          int default 240,
  escalation_recipients           text not null default 'supervisors',
  respect_working_hours           boolean not null default true,
  -- D4: تسليم معلّق: تذكير بعد 60 وتصعيد بعد 240.
  handover_remind_after_minutes   int default 60,
  handover_escalate_after_minutes int default 240,
  -- المراقب
  stale_after_days                int not null default 7,
  postpone_flag_count             int not null default 3,
  version                         int not null default 1 check (version >= 1),
  updated_by                      uuid references public.profiles(id) on delete set null,
  updated_at                      timestamptz not null default now(),
  constraint continuity_policies_offsets check (
    cardinality(reminder_offsets_minutes) between 0 and 5
    and array_position(reminder_offsets_minutes, null) is null
    and 5 <= all (reminder_offsets_minutes) and 10080 >= all (reminder_offsets_minutes)),
  constraint continuity_policies_repeat check (overdue_repeat_minutes is null or overdue_repeat_minutes between 15 and 1440),
  constraint continuity_policies_repeat_max check (overdue_repeat_max between 1 and 10),
  constraint continuity_policies_escalate check (escalate_after_minutes is null or escalate_after_minutes between 5 and 43200),
  constraint continuity_policies_recipients check (escalation_recipients in ('supervisors', 'team_then_supervisors')),
  constraint continuity_policies_handover_remind check (handover_remind_after_minutes is null
                                                   or handover_remind_after_minutes between 5 and 43200),
  constraint continuity_policies_handover_escalate check (handover_escalate_after_minutes is null
                                                     or handover_escalate_after_minutes between 5 and 43200),
  constraint continuity_policies_stale check (stale_after_days between 1 and 365),
  constraint continuity_policies_postpone check (postpone_flag_count between 1 and 50)
);

comment on table public.continuity_policies is
  'Continuity (078). سياسة كل مساحة: مفاتيح القدرات (كلها مطفأة) وأوقات التذكير والتصعيد (D1–D4). التغيير للمالك فقط عبر continuity_set_policies.';

insert into public.continuity_policies (workspace_id)
select w.id from public.continuity_workspaces w where w.kind = 'platform'
on conflict (workspace_id) do nothing;

create table if not exists public.continuity_policy_history (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.continuity_workspaces(id),
  actor_id     uuid,
  changed      text[] not null,
  before       jsonb not null,
  after        jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists continuity_policy_history_ws on public.continuity_policy_history (workspace_id, id desc);

comment on table public.continuity_policy_history is
  'Continuity (078). كل تغيير في continuity_policies: من، متى، أي أعمدة، القيم قبل وبعد. للإلحاق فقط.';


-- ============================================================================
-- 2) محفزات الثبات
-- ============================================================================
create or replace function public._continuity_guard_policy_delete()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception 'سياسة الاستمرارية لا تُحذف' using errcode = '42501';
end $$;
revoke all on function public._continuity_guard_policy_delete() from public, anon, authenticated;

drop trigger if exists trg_continuity_policies_no_delete on public.continuity_policies;
create trigger trg_continuity_policies_no_delete before delete on public.continuity_policies
  for each row execute function public._continuity_guard_policy_delete();
drop trigger if exists trg_continuity_policies_no_truncate on public.continuity_policies;
create trigger trg_continuity_policies_no_truncate before truncate on public.continuity_policies
  for each statement execute function public._continuity_guard_append_only();

drop trigger if exists trg_continuity_policy_history_append_only on public.continuity_policy_history;
create trigger trg_continuity_policy_history_append_only before update or delete on public.continuity_policy_history
  for each row execute function public._continuity_guard_append_only();
drop trigger if exists trg_continuity_policy_history_no_truncate on public.continuity_policy_history;
create trigger trg_continuity_policy_history_no_truncate before truncate on public.continuity_policy_history
  for each statement execute function public._continuity_guard_append_only();


-- ============================================================================
-- 3) RLS والاتفاقيات (041/042) — بلا أي سياسة سماح وبلا صلاحيات
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_policies', 'continuity_policy_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
  end loop;
end $$;
revoke all on sequence public.continuity_policy_history_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on sequence public.continuity_policy_history_id_seq from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) مساعدات داخلية
-- ============================================================================
-- القدرات المعروفة وترتيبها الثابت (يستخدمها continuity_my_access والتحقق).
create or replace function public._continuity_capabilities()
returns text[] language sql immutable set search_path to 'public' as $$
  select array['handovers', 'reminders', 'escalation', 'monitor', 'attachments', 'ai'];
$$;

-- القدرة مثبتة = هجرتها أنشأت الدالة العلامة public._continuity_capability_<name>().
create or replace function public._continuity_capability_installed(p_name text)
returns boolean language sql stable set search_path to 'public' as $$
  select p_name = any (public._continuity_capabilities())
     and to_regprocedure('public._continuity_capability_' || p_name || '()') is not null;
$$;

-- قيم السياسة كـ jsonb (بلا workspace_id). مصدر واحد للقراءة والسجل.
create or replace function public._continuity_policy_json(p public.continuity_policies)
returns jsonb language sql stable set search_path to 'public' as $$
  select to_jsonb(p) - 'workspace_id' - 'updated_by' - 'updated_at' - 'version';
$$;

-- القدرات الفعلية (مثبتة ومفعّلة) لمساحة المنصة. أي غياب ⇒ false.
create or replace function public._continuity_effective_capabilities()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_object_agg(c, coalesce((to_jsonb(p) ->> (c || '_enabled'))::boolean, false)
                                and public._continuity_capability_installed(c))
      from unnest(public._continuity_capabilities()) c
      left join public.continuity_workspaces w on w.kind = 'platform'
      left join public.continuity_policies p on p.workspace_id = w.id),
    '{}'::jsonb);
$$;

do $$
declare f text;
begin
  foreach f in array array['public._continuity_capabilities()', 'public._continuity_capability_installed(text)',
                           'public._continuity_policy_json(public.continuity_policies)',
                           'public._continuity_effective_capabilities()', 'public._continuity_guard_policy_delete()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 5) الـRPC
-- ============================================================================
-- للأعضاء: السياسة، والقدرات المثبتة، والفعلية. لا أسماء ولا بريد (updated_by معرّف فقط).
create or replace function public.continuity_get_policies()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare w public.continuity_workspaces; p public.continuity_policies;
begin
  perform public._continuity_require_member();
  w := public._continuity_workspace(null);
  select * into p from public.continuity_policies where workspace_id = w.id;
  if p.workspace_id is null then
    raise exception 'السياسة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object(
    'policy', public._continuity_policy_json(p),
    'version', p.version, 'updated_by', p.updated_by, 'updated_at', p.updated_at,
    'capabilities_installed', (select jsonb_object_agg(c, public._continuity_capability_installed(c))
                                 from unnest(public._continuity_capabilities()) c),
    'capabilities', public._continuity_effective_capabilities());
end $$;

-- للمالك فقط (R1). كل مفتاح يُتحقق من نوعه؛ الحدود يفرضها قيد الجدول وتُترجم
-- لـ validation_failed. تفعيل قدرة غير مثبتة ⇒ feature_not_enabled. تغيير بلا فرق
-- لا يرفع النسخة ولا يكتب سجلًا.
create or replace function public.continuity_set_policies(p_patch jsonb, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  w public.continuity_workspaces;
  o public.continuity_policies;
  n public.continuity_policies;
  k text;
  v jsonb;
  e jsonb;
  v_changed text[];
  v_bool constant text[] := array['handovers_enabled', 'reminders_enabled', 'escalation_enabled', 'monitor_enabled',
                                  'attachments_enabled', 'ai_enabled', 'due_alert', 'respect_working_hours'];
  v_int_null constant text[] := array['overdue_repeat_minutes', 'escalate_after_minutes',
                                      'handover_remind_after_minutes', 'handover_escalate_after_minutes'];
  v_int constant text[] := array['overdue_repeat_max', 'stale_after_days', 'postpone_flag_count'];
begin
  v_uid := public._continuity_require_owner();
  w := public._continuity_workspace(null);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public._continuity_validation('patch');
  end if;
  if p_expected_version is null then perform public._continuity_validation('expected_version'); end if;

  select * into o from public.continuity_policies where workspace_id = w.id for update;
  if o.workspace_id is null then
    raise exception 'السياسة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if o.version <> p_expected_version then
    raise exception 'السياسة اتعدّلت — حدّث الصفحة' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', o.version)::text;
  end if;

  n := o;
  for k, v in select key, value from jsonb_each(p_patch) loop
    if k = any (v_bool) then
      if jsonb_typeof(v) <> 'boolean' then perform public._continuity_validation(k, 'boolean_expected'); end if;
    elsif k = any (v_int_null) then
      if jsonb_typeof(v) not in ('number', 'null')
         or (jsonb_typeof(v) = 'number' and (v #>> '{}') !~ '^[0-9]+$') then
        perform public._continuity_validation(k, 'integer_expected');
      end if;
    elsif k = any (v_int) then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]+$' then
        perform public._continuity_validation(k, 'integer_expected');
      end if;
    elsif k = 'reminder_offsets_minutes' then
      if jsonb_typeof(v) <> 'array' then perform public._continuity_validation(k, 'array_expected'); end if;
      for e in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]+$' then
          perform public._continuity_validation(k, 'integer_expected');
        end if;
      end loop;
    elsif k = 'escalation_recipients' then
      if jsonb_typeof(v) <> 'string' then perform public._continuity_validation(k, 'string_expected'); end if;
    else
      perform public._continuity_validation('patch.' || k, 'not_updatable');
    end if;
    -- تفعيل قدرة: لازم كودها مثبت.
    if k like '%\_enabled' and v = 'true'::jsonb
       and not public._continuity_capability_installed(left(k, -length('_enabled'))) then
      raise exception 'القدرة غير مثبتة بعد' using errcode = '0A000',
        detail = jsonb_build_object('code', 'feature_not_enabled', 'field', k)::text;
    end if;
  end loop;

  -- تطبيق الرقعة على نسخة السطر؛ القيود تُفحص عند التحديث.
  n := jsonb_populate_record(o, p_patch);
  select array_agg(c order by c) into v_changed
    from jsonb_object_keys(public._continuity_policy_json(o)) c
   where (public._continuity_policy_json(o) -> c) is distinct from (public._continuity_policy_json(n) -> c);
  if v_changed is null then
    return public.continuity_get_policies();
  end if;

  begin
    update public.continuity_policies
       set handovers_enabled = n.handovers_enabled, reminders_enabled = n.reminders_enabled,
           escalation_enabled = n.escalation_enabled, monitor_enabled = n.monitor_enabled,
           attachments_enabled = n.attachments_enabled, ai_enabled = n.ai_enabled,
           reminder_offsets_minutes = n.reminder_offsets_minutes, due_alert = n.due_alert,
           overdue_repeat_minutes = n.overdue_repeat_minutes, overdue_repeat_max = n.overdue_repeat_max,
           escalate_after_minutes = n.escalate_after_minutes, escalation_recipients = n.escalation_recipients,
           respect_working_hours = n.respect_working_hours,
           handover_remind_after_minutes = n.handover_remind_after_minutes,
           handover_escalate_after_minutes = n.handover_escalate_after_minutes,
           stale_after_days = n.stale_after_days, postpone_flag_count = n.postpone_flag_count,
           version = version + 1, updated_by = v_uid, updated_at = now()
     where workspace_id = w.id
    returning * into n;
  exception when check_violation then
    get stacked diagnostics k = constraint_name;
    perform public._continuity_validation('policy', k);
  end;

  insert into public.continuity_policy_history (workspace_id, actor_id, changed, before, after)
  values (w.id, v_uid, v_changed,
          (select jsonb_object_agg(c, public._continuity_policy_json(o) -> c) from unnest(v_changed) c),
          (select jsonb_object_agg(c, public._continuity_policy_json(n) -> c) from unnest(v_changed) c));
  return public.continuity_get_policies();
end $$;

-- 076 كما هو + capabilities (مثبتة ومفعّلة). كل المفاتيح القديمة وقيمها كما هي.
create or replace function public.continuity_my_access()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._continuity_is_member() then
    return jsonb_build_object('member', false, 'enabled', false, 'supervisor', false, 'can_assign', false,
                              'owner', false,
                              'capabilities', (select jsonb_object_agg(c, false) from unnest(public._continuity_capabilities()) c));
  end if;
  return jsonb_build_object(
    'member', true,
    'enabled', coalesce((select w.enabled from public.continuity_workspaces w where w.kind = 'platform'), false),
    'supervisor', public._continuity_is_supervisor(),
    'can_assign', public._continuity_can_assign(),
    'owner', public._continuity_is_owner(),
    'capabilities', public._continuity_effective_capabilities());
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.continuity_get_policies()', 'public.continuity_set_policies(jsonb, integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 6) تحقق
-- ============================================================================
do $$
declare
  t text;
  f text;
begin
  foreach t in array array['continuity_workspaces', 'continuity_records', 'continuity_sources', 'continuity_source_snapshots',
                           'continuity_events', 'continuity_assigners', 'continuity_policies', 'continuity_policy_history'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '078: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '078: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '078: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%') loop
    if has_function_privilege('anon', f, 'EXECUTE')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_function_privilege('service_role', f, 'EXECUTE'))
       or (has_function_privilege('authenticated', f, 'EXECUTE')
           and f not in ('continuity_create(jsonb)', 'continuity_get(uuid)', 'continuity_list(jsonb)',
                         'continuity_update(uuid,jsonb,integer)', 'continuity_assign(uuid,uuid,uuid,integer)',
                         'continuity_transition(uuid,text,jsonb,integer)',
                         'continuity_attach_sources(uuid,jsonb,integer,boolean)', 'continuity_redact_source(uuid,text)',
                         'continuity_redact_for_subject(uuid,text)', 'continuity_find_by_source(jsonb)',
                         'continuity_events_for(uuid,bigint,integer)', 'continuity_my_access()',
                         'continuity_list_assigners()', 'continuity_grant_assigner(uuid)',
                         'continuity_revoke_assigner(uuid)', 'continuity_remove_source(uuid,integer)',
                         'continuity_restore_source(uuid,integer)', 'continuity_list_removed(integer)',
                         'continuity_purge_removed(uuid)', 'continuity_get_policies()',
                         'continuity_set_policies(jsonb,integer)')) then
      raise exception '078: دالة مكشوفة لدور غير مقصود: %', f;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 21 then
    raise exception '078: المتوقع 21 دالة لـ authenticated';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '078: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  if not exists (select 1 from public.continuity_policies p join public.continuity_workspaces w on w.id = p.workspace_id
                  where w.kind = 'platform' and not (p.handovers_enabled or p.reminders_enabled or p.escalation_enabled
                                                     or p.monitor_enabled or p.attachments_enabled or p.ai_enabled)) then
    raise exception '078: سياسة المنصة مفقودة أو فيها قدرة مفعّلة';
  end if;
  if pg_get_functiondef('public.continuity_my_access()'::regprocedure) not like '%_continuity_effective_capabilities()%' then
    raise exception '078: continuity_my_access بلا capabilities';
  end if;
  raise notice '078: سياسات الاستمرارية جاهزة (كل القدرات مطفأة وغير مثبتة)';
end $$;
