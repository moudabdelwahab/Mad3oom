-- ============================================================================
-- التراجع عن 118_ecommerce_store_accounts
--   يرفض إن وُجدت بيانات متاجر حقيقية (منظمة متجر، طلب متجر، اشتراك باقة store، أو ربط
--   Shopify) — التراجع حينها يُفقد نوع الحساب بصمت. انقلها أو احسمها أولًا.
--   يعيد my_company_account_request و admin_list_company_account_requests إلى نص الإنتاج
--   حرفيًا (md5 قبل 118: 91666c394648d9e09fb823f7f0dd3d76 و 4ae5f2572f0b05f3a16ce79ba781c2bb).
--   119 يُتراجع عنه أولًا.
-- ============================================================================
do $$
begin
  if to_regclass('public.ihub_sync_jobs') is not null then
    raise exception 'التراجع عن 118 مرفوض: تراجع عن 119 أولًا';
  end if;
  if exists (select 1 from public.companies where account_kind = 'ecommerce_store')
     or exists (select 1 from public.company_account_requests where account_kind = 'ecommerce_store')
     or exists (select 1 from public.whatsapp_subscriptions where plan = 'store') then
    raise exception 'التراجع عن 118 مرفوض: توجد بيانات متاجر (منظمة أو طلب أو اشتراك)';
  end if;
end $$;

drop trigger if exists trg_enforce_plan_audience on public.whatsapp_subscriptions;
drop function if exists public.enforce_plan_audience();
drop trigger if exists trg_account_request_apply_kind on public.company_account_requests;
drop function if exists public._account_request_apply_kind();
drop trigger if exists trg_guard_company_account_kind on public.companies;
drop function if exists public._guard_company_account_kind();
drop function if exists public.submit_store_account_request(text,text,date,text,text,text,text,text);
drop function if exists public.my_account_type();
drop function if exists public.owner_set_company_account_kind(uuid,text,text);

delete from public.plan_features pf using public.subscription_plans sp
 where pf.plan_id = sp.id and sp.key = 'store';
delete from public.subscription_plans where key = 'store';
delete from public.company_feature_overrides where feature_key in ('shopify_integration', 'store_support');
delete from public.plan_features where feature_key in ('shopify_integration', 'store_support');
delete from public.feature_flags where key in ('shopify_integration', 'store_support');

alter table public.whatsapp_subscriptions drop constraint if exists whatsapp_subscriptions_plan_check;
alter table public.whatsapp_subscriptions add constraint whatsapp_subscriptions_plan_check
  check (plan = any (array['support'::text, 'ultimate'::text, 'whatsapp'::text, 'bundle'::text]));
alter table public.company_feature_overrides drop constraint if exists company_feature_overrides_pilot_only;
alter table public.company_feature_overrides add constraint company_feature_overrides_pilot_only
  check (feature_key in ('integrations_hub'));

alter table public.subscription_plans drop constraint if exists subscription_plans_store_priced;
alter table public.subscription_plans drop constraint if exists subscription_plans_audience_check;
alter table public.subscription_plans drop column if exists audience;
alter table public.company_account_requests drop constraint if exists company_account_requests_store_check;
alter table public.company_account_requests drop constraint if exists company_account_requests_kind_check;
alter table public.company_account_requests drop column if exists store_domain_hint,
                                            drop column if exists store_platform,
                                            drop column if exists account_kind;
drop index if exists public.companies_account_kind;
alter table public.companies drop constraint if exists companies_account_kind_check;
alter table public.companies drop column if exists account_kind;

CREATE OR REPLACE FUNCTION public.my_company_account_request()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
           'id',             r.id,
           'status',         r.status,
           'company_name',   r.company_name,
           'requested_plan', r.requested_plan,
           'review_note',    r.review_note,
           'created_at',     r.created_at,
           'reviewed_at',    r.reviewed_at
         )
    from public.company_account_requests r
   where auth.uid() is not null
     and r.user_id = auth.uid()
   order by (r.status = 'pending') desc, r.created_at desc
   limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_company_account_requests()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(q.item order by q.r_created desc), '[]'::jsonb)
    into v_rows
    from (
      select r.created_at as r_created,
             jsonb_build_object(
               'id',                             r.id,
               'user_id',                        r.user_id,
               'customer_name',                  coalesce(nullif(btrim(p.full_name), ''), p.email),
               'customer_email',                 p.email,
               'customer_phone',                 p.phone,
               'company_name',                   r.company_name,
               'commercial_registration_number', r.commercial_registration_number,
               'commercial_registration_expiry', r.commercial_registration_expiry,
               'company_email',                  r.company_email,
               'company_phone',                  r.company_phone,
               'requested_plan',                 r.requested_plan,
               'requested_plan_name_ar',         coalesce(sp.name_ar, sp.name, r.requested_plan),
               'requested_billing_cycle',        r.requested_billing_cycle,
               'status',                         r.status,
               'review_note',                    r.review_note,
               'reviewed_at',                    r.reviewed_at,
               'reviewer_name',                  coalesce(nullif(btrim(rv.full_name), ''), rv.email),
               'company_id',                     r.company_id,
               'created_at',                     r.created_at
             ) as item
        from public.company_account_requests r
        left join public.profiles p  on p.id  = r.user_id
        left join public.profiles rv on rv.id = r.reviewed_by
        left join public.subscription_plans sp on sp.key = r.requested_plan
    ) q;

  return v_rows;
end;
$function$;
