-- ============================================================================
-- 079_continuity_reopen_lifecycle.sql
--   مدعوم — الاستمرارية: تاريخ الإغلاق وإعادة الفتح المنضبطة
--   (docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md §15.1)
--
-- طلب المالك 2026-10-12: السجل المقفول يبقى مرئيًا، ويُعاد فتحه بإجراء صريح
--   مُدقَّق لا يمحو تاريخ الإغلاق السابق، ولا يعيد استخدام موعد منتهٍ بصمت.
--
-- قبل 079: إعادة الفتح كانت تمسح resolution_note/resolved_*/cancel_reason من صف
--   السجل، والأحداث تحفظ بصمة النص فقط ⇒ نص الإغلاق السابق كان يضيع.
--
-- ما يضيفه
--   continuity_closures      صف لكل إغلاق (seq): الحالة، الوقت، الفاعل، نص الحل أو
--                            سبب الإلغاء؛ وعند إعادة الفتح: الوقت والفاعل والسبب.
--                            للإلحاق فقط: لا حذف، والتحديث مسموح مرة واحدة لملء
--                            أعمدة reopened_* فقط، أو لتفريغ الفاعل عند حذف حسابه.
--   continuity_records.closure_seq   عدد الإغلاقات (يدخل أساس جدولة التذكيرات لاحقًا).
--
-- يعيد تعريف
--   continuity_transition   الإغلاق يكتب صف closure؛ إعادة الفتح:
--     • الحالة الهدف دائمًا open (قرار L1)، ليست الحالة النشطة السابقة.
--     • المتابعة (follow_up) التي موعدها فات أو خلال 5 دقائق أو بلا موعد تتطلب
--       details.due جديدًا (وقت محلي + منطقة، نفس قواعد الإنشاء)، وإلا
--       validation_failed بسبب due_required_on_reopen. الموعد المستقبلي يبقى ما لم
--       يُرسل جديد. المشكلة (issue): الموعد اختياري.
--     • أي موعد جديد يُرسل عند إعادة الفتح يجب أن يكون بعد الآن فعلًا (in_past)،
--       بلا هامش الدقائق الخمس المسموح عند الإنشاء.
--     • تملأ reopened_* في صف الإغلاق الأخير، ولا تمسحه.
--     • باقي القواعد كما هي حرفيًا: من يغلق/يفتح (المالك أو المشرف)، فحص النسخة،
--       حجب المقتطفات منتهية الاحتفاظ عند إعادة الفتح.
--   _continuity_full        يضيف closures (الأحدث أولًا) لكل من يرى السجل.
--
-- ترحيل البيانات: السجلات المقفولة أو التي اتقفلت قبل 079 تُبنى إغلاقاتها من
--   الأحداث (resolved/cancelled/reopened) بالترتيب. النص متاح فقط للإغلاق الحالي
--   (من صف السجل)؛ إغلاقات سابقة أعيد فتحها قبل 079 بلا نص (الأحداث تحفظ البصمة
--   فقط) — موثّق كحد معروف. لا يُعدَّل أي حدث.
--
-- لا يلمس: chat_* أو inbox_* أو tickets أو profiles أو notifications، ولا أغلفة
--   relay_* (relay_transition ينادي continuity_transition فيأخذ السلوك الجديد).
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/079_continuity_reopen_lifecycle.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات (077 + 078)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.continuity_transition(uuid, text, jsonb, integer)', 'public._continuity_full(uuid, boolean)',
    'public._continuity_lock_for_write(uuid, integer)', 'public._continuity_parse_due(jsonb, text, boolean)',
    'public._continuity_log(uuid, uuid, text, jsonb, text)', 'public._continuity_validation(text, text)',
    'public._continuity_guard_append_only()', 'public.continuity_get_policies()'] loop
    if to_regprocedure(f) is null then
      raise exception '079 يتطلب 077 و078 (%)', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) الجدول والعمود
-- ============================================================================
alter table public.continuity_records add column if not exists closure_seq int not null default 0;
do $$ begin
  alter table public.continuity_records add constraint continuity_records_closure_seq check (closure_seq >= 0);
exception when duplicate_object then null; end $$;

create table if not exists public.continuity_closures (
  id              bigint generated always as identity primary key,
  record_id       uuid not null references public.continuity_records(id),
  workspace_id    uuid not null references public.continuity_workspaces(id),
  seq             int not null check (seq >= 1),
  closed_status   text not null check (closed_status in ('resolved', 'cancelled')),
  closed_at       timestamptz not null,
  closed_by       uuid references public.profiles(id) on delete set null,
  resolution_note text check (char_length(resolution_note) <= 4000),
  cancel_reason   text check (char_length(cancel_reason) <= 1000),
  reopened_at     timestamptz,
  reopened_by     uuid references public.profiles(id) on delete set null,
  reopen_reason   text check (char_length(reopen_reason) <= 1000),
  -- ترحيل البيانات: إغلاق أعيد فتحه قبل 079 لا نص له (الأحداث تحفظ البصمة فقط).
  backfilled      boolean not null default false,
  constraint continuity_closures_seq unique (record_id, seq),
  constraint continuity_closures_reopen_pair check (reopened_by is null or reopened_at is not null),
  constraint continuity_closures_reopen_reason check (reopen_reason is null or reopened_at is not null),
  constraint continuity_closures_note_kind check (
    (closed_status = 'resolved' and cancel_reason is null) or (closed_status = 'cancelled' and resolution_note is null))
);
create index if not exists continuity_closures_record on public.continuity_closures (record_id, seq desc);

comment on table public.continuity_closures is
  'الاستمرارية (079). تاريخ إغلاقات السجل: من أغلق ومتى وبأي نص، ومن أعاد الفتح ومتى ولماذا. للإلحاق فقط.';

-- الثبات: لا حذف ولا تفريغ؛ التحديث مرة واحدة لملء reopened_* فقط.
create or replace function public._continuity_guard_closure()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'تاريخ الإغلاق لا يُحذف' using errcode = '42501';
  end if;
  -- حذف حساب الفاعل (ON DELETE SET NULL على closed_by/reopened_by): التغيير الوحيد
  -- أن الفاعل يصبح فارغًا. يُسمح به فقط إذا لم يتغير أي عمود آخر.
  if (new.closed_by is null or new.closed_by = old.closed_by)
     and (new.reopened_by is null or new.reopened_by = old.reopened_by)
     and (to_jsonb(new) - 'closed_by' - 'reopened_by') = (to_jsonb(old) - 'closed_by' - 'reopened_by') then
    return new;
  end if;
  if old.reopened_at is not null
     or new.id is distinct from old.id or new.record_id is distinct from old.record_id
     or new.workspace_id is distinct from old.workspace_id or new.seq is distinct from old.seq
     or new.closed_status is distinct from old.closed_status or new.closed_at is distinct from old.closed_at
     or (new.closed_by is distinct from old.closed_by and new.closed_by is not null)
     or new.resolution_note is distinct from old.resolution_note or new.cancel_reason is distinct from old.cancel_reason
     or new.backfilled is distinct from old.backfilled
     or new.reopened_at is null then
    raise exception 'تاريخ الإغلاق ثابت — التحديث الوحيد المسموح هو تسجيل إعادة الفتح مرة واحدة' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._continuity_guard_closure() from public, anon, authenticated;

drop trigger if exists trg_continuity_closure_guard on public.continuity_closures;
create trigger trg_continuity_closure_guard before update or delete on public.continuity_closures
  for each row execute function public._continuity_guard_closure();
drop trigger if exists trg_continuity_closures_no_truncate on public.continuity_closures;
create trigger trg_continuity_closures_no_truncate before truncate on public.continuity_closures
  for each statement execute function public._continuity_guard_append_only();

-- اتفاقيات 041/042
alter table public.continuity_closures enable row level security;
revoke all on table public.continuity_closures from public, anon, authenticated;
drop policy if exists gate_account_active on public.continuity_closures;
create policy gate_account_active on public.continuity_closures
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.continuity_closures;
create trigger trg_preview_read_only
  before insert or update or delete on public.continuity_closures
  for each statement execute function public.guard_preview_read_only();
revoke all on sequence public.continuity_closures_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.continuity_closures from service_role;
    revoke all on sequence public.continuity_closures_id_seq from service_role;
    revoke all on function public._continuity_guard_closure() from service_role;
  end if;
end $$;


-- ============================================================================
-- 2) ترحيل البيانات (مرة واحدة: فقط للسجلات التي بلا صفوف إغلاق)
-- ============================================================================
do $$
declare
  r public.continuity_records;
  e record;
  v_rows jsonb;
  v_last int;
begin
  for r in select * from public.continuity_records rec
            where not exists (select 1 from public.continuity_closures c where c.record_id = rec.id)
              and exists (select 1 from public.continuity_events ev
                           where ev.record_id = rec.id and ev.kind in ('resolved', 'cancelled'))
            order by rec.created_at for update loop
    -- 1) بناء الإغلاقات من الأحداث بالترتيب (بلا كتابة بعد)
    v_rows := '[]'::jsonb;
    for e in select * from public.continuity_events
              where record_id = r.id and kind in ('resolved', 'cancelled', 'reopened') order by id loop
      v_last := jsonb_array_length(v_rows) - 1;
      if e.kind in ('resolved', 'cancelled') then
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'status', e.kind, 'closed_at', coalesce(e.payload ->> 'closed_at', e.created_at::text), 'closed_by', e.actor_id));
      elsif e.kind = 'reopened' and v_last >= 0 and not (v_rows -> v_last ? 'reopened_at') then
        v_rows := jsonb_set(v_rows, array[v_last::text], (v_rows -> v_last)
                    || jsonb_build_object('reopened_at', e.created_at, 'reopened_by', e.actor_id));
      end if;
    end loop;
    -- 2) الإدراج مرة واحدة. الإغلاق الحالي (السجل ما زال مقفولًا) يأخذ نصه من صف السجل؛
    --    الإغلاقات التي أعيد فتحها قبل 079 بلا نص (backfilled = true).
    insert into public.continuity_closures (record_id, workspace_id, seq, closed_status, closed_at, closed_by,
                                            resolution_note, cancel_reason, reopened_at, reopened_by, backfilled)
    select r.id, r.workspace_id, x.ord::int, x.v ->> 'status',
           case when cur then coalesce(r.closed_at, (x.v ->> 'closed_at')::timestamptz) else (x.v ->> 'closed_at')::timestamptz end,
           -- actor_id في الأحداث بلا مفتاح أجنبي: حساب محذوف ⇒ فاعل فارغ (لا كسر للمفتاح).
           (select p.id from public.profiles p
             where p.id = case when cur and r.status = 'resolved' then coalesce(r.resolved_by, (x.v ->> 'closed_by')::uuid)
                               else (x.v ->> 'closed_by')::uuid end),
           case when cur and r.status = 'resolved' then r.resolution_note end,
           case when cur and r.status = 'cancelled' then r.cancel_reason end,
           (x.v ->> 'reopened_at')::timestamptz,
           (select p.id from public.profiles p where p.id = (x.v ->> 'reopened_by')::uuid),
           not cur
      from jsonb_array_elements(v_rows) with ordinality x(v, ord)
      cross join lateral (select (x.ord = jsonb_array_length(v_rows) and not (x.v ? 'reopened_at')
                                  and r.status in ('resolved', 'cancelled')
                                  and r.status = x.v ->> 'status') as cur) c;
    update public.continuity_records set closure_seq = jsonb_array_length(v_rows) where id = r.id;
  end loop;
end $$;


-- ============================================================================
-- 3) الانتقالات
-- ============================================================================
create or replace function public.continuity_transition(p_record uuid, p_to text, p_details jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  n public.continuity_records;
  v_note text;
  v_due_at timestamptz;
  v_due_tz text;
  v_active constant text[] := array['open', 'scheduled', 'in_progress', 'waiting'];
begin
  r := public._continuity_lock_for_write(p_record, p_expected_version);
  if not (public._continuity_is_supervisor() or r.owner_id = auth.uid()) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_details is not null and jsonb_typeof(p_details) not in ('object', 'null') then
    perform public._continuity_validation('details');
  end if;
  if p_to = 'ready_for_handover' then
    raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  perform public._continuity_text_ok(p_details -> 'waiting_on', 'details.waiting_on', 1000);
  perform public._continuity_text_ok(p_details -> 'resolution_note', 'details.resolution_note', 4000);
  perform public._continuity_text_ok(p_details -> 'cancel_reason', 'details.cancel_reason', 1000);
  perform public._continuity_text_ok(p_details -> 'reason', 'details.reason', 1000);

  if p_to in ('in_progress', 'waiting', 'scheduled') and r.status = any(v_active) and r.status <> p_to then
    v_note := nullif(btrim(p_details ->> 'waiting_on'), '');
    if p_to = 'waiting' and v_note is null then perform public._continuity_validation('details.waiting_on'); end if;
    if char_length(v_note) > 1000 then perform public._continuity_validation('details.waiting_on'); end if;
    update public.continuity_records
       set status = p_to, waiting_on = case when p_to = 'waiting' then v_note end,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'transitioned',
      jsonb_build_object('from', r.status, 'to', p_to, 'fields',
                         jsonb_build_object('waiting_on', public._continuity_hash(v_note))));
  elsif p_to = 'resolved' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'resolution_note'), '');
    if v_note is null or char_length(v_note) > 4000 then perform public._continuity_validation('details.resolution_note'); end if;
    update public.continuity_records
       set status = 'resolved', resolution_note = v_note, resolved_at = now(), resolved_by = auth.uid(),
           closed_at = now(), waiting_on = null, closure_seq = closure_seq + 1, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    insert into public.continuity_closures (record_id, workspace_id, seq, closed_status, closed_at, closed_by, resolution_note)
    values (n.id, n.workspace_id, n.closure_seq, 'resolved', n.closed_at, auth.uid(), v_note);
    perform public._continuity_log(r.id, r.workspace_id, 'resolved',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at, 'closure_seq', n.closure_seq,
                         'fields', jsonb_build_object('resolution_note', public._continuity_hash(v_note))));
  elsif p_to = 'cancelled' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'cancel_reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.cancel_reason'); end if;
    update public.continuity_records
       set status = 'cancelled', cancel_reason = v_note, closed_at = now(), waiting_on = null,
           closure_seq = closure_seq + 1, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    insert into public.continuity_closures (record_id, workspace_id, seq, closed_status, closed_at, closed_by, cancel_reason)
    values (n.id, n.workspace_id, n.closure_seq, 'cancelled', n.closed_at, auth.uid(), v_note);
    perform public._continuity_log(r.id, r.workspace_id, 'cancelled',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at, 'closure_seq', n.closure_seq,
                         'fields', jsonb_build_object('cancel_reason', public._continuity_hash(v_note))));
  elsif p_to = 'open' and r.status in ('resolved', 'cancelled') then
    v_note := nullif(btrim(p_details ->> 'reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.reason'); end if;
    -- الموعد (L1/§15.1): متابعة بموعد فات (أو خلال 5 دقائق) أو بلا موعد ⇒ موعد جديد إلزامي.
    -- موعد مستقبلي يبقى ما لم يُرسل جديد. نفس قواعد الإنشاء (_continuity_parse_due).
    v_due_at := r.due_at;
    v_due_tz := r.due_tz;
    if p_details ? 'due' and jsonb_typeof(p_details -> 'due') <> 'null' then
      select o_at, o_tz into v_due_at, v_due_tz from public._continuity_parse_due(p_details -> 'due', r.kind, true);
      -- الإنشاء يسمح بخمس دقائق في الماضي (فرق الساعات)؛ هنا الموعد الجديد يجب أن يكون
      -- مستقبليًا فعلًا، وإلا تفتح المتابعة متأخرة من أول لحظة.
      if v_due_at <= now() then perform public._continuity_validation('details.due.at', 'in_past'); end if;
    elsif r.kind = 'follow_up' and (r.due_at is null or r.due_at <= now() + interval '5 minutes') then
      perform public._continuity_validation('details.due', 'due_required_on_reopen');
    end if;
    -- إعادة الفتح توقف ساعة الاحتفاظ؛ الإغلاق التالي يبدأ ساعة جديدة. المحجوب يظل محجوبًا.
    -- لو الموعد عدّى والكنس لسه ماشتغلش: نحجب الآن، وإلا إعادة الفتح كانت سترجّع
    -- محتوى منتهي الاحتفاظ (قناع M6 يعتمد على closed_at الذي سيُمسح).
    if public._continuity_retention_expired(r.closed_at,
         (select w.snapshot_retention_days from public.continuity_workspaces w where w.id = r.workspace_id)) then
      with red as (
        update public.continuity_source_snapshots
           set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = null,
               redaction_reason = 'retention'
         where record_id = r.id and redacted_at is null
        returning source_id)
      insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
      select r.id, r.workspace_id, null, 'cron', 'source_redacted',
             jsonb_build_object('source_id', red.source_id, 'reason', 'retention', 'trigger', 'reopen')
        from red;
    end if;
    -- تاريخ الإغلاق: الإغلاق الأخير يسجل إعادة الفتح ولا يُمسح.
    update public.continuity_closures
       set reopened_at = now(), reopened_by = auth.uid(), reopen_reason = v_note
     where record_id = r.id and seq = r.closure_seq and reopened_at is null;
    if not found then
      raise exception 'تاريخ الإغلاق غير متسق' using errcode = '55000', detail = '{"code":"invalid_transition"}';
    end if;
    update public.continuity_records
       set status = 'open', closed_at = null, resolution_note = null, resolved_at = null, resolved_by = null,
           cancel_reason = null, due_at = v_due_at, due_tz = v_due_tz, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'reopened',
      jsonb_build_object('from', r.status, 'closure_seq', r.closure_seq,
                         'due', case when r.due_at is distinct from n.due_at or r.due_tz is distinct from n.due_tz
                                     then jsonb_build_object('from', r.due_at, 'to', n.due_at, 'tz', n.due_tz) end,
                         'fields', jsonb_build_object('reason', public._continuity_hash(v_note))));
  else
    raise exception 'انتقال غير مسموح' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'from', r.status, 'to', p_to)::text;
  end if;
  return public._continuity_full(r.id, false);
end $$;

-- السجل كاملًا + تاريخ الإغلاق (الأحدث أولًا). نص الإغلاق يراه من يرى السجل، كما كان في صف السجل.
create or replace function public._continuity_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._continuity_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._continuity_source_view(s.id) order by s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(public._continuity_source_view(s.id)
                                          || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)
                                          order by s.removed_at desc, s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is not null and s.purged_at is null), '[]'::jsonb),
    'closures', coalesce((select jsonb_agg(jsonb_build_object(
                             'seq', c.seq, 'closed_status', c.closed_status, 'closed_at', c.closed_at, 'closed_by', c.closed_by,
                             'resolution_note', c.resolution_note, 'cancel_reason', c.cancel_reason,
                             'reopened_at', c.reopened_at, 'reopened_by', c.reopened_by, 'reopen_reason', c.reopen_reason,
                             'backfilled', c.backfilled) order by c.seq desc)
                            from public.continuity_closures c where c.record_id = p_record), '[]'::jsonb),
    'replayed', p_replayed);
$$;
revoke all on function public._continuity_full(uuid, boolean) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._continuity_full(uuid, boolean) from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) تحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_workspaces', 'continuity_records', 'continuity_sources', 'continuity_source_snapshots',
                           'continuity_events', 'continuity_assigners', 'continuity_policies', 'continuity_policy_history',
                           'continuity_closures'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '079: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '079: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '079: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 21 then
    raise exception '079: المتوقع 21 دالة لـ authenticated (لا دوال عامة جديدة)';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '079: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  -- كل سجل مقفول له إغلاق مفتوح بنفس closure_seq، وكل سجل نشط إغلاقاته كلها أعيد فتحها.
  if exists (select 1 from public.continuity_records r
              where (r.status in ('resolved', 'cancelled')
                     and not exists (select 1 from public.continuity_closures c
                                      where c.record_id = r.id and c.seq = r.closure_seq and c.reopened_at is null))
                 or (r.status not in ('resolved', 'cancelled')
                     and exists (select 1 from public.continuity_closures c where c.record_id = r.id and c.reopened_at is null))
                 or r.closure_seq <> (select count(*) from public.continuity_closures c where c.record_id = r.id)) then
    raise exception '079: تاريخ الإغلاق غير متسق مع حالة السجلات';
  end if;
  if pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure) not like '%due_required_on_reopen%' then
    raise exception '079: continuity_transition غير مثبت';
  end if;
  raise notice '079: تاريخ الإغلاق وإعادة الفتح المنضبطة جاهزة';
end $$;
