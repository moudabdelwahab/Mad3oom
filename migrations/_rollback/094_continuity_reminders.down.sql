-- ============================================================================
-- تراجع 094_continuity_reminders
--
-- يوقف الجدولة، ويحذف المحفّزات والدوال والجدولين، وعلامتي القدرتين. لا يعدّل أي دالة قائمة (094 لم
-- يرقّع شيئًا). الإشعارات التي أُرسلت تبقى في notifications (هي لمستلميها).
--
-- حماية: يرفض لو فيه صفوف تسليم (تاريخ ما أُرسل سيضيع)، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- قبل حذف العلامتين يُطفأ المفتاحان (مع سطر في سجل السياسة)، فلا تبقى قدرة مفعّلة بلا كود.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and to_regclass('public.continuity_deliveries') is not null
     and exists (select 1 from public.continuity_deliveries) then
    raise exception 'تراجع 094: فيه تسليمات سيضيع تاريخها — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

-- 1) الجدولة
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname in ('continuity-tick', 'continuity-job-retention');
  end if;
end $$;

-- 2) المحفّزات (قبل تعديل السياسة حتى لا يُعاد التخطيط)
drop trigger if exists trg_continuity_replan_record on public.continuity_records;
drop trigger if exists trg_continuity_replan_handover on public.continuity_handovers;
drop trigger if exists trg_continuity_replan_policy on public.continuity_policies;

-- 3) إطفاء المفتاحين لو مفعّلين (مع السجل)
do $$
declare w public.continuity_workspaces; o public.continuity_policies;
begin
  select * into w from public.continuity_workspaces where kind = 'platform';
  select * into o from public.continuity_policies where workspace_id = w.id for update;
  if o.reminders_enabled or o.escalation_enabled then
    update public.continuity_policies set reminders_enabled = false, escalation_enabled = false,
           version = version + 1, updated_by = null, updated_at = now()
     where workspace_id = w.id;
    insert into public.continuity_policy_history (workspace_id, actor_id, changed, before, after)
    values (w.id, null, array['escalation_enabled', 'reminders_enabled'],
            jsonb_build_object('reminders_enabled', o.reminders_enabled, 'escalation_enabled', o.escalation_enabled),
            jsonb_build_object('reminders_enabled', false, 'escalation_enabled', false));
  end if;
end $$;

-- 4) الدوال والجداول
drop function if exists public.continuity_reminders_for(uuid);
drop function if exists public.continuity_tick();
drop function if exists public.continuity_job_retention_sweep();
drop function if exists public._continuity_deliver(bigint);
drop function if exists public._continuity_fire(bigint);
drop function if exists public._continuity_job_event(public.continuity_jobs, text, jsonb);
drop function if exists public._continuity_notification_text(text, public.continuity_records, public.continuity_jobs);
drop function if exists public._continuity_replan_on_record();
drop function if exists public._continuity_replan_on_handover();
drop function if exists public._continuity_replan_on_policy();
drop function if exists public._continuity_replan(uuid);
drop function if exists public._continuity_plan(public.continuity_records);
drop function if exists public._continuity_job_key(text, uuid, jsonb);
drop function if exists public._continuity_next_working(timestamptz);
drop function if exists public._continuity_supervisor_recipients();
drop function if exists public._continuity_recipient_ok(uuid);
drop function if exists public._continuity_capability_reminders();
drop function if exists public._continuity_capability_escalation();
drop table if exists public.continuity_deliveries;
drop table if exists public.continuity_jobs;
drop function if exists public._continuity_guard_job_row();

-- 5) التحقق
do $$
begin
  if to_regclass('public.continuity_jobs') is not null or to_regclass('public.continuity_deliveries') is not null
     or to_regprocedure('public.continuity_tick()') is not null
     or public._continuity_capability_installed('reminders') or public._continuity_capability_installed('escalation')
     or exists (select 1 from pg_trigger where tgname like 'trg_continuity_replan_%') then
    raise exception 'تراجع 094: بقايا لم تُحذف';
  end if;
end $$;

commit;
