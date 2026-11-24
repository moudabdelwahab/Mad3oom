-- ============================================================================
-- 128_owner_account_tree.sql — شجرة الحسابات لمالك المنصة (قراءة فقط).
--
-- دالة واحدة owner_account_tree(): الشجرة كاملة في نداء واحد بدل N+1
-- (وحدة ← شركاتها ← أعضاء كل شركة وعملاؤها ← تفاصيل كل شخص). لا جداول
-- جديدة، لا كتابة، لا تغيير مفاتيح، لا تفعيل حسابات.
--
-- لماذا دالة جديدة لا RPCs الموجودة؟
--   • owner_hierarchy() يعيد الوحدات وشركاتها وأعضاءها بالأسماء فقط: بلا
--     بريد ولا جوال ولا عدّادات ولا اشتراك ولا رصيد ولا تذاكر مفتوحة.
--   • admin_customer_directory() يفلتر بشركة واحدة في كل نداء، وصفوفه بلا
--     عدّاد تذاكر مفتوحة وبلا رصيد — فبناء الشجرة منه وحده N+1 لكل شركة.
--   • admin_customer_details() تفصيل عميل واحد في كل نداء، وتمرّ عبر
--     is_support_user() (رتبة admin أو owner_capability('staff')) فليست
--     مضمونة في سياق المالك وحده — وتبقى للوحة التفاصيل عند توفرها.
--   • user_wallets تشترط سياسته الرتبة الحرفية 'admin'، فالمالك لا يقرأ
--     الرصيد/التجميد بقراءة مباشرة؛ security definer هنا يقرؤه نيابة عنه.
--
-- الحارس owner_capability('owner_only') نفسه في owner_hierarchy().
-- الأرشفة فقط: الوحدات المؤرشفة والعلاقات المنتهية (ended_at) مستبعدة،
-- ولا حذف فيزيائي لأي سجل. العمق ≤6 مفروض أصلًا في owner_unit_create؛
-- الواجهة تثبّت أي عمق أعمق عند 6 دفاعًا لا قرارًا.
--
-- البنية: مالك المنصة ← وحدات (parent_id، مؤرشفة مستبعدة) ← شركات كل
-- وحدة ← أعضاء الشركة (مالكها ثم موظفوها ثم عملاؤها)؛ وفرع مستقل
-- «عملاء مباشرون للمنصة» من platform_direct_customers؛ وجراب «شركات
-- بلا وحدة» من الشركات بلا إسناد سارٍ. كل شخص: الهوية والدور والعضويات
-- ومدير الحساب وسجله والاشتراك الأحدث والرصيد/النقاط والتذاكر المفتوحة.
-- أحداث العقدة: آخر 5 من hierarchy_events لكل وحدة وشركة.
-- ============================================================================

create or replace function public.owner_account_tree()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;

  with
    -- كل حساب مرة واحدة: الحظر والرصيد ومدير الحساب والتذاكر المفتوحة والعلاقة المباشرة.
    person_base as (
      select p.id, p.full_name, p.email, p.phone, p.role,
             coalesce(p.points, 0) as points,
             public.is_banned(p.id) as banned,
             w.total_points, w.available_points, coalesce(w.is_frozen, false) as wallet_frozen,
             am.manager_id,
             (select count(*) from public.tickets t
               where t.user_id = p.id and t.status in ('open', 'in-progress')) as open_tickets,
             exists (select 1 from public.platform_direct_customers d
                      where d.user_id = p.id and d.ended_at is null) as is_direct,
             (select d.since from public.platform_direct_customers d
               where d.user_id = p.id and d.ended_at is null limit 1) as direct_since,
             exists (select 1 from public.companies oc where oc.user_id = p.id) as owns_company,
             exists (select 1 from public.company_staff s
                      where s.user_id = p.id and s.revoked_at is null) as is_staff,
             exists (select 1 from public.company_memberships m
                      where m.user_id = p.id and m.status = 'active') as has_membership
        from public.profiles p
        left join public.user_wallets w on w.user_id = p.id
        left join public.customer_account_managers am
               on am.customer_id = p.id and am.scope = 'platform' and am.ended_at is null
    ),
    -- تمثيل الشخص الواحد، يُعاد استعماله تحت كل شركة وفي فرع المباشرين.
    -- نوع الحساب بترتيب _customer_accounts() نفسه في 105.
    person_json as (
      select b.id, jsonb_build_object(
        'id', b.id,
        'full_name', b.full_name,
        'email', b.email,
        'phone', b.phone,
        'role', b.role,
        'points', b.points,
        'status', case when b.banned then 'suspended' else 'active' end,
        'wallet', jsonb_build_object('total_points', b.total_points,
                                     'available_points', b.available_points,
                                     'is_frozen', b.wallet_frozen),
        'manager', case when b.manager_id is null then null
                        else jsonb_build_object('id', b.manager_id, 'name', public._profile_name(b.manager_id)) end,
        'manager_history', (select coalesce(jsonb_agg(jsonb_build_object(
                                     'manager_id', h.manager_id,
                                     'manager_name', public._profile_name(h.manager_id),
                                     'assigned_by_name', public._profile_name(h.assigned_by),
                                     'assigned_at', h.assigned_at, 'reason', h.reason,
                                     'ended_at', h.ended_at, 'end_cause', h.end_cause)
                                   order by h.assigned_at desc), '[]'::jsonb)
                             from public.customer_account_managers h where h.customer_id = b.id),
        'subscription', (select jsonb_build_object(
                           'plan', s.plan,
                           'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
                           'status', s.status, 'billing_cycle', s.billing_cycle,
                           'start_date', s.start_date, 'end_date', s.end_date,
                           'is_active', (s.status = 'active' and s.end_date > now()))
                           from public.whatsapp_subscriptions s
                           left join public.subscription_plans sp on sp.key = s.plan
                          where s.user_id = b.id
                          order by (s.status = 'active') desc, s.created_at desc nulls last
                          limit 1),
        'memberships', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'company_id', m.company_id,
                                  'company_name', coalesce(c.company_name, 'شركة محذوفة'),
                                  'is_primary', m.is_primary, 'status', m.status,
                                  'joined_at', m.joined_at, 'joined_via', m.joined_via,
                                  'ended_at', m.ended_at, 'end_cause', m.end_cause)
                                order by m.joined_at desc), '[]'::jsonb)
                          from public.company_memberships m
                          left join public.companies c on c.id = m.company_id
                         where m.user_id = b.id),
        'open_tickets', b.open_tickets,
        'account_type', case
                          when b.role in ('platform_owner', 'admin', 'support') then 'platform_staff'
                          when b.owns_company then 'company_owner'
                          when b.is_staff then 'company_staff'
                          when b.is_direct and b.has_membership then 'direct_and_company'
                          when b.has_membership then 'company_customer'
                          when b.is_direct then 'direct'
                          else 'unclassified' end,
        'direct_since', b.direct_since
      ) as j
      from person_base b
    ),
    -- أعضاء كل شركة: مالكها ثم موظفوها (صف company_staff سارٍ) ثم عملاؤها
    -- (عضوية سارية). الموظف يقدَّم على العضوية إن جمعهما؛ المالك لا يتكرر.
    company_members as (
      select c.id as company_id, pj.id as person_id, pj.j, 'owner' as kind, 1 as kind_rank
        from public.companies c
        join person_json pj on pj.id = c.user_id
      union all
      select c.id, pj.id, pj.j, 'staff', 2
        from public.companies c
        join public.company_staff s on s.company_id = c.id and s.revoked_at is null
        join person_json pj on pj.id = s.user_id
       where c.user_id is distinct from s.user_id
      union all
      select c.id, pj.id, pj.j, 'customer', 3
        from public.companies c
        join public.company_memberships m on m.company_id = c.id and m.status = 'active'
        join person_json pj on pj.id = m.user_id
       where c.user_id is distinct from m.user_id
         and not exists (select 1 from public.company_staff s
                          where s.company_id = c.id and s.user_id = m.user_id and s.revoked_at is null)
    ),
    company_json as (
      select c.id, jsonb_build_object(
        'company_id', c.id,
        'name', c.company_name,
        'status', c.status,
        'members_count', (select count(*) from company_members cm
                           where cm.company_id = c.id and cm.kind in ('owner', 'staff')),
        'customers_count', (select count(*) from company_members cm
                             where cm.company_id = c.id and cm.kind = 'customer'),
        'open_tickets', (select count(*) from public.tickets t
                          where t.company_id = c.id and t.status in ('open', 'in-progress')),
        'people', coalesce((select jsonb_agg(cm.j || jsonb_build_object('kind', cm.kind)
                                               order by cm.kind_rank, cm.j ->> 'full_name')
                              from company_members cm where cm.company_id = c.id), '[]'::jsonb),
        'events', (select coalesce(jsonb_agg(jsonb_build_object(
                                     'at', e.at, 'action', e.action,
                                     'actor_name', public._profile_name(e.actor_id),
                                     'detail', e.detail) order by e.at desc), '[]'::jsonb)
                     from (select * from public.hierarchy_events
                            where company_id = c.id order by at desc limit 5) e)
      ) as j
      from public.companies c
    ),
    unit_json as (
      select u.id, jsonb_build_object(
        'id', u.id,
        'parent_id', u.parent_id,
        'name', u.name,
        'description', u.description,
        'members', coalesce((select jsonb_agg(jsonb_build_object(
                                       'user_id', m.user_id,
                                       'name', public._profile_name(m.user_id),
                                       'role', m.member_role,
                                       'since', m.assigned_at,
                                       'open_tickets', (select count(*) from public.tickets t
                                                         where t.assigned_to = m.user_id
                                                           and t.status in ('open', 'in-progress')))
                                     order by m.assigned_at)
                               from public.admin_unit_members m
                              where m.unit_id = u.id and m.ended_at is null), '[]'::jsonb),
        'companies', coalesce((select jsonb_agg(cj.j order by cj.j ->> 'name')
                                 from public.admin_unit_companies uc
                                 join company_json cj on cj.id = uc.company_id
                                where uc.unit_id = u.id and uc.ended_at is null), '[]'::jsonb),
        'delegations', coalesce((select jsonb_agg(jsonb_build_object(
                                           'id', d.id, 'delegate_id', d.delegate_id,
                                           'name', public._profile_name(d.delegate_id),
                                           'capabilities', d.capabilities,
                                           'expires_at', d.expires_at)
                                         order by d.expires_at)
                                   from public.platform_delegations d
                                  where d.unit_id = u.id and d.revoked_at is null
                                    and (d.expires_at is null or d.expires_at > now())), '[]'::jsonb),
        'events', (select coalesce(jsonb_agg(jsonb_build_object(
                                     'at', e.at, 'action', e.action,
                                     'actor_name', public._profile_name(e.actor_id),
                                     'detail', e.detail) order by e.at desc), '[]'::jsonb)
                     from (select * from public.hierarchy_events
                            where unit_id = u.id order by at desc limit 5) e)
      ) as j
      from public.admin_units u where u.archived_at is null
    ),
    direct_json as (
      select coalesce(jsonb_agg(pj.j order by pj.j ->> 'full_name'), '[]'::jsonb) as j
        from person_json pj
        join person_base b on b.id = pj.id
       where b.is_direct and b.role not in ('platform_owner', 'admin', 'support')
    )
  select jsonb_build_object(
    'delegation_enabled', public._feature_on('delegation_enabled'),
    'units', (select coalesce(jsonb_agg(j order by j ->> 'name'), '[]'::jsonb) from unit_json),
    'unassigned_companies', (select coalesce(jsonb_agg(cj.j order by cj.j ->> 'name'), '[]'::jsonb)
                                               from company_json cj
                                              where not exists (select 1 from public.admin_unit_companies uc
                                                                 where uc.company_id = cj.id and uc.ended_at is null)),
    'direct_customers', (select j from direct_json),
    'counts', jsonb_build_object(
      'units', (select count(*) from public.admin_units where archived_at is null),
      'companies', (select count(*) from public.companies),
      'direct_customers', (select count(*) from person_base
                            where is_direct and role not in ('platform_owner', 'admin', 'support')),
      'members', (select count(*) from company_members where kind in ('owner', 'staff')),
      'customers', (select count(*) from (
                      select person_id from company_members where kind = 'customer'
                      union
                      select id from person_base
                       where is_direct and role not in ('platform_owner', 'admin', 'support')) x),
      'open_tickets', (select count(*) from public.tickets where status in ('open', 'in-progress'))
    )
  )
  into v_result;

  return v_result;
end $$;

comment on function public.owner_account_tree() is
  'شجرة الحسابات كاملة لمالك المنصة في نداء واحد (قراءة فقط): وحدات ≤6 وشركاتها وأعضاؤها، وفرع العملاء المباشرين، وشركات بلا وحدة. owner_only.';

revoke all on function public.owner_account_tree() from public, anon;
grant execute on function public.owner_account_tree() to authenticated;
