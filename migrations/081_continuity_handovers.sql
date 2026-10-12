-- ============================================================================
-- 081_continuity_handovers.sql
--   مدعوم — الاستمرارية: تسليم السجل بين الموظفين بقبول المستلم
--   (docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md §5.2، §6.1، §14.3 — قرار H1 بضوابطه)
--
-- القرار H1 (2026-10-12) بضوابطه:
--   • يطلب التسليم: المالك الحالي، أو المشرف، أو صاحب صلاحية الإسناد — بشرط أن يرى السجل
--     الآن وأن يكون السجل نشطًا. السجل بلا مالك: المشرف أو صاحب الإسناد فقط.
--   • المستلم مؤهل ونشط (نفس شرط P3/P4) ومختلف عن المالك الحالي. الفريق لا يتغير أبدًا.
--   • الطلب المعلّق **لا يمنح أي وصول**: continuity_can_access كما هو. المستلم يقرأ «حزمة»
--     للقراءة فقط عبر continuity_handover_get: الحقول الوصفية + عدد المصادر والمرفقات،
--     بلا أي مقتطف أو مسار ملف.
--   • المالك يظل مسؤولًا حتى ينجح القبول. الملكية تتغير **فقط** داخل القبول، الذي يعيد
--     التحقق في نفس المعاملة: المستلم هو المستدعي ومؤهل، السجل نشط، النسخة هي التي رآها،
--     وصاحب الطلب ما زال المالك أو مشرفًا أو صاحب إسناد (وإلا يُلغى بـ requester_lost_authority).
--   • الرفض والإلغاء والانتهاء والقبول الفاشل لا تغيّر الملكية أبدًا.
--   • طلب معلّق واحد لكل سجل (فهرس فريد جزئي). الإسناد المباشر أو إغلاق السجل يلغيان الطلب
--     المعلّق في نفس المعاملة (محفّز على السجل؛ continuity_assign و continuity_transition بلا تعديل).
--   • الإسناد المباشر خارج التسليم يظل للمشرفين وأصحاب الإسناد (continuity_assign بلا تعديل).
--
-- تعديل على المقترح (موثّق): §14.3 يقارن النسخة المخزنة وقت الطلب؛ هنا القبول يأخذ النسخة
--   التي رآها المستلم (p_expected_version) فأي تعديل بعد ما رآه يُرجع 40001 ويعيد القراءة.
--   المقارنة بنسخة الطلب كانت ستجعل أي تعديل بسيط من المالك يمنع القبول نهائيًا.
--
-- الانتهاء (expired) لا يحدث بالوقت (R2): يُستخدم لاحقًا حين يصبح المستلم غير مؤهل (المجدول).
-- الإشعارات (تذكير 60 / تصعيد 240، D4) في مرحلة المجدول، لا هنا.
--
-- مفتاح الإيقاف: handovers_enabled (078، مطفأ). مطفأ ⇒ لا طلب ولا قرار ولا قراءة؛ الإلغاء
--   يبقى متاحًا للتنظيف، وإغلاق السجل أو إسناده يلغي المعلّق دائمًا.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/081_continuity_handovers.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات (080)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_capability_attachments()', 'public._continuity_lock_for_write(uuid, integer)',
    'public._continuity_log(uuid, uuid, text, jsonb, text)', 'public._continuity_validation(text, text)',
    'public._continuity_is_eligible_owner(uuid)', 'public._continuity_has_assigner_grant(uuid)',
    'public._continuity_can_assign()', 'public._continuity_hash(text)', 'public._continuity_guard_append_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '081 يتطلب 080 (%)', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) الجدول
-- ============================================================================
create table if not exists public.continuity_handovers (
  id                    uuid primary key default gen_random_uuid(),
  record_id             uuid not null references public.continuity_records(id),
  workspace_id          uuid not null references public.continuity_workspaces(id),
  from_owner            uuid references public.profiles(id) on delete set null,
  to_owner              uuid references public.profiles(id) on delete set null,
  reason                text not null check (char_length(reason) between 1 and 1000),
  context_note          text check (char_length(context_note) <= 4000),
  record_version_at_request int not null,
  state                 text not null default 'pending'
                        check (state in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  decided_by            uuid references public.profiles(id) on delete set null,
  decided_at            timestamptz,
  decision_note         text check (char_length(decision_note) <= 1000),
  cancel_cause          text check (cancel_cause in ('initiator', 'reassigned', 'record_closed', 'target_ineligible',
                                                     'supervisor', 'requester_lost_authority')),
  idempotency_key       uuid not null,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  constraint continuity_handovers_idem unique (created_by, idempotency_key),
  constraint continuity_handovers_state check (
    case state
      when 'pending'   then decided_at is null and decision_note is null and cancel_cause is null
      when 'accepted'  then decided_at is not null and cancel_cause is null
      when 'declined'  then decided_at is not null and decision_note is not null and cancel_cause is null
      when 'cancelled' then decided_at is not null and cancel_cause is not null
      when 'expired'   then decided_at is not null and cancel_cause = 'target_ineligible'
    end)
);
create unique index if not exists continuity_handovers_one_pending on public.continuity_handovers (record_id) where state = 'pending';
create index if not exists continuity_handovers_to_pending on public.continuity_handovers (to_owner) where state = 'pending';
create index if not exists continuity_handovers_record on public.continuity_handovers (record_id, created_at desc);

comment on table public.continuity_handovers is
  'الاستمرارية (081). طلبات تسليم السجل. الملكية تتغير فقط عند القبول؛ الطلب المعلّق لا يمنح وصولًا. '
  'التاريخ ثابت: لا حذف، والقرار مرة واحدة.';

-- الثبات: لا حذف ولا تفريغ؛ الحقول الأصلية ثابتة؛ القرار مرة واحدة من pending؛
-- وحذف حساب فاعل (ON DELETE SET NULL) مسموح وحده (نفس قاعدة 079).
create or replace function public._continuity_guard_handover()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'طلبات التسليم لا تُحذف' using errcode = '42501';
  end if;
  if (new.from_owner is null or new.from_owner = old.from_owner)
     and (new.to_owner is null or new.to_owner = old.to_owner)
     and (new.decided_by is null or new.decided_by = old.decided_by)
     and (new.created_by is null or new.created_by = old.created_by)
     and (to_jsonb(new) - 'from_owner' - 'to_owner' - 'decided_by' - 'created_by')
       = (to_jsonb(old) - 'from_owner' - 'to_owner' - 'decided_by' - 'created_by') then
    return new;
  end if;
  if old.state <> 'pending' or new.state = 'pending'
     or new.id is distinct from old.id or new.record_id is distinct from old.record_id
     or new.workspace_id is distinct from old.workspace_id or new.from_owner is distinct from old.from_owner
     or new.to_owner is distinct from old.to_owner or new.reason is distinct from old.reason
     or new.context_note is distinct from old.context_note
     or new.record_version_at_request is distinct from old.record_version_at_request
     or new.idempotency_key is distinct from old.idempotency_key or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'طلب التسليم ثابت — القرار مرة واحدة فقط' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_continuity_handover_guard on public.continuity_handovers;
create trigger trg_continuity_handover_guard before update or delete on public.continuity_handovers
  for each row execute function public._continuity_guard_handover();
drop trigger if exists trg_continuity_handovers_no_truncate on public.continuity_handovers;
create trigger trg_continuity_handovers_no_truncate before truncate on public.continuity_handovers
  for each statement execute function public._continuity_guard_append_only();

-- اتفاقيات 041/042
alter table public.continuity_handovers enable row level security;
revoke all on table public.continuity_handovers from public, anon, authenticated;
drop policy if exists gate_account_active on public.continuity_handovers;
create policy gate_account_active on public.continuity_handovers
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.continuity_handovers;
create trigger trg_preview_read_only
  before insert or update or delete on public.continuity_handovers
  for each statement execute function public.guard_preview_read_only();


-- ============================================================================
-- 2) مساعدات
-- ============================================================================
create or replace function public._continuity_handovers_on()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((public._continuity_effective_capabilities() ->> 'handovers')::boolean, false);
$$;

create or replace function public._continuity_require_handovers()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._continuity_handovers_on() then
    raise exception 'التسليم غير مفعّل' using errcode = '0A000',
      detail = '{"code":"feature_not_enabled","field":"handovers"}';
  end if;
end $$;

-- صلاحية «إدارة» السجل لمستخدم **آخر** (لصاحب الطلب وقت القبول): ما زال المالك، أو صاحب
-- إسناد مؤهل، أو مشرف بسلطة دائمة (elevated_admin بدور admin، أو مالك المنصة) وحسابه نشط.
-- سياق المالك (owner_context) لكل جلسة، فلا يُحسب لغير المستدعي (R4).
create or replace function public._continuity_user_can_manage(p_user uuid, p_record uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(p_user is not null and (
       exists (select 1 from public.continuity_records r where r.id = p_record and r.owner_id = p_user)
    or public._continuity_has_assigner_grant(p_user)
    or (coalesce(public._inbox_account_active(p_user), false) and exists (
          select 1 from public.platform_authority a join public.profiles p on p.id = a.user_id
           where a.user_id = p_user and ((a.level = 'elevated_admin' and p.role = 'admin') or a.level = 'owner')))), false);
$$;

create or replace function public._continuity_handover_json(h public.continuity_handovers)
returns jsonb language sql stable set search_path to 'public' as $$
  select jsonb_build_object('id', h.id, 'record_id', h.record_id, 'from_owner', h.from_owner, 'to_owner', h.to_owner,
    'reason', h.reason, 'context_note', h.context_note, 'state', h.state, 'decided_by', h.decided_by,
    'decided_at', h.decided_at, 'decision_note', h.decision_note, 'cancel_cause', h.cancel_cause,
    'created_by', h.created_by, 'created_at', h.created_at);
$$;

-- الحزمة: ما يحتاجه المستلم ليقرر، بلا مقتطفات ولا مسارات ملفات ولا أحداث.
create or replace function public._continuity_handover_package(p_record uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary, 'problem', r.problem,
    'next_action', r.next_action, 'status', r.status, 'waiting_on', r.waiting_on, 'priority', r.priority,
    'category', r.category, 'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
    'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
    'version', r.version, 'updated_at', r.updated_at,
    'source_count', (select count(*) from public.continuity_sources s where s.record_id = r.id and s.removed_at is null),
    'attachment_count', (select count(*) from public.continuity_attachments a where a.record_id = r.id and a.status = 'active'))
  from public.continuity_records r where r.id = p_record;
$$;

-- رد موحّد بعد أي عملية: الطلب، والسجل الكامل لو المستدعي يراه، وإلا الحزمة.
create or replace function public._continuity_handover_result(p_handover uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('handover', public._continuity_handover_json(h),
    'record', case when public.continuity_can_access(h.record_id) then public._continuity_full(h.record_id, false) end,
    'package', case when not public.continuity_can_access(h.record_id) and h.state = 'pending'
                         and h.to_owner = auth.uid() then public._continuity_handover_package(h.record_id) end)
  from public.continuity_handovers h where h.id = p_handover;
$$;


-- ============================================================================
-- 3) الطلب
-- ============================================================================
create or replace function public.continuity_handover_request(
  p_record uuid, p_to_owner uuid, p_reason text, p_context_note text, p_expected_version integer, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  h public.continuity_handovers;
  v_reason text := nullif(btrim(p_reason), '');
  v_note text := nullif(btrim(p_context_note), '');
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_idempotency_key is null then perform public._continuity_validation('idempotency_key'); end if;

  select * into h from public.continuity_handovers where created_by = auth.uid() and idempotency_key = p_idempotency_key;
  if h.id is not null then
    if h.record_id is distinct from p_record or h.to_owner is distinct from p_to_owner
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
  -- من يطلب: المالك الحالي، أو مشرف، أو صاحب إسناد (سجل بلا مالك: المشرف أو صاحب الإسناد فقط).
  if not coalesce(r.owner_id = auth.uid() or public._continuity_can_assign(), false) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
  end if;
  if p_to_owner is null or not public._continuity_is_eligible_owner(p_to_owner) then
    perform public._continuity_validation('to_owner', 'not_eligible');
  end if;
  if p_to_owner = r.owner_id then perform public._continuity_validation('to_owner', 'already_owner'); end if;
  if exists (select 1 from public.continuity_handovers x where x.record_id = r.id and x.state = 'pending') then
    raise exception 'فيه طلب تسليم معلّق للسجل ده' using errcode = '55000',
      detail = '{"code":"invalid_transition","reason":"handover_pending"}';
  end if;

  insert into public.continuity_handovers (record_id, workspace_id, from_owner, to_owner, reason, context_note,
                                           record_version_at_request, idempotency_key, created_by)
  values (r.id, r.workspace_id, r.owner_id, p_to_owner, v_reason, v_note, r.version + 1, p_idempotency_key, auth.uid())
  returning * into h;
  update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_requested',
    jsonb_build_object('handover_id', h.id, 'from_owner', r.owner_id, 'to_owner', p_to_owner,
                       'fields', jsonb_strip_nulls(jsonb_build_object('reason', public._continuity_hash(v_reason),
                                                                     'context_note', public._continuity_hash(v_note)))));
  return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
end $$;


-- ============================================================================
-- 4) القرار (المستلم فقط)
-- ============================================================================
create or replace function public.continuity_handover_decide(
  p_handover uuid, p_decision text, p_note text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers;
  r public.continuity_records;
  v_note text := nullif(btrim(p_note), '');
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_decision not in ('accept', 'decline') then perform public._continuity_validation('decision'); end if;
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;

  select * into h from public.continuity_handovers where id = p_handover;
  -- غير موجود، أو لست المستلم ⇒ نفس الرد.
  if h.id is null or h.to_owner is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  -- القفل: السجل ثم الطلب (نفس ترتيب الإسناد والإغلاق ⇒ لا جمود).
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
      jsonb_build_object('handover_id', h.id, 'fields', jsonb_build_object('note', public._continuity_hash(v_note))));
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
  end if;

  -- القبول: كل شيء يُعاد فحصه الآن.
  if not public._continuity_is_eligible_owner(auth.uid()) then
    perform public._continuity_validation('to_owner', 'not_eligible');
  end if;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if p_expected_version is null or r.version <> p_expected_version then
    raise exception 'السجل اتعدّل — حدّث الطلب' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', r.version)::text;
  end if;
  if not public._continuity_user_can_manage(h.created_by, r.id) then
    -- صاحب الطلب فقد صلاحيته: الطلب يُلغى (نتيجة دائمة، لا تراجع)، ولا تتغير الملكية.
    update public.continuity_handovers
       set state = 'cancelled', cancel_cause = 'requester_lost_authority', decided_by = auth.uid(), decided_at = now()
     where id = h.id;
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'handover_cancelled',
      jsonb_build_object('handover_id', h.id, 'cause', 'requester_lost_authority'));
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false, 'accepted', false);
  end if;

  update public.continuity_handovers
     set state = 'accepted', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = h.id;
  -- بعد إغلاق الطلب: محفّز السجل لا يجد طلبًا معلّقًا فلا يلغي شيئًا. الفريق كما هو.
  update public.continuity_records set owner_id = auth.uid(), version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_accepted',
    jsonb_build_object('handover_id', h.id, 'from_owner', r.owner_id, 'to_owner', auth.uid(),
                       'fields', jsonb_strip_nulls(jsonb_build_object('note', public._continuity_hash(v_note)))));
  return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false, 'accepted', true);
end $$;


-- ============================================================================
-- 5) الإلغاء: صاحب الطلب، أو مشرف/صاحب إسناد يرى السجل
-- ============================================================================
create or replace function public.continuity_handover_cancel(p_handover uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers;
  r public.continuity_records;
  v_cause text;
  v_note text := nullif(btrim(p_note), '');
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or not public.continuity_can_access(h.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if h.created_by = auth.uid() then v_cause := 'initiator';
  elsif public._continuity_can_assign() then v_cause := 'supervisor';
  else
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"handover"}';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;
  select * into r from public.continuity_records where id = h.record_id for update;
  select * into h from public.continuity_handovers where id = p_handover for update;
  if h.state = 'cancelled' then
    return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', true);
  end if;
  if h.state <> 'pending' then
    raise exception 'الطلب لم يعد معلّقًا' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'handover_' || h.state)::text;
  end if;
  update public.continuity_handovers
     set state = 'cancelled', cancel_cause = v_cause, decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = h.id;
  update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'handover_cancelled',
    jsonb_build_object('handover_id', h.id, 'cause', v_cause,
                       'fields', jsonb_strip_nulls(jsonb_build_object('note', public._continuity_hash(v_note)))));
  return public._continuity_handover_result(h.id) || jsonb_build_object('replayed', false);
end $$;


-- ============================================================================
-- 6) الإسناد المباشر أو إغلاق السجل يلغي الطلب المعلّق (نفس المعاملة)
-- ============================================================================
create or replace function public._continuity_handover_on_record_change()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; v_cause text;
begin
  if new.status in ('resolved', 'cancelled') and old.status not in ('resolved', 'cancelled') then
    v_cause := 'record_closed';
  elsif new.owner_id is distinct from old.owner_id or new.team_id is distinct from old.team_id then
    v_cause := 'reassigned';
  else
    return null;
  end if;
  for h in select * from public.continuity_handovers where record_id = new.id and state = 'pending' for update loop
    update public.continuity_handovers
       set state = 'cancelled', cancel_cause = v_cause, decided_by = auth.uid(), decided_at = now()
     where id = h.id;
    insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
    values (new.id, new.workspace_id, auth.uid(), coalesce(public._continuity_client(), 'native'), 'handover_cancelled',
            jsonb_build_object('handover_id', h.id, 'cause', v_cause));
  end loop;
  return null;
end $$;

drop trigger if exists trg_continuity_handover_on_record on public.continuity_records;
create trigger trg_continuity_handover_on_record after update of owner_id, team_id, status on public.continuity_records
  for each row execute function public._continuity_handover_on_record_change();


-- ============================================================================
-- 7) القراءة
-- ============================================================================
-- طلب واحد: للمستلم (حزمة)، ولصاحب الطلب، ولمن يرى السجل.
create or replace function public.continuity_handover_get(p_handover uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare h public.continuity_handovers;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  select * into h from public.continuity_handovers where id = p_handover;
  if h.id is null or not (h.to_owner = auth.uid() or h.created_by = auth.uid() or public.continuity_can_access(h.record_id)) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return public._continuity_handover_result(h.id);
end $$;

-- طلباتي: الواردة المعلّقة (مع الحزمة) والصادرة المعلّقة.
create or replace function public.continuity_handovers_mine()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  return jsonb_build_object(
    'incoming', coalesce((select jsonb_agg(public._continuity_handover_json(h)
                                           || jsonb_build_object('package', public._continuity_handover_package(h.record_id))
                                           order by h.created_at)
                            from public.continuity_handovers h where h.to_owner = auth.uid() and h.state = 'pending'), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(public._continuity_handover_json(h) || jsonb_build_object('title', r.title)
                                           order by h.created_at)
                            from public.continuity_handovers h join public.continuity_records r on r.id = h.record_id
                           where h.created_by = auth.uid() and h.state = 'pending'
                             and public.continuity_can_access(h.record_id)), '[]'::jsonb));
end $$;

-- تاريخ التسليم لسجل يراه المستدعي (الأحدث أولًا، حتى 50).
create or replace function public.continuity_handovers_for_record(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_handovers();
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((select jsonb_agg(public._continuity_handover_json(h) order by h.created_at desc)
                     from (select * from public.continuity_handovers where record_id = p_record
                            order by created_at desc limit 50) h), '[]'::jsonb);
end $$;

-- علامة التثبيت (078): القدرة «مثبتة»؛ تظل مطفأة حتى قرار التفعيل.
create or replace function public._continuity_capability_handovers()
returns boolean language sql immutable set search_path to 'public' as $$ select true $$;


-- ============================================================================
-- 8) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_guard_handover()', 'public._continuity_handovers_on()', 'public._continuity_require_handovers()',
    'public._continuity_user_can_manage(uuid, uuid)', 'public._continuity_handover_json(public.continuity_handovers)',
    'public._continuity_handover_package(uuid)', 'public._continuity_handover_result(uuid)',
    'public._continuity_handover_on_record_change()', 'public._continuity_capability_handovers()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array array[
    'public.continuity_handover_request(uuid, uuid, text, text, integer, uuid)',
    'public.continuity_handover_decide(uuid, text, text, integer)', 'public.continuity_handover_cancel(uuid, text)',
    'public.continuity_handover_get(uuid)', 'public.continuity_handovers_mine()',
    'public.continuity_handovers_for_record(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.continuity_handovers from service_role;
  end if;
end $$;


-- ============================================================================
-- 9) تحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_workspaces', 'continuity_records', 'continuity_sources', 'continuity_source_snapshots',
                           'continuity_events', 'continuity_assigners', 'continuity_policies', 'continuity_policy_history',
                           'continuity_closures', 'continuity_attachments', 'continuity_handovers'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '081: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '081: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '081: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;
  -- 27 (080) + 6 دوال تسليم
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 33 then
    raise exception '081: المتوقع 33 دالة لـ authenticated';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '081: دالة متاحة لـ anon';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '081: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  -- الإسناد المباشر بلا تعديل (P3/P4 كما هي): لا ذكر للتسليم في continuity_assign
  if pg_get_functiondef('public.continuity_assign(uuid,uuid,uuid,integer)'::regprocedure) like '%handover%' then
    raise exception '081: continuity_assign تغيّرت';
  end if;
  if not public._continuity_capability_installed('handovers') then
    raise exception '081: علامة التثبيت مفقودة';
  end if;
  raise notice '081: التسليم مثبت ومطفأ';
end $$;
