-- ============================================================================
-- 071 — فحص Production بعد التثبيت: المالك في سياقه الحالي، وعميل حقيقي
--
-- كتلة DO واحدة بتنتهي دايمًا بـ RAISE ⇒ المعاملة كلها بترجع (التعديل
-- التجريبي وإعادة الحساب مابيفضلوش). قراءة كهوية المالك والعميل تحت RLS
-- الحقيقية.
-- اتشغّل على Production يوم 2026-10-09 08:00 UTC ⇒ PASS/PASS (12 اشتراك، 1 شحن).
-- متوقع: المالك في سياق admin يشوف كل طلبات الاشتراك والشحن (نفس عدد
-- الجدول)، يعدّل صف اشتراك، وينادي admin_recompute_user_access؛ العميل يشوف
-- طلباته بس، تعديله 0 صفوف، ونداء الدالة 42501.
-- ============================================================================
do $smoke$
declare
  ow uuid; cu uuid; sub uuid;
  ctx text; n_sub_all int; n_top_all int; n_sub int; n_top int; upd int; acc text;
  n_cust_own int; n_cust_seen int; upd_c int; st text; res text := '';
begin
  select a.user_id into ow from public.platform_authority a where a.level = 'owner' limit 1;
  select s.user_id, s.id into cu, sub from public.whatsapp_subscriptions s
    join public.profiles p on p.id = s.user_id
   where p.role not in ('admin','support','platform_owner') and s.user_id <> ow
   order by s.created_at desc limit 1;
  select count(*) into n_sub_all from public.whatsapp_subscriptions;
  select count(*) into n_top_all from public.whatsapp_wallet_topup_requests;

  perform set_config('request.jwt.claim.sub', ow::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ow, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ctx := public.active_context();
  select count(*) into n_sub from public.whatsapp_subscriptions;
  select count(*) into n_top from public.whatsapp_wallet_topup_requests;
  begin
    update public.whatsapp_subscriptions set reviewed_at = reviewed_at where id = sub;
    get diagnostics upd = row_count;
    acc := public.admin_recompute_user_access(cu)::text;
  exception when others then acc := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  res := res || E'\n' || case when ctx in ('admin','owner') and n_sub = n_sub_all and n_top = n_top_all
                                   and upd = 1 and acc like '{%' then 'PASS' else 'FAIL' end
         || format(' OWNER context=%s sees subscriptions=%s/%s topups=%s/%s, update rows=%s, recompute=%s',
                   ctx, n_sub, n_sub_all, n_top, n_top_all, upd, left(acc, 80));

  select count(*) into n_cust_own from public.whatsapp_subscriptions where user_id = cu;
  perform set_config('request.jwt.claim.sub', cu::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n_cust_seen from public.whatsapp_subscriptions;
  update public.whatsapp_subscriptions set reviewed_at = reviewed_at where id = sub;
  get diagnostics upd_c = row_count;
  begin
    perform public.admin_recompute_user_access(cu);
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  res := res || E'\n' || case when n_cust_seen = n_cust_own and upd_c = 0 and st = '42501' then 'PASS' else 'FAIL' end
         || format(' CUSTOMER sees %s of own %s; update rows=%s; recompute → %s', n_cust_seen, n_cust_own, upd_c, st);

  raise exception 'SMOKE_071_RESULT:%', res;
end
$smoke$;
