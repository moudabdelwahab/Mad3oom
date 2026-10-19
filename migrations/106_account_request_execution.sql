-- ============================================================================
-- 106_account_request_execution.sql
--   تنفيذ حقيقي لطلبات الحسابات (105): «إضافة عميل إلى شركة» و«نقل عميل مباشر إلى شركة».
--   المرجع: docs/tenancy/ACCOUNT_REQUEST_EXECUTION_106.md (قواعد كل فئة بيانات، مصفوفة المتطلبات، خطة الإصدار).
--
--   النقل = نفس الهوية (لا حساب ثانٍ ولا ملف ثانٍ)، في معاملة واحدة:
--     • عضوية أساسية في الشركة (096، joined_via = account_request) + حدث transferred_in + مرآة super_user_id
--     • العلاقة المباشرة بالمنصة تُنهى صراحةً (end_cause = transferred) — السجل يبقى
--     • إسناد مدير الحساب على مستوى المنصة يُنهى (end_cause = transferred) — السجل يبقى
--     • لا شيء آخر يُنقل: التذاكر والمحادثات والمرفقات والإشعارات والاشتراكات والرموز والتكاملات تبقى ملك
--       العميل في مكانها. الشركة لا ترى شيئًا من تاريخه (عزل 097 شرط للتنفيذ)؛ ما يُكتب بعد النقل يتبع الشركة.
--   الإضافة: كما في 105 (أساسية إن لم تكن له شركة، وإلا إضافية مع تعدد الشركات)، والعلاقة المباشرة تبقى.
--
--   الاشتراكات: ما دام super_user_id هو «صاحب الحساب» في حصص التذاكر (ticket_account_owner، 035/098)، فجعل
--   الشركة أساسية يجعل خطتها هي ما يحكم حصة العميل. لذلك يُرفض التنفيذ (لا يُكسر بصمت) إن كان للعميل اشتراك
--   شخصي نشط أو معلّق وسيصير للشركة عضوًا أساسيًا: شرط no_active_personal_subscription ظاهر للمالك.
--
--   الفشل قابل للاستئناف: أي فشل في إعادة التحقق أو التنفيذ يُلغي كل التغييرات (نقطة حفظ)، ثم يُسجَّل على
--   الطلب (attempts, last_failure) ويبقى «قيد القرار». لا يُوسم طلب بالموافقة إلا وقد نُفّذ.
--
--   التنفيذ يبقى مشروطًا بالمفاتيح (account_request_execution_enabled + company_isolation_enforced +
--   company_permissions_enabled، وتعدد الشركات للعضوية الإضافية). كلها مطفأة؛ لا يُفعَّل شيء هنا.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/106_account_request_execution.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.account_requests') is null
     or to_regprocedure('public._account_request_checks(text,uuid,text,text,uuid,uuid,uuid)') is null then
    raise exception '106 يتطلب 105_account_hierarchy_customers';
  end if;
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception '106: account_request_execution_enabled مفعّل — أطفئه قبل الترحيل';
  end if;
end $$;


-- ============================================================================
-- 1) حالة الفشل القابل للاستئناف + سبب إنهاء الإسناد بالنقل
-- ============================================================================
alter table public.account_requests add column if not exists attempts integer not null default 0;
alter table public.account_requests add column if not exists last_failure jsonb;
comment on column public.account_requests.last_failure is
  '106: آخر محاولة تنفيذ فشلت (code, check, sqlstate, at, by). الطلب يبقى pending ويمكن إعادة المحاولة أو الرفض.';

alter table public.customer_account_managers drop constraint if exists customer_account_managers_end_cause_check;
alter table public.customer_account_managers add constraint customer_account_managers_end_cause_check
  check (end_cause in ('reassigned', 'unassigned', 'manager_ineligible', 'customer_deleted', 'manager_deleted', 'transferred'));


-- ============================================================================
-- 2) الشروط: النقل لعميل مباشر خالص؛ لا كسر صامت لاشتراك شخصي
-- ============================================================================
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
  v_becomes_primary boolean;
begin
  select * into a from public._customer_accounts(p_customer);
  r := r || jsonb_build_object('code', 'customer_exists', 'ok', a.id is not null);
  if a.id is null then
    return r;
  end if;
  v_prof := public._email_norm(a.email);
  select public._email_norm(u.email) into v_auth from auth.users u where u.id = p_customer;
  r := r || jsonb_build_object('code', 'email_unambiguous', 'ok', v_prof is not null and (v_auth is null or v_auth = v_prof));
  r := r || jsonb_build_object('code', 'email_matches', 'ok', v_email is not null and v_email = v_prof);
  r := r || jsonb_build_object('code', 'target_email_valid', 'ok',
              v_target is null or v_target ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  r := r || jsonb_build_object('code', 'target_email_unclaimed', 'ok',
              v_target is null or v_target = v_prof
              or not (exists (select 1 from public.profiles p where public._email_norm(p.email) = v_target and p.id <> p_customer)
                      or exists (select 1 from auth.users u where public._email_norm(u.email) = v_target and u.id <> p_customer)));
  r := r || jsonb_build_object('code', 'customer_is_customer', 'ok',
              a.account_type not in ('platform_staff', 'company_owner', 'company_staff'));
  r := r || jsonb_build_object('code', 'customer_active', 'ok', not a.banned);
  -- 106 (مراجعة M1): الحساب يجتاز بوابة الحساب (042) الآن، قبل أي تغيير. التنفيذ يجعل رتبته company_user التي
  -- تعبر قائمة الانتظار تلقائيًا — فلا يصير طلب حساب طريقًا لتجاوز رفض الانتظار أو التحقق.
  r := r || jsonb_build_object('code', 'customer_gate_ok', 'ok',
              coalesce(public.gate_is_exempt_account(p_customer), false)
              or (coalesce(public.account_is_whitelisted(p_customer), false)
                  and coalesce(public.account_verification_ok(p_customer), false)));
  -- 106 (مراجعة L4): مقدّم الطلب ليس طرفًا في الشركة الوجهة (مالكها أو موظفًا فيها)
  r := r || jsonb_build_object('code', 'requester_not_destination_party', 'ok',
              coalesce(p_requester, auth.uid()) is null
              or (not exists (select 1 from public.companies co where co.id = p_company and co.user_id = coalesce(p_requester, auth.uid()))
                  and public._company_staff_role_of(p_company, coalesce(p_requester, auth.uid())) is null));
  if p_type = 'transfer_direct_to_company' then
    -- 106: النقل لعميل مباشر بلا أي شركة؛ من له شركة يمرّ بنقل 101 (موافقة الشركتين) لا من هنا
    r := r || jsonb_build_object('code', 'customer_is_direct', 'ok', a.account_type = 'direct');
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
  -- 106: من سيصير للشركة عضوًا أساسيًا تنتقل حصة تذاكره إلى خطة الشركة (ticket_account_owner). اشتراك شخصي
  -- نشط أو معلّق يُكسر بصمت لو نُفّذ — فيُرفض حتى ينتهي أو يُعالَج من إدارة الاشتراكات.
  v_becomes_primary := p_type = 'transfer_direct_to_company'
                       or not exists (select 1 from public.company_memberships m
                                       where m.user_id = p_customer and m.status = 'active' and m.is_primary);
  if v_becomes_primary then
    r := r || jsonb_build_object('code', 'no_active_personal_subscription', 'ok',
                -- (مراجعة M3) كل طلب اشتراك معلّق يمنع، أيًّا كان تاريخ انتهائه المؤقت
                not exists (select 1 from public.whatsapp_subscriptions s
                             where s.user_id = p_customer
                               and (s.status = 'pending'
                                    or (s.status = 'active' and (s.end_date is null or s.end_date > now())))));
  end if;
  if p_requester is not null then
    r := r || jsonb_build_object('code', 'requester_eligible', 'ok',
                exists (select 1 from public.profiles p where p.id = p_requester and p.role = 'admin' and not public.is_banned(p.id)));
  end if;
  return r;
end $$;


-- ============================================================================
-- 3) إمكان التنفيذ: النقل صار متاحًا بنفس المتطلبات الأمنية
-- ============================================================================
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
  if p_type is null or p_type not in ('add_to_company', 'transfer_direct_to_company') then
    return jsonb_build_object('available', false, 'code', 'invalid_type', 'missing', '[]'::jsonb);
  end if;
  if not public._feature_on('account_request_execution_enabled') then
    v_missing := array_append(v_missing, 'account_request_execution_enabled');
  end if;
  -- بلا العزل وصلاحيات 098 يرى مالك الشركة تاريخ العميل عبر super_user_id: لا تنفيذ قبلهما
  if not public._feature_on('company_isolation_enforced') then
    v_missing := array_append(v_missing, 'company_isolation_enforced');
  end if;
  if not public._feature_on('company_permissions_enabled') then
    v_missing := array_append(v_missing, 'company_permissions_enabled');
  end if;
  if p_type = 'add_to_company' and p_customer is not null
     and exists (select 1 from public.company_memberships m where m.user_id = p_customer and m.status = 'active' and m.is_primary)
     and not public._feature_on('multi_company_memberships_enabled') then
    v_missing := array_append(v_missing, 'multi_company_memberships_enabled');
  end if;
  return jsonb_build_object('available', cardinality(v_missing) = 0,
                            'code', case when cardinality(v_missing) = 0 then null else 'prerequisite_not_enabled' end,
                            'missing', to_jsonb(v_missing));
end $$;


-- ============================================================================
-- 4) صف الطلب: محاولات التنفيذ وآخر فشل
-- ============================================================================
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
    'decision_reason', r.decision_reason, 'outcome', r.outcome,
    'attempts', r.attempts, 'last_failure', r.last_failure);
$$;

create or replace function public._json_or_null(p text)
returns jsonb
language plpgsql
immutable
as $$
begin
  return p::jsonb;
exception when others then
  return null;
end $$;


-- ============================================================================
-- 5) تفاصيل الطلب للمالك: ملخص أثر حقيقي لكل فئة بيانات
-- ============================================================================
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
  v_primary boolean;
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
  v_primary := r.request_type = 'transfer_direct_to_company'
               or not exists (select 1 from public.company_memberships m
                               where m.user_id = r.customer_id and m.status = 'active' and m.is_primary);
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
        'has_primary_company', a.primary_company_id is not null,
        'gate_ok', coalesce(public.gate_is_exempt_account(r.customer_id), false)
                   or (coalesce(public.account_is_whitelisted(r.customer_id), false)
                       and coalesce(public.account_verification_ok(r.customer_id), false)),
        'platform_manager', case when a.manager_id is null then null
                                 else jsonb_build_object('id', a.manager_id, 'name', public._profile_name(a.manager_id)) end) end,
    'company', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'name', c.company_name, 'contact_email', c.company_email, 'status', c.status,
        'owner_name', public._profile_name(c.user_id)) end,
    -- ما سيحدث فعلًا لكل فئة (الواجهة تعرضه كما هو؛ لا وعد بنقل ما لا يُنقل)
    'impact', jsonb_build_object(
        'membership', case when v_primary then 'primary' else 'secondary' end,
        'direct_relationship', case when r.request_type = 'transfer_direct_to_company' then 'ended' else 'kept' end,
        'platform_account_manager', case when r.request_type = 'transfer_direct_to_company' and a.manager_id is not null
                                         then 'ended' else 'kept' end,
        -- (مراجعة M2) من تاريخ الانضمام فقط: تذاكره الشخصية السابقة لا تُحسب على الشركة ولا يظهر عددها لها
        'ticket_quota_owner', case when v_primary then 'company_from_join' else 'unchanged' end,
        'historical_tickets', 'stay_private',
        'conversations_and_attachments', 'stay_private',
        'notifications', 'unchanged',
        'subscriptions', 'stay_with_customer',
        'api_tokens_and_integrations', 'unchanged',
        'login_identity', 'unchanged'),
    'checks', case when r.status = 'pending'
                   then public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email,
                                                       r.company_id, r.id, r.requested_by) end,
    'execution', case when r.status = 'pending' then public._account_request_execution(r.request_type, r.customer_id) end,
    'self_requested', r.requested_by = auth.uid(),
    'can_decide', r.status = 'pending' and r.requested_by <> auth.uid() and coalesce(public.owner_critical_ok(), false));
end $$;


-- ============================================================================
-- 6) القرار: الموافقة = تنفيذ ذري؛ الفشل يُسجَّل ويبقى الطلب قابلًا للاستئناف
-- ============================================================================
create or replace function public.owner_decide_account_request(p_request uuid, p_approve boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid       uuid := auth.uid();
  r           public.account_requests;
  v_reason    text;
  v_exec      jsonb;
  v_fail      text;
  v_primary   boolean;
  v_transfer  boolean;
  v_mid       uuid;
  v_owner     uuid;
  v_ids       record;
  v_n         integer;
  v_manager   uuid;
  v_state     text;
  v_msg       text;
  v_detail_t  text;
  v_detail    jsonb;
  v_failure   jsonb;
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
  -- ترتيب الأقفال ثابت: الشركة ← حساب العميل ← الطلب (نفس ترتيب الحذف)
  select customer_id, company_id into v_ids from public.account_requests where id = p_request;
  perform 1 from public.companies where id = v_ids.company_id for share;
  -- (مراجعة M3) قفل هوية الدخول: إدراج اشتراك جديد له (مفتاحه الخارجي إلى auth.users) ينتظر هذه المعاملة،
  -- فلا يُشترى اشتراك شخصي بين الفحص والتنفيذ. ترتيب الحذف نفسه: auth.users ← profiles ← الطلب.
  perform 1 from auth.users where id = v_ids.customer_id for update;
  perform 1 from public.profiles where id = v_ids.customer_id for update;
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

  -- قفل مشترك على مفاتيح التنفيذ حتى نهاية المعاملة (لا تغيير لها في منتصف التنفيذ)
  perform 1 from public.platform_feature_switches
   where key in ('account_request_execution_enabled', 'company_isolation_enforced', 'company_permissions_enabled',
                 'multi_company_memberships_enabled')
   for share;
  v_transfer := r.request_type = 'transfer_direct_to_company';
  v_reason := nullif(left(btrim(coalesce(p_reason, '')), 500), '');

  -- نقطة حفظ: كل ما بداخلها ينفَّذ كله أو لا شيء منه
  begin
    v_exec := public._account_request_execution(r.request_type, r.customer_id);
    if not coalesce((v_exec ->> 'available')::boolean, false) then
      raise exception 'لا يمكن تنفيذ هذا الطلب بعد (%)', v_exec ->> 'code'
        using errcode = '0A000', detail = jsonb_build_object('code', v_exec ->> 'code', 'missing', v_exec -> 'missing')::text;
    end if;
    v_fail := public._account_request_first_failure(
                public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email, r.company_id,
                                               r.id, r.requested_by));
    if v_fail is not null then
      raise exception 'تغيّر حال العميل أو الشركة منذ الطلب (%)', v_fail
        using errcode = '55000', detail = jsonb_build_object('code', 'revalidation_failed', 'check', v_fail)::text;
    end if;

    v_primary := v_transfer or not exists (select 1 from public.company_memberships m
                                            where m.user_id = r.customer_id and m.status = 'active' and m.is_primary);
    insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
    values (r.company_id, r.customer_id, v_primary, 'account_request')
    returning id into v_mid;
    perform public._membership_event(r.company_id, r.customer_id, case when v_transfer then 'transferred_in' else 'joined' end,
                                     jsonb_build_object('via', 'account_request', 'request_id', r.id, 'primary', v_primary,
                                                        'from', case when v_transfer then 'platform_direct' end));
    if v_primary then
      perform public._membership_apply_mirror(r.customer_id);
    end if;

    if v_transfer then
      -- العلاقة المباشرة تُنهى صراحةً (سطر واحد بالضبط)، والسجل يبقى
      update public.platform_direct_customers
         set ended_at = now(), ended_by = v_uid, end_cause = 'transferred'
       where user_id = r.customer_id and ended_at is null;
      get diagnostics v_n = row_count;
      if v_n <> 1 then
        raise exception 'تعذّر إنهاء العلاقة المباشرة' using errcode = '55000', detail = '{"code":"execution_failed","check":"direct_relationship"}';
      end if;
      -- مدير الحساب على مستوى المنصة يُنهى؛ العميل صار عميل شركة
      update public.customer_account_managers
         set ended_at = now(), ended_by = v_uid, end_cause = 'transferred'
       where customer_id = r.customer_id and scope = 'platform' and ended_at is null
      returning manager_id into v_manager;
    end if;

    -- تحقق النتيجة قبل وسم الطلب
    select user_id into v_owner from public.companies where id = r.company_id;
    if not public._company_customer_active(r.company_id, r.customer_id)
       or (v_primary and (select p.super_user_id from public.profiles p where p.id = r.customer_id) is distinct from v_owner)
       or public._company_staff_role_of(r.company_id, r.customer_id) is not null
       or (v_transfer and (select a.account_type from public._customer_accounts(r.customer_id) a) <> 'company_customer') then
      raise exception 'تعذّر التنفيذ' using errcode = '55000', detail = '{"code":"execution_failed","check":"verification"}';
    end if;

    update public.account_requests
       set status = 'approved', decided_by = v_uid, decided_at = now(), decision_reason = v_reason,
           outcome = jsonb_build_object('membership_id', v_mid, 'primary', v_primary,
                                        'direct_relationship_ended', v_transfer,
                                        'platform_manager_ended', v_manager is not null,
                                        'previous_platform_manager', v_manager,
                                        'executed_at', now())
     where id = r.id;
    perform public.log_privileged(case when v_transfer then 'account_request.transferred' else 'account_request.approved' end,
                                  r.customer_id, jsonb_build_object('direct', v_transfer, 'manager_id', v_manager),
                                  jsonb_build_object('request_id', r.id, 'company_id', r.company_id, 'membership_id', v_mid,
                                                     'primary', v_primary));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (r.requested_by, 'صدر قرار في طلب حساب', 'قرّر مالك المنصة أحد طلباتك. راجع «طلباتي» لمعرفة القرار.', 'info',
            '/admin/account-requests.html', 'account'),
           (r.customer_id,
            case when v_transfer then 'نُقل حسابك إلى شركة' else 'أُضيف حسابك إلى شركة' end,
            'أصبح حسابك عضوًا في شركة على مدعوم بنفس بيانات الدخول. تذاكرك ومحادثاتك السابقة تبقى خاصة بك.', 'info',
            null, 'account');
    if v_manager is not null and v_manager <> v_uid then
      insert into public.notifications (user_id, title, message, type, link, category)
      values (v_manager, 'انتهى إسناد عميل', 'أحد عملائك صار عميل شركة، فانتهى إسنادك له كمدير حساب.', 'info',
              '/admin/customers.html', 'account');
    end if;
    return jsonb_build_object('request_id', r.id, 'status', 'approved', 'membership_id', v_mid, 'primary', v_primary,
                              'direct_relationship_ended', v_transfer, 'platform_manager_ended', v_manager is not null);
  exception when others then
    -- كل ما في نقطة الحفظ أُلغي. الطلب يبقى pending، ويُسجَّل الفشل ليُرى ويُعاد أو يُرفض.
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    get stacked diagnostics v_detail_t = pg_exception_detail;
    v_detail := public._json_or_null(v_detail_t);
    v_failure := jsonb_build_object('sqlstate', v_state,
                                    'code', coalesce(v_detail ->> 'code', case v_state when '0A000' then 'prerequisite_not_enabled'
                                                                                       else 'execution_failed' end),
                                    'check', v_detail ->> 'check', 'missing', v_detail -> 'missing',
                                    'at', now(), 'by', v_uid);
    update public.account_requests
       set attempts = attempts + 1, last_failure = v_failure
     where id = r.id;
    perform public.log_privileged('account_request.execution_failed', r.customer_id, null,
                                  jsonb_build_object('request_id', r.id, 'failure', v_failure));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (r.requested_by, 'تعذّر تنفيذ طلب حساب', 'لم يُنفَّذ أحد طلباتك ولم يتغير شيء. الطلب ما زال قيد القرار.', 'warning',
            '/admin/account-requests.html', 'account');
    return jsonb_build_object('request_id', r.id, 'status', 'pending', 'outcome', 'failed', 'recoverable', true,
                              'code', v_failure ->> 'code', 'check', v_failure ->> 'check', 'missing', v_failure -> 'missing',
                              'attempts', r.attempts + 1);
  end;
end $$;


-- ============================================================================
-- 6ب) حصة التذاكر: لا يُحسب تاريخ العميل الشخصي على الشركة (نص الإنتاج حرفيًا والتغيير في الشرط وحده)
-- ============================================================================
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
   -- 106 (مراجعة M2): تذاكر التابع تُحسب على صاحب الحساب من تاريخ عضويته الأساسية في شركته فقط. ما كتبه قبل
   -- انضمامه (تذاكره الشخصية مع مدعوم) يبقى خارج حصة الشركة وعدّادها — كما سجّله دفتر 098 لحظة إنشائه.
   where (t.user_id = v_owner
          or exists (select 1 from public.profiles p
                       join public.company_memberships m on m.user_id = p.id and m.status = 'active' and m.is_primary
                       join public.companies c on c.id = m.company_id and c.user_id = v_owner
                      where p.id = t.user_id and p.super_user_id = v_owner and t.created_at >= m.joined_at))
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

-- ============================================================================
-- 7) الامتيازات + تحقق ذاتي
-- ============================================================================
revoke all on function public._json_or_null(text) from public, anon, authenticated, service_role;
revoke all on function public._account_request_row(public.account_requests) from public, anon, authenticated, service_role;
revoke all on function public._account_request_checks(text,uuid,text,text,uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public._account_request_execution(text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.owner_account_request_details(uuid) from public, anon, service_role;
grant execute on function public.owner_account_request_details(uuid) to authenticated;
revoke all on function public.owner_decide_account_request(uuid,boolean,text) from public, anon, service_role;
grant execute on function public.owner_decide_account_request(uuid,boolean,text) to authenticated;

do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception '106: account_request_execution_enabled مفعّل';
  end if;
  if has_function_privilege('authenticated', 'public._json_or_null(text)', 'execute')
     or has_function_privilege('authenticated', 'public._account_request_checks(text,uuid,text,text,uuid,uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.owner_decide_account_request(uuid,boolean,text)', 'execute') then
    raise exception '106: دالة داخلية أو واجهة مفتوحة';
  end if;
  if position('m.joined_at' in pg_get_functiondef('public.ticket_quota_status(uuid)'::regprocedure)) = 0 then
    raise exception '106: شرط حصة التذاكر غير مركّب';
  end if;
  if position('transfer_direct_to_company' in pg_get_functiondef('public.owner_decide_account_request(uuid,boolean,text)'::regprocedure)) = 0 then
    raise exception '106: مسار النقل غير مركّب';
  end if;
end $$;
