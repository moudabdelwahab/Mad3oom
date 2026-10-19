-- ============================================================================
-- التراجع عن 106_account_request_execution — يعيد دوال 105 الخمس حرفيًا (منسوخة من ملف 105) و ticket_quota_status
-- كما في الإنتاج، ويحذف أعمدة
-- محاولات التنفيذ ودالة _json_or_null، ويعيد قيد سبب إنهاء إسناد مدير الحساب.
--
-- يُشغَّل في معاملة واحدة:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/106_account_request_execution.down.sql
-- يرفض (قبل أي تغيير) إن كان مفتاح التنفيذ مفعّلًا، أو وُجد سجل لا يعود عليه 105: محاولة تنفيذ مسجَّلة، أو نقل
-- منفَّذ، أو إسناد أُنهي بالنقل. التاريخ لا يُحذف بتراجع، والتنفيذ المنجز لا يُعكس به.
-- ============================================================================
do $$
begin
  lock table public.account_requests, public.customer_account_managers, public.platform_direct_customers in exclusive mode;
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception 'التراجع عن 106 مرفوض: account_request_execution_enabled مفعّل — أطفئه أولًا';
  end if;
  if exists (select 1 from public.account_requests where attempts > 0 or last_failure is not null) then
    raise exception 'التراجع عن 106 مرفوض: توجد محاولات تنفيذ مسجَّلة (سجل)';
  end if;
  if exists (select 1 from public.account_requests where status = 'approved' and request_type = 'transfer_direct_to_company')
     or exists (select 1 from public.customer_account_managers where end_cause = 'transferred') then
    raise exception 'التراجع عن 106 مرفوض: نقل منفَّذ — لا يعود عليه 105';
  end if;
end $$;

-- دوال 105 حرفيًا

create or replace function public._account_request_checks(p_type text, p_customer uuid, p_customer_email text,
                                                          p_target_email text, p_company uuid, p_exclude uuid default null,
                                                          p_requester uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  a        record;
  v_email  text := public._email_norm(p_customer_email);
  v_target text := public._email_norm(p_target_email);
  v_auth   text;
  v_prof   text;
  c        public.companies;
  r        jsonb := '[]'::jsonb;
begin
  select * into a from public._customer_accounts(p_customer);
  r := r || jsonb_build_object('code', 'customer_exists', 'ok', a.id is not null);
  if a.id is null then
    return r;
  end if;
  v_prof := public._email_norm(a.email);
  select public._email_norm(u.email) into v_auth from auth.users u where u.id = p_customer;
  -- بريد الملف وبريد الدخول يختلفان ⇒ التباس: يُوقف ولا يُخمَّن أيهما الصحيح
  r := r || jsonb_build_object('code', 'email_unambiguous', 'ok', v_prof is not null and (v_auth is null or v_auth = v_prof));
  r := r || jsonb_build_object('code', 'email_matches', 'ok', v_email is not null and v_email = v_prof);
  r := r || jsonb_build_object('code', 'target_email_valid', 'ok',
              v_target is null or v_target ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  -- بريد مختلف يخص حسابًا آخر ⇒ التباس في هوية العميل: يُوقف
  r := r || jsonb_build_object('code', 'target_email_unclaimed', 'ok',
              v_target is null or v_target = v_prof
              or not (exists (select 1 from public.profiles p where public._email_norm(p.email) = v_target and p.id <> p_customer)
                      or exists (select 1 from auth.users u where public._email_norm(u.email) = v_target and u.id <> p_customer)));
  r := r || jsonb_build_object('code', 'customer_is_customer', 'ok',
              a.account_type not in ('platform_staff', 'company_owner', 'company_staff'));
  r := r || jsonb_build_object('code', 'customer_active', 'ok', not a.banned);
  if p_type = 'transfer_direct_to_company' then
    r := r || jsonb_build_object('code', 'customer_is_direct', 'ok', a.account_type in ('direct', 'direct_and_company'));
  end if;
  select * into c from public.companies where id = p_company;
  r := r || jsonb_build_object('code', 'company_exists', 'ok', c.id is not null);
  r := r || jsonb_build_object('code', 'company_active', 'ok', c.id is not null and coalesce(c.status, 'active') = 'active');
  r := r || jsonb_build_object('code', 'not_company_owner', 'ok', c.id is null or c.user_id <> p_customer);
  r := r || jsonb_build_object('code', 'not_already_member', 'ok',
              not exists (select 1 from public.company_memberships m
                           where m.user_id = p_customer and m.company_id = p_company and m.status = 'active'));
  r := r || jsonb_build_object('code', 'no_pending_transfer', 'ok',
              not exists (select 1 from public.customer_transfers x where x.customer_id = p_customer and x.status = 'pending'));
  r := r || jsonb_build_object('code', 'no_conflicting_request', 'ok',
              not exists (select 1 from public.account_requests q
                           where q.customer_id = p_customer and q.status = 'pending' and q.id is distinct from p_exclude));
  -- عند القرار: مقدّم الطلب ما زال إداريًا غير محظور (طلب من أُقيل أو حُظر لا يُنفَّذ)
  if p_requester is not null then
    r := r || jsonb_build_object('code', 'requester_eligible', 'ok',
                exists (select 1 from public.profiles p where p.id = p_requester and p.role = 'admin' and not public.is_banned(p.id)));
  end if;
  return r;
end $$;

create or replace function public._account_request_execution(p_type text, p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_missing text[] := '{}';
begin
  if p_type = 'transfer_direct_to_company' then
    return jsonb_build_object('available', false, 'code', 'operation_not_available', 'missing', '[]'::jsonb);
  end if;
  if not public._feature_on('account_request_execution_enabled') then
    v_missing := array_append(v_missing, 'account_request_execution_enabled');
  end if;
  -- بلا العزل وصلاحيات 098 يرى مالك الشركة تذاكر العميل القديمة عبر super_user_id (كما في 101)
  if not public._feature_on('company_isolation_enforced') then
    v_missing := array_append(v_missing, 'company_isolation_enforced');
  end if;
  if not public._feature_on('company_permissions_enabled') then
    v_missing := array_append(v_missing, 'company_permissions_enabled');
  end if;
  -- عضوية إضافية (للعميل شركة أساسية) لا معنى لها قبل تعدد الشركات
  if p_customer is not null
     and exists (select 1 from public.company_memberships m where m.user_id = p_customer and m.status = 'active' and m.is_primary)
     and not public._feature_on('multi_company_memberships_enabled') then
    v_missing := array_append(v_missing, 'multi_company_memberships_enabled');
  end if;
  return jsonb_build_object('available', cardinality(v_missing) = 0,
                            'code', case when cardinality(v_missing) = 0 then null else 'prerequisite_not_enabled' end,
                            'missing', to_jsonb(v_missing));
end $$;

create or replace function public._account_request_row(r public.account_requests)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'request_type', r.request_type, 'status', r.status,
    'customer_id', r.customer_id, 'customer_name', public._profile_name(r.customer_id), 'customer_email', r.customer_email,
    'target_email', r.target_email,
    'company_id', r.company_id, 'company_name', coalesce((select c.company_name from public.companies c where c.id = r.company_id), 'شركة محذوفة'),
    'reason', r.reason, 'requested_by', r.requested_by, 'requester_name', public._profile_name(r.requested_by),
    'requested_at', r.requested_at, 'decided_by_name', public._profile_name(r.decided_by), 'decided_at', r.decided_at,
    'decision_reason', r.decision_reason, 'outcome', r.outcome);
$$;

create or replace function public.owner_account_request_details(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r public.account_requests;
  a record;
  c public.companies;
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false)
     or not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'صندوق طلبات الحسابات لمالك المنصة وحده' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  select * into r from public.account_requests where id = p_request;
  if r.id is null then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into a from public._customer_accounts(r.customer_id);
  select * into c from public.companies where id = r.company_id;
  return public._account_request_row(r) || jsonb_build_object(
    'snapshot', r.snapshot,
    'customer_now', case when a.id is null then null else jsonb_build_object(
        'account_type', a.account_type, 'email', a.email, 'status', case when a.banned then 'suspended' else 'active' end,
        'is_direct', a.is_direct,
        'companies', coalesce((select jsonb_agg(jsonb_build_object('id', m.company_id, 'name', co.company_name, 'is_primary', m.is_primary)
                                                order by m.is_primary desc)
                                 from public.company_memberships m join public.companies co on co.id = m.company_id
                                where m.user_id = r.customer_id and m.status = 'active' and m.company_id = any (a.member_company_ids)), '[]'::jsonb),
        'open_tickets', (select count(*) from public.tickets t where t.user_id = r.customer_id and t.status in ('open', 'in-progress')),
        'active_subscriptions', (select count(*) from public.whatsapp_subscriptions s where s.user_id = r.customer_id and s.status = 'active'),
        'has_primary_company', a.primary_company_id is not null) end,
    -- بريد التواصل الخاص بالشركة يُعرض منفصلًا عن بريد العميل
    'company', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'name', c.company_name, 'contact_email', c.company_email, 'status', c.status,
        'owner_name', public._profile_name(c.user_id)) end,
    'checks', case when r.status = 'pending'
                   then public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email,
                                                       r.company_id, r.id, r.requested_by) end,
    'execution', case when r.status = 'pending' then public._account_request_execution(r.request_type, r.customer_id) end,
    'self_requested', r.requested_by = auth.uid(),
    'can_decide', r.status = 'pending' and r.requested_by <> auth.uid() and coalesce(public.owner_critical_ok(), false));
end $$;

create or replace function public.owner_decide_account_request(p_request uuid, p_approve boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  r         public.account_requests;
  v_reason  text;
  v_exec    jsonb;
  v_fail    text;
  v_primary boolean;
  v_mid     uuid;
  v_owner   uuid;
  v_ids     record;
begin
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مصرّح' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'القرار لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501', detail = '{"code":"step_up_required"}';
  end if;
  if p_approve is null then
    raise exception 'القرار مطلوب' using errcode = '22023', detail = '{"code":"decision_required"}';
  end if;
  -- ترتيب الأقفال ثابت: الشركة ← حساب العميل ← الطلب — نفس ترتيب حذف الشركة أو الحساب (يقفلان صفّهما ثم
  -- يلغيان الطلب المعلّق بمحفّز)، فلا قفل متبادل. الشركة بقفل مشترك: لا إيقاف ولا حذف أثناء القرار.
  select customer_id, company_id into v_ids from public.account_requests where id = p_request;
  perform 1 from public.companies where id = v_ids.company_id for share;
  perform 1 from public.profiles where id = v_ids.customer_id for update;
  -- القفل يرتّب قرارين متزامنين؛ الثاني يجد الطلب نهائيًا
  select * into r from public.account_requests where id = p_request for update;
  if r.id is null then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if r.status <> 'pending' then
    raise exception 'الطلب نهائي' using errcode = '55000', detail = '{"code":"request_final"}';
  end if;
  if r.requested_by = v_uid then
    raise exception 'لا قرار على طلبك أنت' using errcode = '42501', detail = '{"code":"self_approval"}';
  end if;

  if not p_approve then
    v_reason := public._reason_check(p_reason);
    update public.account_requests
       set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_reason = v_reason
     where id = r.id;
    perform public.log_privileged('account_request.rejected', r.customer_id, null,
                                  jsonb_build_object('request_id', r.id, 'reason', v_reason));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (r.requested_by, 'صدر قرار في طلب حساب', 'قرّر مالك المنصة أحد طلباتك. راجع «طلباتي» لمعرفة القرار.', 'info',
            '/admin/account-requests.html', 'account');
    return jsonb_build_object('request_id', r.id, 'status', 'rejected');
  end if;

  -- الموافقة = التنفيذ. ما لا يمكن تنفيذه لا يُوافَق عليه: يبقى الطلب معلّقًا.
  -- قفل مشترك على مفاتيح التنفيذ: إطفاء العزل في اللحظة نفسها ينتظر هذه المعاملة ثم يرى الموافقة فيرفضه الحارس
  perform 1 from public.platform_feature_switches
   where key in ('account_request_execution_enabled', 'company_isolation_enforced', 'company_permissions_enabled',
                 'multi_company_memberships_enabled')
   for share;
  v_exec := public._account_request_execution(r.request_type, r.customer_id);
  if not coalesce((v_exec ->> 'available')::boolean, false) then
    raise exception 'لا يمكن تنفيذ هذا الطلب بعد (%) — يبقى معلّقًا', v_exec ->> 'code'
      using errcode = '0A000', detail = jsonb_build_object('code', v_exec ->> 'code', 'missing', v_exec -> 'missing')::text;
  end if;

  v_fail := public._account_request_first_failure(
              public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email, r.company_id, r.id,
                                             r.requested_by));
  if v_fail is not null then
    raise exception 'تغيّر حال العميل أو الشركة منذ الطلب (%) — لم يُنفَّذ شيء', v_fail
      using errcode = '55000', detail = jsonb_build_object('code', 'revalidation_failed', 'check', v_fail)::text;
  end if;

  -- التنفيذ (add_to_company): عضوية عميل عبر 096. الأساسية إن لم تكن له شركة أساسية، وإلا إضافية.
  v_primary := not exists (select 1 from public.company_memberships m
                            where m.user_id = r.customer_id and m.status = 'active' and m.is_primary);
  insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
  values (r.company_id, r.customer_id, v_primary, 'account_request')
  returning id into v_mid;
  perform public._membership_event(r.company_id, r.customer_id, 'joined',
                                   jsonb_build_object('via', 'account_request', 'request_id', r.id, 'primary', v_primary));
  if v_primary then
    perform public._membership_apply_mirror(r.customer_id);
  end if;
  -- تحقق النتيجة قبل وسم الطلب: أي انحراف يُلغي المعاملة كلها
  select user_id into v_owner from public.companies where id = r.company_id;
  if not public._company_customer_active(r.company_id, r.customer_id)
     or (v_primary and (select p.super_user_id from public.profiles p where p.id = r.customer_id) is distinct from v_owner) then
    raise exception 'تعذّر التنفيذ — لم يُنفَّذ شيء' using errcode = '55000', detail = '{"code":"execution_failed"}';
  end if;

  v_reason := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  update public.account_requests
     set status = 'approved', decided_by = v_uid, decided_at = now(), decision_reason = v_reason,
         outcome = jsonb_build_object('membership_id', v_mid, 'primary', v_primary)
   where id = r.id;
  perform public.log_privileged('account_request.approved', r.customer_id, null,
                                jsonb_build_object('request_id', r.id, 'company_id', r.company_id, 'membership_id', v_mid,
                                                   'primary', v_primary));
  insert into public.notifications (user_id, title, message, type, link, category)
  values (r.requested_by, 'صدر قرار في طلب حساب', 'قرّر مالك المنصة أحد طلباتك. راجع «طلباتي» لمعرفة القرار.', 'info',
          '/admin/account-requests.html', 'account'),
         (r.customer_id, 'أُضيف حسابك إلى شركة', 'أصبح حسابك عضوًا في شركة على مدعوم. تذاكرك السابقة تبقى خاصة بك.', 'info',
          null, 'account');
  return jsonb_build_object('request_id', r.id, 'status', 'approved', 'membership_id', v_mid, 'primary', v_primary);
end $$;

-- حصة التذاكر كما في الإنتاج قبل 106 حرفيًا
CREATE OR REPLACE FUNCTION public.ticket_quota_status(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner        uuid := public.ticket_account_owner(p_user_id);
  v_period_start timestamptz := date_trunc('month', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo';
  v_period_end   timestamptz := (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month') at time zone 'Africa/Cairo';
  v_plan         text;
  v_sub          public.whatsapp_subscriptions%rowtype;
  v_unlimited    boolean;
  v_limit        integer;
  v_used         integer;
  v_billing      integer;
begin
  if p_user_id is null then
    return null;
  end if;

  select s.* into v_sub
    from public.whatsapp_subscriptions s
    join public.plan_ticket_quotas q on q.plan_key = s.plan
   where s.user_id = v_owner and s.status = 'active'
     and s.start_date <= now() and s.end_date > now()
   order by (q.monthly_tickets is null) desc, q.monthly_tickets desc nulls first, s.end_date desc
   limit 1;

  v_plan := coalesce(v_sub.plan, 'free');
  select q.monthly_tickets is null, q.monthly_tickets into v_unlimited, v_limit
    from public.plan_ticket_quotas q where q.plan_key = v_plan;
  if not found then
    v_unlimited := false; v_limit := 20;
  end if;

  -- تذكرة واحدة تُحسب مرة واحدة في واحد من العدّادين بالضبط
  select count(*) filter (where not b.is_billing),
         count(*) filter (where b.is_billing)
    into v_used, v_billing
    from public.tickets t
    cross join lateral (
      select coalesce(t.category, '') = 'whatsapp_wallet_topup'
             or exists (select 1 from public.whatsapp_subscriptions s where s.ticket_id = t.id) as is_billing
    ) b
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start
     -- 101: التذكرة المنسوخة لا تُحسب مرة ثانية
     and not exists (select 1 from public.ticket_carry_items ci where ci.new_ticket_id = t.id);

  return jsonb_build_object(
    'plan_key',          v_plan,
    'plan_name_ar',      coalesce((select coalesce(sp.name_ar, sp.name) from public.subscription_plans sp where sp.key = v_plan), 'الخطة المجانية'),
    'is_free',           v_sub.id is null,
    'subscription_id',   v_sub.id,
    'subscription_end',  v_sub.end_date,
    'billing_cycle',     v_sub.billing_cycle,
    'account_owner',     v_owner,
    'shared_account',    v_owner is distinct from p_user_id,
    'unlimited',         coalesce(v_unlimited, false),
    'monthly_limit',     case when v_unlimited then null else v_limit end,
    'used',              v_used,
    'remaining',         case when v_unlimited then null else greatest(0, v_limit - v_used) end,
    'billing_used',      v_billing,
    'billing_limit',     5,
    'period_start',      v_period_start,
    'resets_at',         v_period_end);
end;
$function$;

drop function if exists public._json_or_null(text);

alter table public.customer_account_managers drop constraint if exists customer_account_managers_end_cause_check;
alter table public.customer_account_managers add constraint customer_account_managers_end_cause_check
  check (end_cause in ('reassigned', 'unassigned', 'manager_ineligible', 'customer_deleted', 'manager_deleted'));

alter table public.account_requests drop column if exists last_failure;
alter table public.account_requests drop column if exists attempts;
