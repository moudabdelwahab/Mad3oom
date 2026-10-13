-- ============================================================================
-- 091_continuity_scoped_handover.sql
--   Mad3oom Continuity — التسليم المحدود والوصول المفوَّض (082a في docs/continuity/SCOPED_HANDOVER_DESIGN.md)
--
-- القرارات المعتمدة (2026-10-12، §12): S-1 … S-8. هنا 082a فقط:
--   • ثلاثة أوضاع للتسليم في نفس الجدول: transfer (كما 081)، review (عرض فقط)، collab (عرض فقط
--     في 082a؛ الإجراءات الأخرى بعد 082b ويرفضها الخادم feature_not_enabled).
--   • النطاق قائمة صريحة ثابتة ومُرقّمة (continuity_handover_scopes): معرّفات رسائل ومرفقات تُحسم
--     وقت الطلب، ونطاق زمني اختياري [من، إلى) بمنطقة زمنية، وإجراءات، وانتهاء. لا يتوسع وحده أبدًا.
--   • الوصول = النطاق المعتمد ∩ صلاحيات المستلم الحالية ∩ حالة السجل. C3 كما هو: المقتطف يظهر فقط
--     لو المستلم نفسه يقدر يفتح المحادثة الآن.
--   • البوابة (_continuity_active_grant) تعيد الفحص في كل قراءة: الحالة، الانتهاء، الجلسة المربوطة
--     (auth.sessions)، أهلية المستلم، سلطة المانح، حالة السجل، القدرة، والإجراء.
--   • الوقت يبدأ عند القبول (S-1)؛ الافتراضي 4 ساعات، الأقصى 7 أيام، الجلسة 12 ساعة، المستمر مطفأ (S-2).
--   • من يمنح: مالك السجل أو المشرف أو صاحب الإسناد (S-4). الإسناد أو الإغلاق يسحب كل المنح (S-4).
--   • أصغر وحدة: رسالة كاملة (S-5).
--   • المرفقات المشتركة لا يوقّعها المستلم أبدًا: سياسة المستودع كما هي، والملف يمر عبر الدالة الطرفية
--     continuity-shared-attachment التي تعيد البوابة لكل طلب وتوقّع داخليًا ≤ min(60ث، الوقت المتبقي) (S-7).
--   • القبول بالمراجعة: التعديلات العادية لا تمنع القبول (يُخبَر المستلم بأسماء الحقول)، والتغيير
--     الجوهري (الحالة، المالك، الفريق، النوع، التصنيف، الموعد، عناصر النطاق) يتطلب مراجعة جديدة (§7).
--   • التضييق فوري بلا موافقة؛ التوسيع نسخة «مقترحة» تنتظر قبول المستلم والقديم يحكم (§8).
--
-- ما لا يتغيّر
--   • continuity_handover_request بستة معاملات (التسليم الكامل) وcancel وget وhandovers_for_record
--     ومحفّز 081: بلا تعديل. الطلب الجديد بثمانية معاملات (بلا افتراضيات، فلا التباس في الأسماء).
--   • continuity_handover_decide القديم (بالنسخة) يُرقَّع بسطر واحد: يرفض غير transfer، فلا يمكن أبدًا
--     أن ينقل طلب مراجعة الملكية. القرار الجديد يأخذ بصمة المراجعة.
--   • القراءة العادية (continuity_get/list/events) لا ترى المنح، والمنح لا يظهر فيها.
--   • لا جدول continuity_* يُضاف لـ supabase_realtime (يُتحقق).
--
-- الترقيع (نفس طريقة 087): استبدال نص ثابت يظهر مرة واحدة، بشرط أن بصمة الدالة تطابق نص الإنتاج،
--   وإثبات أن عكس الاستبدال يعيد البصمة. العلامة 091_continuity_scoped_handover.
--
-- مفتاح الإيقاف: handovers_enabled. مطفأ ⇒ كل قراءة وكتابة مشتركة تتوقف فورًا، ولا شيء يضيع.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/091_continuity_scoped_handover.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.continuity_handovers') is null
     or to_regprocedure('public._continuity_permissions(uuid)') is null
     or to_regprocedure('public._continuity_attachment_cleanup_call()') is null then
    raise exception '091: يتطلب 081 و087 و089';
  end if;
end $$;


-- ============================================================================
-- 1) السياسة: مدد التفويض (S-2)
-- ============================================================================
alter table public.continuity_policies
  add column if not exists delegation_default_minutes     int not null default 240,
  add column if not exists delegation_max_minutes         int not null default 10080,
  add column if not exists delegation_session_max_minutes int not null default 720,
  add column if not exists delegation_allow_ongoing       boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.continuity_policies'::regclass
                  and conname = 'continuity_policies_delegation') then
    alter table public.continuity_policies add constraint continuity_policies_delegation check (
      delegation_max_minutes between 1 and 10080
      and delegation_default_minutes between 1 and delegation_max_minutes
      and delegation_session_max_minutes between 1 and 720);
  end if;
end $$;


-- ============================================================================
-- 2) الطلبات: الوضع والمراجعة والانتهاء والسحب
-- ============================================================================
alter table public.continuity_handovers
  add column if not exists mode              text not null default 'transfer',
  add column if not exists scope_version     int,
  add column if not exists reviewed_version  int,
  add column if not exists reviewed_digest   text,
  add column if not exists reviewed_material jsonb,
  add column if not exists reviewed_at       timestamptz,
  add column if not exists expires_at        timestamptz,
  add column if not exists bound_session_id  text,
  add column if not exists revoked_at        timestamptz,
  add column if not exists revoked_by        uuid references public.profiles(id) on delete set null,
  add column if not exists revoke_cause      text;

alter table public.continuity_handovers drop constraint if exists continuity_handovers_state_check;
alter table public.continuity_handovers add constraint continuity_handovers_state_check
  check (state in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'revoked'));
alter table public.continuity_handovers drop constraint if exists continuity_handovers_cancel_cause_check;
alter table public.continuity_handovers add constraint continuity_handovers_cancel_cause_check
  check (cancel_cause in ('initiator', 'reassigned', 'record_closed', 'target_ineligible', 'supervisor',
                          'requester_lost_authority', 'time', 'session'));
alter table public.continuity_handovers drop constraint if exists continuity_handovers_state;
alter table public.continuity_handovers add constraint continuity_handovers_state check (
  case state
    when 'pending'   then decided_at is null and decision_note is null and cancel_cause is null and revoked_at is null
    when 'accepted'  then decided_at is not null and cancel_cause is null and revoked_at is null
    when 'declined'  then decided_at is not null and decision_note is not null and cancel_cause is null
    when 'cancelled' then decided_at is not null and cancel_cause is not null
    when 'expired'   then decided_at is not null and (cancel_cause = 'target_ineligible'
                                                      or (cancel_cause in ('time', 'session') and mode <> 'transfer'))
    when 'revoked'   then decided_at is not null and revoked_at is not null and revoke_cause is not null and mode <> 'transfer'
  end);
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.continuity_handovers'::regclass and conname = 'continuity_handovers_mode') then
    alter table public.continuity_handovers add constraint continuity_handovers_mode check (
      mode in ('transfer', 'review', 'collab')
      and (mode = 'transfer') = (scope_version is null)
      and (mode <> 'transfer' or (expires_at is null and bound_session_id is null)));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.continuity_handovers'::regclass and conname = 'continuity_handovers_revoke_cause') then
    alter table public.continuity_handovers add constraint continuity_handovers_revoke_cause check (
      revoke_cause in ('owner', 'grantor', 'supervisor', 'record_closed', 'reassigned', 'grantor_lost_authority',
                       'recipient_ineligible', 'policy'));
  end if;
end $$;
create index if not exists continuity_handovers_grants on public.continuity_handovers (to_owner, record_id)
  where state = 'accepted' and mode <> 'transfer';


-- ============================================================================
-- 3) النطاقات (ثابتة ومُرقّمة)
-- ============================================================================
create table if not exists public.continuity_handover_scopes (
  id               uuid primary key default gen_random_uuid(),
  handover_id      uuid not null references public.continuity_handovers(id),
  record_id        uuid not null references public.continuity_records(id),
  workspace_id     uuid not null references public.continuity_workspaces(id),
  version          int not null check (version >= 1),
  status           text not null check (status in ('proposed', 'approved', 'superseded', 'rejected')),
  source_ids       uuid[] not null default '{}',
  attachment_ids   uuid[] not null default '{}',
  range_from       timestamptz,
  range_to         timestamptz,
  range_tz         text,
  actions          text[] not null default '{view}',
  editable_fields  text[] not null default '{}',
  expiry_kind      text not null check (expiry_kind in ('session', 'duration', 'until', 'ongoing')),
  duration_minutes int,
  until_at         timestamptz,
  reason           text not null check (char_length(reason) between 1 and 1000),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  constraint continuity_handover_scopes_version unique (handover_id, version),
  constraint continuity_handover_scopes_range check (
    (range_from is null) = (range_to is null) and (range_from is null) = (range_tz is null)
    and (range_from is null or range_from < range_to)),
  constraint continuity_handover_scopes_actions check (
    'view' = any (actions) and actions <@ array['view', 'note', 'propose', 'edit_fields', 'add_source']),
  constraint continuity_handover_scopes_fields check (
    editable_fields <@ array['next_action', 'summary', 'due', 'priority', 'waiting_on']),
  constraint continuity_handover_scopes_expiry check (
    case expiry_kind
      when 'duration' then duration_minutes between 1 and 10080 and until_at is null
      when 'session'  then duration_minutes between 1 and 720 and until_at is null
      when 'until'    then until_at is not null and duration_minutes is null
      when 'ongoing'  then duration_minutes is null and until_at is null
    end),
  constraint continuity_handover_scopes_items check (cardinality(source_ids) + cardinality(attachment_ids) >= 1)
);
create unique index if not exists continuity_handover_scopes_one_approved on public.continuity_handover_scopes (handover_id)
  where status = 'approved';
create unique index if not exists continuity_handover_scopes_one_proposed on public.continuity_handover_scopes (handover_id)
  where status = 'proposed';
create index if not exists continuity_handover_scopes_record on public.continuity_handover_scopes (record_id);

comment on table public.continuity_handover_scopes is
  'الاستمرارية (091). نطاق التسليم المحدود: قوائم صريحة ثابتة لكل نسخة. التضييق نسخة معتمدة فورًا، والتوسيع '
  'نسخة مقترحة تنتظر المستلم. لا حذف ولا تعديل إلا انتقال الحالة.';

-- الثبات: لا حذف؛ التعديل انتقال حالة فقط (proposed → approved|rejected|superseded، approved → superseded)
-- أو حذف حساب فاعل (ON DELETE SET NULL).
create or replace function public._continuity_guard_scope()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'نطاقات التسليم لا تُحذف' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'created_by' - 'status' - 'decided_at') = (to_jsonb(old) - 'created_by' - 'status' - 'decided_at')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.status = old.status
          or (old.status = 'proposed' and new.status in ('approved', 'rejected', 'superseded'))
          or (old.status = 'approved' and new.status = 'superseded')) then
    return new;
  end if;
  raise exception 'نطاق التسليم ثابت' using errcode = '42501';
end $$;

-- كل عنصر من نفس السجل والمساحة، والطلب من نفس السجل (يُفحص عند الإدراج).
create or replace function public._continuity_scope_same_record()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.continuity_handovers h
                  where h.id = new.handover_id and h.record_id = new.record_id and h.workspace_id = new.workspace_id
                    and h.mode <> 'transfer') then
    raise exception 'نطاق لطلب من سجل آخر' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(new.source_ids) x
              where not exists (select 1 from public.continuity_sources s
                                 where s.id = x and s.record_id = new.record_id and s.workspace_id = new.workspace_id))
     or exists (select 1 from unnest(new.attachment_ids) x
                 where not exists (select 1 from public.continuity_attachments a
                                    where a.id = x and a.record_id = new.record_id and a.workspace_id = new.workspace_id)) then
    raise exception 'عنصر من سجل آخر في النطاق' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_continuity_scope_guard on public.continuity_handover_scopes;
create trigger trg_continuity_scope_guard before update or delete on public.continuity_handover_scopes
  for each row execute function public._continuity_guard_scope();
drop trigger if exists trg_continuity_scope_same_record on public.continuity_handover_scopes;
create trigger trg_continuity_scope_same_record before insert on public.continuity_handover_scopes
  for each row execute function public._continuity_scope_same_record();
drop trigger if exists trg_continuity_scopes_no_truncate on public.continuity_handover_scopes;
create trigger trg_continuity_scopes_no_truncate before truncate on public.continuity_handover_scopes
  for each statement execute function public._continuity_guard_append_only();

alter table public.continuity_handover_scopes enable row level security;
revoke all on table public.continuity_handover_scopes from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.continuity_handover_scopes from service_role;
  end if;
end $$;
drop policy if exists gate_account_active on public.continuity_handover_scopes;
create policy gate_account_active on public.continuity_handover_scopes
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.continuity_handover_scopes;
create trigger trg_preview_read_only
  before insert or update or delete on public.continuity_handover_scopes
  for each statement execute function public.guard_preview_read_only();


-- ============================================================================
-- 4) ثبات طلبات التسليم مع الانتقالات الجديدة
-- ============================================================================
-- true  = مسموح بالقواعد الجديدة (091)؛ false = يُترك لحارس 081 كما هو؛ استثناء = ممنوع.
create or replace function public._continuity_guard_grant(o public.continuity_handovers, n public.continuity_handovers)
returns boolean language plpgsql set search_path to 'public' as $$
declare
  v_actor_only boolean;
  v_review constant text[] := array['reviewed_version', 'reviewed_digest', 'reviewed_material', 'reviewed_at'];
  v_actors constant text[] := array['from_owner', 'to_owner', 'decided_by', 'created_by', 'revoked_by'];
begin
  if n.mode is distinct from o.mode then
    raise exception 'وضع التسليم ثابت' using errcode = '42501';
  end if;
  -- حذف حساب فاعل فقط (أي حالة، بما فيها المسحوب)
  v_actor_only := (to_jsonb(n) - v_actors) = (to_jsonb(o) - v_actors)
                  and (n.from_owner is null or n.from_owner = o.from_owner) and (n.to_owner is null or n.to_owner = o.to_owner)
                  and (n.decided_by is null or n.decided_by = o.decided_by) and (n.created_by is null or n.created_by = o.created_by)
                  and (n.revoked_by is null or n.revoked_by = o.revoked_by);
  if v_actor_only then return true; end if;
  -- سقف الانتهاء (دفاع إضافي): لا منحة تمتد بعد الحد الأقصى في السياسة من الآن
  if n.expires_at is distinct from o.expires_at and n.expires_at is not null
     and n.expires_at > now() + make_interval(mins => coalesce((public._continuity_policy_row()).delegation_max_minutes, 10080)) then
    raise exception 'انتهاء المنحة يتجاوز حد السياسة' using errcode = '42501';
  end if;
  -- المراجعة أثناء الانتظار (كل الأوضاع)
  if o.state = 'pending' and n.state = 'pending' then
    if (to_jsonb(n) - v_review) = (to_jsonb(o) - v_review) then return true; end if;
    raise exception 'الطلب المعلّق ثابت إلا المراجعة' using errcode = '42501';
  end if;
  if o.mode = 'transfer' then
    if n.scope_version is not null or n.expires_at is not null or n.bound_session_id is not null or n.revoked_at is not null then
      raise exception 'التسليم الكامل بلا نطاق ولا انتهاء' using errcode = '42501';
    end if;
    return false;  -- قرار 081 كما هو
  end if;
  -- review/collab
  if o.state = 'pending' then
    -- القرار: نفس قيود 081 (تُفحص هناك)، مع ثبات حقول المراجعة والنطاق
    if n.scope_version is distinct from o.scope_version or n.reviewed_digest is distinct from o.reviewed_digest then
      raise exception 'النطاق والمراجعة ثابتان عند القرار' using errcode = '42501';
    end if;
    if n.state <> 'accepted' and (n.expires_at is not null or n.bound_session_id is not null) then
      raise exception 'لا انتهاء لطلب لم يُقبل' using errcode = '42501';
    end if;
    return false;
  end if;
  if o.state = 'accepted' then
    if (to_jsonb(n) - array['state', 'scope_version', 'expires_at', 'bound_session_id', 'revoked_at', 'revoked_by',
                            'revoke_cause', 'cancel_cause'])
       <> (to_jsonb(o) - array['state', 'scope_version', 'expires_at', 'bound_session_id', 'revoked_at', 'revoked_by',
                               'revoke_cause', 'cancel_cause']) then
      raise exception 'المنحة ثابتة إلا نطاقها وانتهاؤها' using errcode = '42501';
    end if;
    if n.state = 'accepted' and n.revoked_at is null and n.cancel_cause is null then return true; end if;
    if n.state = 'revoked' and n.revoked_at is not null and n.revoke_cause is not null then return true; end if;
    if n.state = 'expired' and n.cancel_cause in ('time', 'session') then return true; end if;
  end if;
  raise exception 'المنحة انتهت — لا رجوع' using errcode = '42501';
end $$;


-- ============================================================================
-- 5) مساعدات
-- ============================================================================
create or replace function public._continuity_policy_row()
returns public.continuity_policies language sql stable security definer set search_path to 'public' as $$
  select p.* from public.continuity_policies p join public.continuity_workspaces w on w.id = p.workspace_id
   where w.kind = 'platform';
$$;

-- هل يقدر مستخدم **آخر** يفتح المحادثة الآن؟ تقريب لـ inbox_can_access لغير المنادي (للمعاينة والعدّ
-- فقط؛ عرض المقتطف نفسه يفحص المنادي الحقيقي بـ _continuity_can_read_conversation).
create or replace function public._continuity_user_can_read_conversation(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(p_user is not null and p_session is not null and coalesce(public._inbox_account_active(p_user), false) and (
       exists (select 1 from public.platform_authority a join public.profiles p on p.id = a.user_id
                where a.user_id = p_user and ((a.level = 'elevated_admin' and p.role = 'admin') or a.level = 'owner'))
    or (public._inbox_is_eligible_agent(p_user) and public._inbox_is_assigned(p_user, p_session))), false);
$$;

create or replace function public._continuity_scope_of(h public.continuity_handovers, p_version int default null)
returns public.continuity_handover_scopes language sql stable security definer set search_path to 'public' as $$
  select * from public.continuity_handover_scopes s
   where s.handover_id = h.id and s.version = coalesce(p_version, h.scope_version);
$$;

-- رسالة داخل النطاق: في القائمة، نشطة، ووقتها الأصلي داخل [من، إلى) لو فيه نطاق زمني.
create or replace function public._continuity_scope_source_ids(sc public.continuity_handover_scopes)
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(s.id order by s.position), '{}')
    from public.continuity_sources s
    left join public.continuity_source_snapshots ss on ss.source_id = s.id
   where s.id = any (sc.source_ids) and s.record_id = sc.record_id
     and s.removed_at is null and s.purged_at is null
     and (sc.range_from is null
          or (ss.original_created_at is not null and ss.original_created_at >= sc.range_from and ss.original_created_at < sc.range_to));
$$;

create or replace function public._continuity_scope_attachment_ids(sc public.continuity_handover_scopes)
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(a.id order by a.created_at), '{}')
    from public.continuity_attachments a
    join public.continuity_records r on r.id = a.record_id
    join public.continuity_workspaces w on w.id = r.workspace_id
   where a.id = any (sc.attachment_ids) and a.record_id = sc.record_id and a.status = 'active'
     and public._continuity_attachments_on()
     and not public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days);
$$;

-- ما يراه المستلم قبل القبول (ومالك السجل لمنحة قائمة): أعداد وأنواع، بلا محتوى ولا أسماء.
create or replace function public._continuity_scope_preview(h public.continuity_handovers, p_version int default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare sc public.continuity_handover_scopes; v_src uuid[]; v_att uuid[];
begin
  sc := public._continuity_scope_of(h, p_version);
  if sc.id is null then return null; end if;
  v_src := public._continuity_scope_source_ids(sc);
  v_att := public._continuity_scope_attachment_ids(sc);
  return jsonb_build_object(
    'version', sc.version, 'status', sc.status, 'actions', to_jsonb(sc.actions), 'editable_fields', to_jsonb(sc.editable_fields),
    'expiry', jsonb_build_object('kind', sc.expiry_kind, 'minutes', sc.duration_minutes, 'until', sc.until_at),
    'range', case when sc.range_from is not null then jsonb_build_object('from', sc.range_from, 'to', sc.range_to, 'tz', sc.range_tz) end,
    'reason', sc.reason,
    'counts', jsonb_build_object(
      'sources', cardinality(v_src),
      'attachments', cardinality(v_att),
      'not_readable', (select count(*) from public.continuity_source_snapshots ss
                        where ss.source_id = any (v_src)
                          and not public._continuity_user_can_read_conversation(h.to_owner, ss.origin_session_id)),
      'attachment_kinds', coalesce((select jsonb_object_agg(k, c) from (select a.kind k, count(*) c from public.continuity_attachments a
                                     where a.id = any (v_att) group by a.kind) x), '{}'::jsonb)));
end $$;

-- الحزمة لطلب معلّق: التسليم الكامل كما 081؛ المراجعة/المشاركة: وصف السجل + معاينة النطاق فقط.
create or replace function public._continuity_handover_package_for(h public.continuity_handovers)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when h.mode = 'transfer' then public._continuity_handover_package(h.record_id)
    else (select jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'priority', r.priority, 'category', r.category,
                                    'due_at', r.due_at, 'due_tz', r.due_tz,
                                    'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
                                    'version', r.version, 'scope', public._continuity_scope_preview(h))
            from public.continuity_records r where r.id = h.record_id) end;
$$;

-- الحقائق «الجوهرية» (§7). البصمة = hash لنصها (jsonb يرتّب المفاتيح).
create or replace function public._continuity_handover_material(h public.continuity_handovers)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'status', r.status, 'owner', r.owner_id, 'team', r.team_id, 'kind', r.kind, 'category', r.category,
    'due', jsonb_build_object('at', r.due_at, 'tz', r.due_tz),
    'scope', case when h.mode = 'transfer' then jsonb_build_object(
                 'sources', (select count(*) from public.continuity_sources s where s.record_id = r.id and s.removed_at is null and s.purged_at is null),
                 'attachments', (select count(*) from public.continuity_attachments a where a.record_id = r.id and a.status = 'active'))
             else (select jsonb_build_object(
                     'sources', coalesce((select jsonb_agg(jsonb_build_array(x, x = any (public._continuity_scope_source_ids(sc))) order by x)
                                          from unnest(sc.source_ids) x), '[]'::jsonb),
                     'attachments', coalesce((select jsonb_agg(jsonb_build_array(x, x = any (public._continuity_scope_attachment_ids(sc))) order by x)
                                              from unnest(sc.attachment_ids) x), '[]'::jsonb))
                     from public.continuity_handover_scopes sc where sc.handover_id = h.id and sc.version = h.scope_version) end)
  from public.continuity_records r where r.id = h.record_id;
$$;

-- الجلسة المربوطة ما زالت قائمة لهذا المستخدم (تسجيل الخروج يحذف الصف ⇒ يتوقف الوصول فورًا).
create or replace function public._continuity_session_alive(p_user uuid, p_session text)
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
begin
  if p_session is null or p_user is null then return false; end if;
  return exists (select 1 from auth.sessions s
                  where s.id::text = p_session and s.user_id = p_user and (s.not_after is null or s.not_after > now()));
exception when others then
  return false;
end $$;

-- هل المنحة فعّالة الآن؟ (§4.1) — بلا افتراض عن المنادي سوى الجلسة لو مربوطة.
create or replace function public._continuity_grant_state(h public.continuity_handovers, p_check_caller_session boolean default true)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare r public.continuity_records; sc public.continuity_handover_scopes; pol public.continuity_policies;
begin
  if h.id is null or h.mode = 'transfer' or h.state <> 'accepted' then return 'inactive'; end if;
  pol := public._continuity_policy_row();
  sc := public._continuity_scope_of(h);
  select * into r from public.continuity_records where id = h.record_id;
  if r.status in ('resolved', 'cancelled') then return 'record_closed'; end if;
  if h.expires_at is null then
    if sc.expiry_kind <> 'ongoing' or not coalesce(pol.delegation_allow_ongoing, false) then return 'policy'; end if;
  elsif h.expires_at <= now() then
    return 'time';
  end if;
  if h.bound_session_id is not null then
    if not public._continuity_session_alive(h.to_owner, h.bound_session_id) then return 'session'; end if;
    if p_check_caller_session and h.bound_session_id is distinct from public._jwt_session_id() then return 'other_session'; end if;
  end if;
  if not public._continuity_is_eligible_owner(h.to_owner) then return 'recipient_ineligible'; end if;
  if not public._continuity_user_can_manage(h.created_by, h.record_id) then return 'grantor_lost_authority'; end if;
  return 'active';
end $$;

-- البوابة الوحيدة (§5.1). أي سبب للرفض ⇒ نفس «غير موجود».
create or replace function public._continuity_active_grant(p_record uuid, p_action text)
returns public.continuity_handovers language plpgsql stable security definer set search_path to 'public' as $$
declare h public.continuity_handovers; sc public.continuity_handover_scopes;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if public._continuity_handovers_on() and not public._continuity_via_api() then
    for h in select * from public.continuity_handovers x
              where x.record_id = p_record and x.to_owner = auth.uid() and x.state = 'accepted' and x.mode <> 'transfer'
              order by x.decided_at desc loop
      if public._continuity_grant_state(h, true) = 'active' then
        sc := public._continuity_scope_of(h);
        if sc.id is not null and p_action = any (sc.actions) then
          return h;
        end if;
      end if;
    end loop;
  end if;
  raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
end $$;

-- رسالة داخل نطاق منحة: نفس قواعد _continuity_source_view (C3، الحجب، الاحتفاظ) مع ترقيم جديد.
-- لا تُستدعى إلا بعد البوابة؛ والمقتطف يحتاج وصول المنادي نفسه للمحادثة الآن.
create or replace function public._continuity_shared_source_view(p_source uuid, p_position int)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  s public.continuity_sources;
  snap public.continuity_source_snapshots;
  r public.continuity_records;
  w public.continuity_workspaces;
  base jsonb;
  m record;
  hidden constant jsonb := '{"excerpt": null, "excerpt_hidden": "no_conversation_access"}';
begin
  select * into s from public.continuity_sources where id = p_source;
  if s.id is null then return null; end if;
  base := jsonb_build_object('id', s.id, 'position', p_position, 'source_type', s.source_type, 'provider', s.provider);
  begin
    select * into r from public.continuity_records where id = s.record_id;
    select * into w from public.continuity_workspaces where id = r.workspace_id;
    select * into snap from public.continuity_source_snapshots where source_id = s.id;
    if w.kind <> 'platform' or s.workspace_id <> r.workspace_id then return base || hidden; end if;
    if s.provider <> 'mad3oom' then
      return base || '{"excerpt": null, "excerpt_hidden": "no_provider_rule"}'::jsonb;
    end if;
    if snap.id is null or snap.workspace_id <> r.workspace_id or snap.record_id <> r.id then return base || hidden; end if;
    if not public._continuity_can_read_conversation(snap.origin_session_id) then return base || hidden; end if;
    base := base || jsonb_build_object('chat_session_id', snap.origin_session_id);
    if snap.redacted_at is not null then
      return base || jsonb_build_object('excerpt', null, 'redacted', jsonb_build_object('at', snap.redacted_at));
    end if;
    if public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days) then
      return base || '{"excerpt": null, "retention_expired": true}'::jsonb;
    end if;
    select cm.deleted_at into m from public.chat_messages cm where cm.id = s.chat_message_id;
    return base || jsonb_build_object(
      'excerpt', snap.excerpt, 'sender_label', snap.sender_label, 'original_created_at', snap.original_created_at,
      'truncated', snap.truncated,
      'source_deleted', (snap.source_deleted_at is not null or s.chat_message_id is null or m.deleted_at is not null));
  exception when others then
    return jsonb_build_object('id', s.id, 'position', p_position, 'source_type', s.source_type, 'provider', s.provider) || hidden;
  end;
end $$;

-- طلب النطاق ⇒ صف نطاق محسوم (بلا معرّفات الطلب). الأخطاء: نفس رموز العقد.
create or replace function public._continuity_scope_resolve(r public.continuity_records, p_scope jsonb, p_mode text)
returns public.continuity_handover_scopes language plpgsql stable security definer set search_path to 'public' as $$
declare
  sc public.continuity_handover_scopes;
  pol public.continuity_policies := public._continuity_policy_row();
  v jsonb; e jsonb; x uuid; v_ids uuid[] := '{}'; v_kind text; v_min int; v_at timestamptz; a text;
begin
  if p_scope is null or jsonb_typeof(p_scope) <> 'object' then perform public._continuity_validation('scope'); end if;
  sc.record_id := r.id;
  sc.workspace_id := r.workspace_id;

  -- الرسائل
  v := p_scope -> 'sources';
  if v is null or v = '"all"'::jsonb then
    select coalesce(array_agg(s.id order by s.position), '{}') into sc.source_ids from public.continuity_sources s
     where s.record_id = r.id and s.removed_at is null and s.purged_at is null;
  elsif jsonb_typeof(v) = 'array' then
    for e in select value from jsonb_array_elements(v) loop
      begin x := (e #>> '{}')::uuid; exception when others then perform public._continuity_validation('scope.sources'); end;
      if not exists (select 1 from public.continuity_sources s where s.id = x and s.record_id = r.id
                      and s.removed_at is null and s.purged_at is null) then
        raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found","field":"scope.sources"}';
      end if;
      if not x = any (v_ids) then v_ids := v_ids || x; end if;
    end loop;
    sc.source_ids := v_ids;
  else
    perform public._continuity_validation('scope.sources');
  end if;

  -- المرفقات
  v_ids := '{}';
  v := p_scope -> 'attachments';
  if v is null or v = '[]'::jsonb or v = 'null'::jsonb then
    sc.attachment_ids := '{}';
  elsif not public._continuity_attachments_on() then
    raise exception 'المرفقات غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled","field":"scope.attachments"}';
  elsif v = '"all"'::jsonb then
    select coalesce(array_agg(a.id order by a.created_at), '{}') into sc.attachment_ids from public.continuity_attachments a
     where a.record_id = r.id and a.status = 'active';
  elsif jsonb_typeof(v) = 'array' then
    for e in select value from jsonb_array_elements(v) loop
      begin x := (e #>> '{}')::uuid; exception when others then perform public._continuity_validation('scope.attachments'); end;
      if not exists (select 1 from public.continuity_attachments a where a.id = x and a.record_id = r.id and a.status = 'active') then
        raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found","field":"scope.attachments"}';
      end if;
      if not x = any (v_ids) then v_ids := v_ids || x; end if;
    end loop;
    sc.attachment_ids := v_ids;
  else
    perform public._continuity_validation('scope.attachments');
  end if;
  if cardinality(sc.source_ids) + cardinality(sc.attachment_ids) = 0 then
    perform public._continuity_validation('scope', 'empty');
  end if;

  -- النطاق الزمني: [من، إلى) بتوقيت محلي في منطقة صريحة
  v := p_scope -> 'range';
  if v is not null and v <> 'null'::jsonb then
    if jsonb_typeof(v) <> 'object' or coalesce(v ->> 'from', '') = '' or coalesce(v ->> 'to', '') = '' or coalesce(v ->> 'tz', '') = '' then
      perform public._continuity_validation('scope.range');
    end if;
    begin
      sc.range_from := public._continuity_local_to_utc((v ->> 'from')::timestamp, v ->> 'tz');
      sc.range_to := public._continuity_local_to_utc((v ->> 'to')::timestamp, v ->> 'tz');
    exception when others then perform public._continuity_validation('scope.range');
    end;
    if sc.range_from is null or sc.range_to is null or sc.range_from >= sc.range_to then
      perform public._continuity_validation('scope.range', 'order');
    end if;
    sc.range_tz := v ->> 'tz';
  end if;

  -- الإجراءات: العرض دائمًا؛ review عرض فقط؛ collab: غير العرض بعد 082b
  sc.actions := array['view'];
  v := p_scope -> 'actions';
  if v is not null and v <> 'null'::jsonb then
    if jsonb_typeof(v) <> 'array' then perform public._continuity_validation('scope.actions'); end if;
    for a in select value from jsonb_array_elements_text(v) loop
      if a not in ('view', 'note', 'propose', 'edit_fields', 'add_source') then perform public._continuity_validation('scope.actions'); end if;
      if a <> 'view' then
        if p_mode = 'review' then perform public._continuity_validation('scope.actions', 'review_is_view_only'); end if;
        raise exception 'إجراءات المشاركة غير مفعّلة بعد' using errcode = '0A000',
          detail = '{"code":"feature_not_enabled","field":"scope.actions"}';
      end if;
    end loop;
  end if;
  sc.editable_fields := '{}';

  -- الانتهاء (S-1/S-2): يبدأ عند القبول
  v := p_scope -> 'expiry';
  v_kind := coalesce(v ->> 'kind', 'duration');
  if v_kind = 'duration' then
    begin v_min := coalesce((v ->> 'minutes')::int, pol.delegation_default_minutes);
    exception when others then perform public._continuity_validation('scope.expiry.minutes'); end;
    if v_min is null or v_min < 1 or v_min > pol.delegation_max_minutes then
      perform public._continuity_validation('scope.expiry.minutes', 'range');
    end if;
    sc.duration_minutes := v_min;
  elsif v_kind = 'session' then
    begin v_min := coalesce((v ->> 'minutes')::int, pol.delegation_session_max_minutes);
    exception when others then perform public._continuity_validation('scope.expiry.minutes'); end;
    if v_min is null or v_min < 1 or v_min > pol.delegation_session_max_minutes then
      perform public._continuity_validation('scope.expiry.minutes', 'range');
    end if;
    sc.duration_minutes := v_min;
  elsif v_kind = 'until' then
    begin
      v_at := public._continuity_local_to_utc((v ->> 'at')::timestamp, v ->> 'tz');
    exception when others then perform public._continuity_validation('scope.expiry.until');
    end;
    if v_at is null or v_at <= now() then perform public._continuity_validation('scope.expiry.until', 'in_past'); end if;
    if v_at > now() + make_interval(mins => pol.delegation_max_minutes) then
      perform public._continuity_validation('scope.expiry.until', 'too_far');
    end if;
    sc.until_at := v_at;
  elsif v_kind = 'ongoing' then
    if not coalesce(pol.delegation_allow_ongoing, false) then
      raise exception 'الوصول المستمر غير مسموح' using errcode = '0A000', detail = '{"code":"feature_not_enabled","field":"scope.expiry"}';
    end if;
  else
    perform public._continuity_validation('scope.expiry.kind');
  end if;
  sc.expiry_kind := v_kind;
  return sc;
end $$;

-- الانتهاء الفعلي عند القبول (أو قبول التوسيع).
create or replace function public._continuity_scope_expires(sc public.continuity_handover_scopes)
returns timestamptz language sql stable set search_path to 'public' as $$
  select case sc.expiry_kind
    when 'duration' then now() + make_interval(mins => sc.duration_minutes)
    when 'session'  then now() + make_interval(mins => sc.duration_minutes)
    when 'until'    then sc.until_at
    else null end;
$$;

-- هل نطاق b أضيق من (أو يساوي) a؟
create or replace function public._continuity_scope_narrower(a public.continuity_handover_scopes, b public.continuity_handover_scopes,
                                                             a_expires timestamptz, b_expires timestamptz)
returns boolean language sql immutable set search_path to 'public' as $$
  select b.source_ids <@ a.source_ids and b.attachment_ids <@ a.attachment_ids and b.actions <@ a.actions
     and (a.range_from is null or (b.range_from is not null and b.range_from >= a.range_from and b.range_to <= a.range_to))
     and (a.expiry_kind = 'session') = (b.expiry_kind = 'session')
     and b.expiry_kind <> 'ongoing'
     and b_expires is not null and (a_expires is null or b_expires <= a_expires);
$$;


-- ============================================================================
-- 6) الطلب (ثمانية معاملات: الوضع والنطاق صريحان)
-- ============================================================================
create or replace function public.continuity_handover_request(
  p_record uuid, p_to_owner uuid, p_reason text, p_context_note text, p_expected_version integer, p_idempotency_key uuid,
  p_mode text, p_scope jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  h public.continuity_handovers;
  sc public.continuity_handover_scopes;
  v_reason text := nullif(btrim(p_reason), '');
  v_note text := nullif(btrim(p_context_note), '');
begin
  if p_mode = 'transfer' then
    -- التسليم الكامل: نفس دالة 081 حرفيًا
    return public.continuity_handover_request(p_record, p_to_owner, p_reason, p_context_note, p_expected_version, p_idempotency_key);
  end if;
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_mode is null or p_mode not in ('review', 'collab') then perform public._continuity_validation('mode'); end if;
  if p_idempotency_key is null then perform public._continuity_validation('idempotency_key'); end if;

  select * into h from public.continuity_handovers where created_by = auth.uid() and idempotency_key = p_idempotency_key;
  if h.id is not null then
    if h.record_id is distinct from p_record or h.to_owner is distinct from p_to_owner or h.mode is distinct from p_mode
       or h.reason is distinct from v_reason or h.context_note is distinct from v_note then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505', detail = '{"code":"idempotency_conflict"}';
    end if;
    if not public.continuity_can_access(h.record_id) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', true);
  end if;

  if v_reason is null or char_length(v_reason) > 1000 then perform public._continuity_validation('reason'); end if;
  if v_note is not null and char_length(v_note) > 4000 then perform public._continuity_validation('context_note'); end if;

  r := public._continuity_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  -- S-4: المالك أو المشرف أو صاحب الإسناد
  if not coalesce(r.owner_id = auth.uid() or public._continuity_can_assign(), false) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
  end if;
  if p_to_owner is null or not public._continuity_is_eligible_owner(p_to_owner) then
    perform public._continuity_validation('to_owner', 'not_eligible');
  end if;
  if p_to_owner = r.owner_id then perform public._continuity_validation('to_owner', 'already_owner'); end if;
  if p_to_owner = auth.uid() then perform public._continuity_validation('to_owner', 'self'); end if;
  if exists (select 1 from public.continuity_handovers x where x.record_id = r.id and x.state = 'pending') then
    raise exception 'فيه طلب تسليم معلّق للسجل ده' using errcode = '55000',
      detail = '{"code":"invalid_transition","reason":"handover_pending"}';
  end if;

  sc := public._continuity_scope_resolve(r, p_scope, p_mode);

  insert into public.continuity_handovers (record_id, workspace_id, from_owner, to_owner, reason, context_note,
                                           record_version_at_request, idempotency_key, created_by, mode, scope_version)
  values (r.id, r.workspace_id, r.owner_id, p_to_owner, v_reason, v_note, r.version + 1, p_idempotency_key, auth.uid(), p_mode, 1)
  returning * into h;
  insert into public.continuity_handover_scopes (handover_id, record_id, workspace_id, version, status, source_ids, attachment_ids,
                                                 range_from, range_to, range_tz, actions, editable_fields, expiry_kind,
                                                 duration_minutes, until_at, reason, created_by)
  values (h.id, r.id, r.workspace_id, 1, 'approved', sc.source_ids, sc.attachment_ids, sc.range_from, sc.range_to, sc.range_tz,
          sc.actions, sc.editable_fields, sc.expiry_kind, sc.duration_minutes, sc.until_at, v_reason, auth.uid());
  update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_requested',
    jsonb_build_object('handover_id', h.id, 'mode', p_mode, 'to_owner', p_to_owner,
                       'scope', jsonb_build_object('sources', cardinality(sc.source_ids), 'attachments', cardinality(sc.attachment_ids),
                                                   'range', sc.range_from is not null, 'expiry', sc.expiry_kind),
                       'fields', jsonb_strip_nulls(jsonb_build_object('reason', public._continuity_hash(v_reason),
                                                                     'context_note', public._continuity_hash(v_note)))));
  return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
end $$;


-- ============================================================================
-- 7) المراجعة والقرار (§7)
-- ============================================================================
create or replace function public.continuity_handover_review(p_handover uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; r public.continuity_records; m jsonb; d text;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.to_owner is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = h.record_id;
  select * into h from public.continuity_handovers where id = p_handover for update;
  if h.state <> 'pending' then
    raise exception 'الطلب لم يعد معلّقًا' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'handover_' || h.state)::text;
  end if;
  m := public._continuity_handover_material(h);
  d := public._continuity_hash(m::text);
  update public.continuity_handovers
     set reviewed_version = r.version, reviewed_digest = d, reviewed_material = m, reviewed_at = now()
   where id = h.id returning * into h;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_reviewed', jsonb_build_object('handover_id', h.id));
  return jsonb_build_object('handover', public._continuity_handover_json(h), 'package', public._continuity_handover_package_for(h),
                            'version', r.version, 'digest', d);
end $$;

-- القرار ببصمة المراجعة (كل الأوضاع). الإصدار القديم بالنسخة يبقى للتسليم الكامل فقط.
create or replace function public.continuity_handover_decide(p_handover uuid, p_decision text, p_note text, p_reviewed_digest text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers;
  r public.continuity_records;
  sc public.continuity_handover_scopes;
  v_note text := nullif(btrim(p_note), '');
  m jsonb;
  v_changed jsonb;
  v_since jsonb;
  v_exp timestamptz;
  v_sess text;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_decision not in ('accept', 'decline') then perform public._continuity_validation('decision'); end if;
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;

  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.to_owner is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = h.record_id for update;
  select * into h from public.continuity_handovers where id = p_handover for update;
  if h.state = 'accepted' and p_decision = 'accept' then
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', true);
  end if;
  if h.state = 'declined' and p_decision = 'decline' then
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', true);
  end if;
  if h.state <> 'pending' then
    raise exception 'الطلب لم يعد معلّقًا' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'handover_' || h.state)::text;
  end if;

  if p_decision = 'decline' then
    if v_note is null then perform public._continuity_validation('note', 'required'); end if;
    update public.continuity_handovers
       set state = 'declined', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     where id = h.id;
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_declined',
      jsonb_build_object('handover_id', h.id, 'mode', h.mode, 'fields', jsonb_build_object('note', public._continuity_hash(v_note))));
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
  end if;

  -- القبول: كل شيء يُعاد فحصه الآن
  if not public._continuity_is_eligible_owner(auth.uid()) then
    perform public._continuity_validation('to_owner', 'not_eligible');
  end if;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if h.reviewed_digest is null or p_reviewed_digest is null then
    raise exception 'راجع الطلب أولًا' using errcode = '40001', detail = '{"code":"version_conflict","reason":"review_required"}';
  end if;
  m := public._continuity_handover_material(h);
  if public._continuity_hash(m::text) <> p_reviewed_digest or p_reviewed_digest <> h.reviewed_digest then
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
      from (select case k when 'scope' then 'scope_items' else k end k from jsonb_object_keys(m) k
             where (m -> k) is distinct from (h.reviewed_material -> k)) x;
    raise exception 'السجل اتغيّر تغييرًا جوهريًا بعد مراجعتك' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'reason', 'material_change', 'kinds', v_changed)::text;
  end if;
  if not public._continuity_user_can_manage(h.created_by, r.id) then
    update public.continuity_handovers
       set state = 'cancelled', cancel_cause = 'requester_lost_authority', decided_by = auth.uid(), decided_at = now()
     where id = h.id;
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_cancelled',
      jsonb_build_object('handover_id', h.id, 'cause', 'requester_lost_authority'));
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false, 'accepted', false);
  end if;
  -- الحقول العادية التي تغيّرت بعد المراجعة (أسماء فقط)
  select coalesce(jsonb_agg(distinct f), '[]'::jsonb) into v_since
    from public.continuity_events e, jsonb_array_elements_text(coalesce(e.payload -> 'changed', '[]'::jsonb)) f
   where e.record_id = r.id and e.kind = 'updated'
     and e.id > coalesce((select max(x.id) from public.continuity_events x
                           where x.record_id = r.id and x.kind = 'handover_reviewed' and x.payload ->> 'handover_id' = h.id::text), 0);

  if h.mode = 'transfer' then
    update public.continuity_handovers
       set state = 'accepted', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     where id = h.id;
    update public.continuity_records set owner_id = auth.uid(), version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_accepted',
      jsonb_build_object('handover_id', h.id, 'mode', 'transfer', 'from_owner', r.owner_id, 'to_owner', auth.uid(),
                         'fields', jsonb_strip_nulls(jsonb_build_object('note', public._continuity_hash(v_note)))));
  else
    sc := public._continuity_scope_of(h);
    if sc.expiry_kind = 'ongoing' and not coalesce((public._continuity_policy_row()).delegation_allow_ongoing, false) then
      raise exception 'الوصول المستمر غير مسموح' using errcode = '0A000', detail = '{"code":"feature_not_enabled","field":"scope.expiry"}';
    end if;
    if sc.expiry_kind = 'until' and sc.until_at <= now() then
      perform public._continuity_validation('scope.expiry.until', 'in_past');
    end if;
    if sc.expiry_kind = 'session' then
      v_sess := public._jwt_session_id();
      if v_sess is null or not public._continuity_session_alive(auth.uid(), v_sess) then
        perform public._continuity_validation('session', 'required');
      end if;
    end if;
    v_exp := public._continuity_scope_expires(sc);
    update public.continuity_handovers
       set state = 'accepted', decided_by = auth.uid(), decided_at = now(), decision_note = v_note,
           expires_at = v_exp, bound_session_id = v_sess
     where id = h.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_accepted',
      jsonb_build_object('handover_id', h.id, 'mode', h.mode, 'expires_at', v_exp, 'session_bound', v_sess is not null,
                         'fields', jsonb_strip_nulls(jsonb_build_object('note', public._continuity_hash(v_note)))));
  end if;
  return public._continuity_handover_result(h.id)
         || jsonb_build_object('replayed', false, 'accepted', true, 'changed_since_review', v_since);
end $$;


-- ============================================================================
-- 8) السحب، وتعديل النطاق، والرد على التوسيع (§6، §8)
-- ============================================================================
-- من يدير منحة قائمة: مانحها، أو مالك السجل، أو مشرف/صاحب إسناد يرى السجل. يرجع السبب أو null.
create or replace function public._continuity_grant_manager_cause(h public.continuity_handovers)
returns text language sql stable security definer set search_path to 'public' as $$
  select case
    when not public.continuity_can_access(h.record_id) then null
    when h.created_by = auth.uid() then 'grantor'
    when exists (select 1 from public.continuity_records r where r.id = h.record_id and r.owner_id = auth.uid()) then 'owner'
    when public._continuity_can_assign() then 'supervisor'
  end;
$$;

create or replace function public.continuity_handover_revoke(p_handover uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; r public.continuity_records; v_cause text; v_note text := nullif(btrim(p_note), '');
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.mode = 'transfer' then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_cause := public._continuity_grant_manager_cause(h);
  if v_cause is null then
    if public.continuity_can_access(h.record_id) then
      raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
    end if;
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = h.record_id for update;
  select * into h from public.continuity_handovers where id = p_handover for update;
  if h.state = 'revoked' then
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', true);
  end if;
  if h.state <> 'accepted' then
    raise exception 'المنحة غير قائمة' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'handover_' || h.state)::text;
  end if;
  update public.continuity_handovers
     set state = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_cause = v_cause
   where id = h.id;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_revoked',
    jsonb_build_object('handover_id', h.id, 'cause', v_cause,
                       'fields', jsonb_strip_nulls(jsonb_build_object('note', public._continuity_hash(v_note)))));
  return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
end $$;

-- التضييق فوري (نسخة معتمدة جديدة). التوسيع أو الخليط: التقاطع يُطبَّق فورًا، والكامل نسخة مقترحة.
create or replace function public.continuity_handover_amend_scope(p_handover uuid, p_scope jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers; r public.continuity_records;
  cur public.continuity_handover_scopes; want public.continuity_handover_scopes; mid public.continuity_handover_scopes;
  v_cause text; v_want_exp timestamptz; v_mid_exp timestamptz; v_next int; v_result text;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.mode = 'transfer' then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_cause := public._continuity_grant_manager_cause(h);
  if v_cause is null then
    if public.continuity_can_access(h.record_id) then
      raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
    end if;
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = h.record_id for update;
  select * into h from public.continuity_handovers where id = p_handover for update;
  if h.state <> 'accepted' or public._continuity_grant_state(h, false) <> 'active' then
    raise exception 'المنحة غير قائمة' using errcode = '55000', detail = '{"code":"invalid_transition","reason":"grant_inactive"}';
  end if;
  cur := public._continuity_scope_of(h);
  want := public._continuity_scope_resolve(r, p_scope, h.mode);
  v_want_exp := public._continuity_scope_expires(want);
  select coalesce(max(version), 0) + 1 into v_next from public.continuity_handover_scopes where handover_id = h.id;

  if public._continuity_scope_narrower(cur, want, h.expires_at, v_want_exp) then
    update public.continuity_handover_scopes set status = 'superseded', decided_at = now() where handover_id = h.id and status in ('approved', 'proposed');
    insert into public.continuity_handover_scopes (handover_id, record_id, workspace_id, version, status, source_ids, attachment_ids,
                                                   range_from, range_to, range_tz, actions, editable_fields, expiry_kind,
                                                   duration_minutes, until_at, reason, created_by, decided_at)
    values (h.id, r.id, r.workspace_id, v_next, 'approved', want.source_ids, want.attachment_ids, want.range_from, want.range_to,
            want.range_tz, want.actions, want.editable_fields, want.expiry_kind, want.duration_minutes, want.until_at,
            cur.reason, auth.uid(), now());
    update public.continuity_handovers set scope_version = v_next, expires_at = least(coalesce(h.expires_at, v_want_exp), v_want_exp)
     where id = h.id;
    v_result := 'narrowed';
    perform public._continuity_log(r.id, r.workspace_id, 'handover_scope_narrowed',
      jsonb_build_object('handover_id', h.id, 'version', v_next, 'by', v_cause));
  else
    -- التقاطع فورًا (إن ضيّق شيئًا)
    mid := cur;
    mid.source_ids := array(select x from unnest(cur.source_ids) x where x = any (want.source_ids));
    mid.attachment_ids := array(select x from unnest(cur.attachment_ids) x where x = any (want.attachment_ids));
    mid.actions := array(select x from unnest(cur.actions) x where x = any (want.actions));
    if want.range_from is not null then
      mid.range_from := greatest(coalesce(cur.range_from, want.range_from), want.range_from);
      mid.range_to := least(coalesce(cur.range_to, want.range_to), want.range_to);
      mid.range_tz := want.range_tz;
    end if;
    v_mid_exp := least(coalesce(h.expires_at, v_want_exp), coalesce(v_want_exp, h.expires_at));
    update public.continuity_handover_scopes set status = 'superseded', decided_at = now() where handover_id = h.id and status = 'proposed';
    if (mid.source_ids <> cur.source_ids or mid.attachment_ids <> cur.attachment_ids or mid.actions <> cur.actions
        or mid.range_from is distinct from cur.range_from or mid.range_to is distinct from cur.range_to
        or v_mid_exp is distinct from h.expires_at)
       and cardinality(mid.source_ids) + cardinality(mid.attachment_ids) >= 1
       and (mid.range_from is null or mid.range_from < mid.range_to) then
      update public.continuity_handover_scopes set status = 'superseded', decided_at = now() where handover_id = h.id and status = 'approved';
      insert into public.continuity_handover_scopes (handover_id, record_id, workspace_id, version, status, source_ids, attachment_ids,
                                                     range_from, range_to, range_tz, actions, editable_fields, expiry_kind,
                                                     duration_minutes, until_at, reason, created_by, decided_at)
      values (h.id, r.id, r.workspace_id, v_next, 'approved', mid.source_ids, mid.attachment_ids, mid.range_from, mid.range_to,
              mid.range_tz, mid.actions, mid.editable_fields, cur.expiry_kind, cur.duration_minutes, cur.until_at,
              cur.reason, auth.uid(), now());
      update public.continuity_handovers set scope_version = v_next, expires_at = v_mid_exp where id = h.id;
      perform public._continuity_log(r.id, r.workspace_id, 'handover_scope_narrowed',
        jsonb_build_object('handover_id', h.id, 'version', v_next, 'by', v_cause, 'partial', true));
      v_next := v_next + 1;
    end if;
    insert into public.continuity_handover_scopes (handover_id, record_id, workspace_id, version, status, source_ids, attachment_ids,
                                                   range_from, range_to, range_tz, actions, editable_fields, expiry_kind,
                                                   duration_minutes, until_at, reason, created_by)
    values (h.id, r.id, r.workspace_id, v_next, 'proposed', want.source_ids, want.attachment_ids, want.range_from, want.range_to,
            want.range_tz, want.actions, want.editable_fields, want.expiry_kind, want.duration_minutes, want.until_at,
            cur.reason, auth.uid());
    v_result := 'proposed';
    perform public._continuity_log(r.id, r.workspace_id, 'handover_scope_proposed',
      jsonb_build_object('handover_id', h.id, 'version', v_next, 'by', v_cause));
  end if;
  return public._continuity_handover_result(h.id) || jsonb_build_object('scope_change', v_result);
end $$;

create or replace function public.continuity_handover_respond_scope(p_handover uuid, p_version int, p_accept boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; r public.continuity_records; sc public.continuity_handover_scopes; v_sess text; v_exp timestamptz;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.mode = 'transfer' or h.to_owner is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = h.record_id for update;
  select * into h from public.continuity_handovers where id = p_handover for update;
  select * into sc from public.continuity_handover_scopes where handover_id = h.id and version = p_version for update;
  if h.state <> 'accepted' or public._continuity_grant_state(h, true) <> 'active' or sc.id is null or sc.status <> 'proposed' then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if coalesce(p_accept, false) then
    if sc.expiry_kind = 'ongoing' and not coalesce((public._continuity_policy_row()).delegation_allow_ongoing, false) then
      raise exception 'الوصول المستمر غير مسموح' using errcode = '0A000', detail = '{"code":"feature_not_enabled","field":"scope.expiry"}';
    end if;
    if sc.expiry_kind = 'until' and sc.until_at <= now() then perform public._continuity_validation('scope.expiry.until', 'in_past'); end if;
    v_sess := h.bound_session_id;
    if sc.expiry_kind = 'session' then
      v_sess := public._jwt_session_id();
      if v_sess is null or not public._continuity_session_alive(auth.uid(), v_sess) then
        perform public._continuity_validation('session', 'required');
      end if;
    elsif sc.expiry_kind <> 'session' then
      v_sess := null;
    end if;
    v_exp := public._continuity_scope_expires(sc);
    update public.continuity_handover_scopes set status = 'superseded', decided_at = now() where handover_id = h.id and status = 'approved';
    update public.continuity_handover_scopes set status = 'approved', decided_at = now() where id = sc.id;
    update public.continuity_handovers set scope_version = sc.version, expires_at = v_exp, bound_session_id = v_sess where id = h.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_scope_accepted', jsonb_build_object('handover_id', h.id, 'version', sc.version));
  else
    update public.continuity_handover_scopes set status = 'rejected', decided_at = now() where id = sc.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_scope_rejected', jsonb_build_object('handover_id', h.id, 'version', sc.version));
  end if;
  return public.continuity_shared_with_me();
end $$;


-- ============================================================================
-- 9) القراءة المشتركة (§5.2) والمرفقات (§5.3)
-- ============================================================================
create or replace function public.continuity_shared_get(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare h public.continuity_handovers; sc public.continuity_handover_scopes; r public.continuity_records; v_src uuid[]; v_att uuid[];
begin
  h := public._continuity_active_grant(p_record, 'view');
  sc := public._continuity_scope_of(h);
  select * into r from public.continuity_records where id = p_record;
  v_src := public._continuity_scope_source_ids(sc);
  v_att := public._continuity_scope_attachment_ids(sc);
  return jsonb_build_object(
    'record', jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary, 'problem', r.problem,
                                 'next_action', r.next_action, 'status', r.status, 'priority', r.priority, 'category', r.category,
                                 'due_at', r.due_at, 'due_tz', r.due_tz,
                                 'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
                                 'version', r.version),
    'sources', coalesce((select jsonb_agg(public._continuity_shared_source_view(x, n::int) order by n)
                           from unnest(v_src) with ordinality u(x, n)), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime,
                                                                 'size', coalesce(a.size_bytes, a.declared_size), 'name', a.display_name,
                                                                 'created_at', a.created_at) order by a.created_at)
                               from public.continuity_attachments a where a.id = any (v_att)), '[]'::jsonb),
    'grant', jsonb_build_object('handover_id', h.id, 'mode', h.mode, 'actions', to_jsonb(sc.actions), 'expires_at', h.expires_at,
                                'session_bound', h.bound_session_id is not null, 'reason', sc.reason, 'granted_by', h.created_by,
                                'scope_version', sc.version,
                                'range', case when sc.range_from is not null then jsonb_build_object('from', sc.range_from, 'to', sc.range_to, 'tz', sc.range_tz) end));
end $$;

create or replace function public.continuity_shared_with_me()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  return jsonb_build_object(
    'active', coalesce((select jsonb_agg(jsonb_build_object(
                          'handover_id', h.id, 'record_id', h.record_id, 'title', r.title, 'kind', r.kind, 'mode', h.mode,
                          'actions', to_jsonb(sc.actions), 'expires_at', h.expires_at, 'session_bound', h.bound_session_id is not null,
                          'granted_by', h.created_by, 'reason', sc.reason, 'scope_version', sc.version) order by h.expires_at nulls last)
                          from public.continuity_handovers h
                          join public.continuity_records r on r.id = h.record_id
                          join public.continuity_handover_scopes sc on sc.handover_id = h.id and sc.version = h.scope_version
                         where h.to_owner = auth.uid() and h.state = 'accepted' and h.mode <> 'transfer'
                           and public._continuity_grant_state(h, true) = 'active'), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(jsonb_build_object('handover_id', h.id, 'record_id', h.record_id, 'title', r.title,
                                                               'current', public._continuity_scope_preview(h),
                                                               'proposed', public._continuity_scope_preview(h, p.version))
                                            order by p.created_at)
                             from public.continuity_handovers h
                             join public.continuity_records r on r.id = h.record_id
                             join public.continuity_handover_scopes p on p.handover_id = h.id and p.status = 'proposed'
                            where h.to_owner = auth.uid() and h.state = 'accepted' and h.mode <> 'transfer'
                              and public._continuity_grant_state(h, true) = 'active'), '[]'::jsonb));
end $$;

-- للدالة الطرفية فقط (تُنادى بهوية المستخدم): المسار والنوع والمدة لتوقيع داخلي قصير. أي رفض ⇒ «غير موجود».
create or replace function public.continuity_shared_attachment_check(p_attachment uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare a public.continuity_attachments; h public.continuity_handovers; sc public.continuity_handover_scopes; v_ttl int;
begin
  select * into a from public.continuity_attachments where id = p_attachment;
  if a.id is null then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  h := public._continuity_active_grant(a.record_id, 'view');
  sc := public._continuity_scope_of(h);
  if not (a.id = any (public._continuity_scope_attachment_ids(sc))) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_ttl := case when h.expires_at is null then 60 else least(60, floor(extract(epoch from (h.expires_at - now())))::int) end;
  if v_ttl < 1 then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object('path', a.storage_path, 'mime', a.mime, 'name', a.display_name,
                            'size', coalesce(a.size_bytes, a.declared_size), 'ttl', v_ttl);
end $$;

-- للمانح فقط: هل سيرى المستلم مقتطف كل رسالة؟ قيم منطقية فقط (§11.1).
create or replace function public.continuity_handover_preview_recipient(p_record uuid, p_recipient uuid, p_source_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r public.continuity_records;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = p_record;
  if not coalesce(r.owner_id = auth.uid() or public._continuity_can_assign(), false) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
  end if;
  if p_recipient is null or not public._continuity_is_eligible_owner(p_recipient) then
    perform public._continuity_validation('to_owner', 'not_eligible');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('source_id', s.id,
                     'visible', public._continuity_user_can_read_conversation(p_recipient, ss.origin_session_id)) order by s.position)
                     from public.continuity_sources s
                     join public.continuity_source_snapshots ss on ss.source_id = s.id
                    where s.record_id = p_record and s.id = any (coalesce(p_source_ids, '{}'))
                      and s.removed_at is null and s.purged_at is null), '[]'::jsonb);
end $$;

-- نطاق منحة لمن يديرها أو يرى السجل (لتاريخ التسليم والتعديل): المعتمد والمقترح.
create or replace function public.continuity_handover_scope(p_handover uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare h public.continuity_handovers;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or h.mode = 'transfer' or not public.continuity_can_access(h.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object(
    'handover', public._continuity_handover_json(h),
    'state', public._continuity_grant_state(h, false),
    'can_manage', public._continuity_grant_manager_cause(h) is not null,
    'scopes', coalesce((select jsonb_agg(jsonb_build_object(
                'version', s.version, 'status', s.status, 'source_ids', to_jsonb(s.source_ids), 'attachment_ids', to_jsonb(s.attachment_ids),
                'range', case when s.range_from is not null then jsonb_build_object('from', s.range_from, 'to', s.range_to, 'tz', s.range_tz) end,
                'actions', to_jsonb(s.actions), 'expiry', jsonb_build_object('kind', s.expiry_kind, 'minutes', s.duration_minutes, 'until', s.until_at),
                'created_at', s.created_at, 'decided_at', s.decided_at) order by s.version)
                from public.continuity_handover_scopes s where s.handover_id = h.id), '[]'::jsonb));
end $$;


-- ============================================================================
-- 10) دورة الحياة: الإسناد أو الإغلاق يسحب المنح (S-4)، والكنس يجسّد الانتهاء
-- ============================================================================
create or replace function public._continuity_grant_on_record_change()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_cause text; h record;
begin
  if new.status in ('resolved', 'cancelled') and old.status not in ('resolved', 'cancelled') then
    v_cause := 'record_closed';
  elsif new.owner_id is distinct from old.owner_id or new.team_id is distinct from old.team_id then
    v_cause := 'reassigned';
  else
    return null;
  end if;
  for h in select id from public.continuity_handovers
            where record_id = new.id and state = 'accepted' and mode <> 'transfer' for update loop
    update public.continuity_handovers
       set state = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_cause = v_cause
     where id = h.id;
    insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
    values (new.id, new.workspace_id, auth.uid(), coalesce(public._continuity_client(), 'native'), 'handover_revoked',
            jsonb_build_object('handover_id', h.id, 'cause', v_cause));
  end loop;
  return null;
end $$;

drop trigger if exists trg_continuity_grant_on_record on public.continuity_records;
create trigger trg_continuity_grant_on_record after update of owner_id, team_id, status on public.continuity_records
  for each row execute function public._continuity_grant_on_record_change();

-- كل ساعة: يجسّد ما انتهى (الوقت، الجلسة، السياسة، الأهلية، السلطة). الوصول يتوقف قبله في البوابة.
create or replace function public.continuity_grant_sweep()
returns int language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; v_state text; n int := 0;
begin
  for h in select * from public.continuity_handovers
            where state = 'accepted' and mode <> 'transfer' for update skip locked loop
    v_state := public._continuity_grant_state(h, false);
    if v_state = 'active' then continue; end if;
    if v_state in ('time', 'session') then
      update public.continuity_handovers set state = 'expired', cancel_cause = v_state where id = h.id;
      insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
      values (h.record_id, h.workspace_id, null, 'cron', 'handover_expired', jsonb_build_object('handover_id', h.id, 'cause', v_state));
    else
      update public.continuity_handovers
         set state = 'revoked', revoked_at = now(), revoke_cause = case v_state when 'record_closed' then 'record_closed'
                                                                             when 'recipient_ineligible' then 'recipient_ineligible'
                                                                             when 'grantor_lost_authority' then 'grantor_lost_authority'
                                                                             else 'policy' end
       where id = h.id;
      insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
      values (h.record_id, h.workspace_id, null, 'cron', 'handover_revoked', jsonb_build_object('handover_id', h.id, 'cause', v_state));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-grant-sweep';
    perform cron.schedule('continuity-grant-sweep', '37 * * * *', 'select public.continuity_grant_sweep()');
  end if;
end $$;


-- ============================================================================
-- 11) ترقيع دوال 078/081 بسطر واحد (نص الإنتاج بالضبط)
-- ============================================================================
do $patch$
declare p record; v_def text; v_hits int;
begin
  for p in select * from (values
    -- القرار القديم بالنسخة: التسليم الكامل فقط
    ('public.continuity_handover_decide(uuid,text,text,integer)', '2b9abbfecccbc43012330d99a563256c',
     E'      detail = jsonb_build_object(''code'', ''invalid_transition'', ''reason'', ''handover_'' || h.state)::text;\n  end if;\n',
     E'      detail = jsonb_build_object(''code'', ''invalid_transition'', ''reason'', ''handover_'' || h.state)::text;\n  end if;\n'
     || E'  if h.mode <> ''transfer'' then raise exception ''استخدم مراجعة الطلب'' using errcode = ''0A000'', detail = ''{"code":"feature_not_enabled","field":"decision"}''; end if; -- 091_continuity_scoped_handover\n'),
    -- الحارس: القواعد الجديدة أولًا
    ('public._continuity_guard_handover()', '9495867c0549803319815a9018e7fd31',
     E'    raise exception ''طلبات التسليم لا تُحذف'' using errcode = ''42501'';\n  end if;\n',
     E'    raise exception ''طلبات التسليم لا تُحذف'' using errcode = ''42501'';\n  end if;\n'
     || E'  if public._continuity_guard_grant(old, new) then return new; end if; -- 091_continuity_scoped_handover\n'),
    -- JSON الطلب: الوضع والانتهاء والسحب
    ('public._continuity_handover_json(public.continuity_handovers)', '380c3b9637a45f14c1d689079a88670b',
     E'''created_by'', h.created_by, ''created_at'', h.created_at',
     E'''created_by'', h.created_by, ''created_at'', h.created_at, ''mode'', h.mode, ''scope_version'', h.scope_version, '
     || E'''expires_at'', h.expires_at, ''session_bound'', h.bound_session_id is not null, ''revoked_at'', h.revoked_at, '
     || E'''revoked_by'', h.revoked_by, ''revoke_cause'', h.revoke_cause /* 091_continuity_scoped_handover */'),
    -- الحزمة حسب الوضع
    ('public._continuity_handover_result(uuid)', '8e6b6caf332763aba1cd26c171563ecc',
     'public._continuity_handover_package(h.record_id)',
     'public._continuity_handover_package_for(h) /* 091_continuity_scoped_handover */'),
    ('public.continuity_handovers_mine()', '45fe064e8742aaa5fc4c44aa8457ac1c',
     'public._continuity_handover_package(h.record_id)',
     'public._continuity_handover_package_for(h) /* 091_continuity_scoped_handover */'),
    -- السياسة: مدد التفويض
    ('public.continuity_set_policies(jsonb,integer)', 'dbc054543efacebd576acb336be59609',
     E'''due_alert'', ''respect_working_hours''];',
     E'''due_alert'', ''respect_working_hours'', ''delegation_allow_ongoing'' /* 091_continuity_scoped_handover */];'),
    ('public.continuity_set_policies(jsonb,integer)', 'x-chained',
     E'''stale_after_days'', ''postpone_flag_count''];',
     E'''stale_after_days'', ''postpone_flag_count'', ''delegation_default_minutes'', ''delegation_max_minutes'', '
     || E'''delegation_session_max_minutes'' /* 091_continuity_scoped_handover */];'),
    ('public.continuity_set_policies(jsonb,integer)', 'x-chained',
     E'postpone_flag_count = n.postpone_flag_count,',
     E'postpone_flag_count = n.postpone_flag_count, delegation_default_minutes = n.delegation_default_minutes, '
     || E'delegation_max_minutes = n.delegation_max_minutes, delegation_session_max_minutes = n.delegation_session_max_minutes, '
     || E'delegation_allow_ongoing = n.delegation_allow_ongoing /* 091_continuity_scoped_handover */,')
  ) as x(fn, md5_before, anchor, replacement) loop
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, p.replacement) > 0 then continue; end if;  -- مُرقَّعة من تشغيل سابق
    if p.md5_before <> 'x-chained' and md5(v_def) <> p.md5_before then
      raise exception '091: نص % لا يطابق الإنتاج (md5 %)، لن يُرقَّع', p.fn, md5(v_def);
    end if;
    v_hits := (length(v_def) - length(replace(v_def, p.anchor, ''))) / length(p.anchor);
    if v_hits <> 1 then raise exception '091: الارتكاز في % ظهر % مرة', p.fn, v_hits; end if;
    execute replace(v_def, p.anchor, p.replacement);
  end loop;
end $patch$;

-- بعد الترقيع: عكس كل استبدال يعيد بصمة الإنتاج (يُثبت أن لا شيء آخر تغيّر)
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.continuity_set_policies(jsonb,integer)'::regprocedure);
  v_def := replace(v_def, E'''due_alert'', ''respect_working_hours'', ''delegation_allow_ongoing'' /* 091_continuity_scoped_handover */];',
                          E'''due_alert'', ''respect_working_hours''];');
  v_def := replace(v_def, E'''stale_after_days'', ''postpone_flag_count'', ''delegation_default_minutes'', ''delegation_max_minutes'', '
                          || E'''delegation_session_max_minutes'' /* 091_continuity_scoped_handover */];',
                          E'''stale_after_days'', ''postpone_flag_count''];');
  v_def := replace(v_def, E'postpone_flag_count = n.postpone_flag_count, delegation_default_minutes = n.delegation_default_minutes, '
                          || E'delegation_max_minutes = n.delegation_max_minutes, delegation_session_max_minutes = n.delegation_session_max_minutes, '
                          || E'delegation_allow_ongoing = n.delegation_allow_ongoing /* 091_continuity_scoped_handover */,',
                          E'postpone_flag_count = n.postpone_flag_count,');
  if md5(v_def) <> 'dbc054543efacebd576acb336be59609' then
    raise exception '091: ترقيع continuity_set_policies غيّر أكثر من المقصود';
  end if;
end $$;


-- ============================================================================
-- 12) علامة 082a والصلاحيات
-- ============================================================================
create or replace function public._continuity_capability_scoped_handover()
returns boolean language sql immutable set search_path to 'public' as $$ select true $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_guard_scope()', 'public._continuity_scope_same_record()',
    'public._continuity_guard_grant(public.continuity_handovers, public.continuity_handovers)',
    'public._continuity_policy_row()', 'public._continuity_user_can_read_conversation(uuid, uuid)',
    'public._continuity_scope_of(public.continuity_handovers, integer)',
    'public._continuity_scope_source_ids(public.continuity_handover_scopes)',
    'public._continuity_scope_attachment_ids(public.continuity_handover_scopes)',
    'public._continuity_scope_preview(public.continuity_handovers, integer)',
    'public._continuity_handover_package_for(public.continuity_handovers)',
    'public._continuity_handover_material(public.continuity_handovers)',
    'public._continuity_session_alive(uuid, text)', 'public._continuity_grant_state(public.continuity_handovers, boolean)',
    'public._continuity_active_grant(uuid, text)', 'public._continuity_shared_source_view(uuid, integer)',
    'public._continuity_scope_resolve(public.continuity_records, jsonb, text)',
    'public._continuity_scope_expires(public.continuity_handover_scopes)',
    'public._continuity_scope_narrower(public.continuity_handover_scopes, public.continuity_handover_scopes, timestamptz, timestamptz)',
    'public._continuity_grant_manager_cause(public.continuity_handovers)',
    'public._continuity_grant_on_record_change()', 'public.continuity_grant_sweep()',
    'public._continuity_capability_scoped_handover()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array array[
    'public.continuity_handover_request(uuid, uuid, text, text, integer, uuid, text, jsonb)',
    'public.continuity_handover_review(uuid)', 'public.continuity_handover_decide(uuid, text, text, text)',
    'public.continuity_handover_revoke(uuid, text)', 'public.continuity_handover_amend_scope(uuid, jsonb)',
    'public.continuity_handover_respond_scope(uuid, integer, boolean)', 'public.continuity_shared_get(uuid)',
    'public.continuity_shared_with_me()', 'public.continuity_shared_attachment_check(uuid)',
    'public.continuity_handover_preview_recipient(uuid, uuid, uuid[])', 'public.continuity_handover_scope(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 13) التحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_handovers', 'continuity_handover_scopes'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '091: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '091: صلاحية مباشرة على %', t;
    end if;
  end loop;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'continuity\_%') then
    raise exception '091: جدول continuity_* في supabase_realtime';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '091: دالة متاحة لـ anon';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '091: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and strpos(pg_get_functiondef(p.oid), '091_continuity_scoped_handover') > 0) <> 6 then
    raise exception '091: الترقيعات الست غير مكتملة';
  end if;
  if (select count(*) from storage.objects o where false) is null then null; end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and (qual like '%continuity%' or with_check like '%continuity%')) <> 1 then
    raise exception '091: سياسات مستودع المرفقات تغيّرت';
  end if;
  raise notice '091: التسليم المحدود مثبت (القدرة handovers تحكمه)';
end $$;
