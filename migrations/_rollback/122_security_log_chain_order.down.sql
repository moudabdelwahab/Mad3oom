-- ============================================================================
-- التراجع عن 122_security_log_chain_order: يعيد guard_security_events إلى نص 121 حرفيًا.
-- الصفوف المضافة بعد 122 تبقى سليمة (ترتيبها هو ترتيب ربطها).
-- ============================================================================
create or replace function public.guard_security_events()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'سجل الأمان لا يُعدَّل ولا يُحذف' using errcode = '42501';
  end if;
  -- ترتيب السلسلة: إضافة واحدة في كل لحظة
  perform pg_advisory_xact_lock(hashtext('public.security_events'));
  new.at := clock_timestamp();
  if new.source is null or new.source not in ('db', 'edge', 'client_report') then
    new.source := 'db';
  end if;
  new.details := coalesce(new.details, '{}'::jsonb);
  select e.hash into new.prev_hash from public.security_events e order by e.id desc limit 1;
  new.hash := public._security_event_hash(new);
  return new;
end;
$$;
revoke all on function public.guard_security_events() from public, anon, authenticated;
