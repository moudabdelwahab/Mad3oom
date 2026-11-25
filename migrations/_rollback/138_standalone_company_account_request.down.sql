-- ============================================================================
-- تراجع 138_standalone_company_account_request
--
-- يزيل المدخل المستقل: دواله الأربع، جدول الرفع المرحلي، أعمدة الطلب
-- وقيودها، ويعيد my_company_account_request و
-- admin_list_company_account_requests إلى تعريف 118 حرفيًا.
--
-- يسيب (عن قصد — مفيش حذف بيانات):
--   • طلبات حساب الشركة نفسها (صفوفها تبقى بحالتها؛ حقول 138 تُحذف مع
--     الأعمدة فقط، والطلب قيد المراجعة يبقى قيد المراجعة).
--   • الشركات التي وُوفق عليها وأدوار company_admin المشتقة منها.
--   • ملفات الإثبات المرفوعة في المستودع الخاص (تُحذف من التخزين يدويًا
--     إن لزم؛ لا دالة حذف هنا).
-- ⚠️ بعده: المدخل المستقل في login.html ولوحة الشركة يرجع يفشل (الدالة
--    غير موجودة)، ومسار الشراء (068/118) يستمر كما كان.
-- ============================================================================

drop function if exists public.submit_standalone_company_account_request(text, text, date, text, text, text, text, uuid);
drop function if exists public.admin_company_account_request_proof_download(uuid);
drop function if exists public.company_account_request_proof_commit_server(uuid, uuid, text);
drop function if exists public.company_account_request_proof_begin(uuid, text, integer, text, uuid);
drop table if exists public.company_account_request_proof_uploads;

alter table public.company_account_requests
  drop constraint if exists company_account_requests_standalone_proof_check,
  drop constraint if exists company_account_requests_proof_check,
  drop constraint if exists company_account_requests_url_check,
  drop constraint if exists company_account_requests_source_check,
  drop constraint if exists company_account_requests_applicant_check;
drop index if exists public.company_account_requests_applicant_source;

alter table public.company_account_requests
  drop column if exists applicant_type,
  drop column if exists request_source,
  drop column if exists website_url,
  drop column if exists proof_document_name,
  drop column if exists proof_document_mime,
  drop column if exists proof_document_size,
  drop column if exists proof_document_path,
  drop column if exists proof_document_sha256,
  drop column if exists proof_token;

-- تعريفا 118 حرفيًا (منقولان من migrations/118_ecommerce_store_accounts.sql، الأسطر 192–266)
create or replace function public.my_company_account_request()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
           'id',             r.id,
           'status',         r.status,
           'company_name',   r.company_name,
           'requested_plan', r.requested_plan,
           'review_note',    r.review_note,
           'created_at',     r.created_at,
           'reviewed_at',    r.reviewed_at,
           'account_kind',   r.account_kind
         )
    from public.company_account_requests r
   where auth.uid() is not null
     and r.user_id = auth.uid()
   order by (r.status = 'pending') desc, r.created_at desc
   limit 1;
$function$;

-- نفس تعريف الإنتاج حرفيًا + النوع والمنصة والنطاق المذكور، لتراها الإدارة قبل القرار.
create or replace function public.admin_list_company_account_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
               'created_at',                     r.created_at,
               'account_kind',                   r.account_kind,
               'store_platform',                 r.store_platform,
               'store_domain_hint',              r.store_domain_hint
             ) as item
        from public.company_account_requests r
        left join public.profiles p  on p.id  = r.user_id
        left join public.profiles rv on rv.id = r.reviewed_by
        left join public.subscription_plans sp on sp.key = r.requested_plan
    ) q;

  return v_rows;
end;
$function$;

revoke all on function public.my_company_account_request() from public, anon;
grant execute on function public.my_company_account_request() to authenticated;

revoke all on function public.admin_list_company_account_requests() from public, anon;
grant execute on function public.admin_list_company_account_requests() to authenticated;
