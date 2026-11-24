-- ============================================================================
-- 129_owner_account_transfer_details.sql — نقل الحساب + تفاصيله الكاملة + تعديل بياناته.
--
-- الثلاثة في owner/accounts.html، للمالك وحده. لا جداول جديدة، لا تغيير
-- مفاتيح، لا تفعيل حسابات، لا حذف فيزيائي لأي سجل. قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/129_owner_account_transfer_details.down.sql
--
-- ما أُعيد استعماله (لا تكرار لمنطق قائم):
--   • _transfer_execute() وجدول customer_transfers (101): التنفيذ الذري
--     لنقل العضوية الأساسية، بما فيه إنشاء عضوية الوجهة إن غابت
--     (initiated_as='owner') وإشعار العميل داخل التطبيق.
--   • owner_assign_company_unit() (099): نقل شركة بين وحدتين — مسار قائم
--     كامل (إنهاء الإسناد السابق + سطر جديد + hierarchy_events)، فلا RPC
--     جديد له؛ الواجهة تناديه مباشرةً والسبب ≥20 حرفًا فيها (حده في القاعدة 10).
--   • _reason_check() (099): السبب ≥10 أحرف، مقصوص عند 500.
--   • _company_customer_active() (096): العميل النشط في شركة (ليس مالكها ولا موظفها).
--   • log_privileged() (053/121) و _hierarchy_event() (099): سجلا التدقيق.
--   • أشكال admin_customer_details() (105) و admin_list_subscriptions() (018):
--     تفاصيل العميل تعيد الحقول نفسها (عضويات/مدير/اشتراكات/طلبات/سجل) لكن
--     بقراءة مباشرة، لأن admin_customer_details() تمرّ عبر
--     is_support_user() (رتبة admin حرفيًا) فليست مضمونة في سياق المالك
--     وحده — والجديد يحرسه owner_capability('owner_only') بنفسه.
--
-- لماذا RPC نقل جديد مع أن owner_transfer_exceptional() (101) موجود؟
--   • الاستثنائي يستدعي _transfers_require_enabled() فيشترط مفتاح
--     customer_transfers_enabled (مفتاح إطلاق لمسار موافقات العميل الذاتي).
--     النقل من شجرة المالك ليس جزءًا من ذلك المسار، فلا يصح أن يموت
--     صامتًا إن أُطفئ المفتاح.
--   • الاستثنائي لا يكتب في hierarchy_events إطلاقًا؛ الجديد يكتب حدثين
--     (خروج من المصدر + دخول إلى الوجهة) فيتسلسل النقل في سجل العقدة.
--   • ما يبقى من 101 هو قيد السلامة لا قيد الإطلاق: العزل
--     (company_isolation_enforced) وصلاحيات الفريق (company_permissions_enabled)
--     شرطان لئلا يرى مالك الوجهة تذاكر العميل القديمة عبر super_user_id.
--     الجديد يفحصهما مباشرةً (_owner_transfer_safety_ok) بلا اشتراط مفتاح النقل.
--     ملاحظة حية (تحقَّق منها بقراءة Supabase في 2026-11-24): كل مفاتيح
--     النقل والعزل والصلاحيات والتفويض مفعّلة منذ 2026-10-21، خلافًا لما
--     زعمه تدقيق سابق بأنها مطفأة — فالاستثنائي يعمل اليوم أيضًا، والجديد
--     يبقى مستقلًا عن المفتاح وعن سجل العقدة.
--
-- معنى «النقل» هنا (قرار موثَّق): نقل العضوية الأساسية للعميل بين شركتين،
-- ونقل الشركة بين وحدتين — أي نقل العقدة بين آباء الشجرة. ليس نقل ملكية
-- حساب (تغيير user_id لشركة) ولا نقل ملكية الشركة؛ فمالك الشركة وموظفها
-- ليسا «عميلًا نشطًا» فيها (_company_customer_active) فيرفض نقلهما بهذا
-- المسار برسالة صريحة، والعميل المباشر بلا عضوية أساسية يحتاج انضمامًا
-- لشركة أولًا عبر مسار العضوية (096) قبل نقله.
--
-- التعديل: الاسم الكامل والجوال فقط. البريد بلا مسار معتمد (يعيش في
-- auth.users وفي profiles معًا؛ تغييره من هنا يُفكّ ارتباط الدخول)،
-- والرتبة عبر مراجعات الإدارة (099/053) لا من هذه الدالة — فالتوقيع نفسه
-- بلا معامل بريد أو رتبة، والواجهة تعرضهما قراءة فقط مع السبب.
-- ============================================================================

-- ── قيد سلامة النقل: العزل + صلاحيات الفريق، بلا اشتراط مفتاح الإطلاق ────────
create or replace function public._owner_transfer_safety_ok()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not (public._feature_on('company_isolation_enforced') and public._feature_on('company_permissions_enabled')) then
    raise exception 'النقل يتطلب تفعيل عزل الشركات وصلاحيات الفريق أولًا' using errcode = '0A000',
      detail = '{"code":"prerequisite_not_enabled"}';
  end if;
end $$;

-- ── 1) نقل عميل بين شركتين (عضويته الأساسية) ───────────────────────────────
create or replace function public.owner_account_transfer(p_customer uuid, p_to_company uuid, p_reason text,
                                                         p_keep_source_secondary boolean default false,
                                                         p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_from uuid;
  x public.customer_transfers;
  r jsonb;
  v_kept boolean;
begin
  perform public._owner_transfer_safety_ok();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'نقل الحساب لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 20 then
    raise exception 'سبب النقل مطلوب (20 حرفًا على الأقل)' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023';
  end if;
  select * into x from public.customer_transfers where initiated_by = auth.uid() and idempotency_key = p_idempotency_key;
  if x.id is not null then
    return jsonb_build_object('transfer_id', x.id, 'status', x.status, 'replayed', true);
  end if;

  select company_id into v_from from public.company_memberships
   where user_id = p_customer and status = 'active' and is_primary;
  if v_from is null then
    raise exception 'لا شركة أساسية للعميل — انضمامه لشركة أولًا عبر مسار العضوية قبل نقله' using errcode = 'P0002';
  end if;
  if p_to_company is null or v_from = p_to_company
     or not exists (select 1 from public.companies where id = p_to_company)
     or exists (select 1 from public.companies where id = p_to_company and user_id = p_customer) then
    raise exception 'العميل أو شركة الوجهة غير صالح للنقل' using errcode = 'P0002';
  end if;
  if not public._company_customer_active(v_from, p_customer) then
    raise exception 'مالك الشركة أو موظفها لا يُنقل بهذا المسار — انقل الشركة نفسها بين الوحدات' using errcode = '55000';
  end if;

  -- طلب معلّق واحد لكل عميل: نقل المالك يلغي ما قبله كما في الاستثنائي (101).
  update public.customer_transfers set status = 'cancelled', outcome = jsonb_build_object('reason', 'owner_account_transfer')
   where customer_id = p_customer and status = 'pending';
  insert into public.customer_transfers (customer_id, from_company, to_company, initiated_by, initiated_as, idempotency_key,
                                         keep_source_secondary, owner_reason)
  values (p_customer, v_from, p_to_company, auth.uid(), 'owner', p_idempotency_key,
          coalesce(p_keep_source_secondary, false), left(v_reason, 500))
  returning * into x;
  perform public.log_privileged('customer.transfer.owner', p_customer, jsonb_build_object('company_id', v_from),
                                jsonb_build_object('company_id', p_to_company, 'reason', left(v_reason, 500), 'transfer_id', x.id));
  r := public._transfer_execute(x.id);
  if r ->> 'status' is distinct from 'completed' then
    -- كل شيء أو لا شيء: لا إلغاء لطلبات أخرى ولا سجل امتياز لنقل لم يحدث
    raise exception 'تعذّر نقل الحساب: تغيّرت عضويات العميل (%)', coalesce(r ->> 'reason', r ->> 'status')
      using errcode = '55000';
  end if;
  v_kept := coalesce((r ->> 'kept_source_secondary')::boolean, false);
  perform public._hierarchy_event('customer.transferred', null, v_from, p_customer,
                                  jsonb_build_object('transfer_id', x.id, 'to_company', p_to_company,
                                                     'reason', left(v_reason, 500), 'kept_secondary', v_kept));
  perform public._hierarchy_event('customer.transferred_in', null, p_to_company, p_customer,
                                  jsonb_build_object('transfer_id', x.id, 'from_company', v_from,
                                                     'reason', left(v_reason, 500)));
  return r || jsonb_build_object('owner_transfer', true);
end $$;

comment on function public.owner_account_transfer(uuid, uuid, text, boolean, uuid) is
  'نقل العضوية الأساسية لعميل بين شركتين من شجرة المالك: تحقق بخطوتين + سبب ≥20 حرفًا + مفتاح منع تكرار، يعيد استخدام _transfer_execute() وcustomer_transfers (101)، ويكتب في hierarchy_events وlog_privileged. مستقل عن مفتاح customer_transfers_enabled، ومشروط بعزل الشركات وصلاحيات الفريق.';

-- ── 2) تفاصيل الحساب كاملة (قراءة فقط) ─────────────────────────────────────
create or replace function public.owner_account_details(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  p public.profiles;
  v_owned uuid;
  v_staff_company uuid;
  v_result jsonb;
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  select * into p from public.profiles where id = p_user_id;
  if p.id is null then
    raise exception 'الحساب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select id into v_owned from public.companies where user_id = p_user_id limit 1;
  select company_id into v_staff_company from public.company_staff
   where user_id = p_user_id and revoked_at is null limit 1;

  select jsonb_build_object(
    'profile', jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone,
      'whatsapp_phone', p.whatsapp_phone, 'whatsapp_enabled', p.whatsapp_enabled,
      'is_verified', p.is_verified, 'role', p.role, 'points', coalesce(p.points, 0),
      'created_at', p.created_at, 'updated_at', p.updated_at,
      'status', case when public.is_banned(p.id) then 'suspended' else 'active' end,
      'ban_until', case when public.is_banned(p.id) then p.ban_until end),
    'account_type', case
      when p.role in ('platform_owner', 'admin', 'support') then 'platform_staff'
      when v_owned is not null then 'company_owner'
      when v_staff_company is not null then 'company_staff'
      when exists (select 1 from public.platform_direct_customers d where d.user_id = p.id and d.ended_at is null)
       and exists (select 1 from public.company_memberships m where m.user_id = p.id and m.status = 'active') then 'direct_and_company'
      when exists (select 1 from public.company_memberships m where m.user_id = p.id and m.status = 'active') then 'company_customer'
      when exists (select 1 from public.platform_direct_customers d where d.user_id = p.id and d.ended_at is null) then 'direct'
      else 'unclassified' end,
    'direct', (select jsonb_build_object('since', d.since, 'source', d.source)
                 from public.platform_direct_customers d where d.user_id = p.id and d.ended_at is null limit 1),
    'owned_company', (select jsonb_build_object('id', c.id, 'name', c.company_name, 'status', c.status)
                        from public.companies c where c.id = v_owned),
    'staff', case when v_staff_company is null then null
                  else jsonb_build_object('company_id', v_staff_company,
                         'company_name', (select c.company_name from public.companies c where c.id = v_staff_company)) end,
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object(
                       'company_id', m.company_id, 'company_name', coalesce(c.company_name, 'شركة محذوفة'),
                       'is_primary', m.is_primary, 'status', m.status, 'joined_at', m.joined_at, 'joined_via', m.joined_via,
                       'ended_at', m.ended_at, 'end_cause', m.end_cause) order by m.joined_at desc), '[]'::jsonb)
                      from public.company_memberships m left join public.companies c on c.id = m.company_id
                     where m.user_id = p.id),
    'manager', (select jsonb_build_object('id', am.manager_id, 'name', public._profile_name(am.manager_id))
                  from public.customer_account_managers am
                 where am.customer_id = p.id and am.scope = 'platform' and am.ended_at is null limit 1),
    'manager_history', (select coalesce(jsonb_agg(jsonb_build_object(
                           'manager_id', h.manager_id, 'manager_name', public._profile_name(h.manager_id),
                           'assigned_by_name', public._profile_name(h.assigned_by), 'assigned_at', h.assigned_at,
                           'reason', h.reason, 'ended_at', h.ended_at, 'end_cause', h.end_cause)
                         order by h.assigned_at desc), '[]'::jsonb)
                         from public.customer_account_managers h where h.customer_id = p.id),
    -- كل الاشتراكات لا الأحدث فقط، بالشكل نفسه في admin_list_subscriptions() (018).
    'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', s.id, 'plan', s.plan, 'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
                         'status', s.status, 'billing_cycle', s.billing_cycle,
                         'start_date', s.start_date, 'end_date', s.end_date, 'created_at', s.created_at,
                         'company_id', s.company_id, 'company_name', c.company_name,
                         'is_active', (s.status = 'active' and s.end_date > now()),
                         'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int)
                       order by s.start_date desc nulls last), '[]'::jsonb)
                       from public.whatsapp_subscriptions s
                       left join public.subscription_plans sp on sp.key = s.plan
                       left join public.companies c on c.id = s.company_id
                      where s.user_id = p.id),
    'wallet', (select jsonb_build_object('total_points', w.total_points, 'available_points', w.available_points,
                                         'is_frozen', coalesce(w.is_frozen, false))
                 from public.user_wallets w where w.user_id = p.id),
    -- أحدث قيود الاستهلاك: الحساب المفوتر هو مالك الحساب (098: ticket_account_owner).
    'usage', (select coalesce(jsonb_agg(jsonb_build_object(
                        'recorded_at', u.recorded_at, 'period', u.period, 'event', u.event, 'counter', u.counter,
                        'units', u.units, 'ticket_id', u.ticket_id, 'company_id', u.company_id, 'source', u.source)
                      order by u.recorded_at desc), '[]'::jsonb)
               from (select * from public.usage_ledger u
                      where u.account_id = p.id or u.ticket_user_id = p.id
                      order by u.recorded_at desc limit 10) u),
    'tickets', jsonb_build_object(
      'counts', (select coalesce(jsonb_object_agg(t.status, t.n), '{}'::jsonb)
                   from (select status, count(*) as n from public.tickets where user_id = p.id group by status) t),
      'open', (select count(*) from public.tickets where user_id = p.id and status in ('open', 'in-progress')),
      'latest', (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', t.id, 'ticket_number', t.ticket_number, 'title', t.title, 'status', t.status,
                           'company_id', t.company_id, 'company_name', c.company_name, 'created_at', t.created_at)
                         order by t.created_at desc), '[]'::jsonb)
                   from (select * from public.tickets where user_id = p.id order by created_at desc limit 10) t
                   left join public.companies c on c.id = t.company_id)),
    'transfers', jsonb_build_object(
      'pending', (select count(*) from public.customer_transfers x where x.customer_id = p.id and x.status = 'pending'),
      'latest', (select coalesce(jsonb_agg(jsonb_build_object(
                            'id', x.id, 'from_company', coalesce(f.company_name, 'شركة محذوفة'),
                            'to_company', coalesce(t.company_name, 'شركة محذوفة'), 'status', x.status,
                            'initiated_as', x.initiated_as, 'created_at', x.created_at, 'completed_at', x.completed_at)
                          order by x.created_at desc), '[]'::jsonb)
                    from (select * from public.customer_transfers where customer_id = p.id order by created_at desc limit 10) x
                    left join public.companies f on f.id = x.from_company
                    left join public.companies t on t.id = x.to_company)),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', r.id, 'request_type', r.request_type, 'status', r.status, 'requested_at', r.requested_at,
                    'company_name', coalesce(c.company_name, 'شركة محذوفة')) order by r.requested_at desc), '[]'::jsonb)
                   from public.account_requests r left join public.companies c on c.id = r.company_id
                  where r.customer_id = p.id),
    -- سجل التدقيق الكامل: عضويات (096) + امتيازات (053) + هرمية (099) + اشتراكات (018).
    'audit', (select coalesce(jsonb_agg(e.item order by e.at desc), '[]'::jsonb) from (
                select ev.created_at as at, jsonb_build_object('source', 'membership', 'action', ev.action,
                         'company_name', coalesce(c.company_name, 'شركة محذوفة'), 'actor_name', public._profile_name(ev.actor_id),
                         'at', ev.created_at) as item
                  from public.company_membership_events ev left join public.companies c on c.id = ev.company_id
                 where ev.user_id = p.id
                union all
                select pa.at, jsonb_build_object('source', 'privileged', 'action', pa.action,
                         'actor_name', public._profile_name(pa.actor_id), 'at', pa.at) as item
                  from public.privileged_audit pa where pa.target_user_id = p.id
                union all
                select he.at, jsonb_build_object('source', 'hierarchy', 'action', he.action,
                         'actor_name', public._profile_name(he.actor_id), 'at', he.at) as item
                  from public.hierarchy_events he
                 where he.user_id = p.id or (v_owned is not null and he.company_id = v_owned)
                union all
                select sa.created_at, jsonb_build_object('source', 'subscription', 'action', sa.action,
                         'actor_name', coalesce(sa.actor_email, public._profile_name(sa.actor_user_id)), 'at', sa.created_at) as item
                  from public.subscription_audit_log sa where sa.target_user_id = p.id
                order by 1 desc limit 50) e),
    'history_note', 'السجل يبدأ من تفعيل كل نظام: العضويات منذ 096، والامتيازات منذ 053، ومديرو الحساب منذ 105، والهرمية منذ 099، والاشتراكات منذ 018.'
  ) into v_result;
  return v_result;
end $$;

comment on function public.owner_account_details(uuid) is
  'تفاصيل حساب كاملة لمالك المنصة في نداء واحد (قراءة فقط): الهوية والعضويات كلها والمدير وسجله وكل الاشتراكات والمحفظة وأحدث قيود usage_ledger والتذاكر بعدّاداتها وسجل التدقيق المدمج. owner_only.';

-- ── 3) تعديل بيانات الحساب: الاسم الكامل والجوال فقط ────────────────────────
create or replace function public.owner_update_account_profile(p_user_id uuid, p_full_name text default null,
                                                               p_phone text default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  p public.profiles;
  v_name text;
  v_phone text;
  v_changed text[] := '{}';
begin
  -- التفويض قبل التحقق من المدخلات: غير المالك يُرفض بـ 42501 أيًا كان السبب.
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  select * into p from public.profiles where id = p_user_id;
  if p.id is null then
    raise exception 'الحساب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  -- الحساب الحسّاس (طاقم المنصة — ومنه حساب المالك نفسه) يتطلب تحققًا بخطوتين؛
  -- حساب العميل العادي يكفيه حارس المالك، والسبب مسجَّل في الحالين.
  if p.role in ('platform_owner', 'admin', 'support') and not coalesce(public.owner_critical_ok(), false) then
    raise exception 'تعديل حساب حسّاس يتطلب تحققًا بخطوتين' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  if p_full_name is null and p_phone is null then
    raise exception 'لا حقل للتعديل: الاسم الكامل أو الجوال' using errcode = '22023';
  end if;
  v_name := case when p_full_name is null then p.full_name else btrim(p_full_name) end;
  v_phone := case when p_phone is null then p.phone
                  when btrim(p_phone) = '' then null
                  else btrim(p_phone) end;
  if p_full_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 120) then
    raise exception 'الاسم الكامل بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if v_phone is not null and (char_length(v_phone) > 30 or v_phone !~ '^\+?[0-9][0-9 ()-]*$') then
    raise exception 'الجوال أرقام وعلامة + ومسافات وشرطات فقط (30 حرفًا حدًا أقصى)' using errcode = '22023';
  end if;
  if v_name is not distinct from p.full_name and v_phone is not distinct from p.phone then
    return jsonb_build_object('user_id', p.id, 'changed', false);
  end if;
  if v_name is distinct from p.full_name then v_changed := array_append(v_changed, 'full_name'); end if;
  if v_phone is distinct from p.phone then v_changed := array_append(v_changed, 'phone'); end if;
  update public.profiles set full_name = v_name, phone = v_phone, updated_at = now() where id = p.id;
  perform public.log_privileged('profile.update.owner', p.id,
                                jsonb_build_object('full_name', p.full_name, 'phone', p.phone),
                                jsonb_build_object('full_name', v_name, 'phone', v_phone, 'reason', v_reason));
  perform public._hierarchy_event('account.profile_updated', null, null, p.id,
                                  jsonb_build_object('reason', v_reason, 'fields', v_changed));
  return jsonb_build_object('user_id', p.id, 'changed', true, 'full_name', v_name, 'phone', v_phone, 'fields', v_changed);
end $$;

comment on function public.owner_update_account_profile(uuid, text, text, text) is
  'تعديل الاسم الكامل والجوال لحساب من لوحة المالك، بسبب مسجَّل وتدقيق. البريد والرتبة خارج التوقيع عمدًا: البريد في auth.users بلا مسار معتمد، والرتبة عبر مراجعات الإدارة (099/053). الحساب الحسّاس يتطلب تحققًا بخطوتين.';

-- ── المنح: الدوال الجديدة للمالك عبر جلسة موثقة؛ الداخلية مغلقة ─────────────
do $$
declare f text;
begin
  foreach f in array array['public._owner_transfer_safety_ok()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.owner_account_transfer(uuid,uuid,text,boolean,uuid)',
                           'public.owner_account_details(uuid)',
                           'public.owner_update_account_profile(uuid,text,text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
