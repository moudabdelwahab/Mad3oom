-- ============================================================================
-- طلبات حساب الشركة (068) — فحص Production بعد التثبيت
--
-- كتلة DO واحدة بتنتهي دايمًا بـ RAISE ⇒ المعاملة كلها بترجع: مفيش حساب ولا
-- طلب ولا شركة ولا إشعار بيفضل. الحسابات اصطناعية (company-smoke-<uuid>@example.com)
-- جوه نفس المعاملة، ومفيش تذاكر (ticket_number_seq مايتحركش).
--
-- النتيجة المتوقعة: ERROR P0001  COMPANY_SMOKE_RESULT fails=0 + سطور PASS.
-- ============================================================================
do $smoke$
declare
  u    uuid := gen_random_uuid();   -- عميل يطلب ويتوافق عليه
  u2   uuid := gen_random_uuid();   -- عميل يطلب ويترفض
  adm  uuid := gen_random_uuid();   -- أدمن اصطناعي
  cr   text := 'CR-SMOKE-' || substr(md5(random()::text), 1, 10);
  res  text := '';
  fails int := 0;
  ok boolean;
  st text; msg text;
  r jsonb;
  req1 uuid; req2 uuid;
  n int;
  acct uuid;
begin
  -- ── الإعداد: حسابات اصطناعية معتمدة في البوابة (042/066) ──
  foreach acct in array array[u, u2, adm] loop
    insert into auth.users (id, email) values (acct, 'company-smoke-' || acct || '@example.com');
    insert into public.profiles (id, email, full_name, role)
    values (acct, 'company-smoke-' || acct || '@example.com', 'company smoke', 'user')
    on conflict (id) do nothing;
    update public.waitlist_entries set status = 'approved', approved_user_id = acct
     where lower(email) = 'company-smoke-' || acct || '@example.com';
    if not found then
      insert into public.waitlist_entries (name, email, status, approved_user_id)
      values ('company smoke', 'company-smoke-' || acct || '@example.com', 'approved', acct);
    end if;
  end loop;
  update public.profiles set phone = '01000000168' where id = u;
  update public.profiles set phone = '01000000169' where id = u2;
  update public.profiles set phone = '01000000170', role = 'admin' where id = adm;

  -- ── C1: العميل — الإنشاء الذاتي مقفول، والطلب بيتسجّل بس ──
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  ok := public.account_is_active() and public.my_company_account_request() is null;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' SETUP synthetic customer active, no prior request';
  if not ok then fails := fails + 1; end if;

  begin
    perform public.upsert_my_company('شركة الفحص', cr, '2030-01-01');
    msg := 'ok';
  exception when others then msg := sqlerrm; end;
  begin
    insert into public.companies (user_id, company_name, commercial_registration_number) values (u, 'شركة', cr);
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := msg = 'إنشاء حساب شركة يتم بطلب يراجعه فريق الإدارة' and st = '42501';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C1a self-creation closed: upsert_my_company refuses, direct INSERT 42501 (' || st || ')';
  if not ok then fails := fails + 1; end if;

  r := public.submit_company_account_request('شركة الفحص', cr, '2030-06-30', 'info@smoke.example.com', null, 'support', 'monthly');
  req1 := (r->>'id')::uuid;
  ok := r->>'status' = 'pending' and public.my_company_account_request()->>'status' = 'pending'
        and public.current_company_id() is null;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C1b request submitted as pending, account still individual';
  if not ok then fails := fails + 1; end if;

  begin
    perform public.submit_company_account_request('شركة تانية', cr || 'x', '2030-01-01');
    msg := 'ok';
  exception when others then msg := sqlerrm; end;
  ok := msg = 'لديك طلب حساب شركة قيد المراجعة بالفعل';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C1c second pending request refused';
  if not ok then fails := fails + 1; end if;

  begin
    update public.company_account_requests set status = 'approved' where id = req1;
    st := 'ok';
  exception when others then st := sqlstate; end;
  begin
    perform public.admin_list_company_account_requests();
    msg := 'ok';
  exception when others then msg := sqlstate; end;
  select count(*) into n from public.company_account_requests;
  ok := st = '42501' and msg = '42501' and n = 1;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C1d no direct write (' || st || '), admin RPC refused (' || msg || '), sees own row only (' || n || ')';
  if not ok then fails := fails + 1; end if;
  execute 'reset role';

  -- العميل التاني يطلب (هيترفض)
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.submit_company_account_request('شركة', cr, '2030-01-01');
    msg := 'ok';
  exception when others then msg := sqlerrm; end;
  r := public.submit_company_account_request('شركة الفحص التانية', cr || '-2', '2030-01-01');
  req2 := (r->>'id')::uuid;
  execute 'reset role';
  ok := msg = 'رقم السجل التجاري مرتبط بطلب آخر قيد المراجعة' and req2 is not null;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C1e CR reserved by another pending request is refused';
  if not ok then fails := fails + 1; end if;

  -- ── C2: الأدمن ──
  perform set_config('request.jwt.claim.sub', adm::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  r := public.admin_list_company_account_requests();
  ok := exists (select 1 from jsonb_array_elements(r) e where (e->>'id')::uuid = req1 and e->>'requested_plan' = 'support')
        and exists (select 1 from public.notifications where user_id = adm and reference_id = req1
                      and link = '/admin/company-requests.html');
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C2a admin sees the request and was notified';
  if not ok then fails := fails + 1; end if;

  begin
    update public.profiles set role = 'company_admin' where id = u2;
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := st = '42501';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C2b manual company role grant still refused for admin (' || st || ')';
  if not ok then fails := fails + 1; end if;

  r := public.admin_review_company_account_request(req1, 'approve');
  begin
    perform public.admin_review_company_account_request(req2, 'reject', '  ');
    msg := 'ok';
  exception when others then msg := sqlerrm; end;
  perform public.admin_review_company_account_request(req2, 'reject', 'فحص: بيانات ناقصة');
  execute 'reset role';

  ok := r->>'status' = 'approved'
        and exists (select 1 from public.companies where user_id = u and commercial_registration_number = cr
                      and id = (r->>'company_id')::uuid)
        and (select role from public.profiles where id = u) = 'company_admin'
        and (select user_type from public.profiles where id = u) = 'company'
        and exists (select 1 from public.notifications where user_id = u and reference_id = req1
                      and link = '/subscriptions.html')
        and exists (select 1 from public.privileged_audit where action = 'role.change'
                      and target_user_id = u and actor_id = adm);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C2c approve ⇒ company created, role company_admin (audited as admin), user_type company, customer notified';
  if not ok then fails := fails + 1; end if;

  ok := msg = 'سبب الرفض مطلوب ليظهر للعميل'
        and (select status from public.company_account_requests where id = req2) = 'rejected'
        and (select role from public.profiles where id = u2) = 'user'
        and not exists (select 1 from public.companies where user_id = u2)
        and exists (select 1 from public.notifications where user_id = u2 and reference_id = req2
                      and message like '%فحص: بيانات ناقصة%');
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C2d reject needs a reason; rejected account unchanged and told why';
  if not ok then fails := fails + 1; end if;

  -- ── C3: العميل بعد الموافقة — حساب شركة ──
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.submit_company_account_request('شركة', cr || '-3', '2030-01-01');
    msg := 'ok';
  exception when others then msg := sqlerrm; end;
  ok := public.current_company_id() is not null and public.is_company_admin()
        and public.company_role() = 'company_admin'
        and public.my_company_account_request()->>'status' = 'approved'
        and msg = 'حسابك حساب شركة بالفعل';
  execute 'reset role';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' C3 approved account is a company admin to every company function; cannot request again';
  if not ok then fails := fails + 1; end if;

  raise exception 'COMPANY_SMOKE_RESULT fails=%: %', fails, res;
end
$smoke$;
