-- ============================================================================
-- 094_continuity_reminders.sql
--   Mad3oom Continuity — المجدول والتذكيرات والتصعيد والإشعارات داخل المنصة
--   (المرحلتان S وN في docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md §4.2، §5.3، §5.4، §7، §14)
--
-- القرارات المعتمدة: D1–D4 (2026-10-12)، وR3 وR4 وR7 (2026-10-13):
--   D1  تذكير قبل الموعد بـ 60 دقيقة + تنبيه عند الموعد (reminder_offsets_minutes، due_alert)
--   D2  تكرار أثناء التأخر: مطفأ افتراضيًا (overdue_repeat_minutes = null)
--   D3  تصعيد المتأخر للمشرفين بعد 240 دقيقة، ينتظر ساعات العمل
--   D4  طلب تسليم معلّق: تذكير المستلم بعد 60، وتصعيد للمشرفين بعد 240
--   R3  working_hours تُقرأ بتوقيت مساحة المنصة (Africa/Cairo). بلا صفوف ساعات عمل ⇒ لا تأجيل
--   R4  «المشرفون» كمستلمين = موظف نشط بسلطة elevated_admin (دوره admin) + مالك المنصة، بغض النظر عن
--       سياق الجلسة. لا سلطة جديدة
--   R7  صفوف المهام والتسليم المنتهية تُحذف بعد 180 يومًا في كنس يومي. سجل السياسة يبقى
--
-- التصميم:
--   • التخطيط (_continuity_replan) بمحفّزات بعد كل تغيير في أساس الجدولة: السجل (الموعد، المالك، الحالة)،
--     طلبات التسليم (إنشاء، حالة)، والسياسة. المهام لا تُحذف: ما لم يعد مطلوبًا يصير superseded. مفتاح
--     التكرار يشمل كل ما يجعل التذكير مختلفًا (الموعد، الإزاحة، المالك، closure_seq)، فإعادة نفس الحساب لا
--     تضيف شيئًا، وأساس أُرسل لا يُرسل مرة ثانية.
--   • التنفيذ (continuity_tick) كل دقيقة: يحجز المهام المستحقة (SKIP LOCKED)، ويعيد التحقق لحظة التنفيذ
--     (السجل نشط؟ نفس الموعد والمالك؟ المفتاح مفعّل؟ المستلم مؤهل؟)، ثم يكتب صف تسليم لكل مستلم (مفتاح فريد
--     لكل مهمة ومستلم وقناة)، ثم يسلّم القناة الوحيدة الآن: in_app ⇒ notifications في نفس المعاملة.
--   • نص الإشعار من قالب ثابت فقط: نوع السجل، الموعد بمنطقته، الأولوية. أبدًا عنوان السجل أو ملخصه أو
--     الخطوة التالية أو مقتطفات أو بيانات عميل (C3/M4/F2: المدير المرتفع يقرأ كل الإشعارات).
--   • مفتاحان مستقلان، مطفآن: reminders_enabled (تذكيرات المالك والمستلم) وescalation_enabled (E1/E2/E3).
--     مطفأ لحظة التنفيذ ⇒ المهمة تُلغى بلا إشعار، وإعادة التشغيل لا تُطلق دفعة قديمة (لا تخطيط لما فات بأكثر
--     من 15 دقيقة).
--   • لا إعادة إسناد تلقائية أبدًا. التصعيد إشعار + حدث فقط.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/094_continuity_reminders.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.continuity_policies') is null or to_regclass('public.continuity_handovers') is null
     or to_regclass('public.working_hours') is null or to_regclass('public.notifications') is null then
    raise exception '094: يتطلب 078 و081 وجداول working_hours وnotifications';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.continuity_jobs (
  id           bigint generated always as identity primary key,
  record_id    uuid not null references public.continuity_records(id),
  workspace_id uuid not null references public.continuity_workspaces(id),
  handover_id  uuid references public.continuity_handovers(id),
  kind         text not null check (kind in ('due_reminder', 'overdue_alert', 'overdue_repeat', 'escalation_overdue',
                                             'escalation_unassigned', 'handover_reminder', 'escalation_handover')),
  run_at       timestamptz not null,
  basis        jsonb not null,
  dedupe_key   text not null,
  state        text not null default 'pending' check (state in ('pending', 'done', 'superseded', 'cancelled', 'failed')),
  reason       text check (char_length(reason) <= 40),
  attempts     int not null default 0 check (attempts between 0 and 10),
  last_error   text check (char_length(last_error) <= 20),
  fired_at     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists continuity_jobs_dedupe on public.continuity_jobs (dedupe_key) where state in ('pending', 'done', 'failed');
create index if not exists continuity_jobs_due on public.continuity_jobs (run_at) where state = 'pending';
create index if not exists continuity_jobs_record on public.continuity_jobs (record_id, created_at desc);
create index if not exists continuity_jobs_terminal on public.continuity_jobs (updated_at) where state <> 'pending';
comment on table public.continuity_jobs is
  'الاستمرارية (094). مهام التذكير والتصعيد. معرّفات وأوقات فقط، بلا نص. لا تُحذف إلا في كنس الاحتفاظ (180 يومًا، R7).';

create table if not exists public.continuity_deliveries (
  id              bigint generated always as identity primary key,
  job_id          bigint not null references public.continuity_jobs(id),
  record_id       uuid not null references public.continuity_records(id),
  recipient_id    uuid not null,
  channel         text not null default 'in_app' check (channel in ('in_app')),
  template        text not null check (template in ('due_soon', 'overdue', 'overdue_repeat', 'escalated_overdue',
                                                    'escalated_unassigned', 'handover_pending', 'escalated_handover')),
  state           text not null default 'pending' check (state in ('pending', 'sent', 'failed', 'dead', 'skipped')),
  attempts        int not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  last_error      text check (char_length(last_error) <= 20),
  sent_at         timestamptz,
  notification_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint continuity_deliveries_once unique (job_id, recipient_id, channel)
);
create index if not exists continuity_deliveries_due on public.continuity_deliveries (next_attempt_at) where state in ('pending', 'failed');
create index if not exists continuity_deliveries_record on public.continuity_deliveries (record_id, created_at desc);
create index if not exists continuity_deliveries_terminal on public.continuity_deliveries (updated_at) where state in ('sent', 'dead', 'skipped');
comment on table public.continuity_deliveries is
  'الاستمرارية (094). صندوق التسليم: مرة واحدة لكل مهمة ومستلم وقناة. معرّفات فقط؛ النص من قالب ثابت وقت التسليم.';

-- الثبات: المنتهي لا يعود؛ أعمدة الهوية ثابتة؛ الحذف لكنس الاحتفاظ فقط.
create or replace function public._continuity_guard_job_row()
returns trigger language plpgsql set search_path to 'public' as $$
declare v_fixed text[]; v_terminal text[];
begin
  if tg_table_name = 'continuity_jobs' then
    v_fixed := array['id', 'record_id', 'workspace_id', 'handover_id', 'kind', 'basis', 'dedupe_key', 'created_at'];
    v_terminal := array['done', 'superseded', 'cancelled', 'failed'];
  else
    v_fixed := array['id', 'job_id', 'record_id', 'recipient_id', 'channel', 'template', 'created_at'];
    v_terminal := array['sent', 'dead', 'skipped'];
  end if;
  if tg_op = 'DELETE' then
    if coalesce(current_setting('continuity.job_retention', true), '') = 'on'
       and (to_jsonb(old) ->> 'state') = any (v_terminal) and (to_jsonb(old) ->> 'updated_at')::timestamptz < now() - interval '180 days' then
      return old;
    end if;
    raise exception 'لا حذف إلا في كنس الاحتفاظ' using errcode = '42501';
  end if;
  if (to_jsonb(old) ->> 'state') = any (v_terminal) then
    raise exception 'الصف انتهى — لا تعديل' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_fixed) c where (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c)) then
    raise exception 'أعمدة الهوية ثابتة' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['continuity_jobs', 'continuity_deliveries'] loop
    execute format('drop trigger if exists trg_%1$s_guard on public.%1$I', t);
    execute format('create trigger trg_%1$s_guard before update or delete on public.%1$I for each row execute function public._continuity_guard_job_row()', t);
    execute format('drop trigger if exists trg_%1$s_no_truncate on public.%1$I', t);
    execute format('create trigger trg_%1$s_no_truncate before truncate on public.%1$I for each statement execute function public._continuity_guard_append_only()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated using (public.account_is_active()) with check (public.account_is_active())', t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format('create trigger trg_preview_read_only before insert or update or delete on public.%I for each statement execute function public.guard_preview_read_only()', t);
  end loop;
end $$;


-- ============================================================================
-- 2) المستلمون (R4) وساعات العمل (R3)
-- ============================================================================
-- مستلم تذكير المالك/المستلم: موظف مؤهل ونشط (نفس شرط ملكية السجل).
create or replace function public._continuity_recipient_ok(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user is not null and coalesce(public._continuity_is_eligible_owner(p_user), false);
$$;

-- «المشرفون» كمستلمين (R4): elevated_admin بدور admin، أو مالك المنصة؛ حساب نشط. سياق الجلسة لا يدخل.
create or replace function public._continuity_supervisor_recipients()
returns setof uuid language sql stable security definer set search_path to 'public' as $$
  select distinct a.user_id
    from public.platform_authority a join public.profiles p on p.id = a.user_id
   where ((a.level = 'elevated_admin' and p.role = 'admin') or a.level = 'owner')
     and coalesce(public._inbox_account_active(a.user_id), false);
$$;

-- أول لحظة عمل عند p_at أو بعدها، بتوقيت مساحة المنصة (R3). بلا ساعات عمل معرّفة ⇒ p_at نفسها.
create or replace function public._continuity_next_working(p_at timestamptz)
returns timestamptz language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_tz text := coalesce((select default_timezone from public.continuity_workspaces where kind = 'platform'), 'Africa/Cairo');
  v_local timestamp;
  wh record;
  i int;
begin
  if not exists (select 1 from public.working_hours
                  where coalesce(is_working_day, true) and start_time is not null and end_time is not null and start_time < end_time) then
    return p_at;
  end if;
  v_local := p_at at time zone v_tz;
  for i in 0 .. 7 loop
    for wh in select start_time, end_time from public.working_hours
               where day_of_week = extract(dow from (v_local::date + i))::int
                 and coalesce(is_working_day, true) and start_time is not null and end_time is not null and start_time < end_time
               order by start_time loop
      if i = 0 then
        if v_local::time >= wh.start_time and v_local::time < wh.end_time then return p_at; end if;
        if v_local::time < wh.start_time then return (v_local::date + wh.start_time) at time zone v_tz; end if;
      else
        return ((v_local::date + i) + wh.start_time) at time zone v_tz;
      end if;
    end loop;
  end loop;
  return p_at;
end $$;


-- ============================================================================
-- 3) التخطيط
-- ============================================================================
create or replace function public._continuity_job_key(p_kind text, p_record uuid, p_basis jsonb)
returns text language sql immutable set search_path to 'public' as $$
  select p_kind || ':' || p_record::text || ':' || md5(p_basis::text);
$$;

-- المهام المطلوبة الآن لسجل (بلا كتابة). الأساس يشمل كل ما يجعل التذكير مختلفًا.
create or replace function public._continuity_plan(r public.continuity_records)
returns table (kind text, run_at timestamptz, basis jsonb, handover_id uuid)
language plpgsql stable security definer set search_path to 'public' as $$
declare pol public.continuity_policies := public._continuity_policy_row(); off int; k int; h record; b jsonb;
begin
  if r.id is null or pol.workspace_id is null or r.status in ('resolved', 'cancelled') then return; end if;
  if r.due_at is not null then
    b := jsonb_build_object('due_at', r.due_at, 'owner_id', r.owner_id, 'closure_seq', r.closure_seq);
    if r.owner_id is not null then
      foreach off in array coalesce(pol.reminder_offsets_minutes, '{}') loop
        kind := 'due_reminder'; run_at := r.due_at - make_interval(mins => off); basis := b || jsonb_build_object('offset', off);
        handover_id := null; return next;
      end loop;
      if pol.due_alert then
        kind := 'overdue_alert'; run_at := r.due_at; basis := b; handover_id := null; return next;
      end if;
      if pol.overdue_repeat_minutes is not null then
        for k in 1 .. pol.overdue_repeat_max loop
          kind := 'overdue_repeat'; run_at := r.due_at + make_interval(mins => pol.overdue_repeat_minutes * k);
          basis := b || jsonb_build_object('n', k, 'every', pol.overdue_repeat_minutes); handover_id := null; return next;
        end loop;
      end if;
      if pol.escalate_after_minutes is not null then
        kind := 'escalation_overdue'; run_at := r.due_at + make_interval(mins => pol.escalate_after_minutes);
        basis := b || jsonb_build_object('rule', 'E1', 'after', pol.escalate_after_minutes); handover_id := null; return next;
      end if;
    else
      -- E3: سجل نشط بلا مالك تجاوز موعده ⇒ المشرفون عند الموعد (R5)
      kind := 'escalation_unassigned'; run_at := r.due_at; basis := b || jsonb_build_object('rule', 'E3');
      handover_id := null; return next;
    end if;
  end if;
  for h in select x.id, x.to_owner, x.created_at from public.continuity_handovers x where x.record_id = r.id and x.state = 'pending' loop
    if pol.handover_remind_after_minutes is not null then
      kind := 'handover_reminder'; run_at := h.created_at + make_interval(mins => pol.handover_remind_after_minutes);
      basis := jsonb_build_object('handover_id', h.id, 'to_owner', h.to_owner, 'after', pol.handover_remind_after_minutes);
      handover_id := h.id; return next;
    end if;
    if pol.handover_escalate_after_minutes is not null then
      kind := 'escalation_handover'; run_at := h.created_at + make_interval(mins => pol.handover_escalate_after_minutes);
      basis := jsonb_build_object('handover_id', h.id, 'rule', 'E2', 'after', pol.handover_escalate_after_minutes);
      handover_id := h.id; return next;
    end if;
  end loop;
end $$;

-- يطابق المهام المعلّقة مع المطلوب: ما لم يعد مطلوبًا ⇒ superseded، والجديد يُضاف (التكرار لا يضيف شيئًا).
-- لا يخطط لما فات وقته بأكثر من 15 دقيقة (لا دفعة قديمة بعد تشغيل المفتاح أو تغيير السياسة).
create or replace function public._continuity_replan(p_record uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.continuity_records; v_keys text[];
begin
  select * into r from public.continuity_records where id = p_record;
  if r.id is null then return; end if;
  select coalesce(array_agg(public._continuity_job_key(p.kind, r.id, p.basis)), '{}') into v_keys from public._continuity_plan(r) p;
  update public.continuity_jobs set state = 'superseded', reason = case when r.status in ('resolved', 'cancelled') then 'record_closed' else 'replanned' end
   where record_id = r.id and state = 'pending' and not dedupe_key = any (v_keys);
  insert into public.continuity_jobs (record_id, workspace_id, handover_id, kind, run_at, basis, dedupe_key)
  select r.id, r.workspace_id, p.handover_id, p.kind, p.run_at, p.basis, public._continuity_job_key(p.kind, r.id, p.basis)
    from public._continuity_plan(r) p
   where p.run_at > now() - interval '15 minutes'
  on conflict (dedupe_key) where state in ('pending', 'done', 'failed') do nothing;
end $$;

create or replace function public._continuity_replan_on_record()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform public._continuity_replan(new.id);
  return null;
end $$;

create or replace function public._continuity_replan_on_handover()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform public._continuity_replan(new.record_id);
  return null;
end $$;

create or replace function public._continuity_replan_on_policy()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare x record;
begin
  for x in select r.id from public.continuity_records r
            where r.workspace_id = new.workspace_id
              and (r.status not in ('resolved', 'cancelled')
                   or exists (select 1 from public.continuity_jobs j where j.record_id = r.id and j.state = 'pending')) loop
    perform public._continuity_replan(x.id);
  end loop;
  return null;
end $$;

drop trigger if exists trg_continuity_replan_record on public.continuity_records;
create trigger trg_continuity_replan_record after insert or update of due_at, due_tz, owner_id, status, closure_seq on public.continuity_records
  for each row execute function public._continuity_replan_on_record();
drop trigger if exists trg_continuity_replan_handover on public.continuity_handovers;
create trigger trg_continuity_replan_handover after insert or update of state on public.continuity_handovers
  for each row execute function public._continuity_replan_on_handover();
drop trigger if exists trg_continuity_replan_policy on public.continuity_policies;
create trigger trg_continuity_replan_policy after update of reminder_offsets_minutes, due_alert, overdue_repeat_minutes, overdue_repeat_max,
  escalate_after_minutes, handover_remind_after_minutes, handover_escalate_after_minutes, reminders_enabled, escalation_enabled
  on public.continuity_policies for each row execute function public._continuity_replan_on_policy();


-- ============================================================================
-- 4) القوالب (نص ثابت فقط)
-- ============================================================================
create or replace function public._continuity_notification_text(p_template text, r public.continuity_records, j public.continuity_jobs)
returns table (title text, message text, type text, link text)
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_kind text := case r.kind when 'follow_up' then 'متابعة' when 'issue' then 'مشكلة' when 'handover' then 'تسليم' else 'سجل' end;
  v_pri text := case r.priority when 1 then 'عاجلة' when 2 then 'عالية' when 3 then 'عادية' when 4 then 'منخفضة' else '—' end;
  v_due text := case when r.due_at is null then '—'
                     else to_char(r.due_at at time zone coalesce(r.due_tz, 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI') || ' (' || coalesce(r.due_tz, 'Africa/Cairo') || ')' end;
  v_link text := '/admin/continuity.html?record=' || r.id::text;
  v_after text := coalesce(j.basis ->> 'after', '');
begin
  case p_template
    when 'due_soon' then
      title := 'تذكير: موعد قريب في الاستمرارية';
      message := v_kind || ' باسمك موعدها ' || v_due || ' · الأولوية: ' || v_pri; type := 'info'; link := v_link;
    when 'overdue' then
      title := 'سجل استمرارية تجاوز موعده';
      message := v_kind || ' باسمك كان موعدها ' || v_due || ' · الأولوية: ' || v_pri; type := 'warning'; link := v_link;
    when 'overdue_repeat' then
      title := 'تذكير: سجل استمرارية ما زال متأخرًا';
      message := v_kind || ' باسمك كان موعدها ' || v_due || ' · الأولوية: ' || v_pri; type := 'warning'; link := v_link;
    when 'escalated_overdue' then
      title := 'تصعيد: سجل استمرارية متأخر';
      message := v_kind || ' تجاوزت موعدها ' || v_due || ' بأكثر من ' || v_after || ' دقيقة · الأولوية: ' || v_pri; type := 'warning'; link := v_link;
    when 'escalated_unassigned' then
      title := 'تصعيد: سجل استمرارية متأخر بلا مالك';
      message := v_kind || ' بلا مالك وموعدها ' || v_due || ' · الأولوية: ' || v_pri; type := 'warning'; link := v_link;
    when 'handover_pending' then
      title := 'طلب بانتظار ردك في الاستمرارية';
      message := 'طلب تسليم أو مشاركة لسجل (' || v_kind || ') ينتظر قبولك أو رفضك منذ أكثر من ' || v_after || ' دقيقة';
      type := 'info'; link := '/admin/continuity.html';
    when 'escalated_handover' then
      title := 'تصعيد: طلب تسليم بلا رد';
      message := 'طلب تسليم أو مشاركة لسجل (' || v_kind || ') بلا رد منذ أكثر من ' || v_after || ' دقيقة'; type := 'warning'; link := v_link;
  end case;
  return next;
end $$;


-- ============================================================================
-- 5) التنفيذ والتسليم
-- ============================================================================
create or replace function public._continuity_job_event(j public.continuity_jobs, p_kind text, p_payload jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
  values (j.record_id, j.workspace_id, null, 'cron', p_kind, jsonb_build_object('job_id', j.id, 'job_kind', j.kind) || coalesce(p_payload, '{}'::jsonb));
$$;

-- مهمة واحدة: إعادة التحقق، ثم المستلمون وصفوف التسليم. ⇒ الحالة الناتجة.
create or replace function public._continuity_fire(p_job bigint)
returns text language plpgsql security definer set search_path to 'public' as $$
declare
  j public.continuity_jobs; r public.continuity_records; h public.continuity_handovers;
  pol public.continuity_policies := public._continuity_policy_row();
  v_reminder boolean; v_template text; v_next timestamptz; v_recipients uuid[]; v_n int;
begin
  select * into j from public.continuity_jobs where id = p_job for update;
  if j.state <> 'pending' then return j.state; end if;
  select * into r from public.continuity_records where id = j.record_id;
  v_reminder := j.kind in ('due_reminder', 'overdue_alert', 'overdue_repeat', 'handover_reminder');

  -- لم يعد ساريًا
  if r.status in ('resolved', 'cancelled') then
    update public.continuity_jobs set state = 'cancelled', reason = 'record_closed' where id = j.id; return 'cancelled';
  end if;
  if j.handover_id is not null then
    select * into h from public.continuity_handovers where id = j.handover_id;
    if h.state is distinct from 'pending' then
      update public.continuity_jobs set state = 'superseded', reason = 'handover_decided' where id = j.id; return 'superseded';
    end if;
  else
    if r.due_at is distinct from (j.basis ->> 'due_at')::timestamptz
       or r.owner_id is distinct from nullif(j.basis ->> 'owner_id', '')::uuid
       or r.closure_seq is distinct from (j.basis ->> 'closure_seq')::int then
      update public.continuity_jobs set state = 'superseded', reason = 'basis_changed' where id = j.id; return 'superseded';
    end if;
  end if;

  -- المفتاح لحظة التنفيذ
  if (v_reminder and not coalesce(pol.reminders_enabled, false)) or (not v_reminder and not coalesce(pol.escalation_enabled, false)) then
    update public.continuity_jobs set state = 'cancelled', reason = 'switch_off' where id = j.id; return 'cancelled';
  end if;

  -- متأخر: تذكير قبل الموعد بعد الموعد، أو تذكير فات بأكثر من 6 ساعات (بعد توقف) ⇒ لا دفعة قديمة
  if (j.kind = 'due_reminder' and now() >= r.due_at) or (v_reminder and now() > j.run_at + interval '6 hours') then
    update public.continuity_jobs set state = 'superseded', reason = 'late' where id = j.id; return 'superseded';
  end if;

  -- التصعيد ينتظر ساعات العمل (R3)؛ تذكير المالك لا (هو من اختار الموعد)
  if not v_reminder and coalesce(pol.respect_working_hours, true) then
    v_next := public._continuity_next_working(now());
    if v_next > now() then
      update public.continuity_jobs set run_at = v_next, reason = 'deferred_to_working_hours' where id = j.id;
      perform public._continuity_job_event(j, 'job_deferred', jsonb_build_object('until', v_next));
      return 'deferred';
    end if;
  end if;

  -- المستلمون
  case j.kind
    when 'handover_reminder' then
      v_recipients := case when public._continuity_recipient_ok(h.to_owner) then array[h.to_owner] else '{}' end;
      v_template := 'handover_pending';
    when 'escalation_handover' then
      select coalesce(array_agg(u), '{}') into v_recipients from public._continuity_supervisor_recipients() u where u is distinct from h.to_owner;
      v_template := 'escalated_handover';
    when 'escalation_overdue' then
      select coalesce(array_agg(u), '{}') into v_recipients from public._continuity_supervisor_recipients() u where u is distinct from r.owner_id;
      v_template := 'escalated_overdue';
    when 'escalation_unassigned' then
      select coalesce(array_agg(u), '{}') into v_recipients from public._continuity_supervisor_recipients() u;
      v_template := 'escalated_unassigned';
    else
      v_recipients := case when public._continuity_recipient_ok(r.owner_id) then array[r.owner_id] else '{}' end;
      v_template := case j.kind when 'due_reminder' then 'due_soon' when 'overdue_alert' then 'overdue' else 'overdue_repeat' end;
  end case;

  insert into public.continuity_deliveries (job_id, record_id, recipient_id, channel, template)
  select j.id, j.record_id, u, 'in_app', v_template from unnest(v_recipients) u
  on conflict (job_id, recipient_id, channel) do nothing;
  get diagnostics v_n = row_count;
  update public.continuity_jobs set state = 'done', fired_at = now(), reason = case when v_n = 0 then 'no_recipient' end where id = j.id;
  perform public._continuity_job_event(j, case when v_reminder then 'job_fired' else 'escalated' end,
    jsonb_build_object('rule', j.basis ->> 'rule', 'recipients', cardinality(v_recipients)));
  return 'done';
end $$;

-- تسليم واحد (in_app ⇒ notifications). المستلم يُعاد فحصه لحظة التسليم.
create or replace function public._continuity_deliver(p_delivery bigint)
returns text language plpgsql security definer set search_path to 'public' as $$
declare d public.continuity_deliveries; j public.continuity_jobs; r public.continuity_records; t record; v_ok boolean; v_nid uuid;
begin
  select * into d from public.continuity_deliveries where id = p_delivery for update;
  if d.state not in ('pending', 'failed') then return d.state; end if;
  select * into j from public.continuity_jobs where id = d.job_id;
  select * into r from public.continuity_records where id = d.record_id;
  v_ok := case when d.template like 'escalated_%' then d.recipient_id in (select public._continuity_supervisor_recipients())
               else public._continuity_recipient_ok(d.recipient_id) end;
  if not v_ok or r.status in ('resolved', 'cancelled') then
    update public.continuity_deliveries set state = 'skipped', last_error = case when v_ok then 'record_closed' else 'ineligible' end where id = d.id;
    return 'skipped';
  end if;
  select * into t from public._continuity_notification_text(d.template, r, j);
  insert into public.notifications (user_id, title, message, type, link, category, action, action_target, action_label)
  values (d.recipient_id, t.title, t.message, t.type, t.link, 'continuity', 'open_section', t.link, 'فتح الاستمرارية')
  returning id into v_nid;
  update public.continuity_deliveries set state = 'sent', sent_at = now(), notification_id = v_nid, attempts = attempts + 1 where id = d.id;
  return 'sent';
end $$;

-- كل دقيقة (pg_cron). كل مهمة وكل تسليم في كتلة استثناء خاصة به.
create or replace function public.continuity_tick()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  x record; v_state text; v_fired int := 0; v_other int := 0; v_sent int := 0; v_failed int := 0; v_err text;
  d public.continuity_deliveries; j public.continuity_jobs;
begin
  for x in select id from public.continuity_jobs where state = 'pending' and run_at <= now()
            order by run_at limit 200 for update skip locked loop
    begin
      v_state := public._continuity_fire(x.id);
      if v_state = 'done' then v_fired := v_fired + 1; else v_other := v_other + 1; end if;
    exception when others then
      v_err := left(sqlstate, 5);
      update public.continuity_jobs
         set attempts = attempts + 1, last_error = v_err,
             state = case when attempts + 1 >= 3 then 'failed' else 'pending' end,
             run_at = now() + interval '5 minutes'
       where id = x.id returning * into j;
      if j.state = 'failed' then perform public._continuity_job_event(j, 'job_failed', jsonb_build_object('error', v_err)); end if;
    end;
  end loop;
  for x in select id from public.continuity_deliveries where state in ('pending', 'failed') and next_attempt_at <= now()
            order by id limit 500 for update skip locked loop
    begin
      if public._continuity_deliver(x.id) = 'sent' then v_sent := v_sent + 1; end if;
    exception when others then
      v_err := left(sqlstate, 5);
      update public.continuity_deliveries
         set attempts = attempts + 1, last_error = v_err,
             state = case when attempts + 1 >= 3 then 'dead' else 'failed' end,
             next_attempt_at = now() + case attempts when 0 then interval '1 minute' when 1 then interval '5 minutes' else interval '15 minutes' end
       where id = x.id returning * into d;
      v_failed := v_failed + 1;
      if d.state = 'dead' then
        select * into j from public.continuity_jobs where id = d.job_id;
        perform public._continuity_job_event(j, 'delivery_dead', jsonb_build_object('delivery_id', d.id, 'error', v_err));
      end if;
    end;
  end loop;
  return jsonb_build_object('fired', v_fired, 'closed', v_other, 'sent', v_sent, 'failed', v_failed);
end $$;

-- R7: المنتهي من المهام والتسليمات بعد 180 يومًا. سجل السياسة يبقى.
create or replace function public.continuity_job_retention_sweep()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_d int; v_j int;
begin
  perform set_config('continuity.job_retention', 'on', true);
  delete from public.continuity_deliveries
   where state in ('sent', 'dead', 'skipped') and updated_at < now() - interval '180 days';
  get diagnostics v_d = row_count;
  delete from public.continuity_jobs j
   where j.state <> 'pending' and j.updated_at < now() - interval '180 days'
     and not exists (select 1 from public.continuity_deliveries d where d.job_id = j.id);
  get diagnostics v_j = row_count;
  perform set_config('continuity.job_retention', 'off', true);
  return jsonb_build_object('deliveries', v_d, 'jobs', v_j);
end $$;


-- ============================================================================
-- 6) القراءة للواجهة: تذكيرات السجل (لمن يرى السجل) — أنواع وأوقات فقط
-- ============================================================================
create or replace function public.continuity_reminders_for(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object(
    'reminders', public._continuity_capability_installed('reminders') and coalesce((public._continuity_policy_row()).reminders_enabled, false),
    'escalation', public._continuity_capability_installed('escalation') and coalesce((public._continuity_policy_row()).escalation_enabled, false),
    'upcoming', coalesce((select jsonb_agg(jsonb_build_object('kind', j.kind, 'run_at', j.run_at) order by j.run_at)
                            from public.continuity_jobs j where j.record_id = p_record and j.state = 'pending'), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by (x ->> 'at') desc) from (
                          select jsonb_build_object('kind', j.kind, 'state', j.state, 'reason', j.reason, 'at', coalesce(j.fired_at, j.updated_at),
                                                    'recipients', (select count(*) from public.continuity_deliveries d where d.job_id = j.id),
                                                    'delivered', (select count(*) from public.continuity_deliveries d where d.job_id = j.id and d.state = 'sent')) x
                            from public.continuity_jobs j where j.record_id = p_record and j.state <> 'pending'
                           order by coalesce(j.fired_at, j.updated_at) desc limit 20) s), '[]'::jsonb));
end $$;


-- ============================================================================
-- 7) العلامات والجدولة والصلاحيات
-- ============================================================================
create or replace function public._continuity_capability_reminders()
returns boolean language sql immutable set search_path to 'public' as $$ select true $$;
create or replace function public._continuity_capability_escalation()
returns boolean language sql immutable set search_path to 'public' as $$ select true $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_guard_job_row()', 'public._continuity_recipient_ok(uuid)', 'public._continuity_supervisor_recipients()',
    'public._continuity_next_working(timestamptz)', 'public._continuity_job_key(text, uuid, jsonb)',
    'public._continuity_plan(public.continuity_records)', 'public._continuity_replan(uuid)',
    'public._continuity_replan_on_record()', 'public._continuity_replan_on_handover()', 'public._continuity_replan_on_policy()',
    'public._continuity_notification_text(text, public.continuity_records, public.continuity_jobs)',
    'public._continuity_job_event(public.continuity_jobs, text, jsonb)', 'public._continuity_fire(bigint)',
    'public._continuity_deliver(bigint)', 'public.continuity_tick()', 'public.continuity_job_retention_sweep()',
    'public._continuity_capability_reminders()', 'public._continuity_capability_escalation()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  execute 'revoke all on function public.continuity_reminders_for(uuid) from public, anon';
  execute 'grant execute on function public.continuity_reminders_for(uuid) to authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.continuity_reminders_for(uuid) from service_role';
  end if;
end $$;

-- تخطيط أولي للسجلات النشطة (المفاتيح مطفأة: لا شيء يُرسل حتى التفعيل)
do $$
declare x record;
begin
  for x in select id from public.continuity_records where status not in ('resolved', 'cancelled') loop
    perform public._continuity_replan(x.id);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname in ('continuity-tick', 'continuity-job-retention');
    perform cron.schedule('continuity-tick', '* * * * *', 'select public.continuity_tick()');
    perform cron.schedule('continuity-job-retention', '29 3 * * *', 'select public.continuity_job_retention_sweep()');
  end if;
end $$;


-- ============================================================================
-- 8) التحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_jobs', 'continuity_deliveries'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '094: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '094: صلاحية مباشرة على %', t;
    end if;
  end loop;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'continuity\_%') then
    raise exception '094: جدول continuity_* في supabase_realtime';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '094: دالة متاحة لـ anon';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '094: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  if has_function_privilege('authenticated', 'public.continuity_tick()', 'EXECUTE') then
    raise exception '094: continuity_tick متاحة للمستخدمين';
  end if;
  if not (public._continuity_capability_installed('reminders') and public._continuity_capability_installed('escalation')) then
    raise exception '094: علامات القدرتين غير مثبتة';
  end if;
  if exists (select 1 from public.continuity_policies where reminders_enabled or escalation_enabled) then
    raise notice '094: تنبيه — أحد المفتاحين مفعّل مسبقًا';
  end if;
  raise notice '094: المجدول والتذكيرات والتصعيد مثبتة (reminders_enabled وescalation_enabled مطفآن)';
end $$;
