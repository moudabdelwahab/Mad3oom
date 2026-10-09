-- ============================================================================
-- 070 — فحص Production بعد التثبيت: المالك في سياقه الحالي، وعميل حقيقي
--
-- كتلة DO واحدة بتنتهي دايمًا بـ RAISE ⇒ المعاملة كلها بترجع (تعديل الأولوية
-- والرد التجريبي مابيفضلوش). قراءة كهوية المالك والعميل تحت RLS الحقيقية.
-- متوقع: المالك في سياق admin يشوف كل تذاكر العملاء ويعدّل ويرد؛ العميل
-- يشوف تذاكره بس ولسه مايقدرش يغيّر الحالة (P0001).
-- اتشغّل على Production يوم 2026-10-09 07:27 UTC ⇒ PASS/PASS (33 تذكرة عميل).
-- ============================================================================
do $smoke$
declare
  ow uuid; cu uuid; tk uuid;
  ctx text; n_t int; n_r int; n_cust_own int; n_cust_seen int; upd int; st text; res text := '';
begin
  select a.user_id into ow from public.platform_authority a where a.level = 'owner' limit 1;
  select t.user_id, t.id into cu, tk from public.tickets t
    join public.profiles p on p.id = t.user_id
   where p.role not in ('admin','support','platform_owner') and t.user_id <> ow
   order by t.created_at desc limit 1;

  perform set_config('request.jwt.claim.sub', ow::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ow, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ctx := public.active_context();
  select count(*) into n_t from public.tickets where user_id <> ow;
  select count(*) into n_r from public.ticket_replies;
  begin
    update public.tickets set priority = priority where id = tk;
    get diagnostics upd = row_count;
    update public.tickets set priority = case when priority = 'high' then 'medium' else 'high' end where id = tk;
    insert into public.ticket_replies (ticket_id, user_id, message, is_internal) values (tk, ow, 'فحص 070', true);
    st := 'ok';
  exception when others then st := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  res := res || E'\n' || case when ctx = 'admin' and upd = 1 and st = 'ok' then 'PASS' else 'FAIL' end
         || format(' OWNER context=%s sees customer tickets=%s replies=%s, update rows=%s, edit+reply=%s', ctx, n_t, n_r, upd, st);

  select count(*) into n_cust_own from public.tickets where user_id = cu;
  perform set_config('request.jwt.claim.sub', cu::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n_cust_seen from public.tickets;
  begin
    update public.tickets set status = 'resolved' where id = tk;
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  res := res || E'\n' || case when n_cust_seen = n_cust_own and st = 'P0001' then 'PASS' else 'FAIL' end
         || format(' CUSTOMER sees %s of own %s; status change → %s', n_cust_seen, n_cust_own, st);

  raise exception 'SMOKE_070_RESULT:%', res;
end
$smoke$;
