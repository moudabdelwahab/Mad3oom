-- ============================================================================
-- 142_owner_requests_aggregator.sql
--   تبويب «الطلبات» المجمّع في لوحة المالك — دالة قراءة واحدة للمالك وحده.
--
--   الفحص: طلبات المالك مبعثرة على صفحاتها (تجارب وتعويض ومتاجر وحسابات
--   واقتراحات)، وثلاثة أنواع بلا دالة owner_list_* أصلًا: طلبات إنشاء
--   حساب الشركة (لها admin_list فقط)، وطلبات حذف الحساب (بلا قائمة
--   للمالك)، والاقتراحات (بلا RPC أصلًا — تقرأها صفحة الإدارة من
--   الجدول). هذا الملف يسدّ الفجوة بدالة تجميع واحدة.
--
--   القاعدة الصارمة: بلا أي جدول جديد — UNION على الجداول القائمة وحدها،
--   وبلا أي كتابة (STABLE + قراءة فقط). كل صف يحمل نوعه ومصدره وحالته
--   وتاريخه ورابطًا عميقًا لصفحة التفاصيل/الإجراء الأصلية:
--     • company_account — طلبات إنشاء حساب الشركة (138/068): صفحة
--       المراجعة الأصلية /admin/company-requests.html، إلا طلب المتجر
--       الإلكتروني المعلّق فيذهب إلى قائمة المتاجر في لوحة المالك
--       /owner/stores.html#storeRequestsHeading حيث يُتَّخذ قراره عبر
--       owner_store_request_decide (133) — وهو الصف نفسه لا صف مكرر،
--       وتشير راية in_store_queue إلى وجوده في قائمة المتاجر.
--     • trial — طلبات التجربة 3 أيام (137): /owner/trials.html.
--     • refund — طلبات تعويض إلغاء الاشتراكات المدفوعة (142): /owner/refunds.html.
--       يظهر مرة واحدة كمصدر واحد (شركات) رغم أنه طلب عميل على خطته —
--       لا صف ثانٍ له في أي مصدر آخر.
--     • deletion — طلبات حذف الحساب (140): /owner/accounts.html?id=
--       الشركة — التنفيذ يدوي من المالك وفق سياسة 140، ولا صفحة حذف
--       مخصصة أصلًا فيربط بشجرة الحسابات حيث يُدار الحساب.
--     • suggestion — اقتراحات الإدارة: /admin/suggestions.html. تصل
--       للمالك لأن is_admin() يمرّ في سياق المالك (owner_capability
--       'admin' يقبل سياق 'owner' في 038)، وسياسة RLS نفسها للإدارة.
--
--   التسمية: التعويض يغطي كل الباقات المدفوعة (support/ultimate/
--   whatsapp/bundle)؛ وباقة المتجر store ليست منها — فلا تظهر طلباتها
--   هنا إطلاقًا.
--
--   يعتمد على 068 (company_account_requests) و 118 (account_kind) و
--   119 (_owner_require) و 137 (saas_trial_requests) و 140
--   (company_deletion_requests) و 142 (refund_requests) و
--   134 (suggestions).
--   قابل لإعادة التشغيل. بلا أي تحديث بيانات وبلا تفعيل باقة.
--   التراجع: migrations/_rollback/142_owner_requests_aggregator.down.sql
--   (يحذف الدالة وحدها؛ الجداول والصفوف بلا مساس إطلاقًا).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.company_account_requests') is null
     or to_regclass('public.saas_trial_requests') is null
     or to_regclass('public.refund_requests') is null
     or to_regclass('public.company_deletion_requests') is null
     or to_regclass('public.suggestions') is null
     or to_regclass('public.companies') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.subscription_plans') is null then
    raise exception '142 يتطلب جداول company_account_requests و saas_trial_requests و refund_requests و company_deletion_requests و suggestions و companies و profiles و subscription_plans';
  end if;
  if to_regprocedure('public._owner_require()') is null then
    raise exception '142 يتطلب public._owner_require() من 119';
  end if;
end $$;


-- ============================================================================
-- 1) دالة التجميع — للمالك وحده، قراءة فقط، بلا جدول جديد
--    p_type: company_account | trial | refund | deletion | suggestion
--    p_status: pending | approved | rejected | paid | closed | expired | cancelled
--              | executed | reviewed | implemented (الحالة الخام لكل نوع)
--    الواجهة تنادي بلا مرشّحات وترشّح محليًا على نمط trials.html؛
--    المرشّحان هنا للاختبار ولأي مستهلك خادمي لاحق.
-- ============================================================================
create or replace function public.owner_list_requests(p_type text default null, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  if p_type is not null and p_type not in ('company_account', 'trial', 'refund', 'deletion', 'suggestion') then
    raise exception 'نوع طلب غير صالح' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'paid', 'closed', 'expired',
                                               'cancelled', 'executed', 'reviewed', 'implemented') then
    raise exception 'حالة طلب غير صالحة' using errcode = '22023';
  end if;

  return (
    select coalesce(jsonb_agg(q.row order by (q.status = 'pending') desc, q.requested_at desc), '[]'::jsonb)
      from (
        -- ── طلبات إنشاء حساب شركة (068/118/138) ──
        select 'company_account'::text as type, r.status as status, r.created_at as requested_at,
               jsonb_build_object(
                 'id', r.id, 'type', 'company_account', 'source', 'companies',
                 'title', case r.account_kind when 'ecommerce_store' then 'طلب إنشاء حساب متجر إلكتروني'
                                              else 'طلب إنشاء حساب شركة' end,
                 'company_id', r.company_id, 'company_name', r.company_name,
                 'requester_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                 'requester_email', p.email,
                 'status', r.status, 'requested_at', r.created_at,
                 'summary', coalesce(sp.name_ar, sp.name, r.requested_plan),
                 'plan_key', r.requested_plan,
                 'plan_label', coalesce(sp.name_ar, sp.name, r.requested_plan),
                 'account_kind', r.account_kind,
                 'in_store_queue', (r.account_kind = 'ecommerce_store' and r.status = 'pending'),
                 'amount', null::numeric, 'currency', null::text, 'category', null::text,
                 'detail_url', case when r.account_kind = 'ecommerce_store' and r.status = 'pending'
                                    then '/owner/stores.html#storeRequestsHeading'
                                    else '/admin/company-requests.html' end) as row
          from public.company_account_requests r
          left join public.profiles p on p.id = r.user_id
          left join public.subscription_plans sp on sp.key = r.requested_plan
        union all
        -- ── طلبات التجربة المجانية 3 أيام (137) ──
        select 'trial'::text, r.status, r.requested_at,
               jsonb_build_object(
                 'id', r.id, 'type', 'trial', 'source', 'companies',
                 'title', 'طلب تجربة مجانية — ' || case r.plan_key
                   when 'support' then 'الخطة المتقدمة'
                   when 'ultimate' then 'الخطة الفائقة'
                   when 'store' then 'باقة المتاجر الإلكترونية'
                   else r.plan_key end,
                 'company_id', r.company_id, 'company_name', c.company_name,
                 'requester_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                 'requester_email', p.email,
                 'status', r.status, 'requested_at', r.requested_at,
                 'summary', 'تجربة مجانية 3 أيام',
                 'plan_key', r.plan_key,
                 'plan_label', case r.plan_key
                   when 'support' then 'الخطة المتقدمة'
                   when 'ultimate' then 'الخطة الفائقة'
                   when 'store' then 'باقة المتاجر الإلكترونية'
                   else coalesce(sp.name_ar, sp.name, r.plan_key) end,
                 'account_kind', c.account_kind,
                 'in_store_queue', false,
                 'amount', null::numeric, 'currency', null::text, 'category', null::text,
                 'detail_url', '/owner/trials.html#trialRequestsHeading') as row
          from public.saas_trial_requests r
          join public.companies c on c.id = r.company_id
          left join public.profiles p on p.id = r.requested_by
          left join public.subscription_plans sp on sp.key = r.plan_key
        union all
        -- ── طلبات تعويض إلغاء الاشتراكات المدفوعة (142) — مرة واحدة، بلا تكرار ──
        select 'refund'::text, r.status, r.requested_at,
               jsonb_build_object(
                 'id', r.id, 'type', 'refund', 'source', 'companies',
                 'title', 'طلب تعويض إلغاء اشتراك — ' || coalesce(sp.name_ar, sp.name, r.plan),
                 'company_id', r.company_id, 'company_name', c.company_name,
                 'requester_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                 'requester_email', p.email,
                 'status', r.status, 'requested_at', r.requested_at,
                 'summary', r.cancel_reason,
                 'plan_key', r.plan,
                 'plan_label', coalesce(sp.name_ar, sp.name, r.plan),
                 'account_kind', c.account_kind,
                 'in_store_queue', false,
                 'amount', r.refund_amount, 'currency', r.currency, 'category', null::text,
                 'detail_url', '/owner/refunds.html#refundRequestsHeading') as row
          from public.refund_requests r
          join public.companies c on c.id = r.company_id
          left join public.profiles p on p.id = r.user_id
          left join public.subscription_plans sp on sp.key = r.plan
        union all
        -- ── طلبات حذف الحساب (140) — التنفيذ يدوي من المالك ──
        select 'deletion'::text, r.status, r.created_at,
               jsonb_build_object(
                 'id', r.id, 'type', 'deletion', 'source', 'customers',
                 'title', 'طلب حذف حساب الشركة',
                 'company_id', r.company_id, 'company_name', c.company_name,
                 'requester_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                 'requester_email', p.email,
                 'status', r.status, 'requested_at', r.created_at,
                 'summary', r.reason,
                 'plan_key', null::text, 'plan_label', null::text,
                 'account_kind', c.account_kind,
                 'in_store_queue', false,
                 'amount', null::numeric, 'currency', null::text, 'category', null::text,
                 'detail_url', '/owner/accounts.html?id=' || r.company_id::text) as row
          from public.company_deletion_requests r
          join public.companies c on c.id = r.company_id
          left join public.profiles p on p.id = r.requested_by
        union all
        -- ── اقتراحات الإدارة — تصل للمالك عبر is_admin() في سياق المالك ──
        select 'suggestion'::text, s.status, s.created_at,
               jsonb_build_object(
                 'id', s.id, 'type', 'suggestion', 'source', 'management',
                 'title', s.title,
                 'company_id', null::uuid, 'company_name', null::text,
                 'requester_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                 'requester_email', p.email,
                 'status', s.status, 'requested_at', s.created_at,
                 'summary', left(coalesce(s.description, ''), 200),
                 'plan_key', null::text, 'plan_label', null::text,
                 'account_kind', null::text,
                 'in_store_queue', false,
                 'amount', null::numeric, 'currency', null::text, 'category', s.category,
                 'detail_url', '/admin/suggestions.html') as row
          from public.suggestions s
          left join public.profiles p on p.id = s.user_id
      ) q
     where (p_type is null or q.type = p_type)
       and (p_status is null or q.status = p_status));
end $$;
comment on function public.owner_list_requests(text, text) is
  '142: تبويب «الطلبات» المجمّع للمالك — UNION قراءة فقط على الجداول القائمة (حساب شركة، تجربة، تعويض اشتراك مدفوع، حذف حساب، اقتراحات)، بلا جدول جديد وبلا كتابة؛ كل صف برابط عميق لصفحته الأصلية، والتعويض مرة واحدة.';

revoke all on function public.owner_list_requests(text, text) from public, anon;
grant execute on function public.owner_list_requests(text, text) to authenticated;


-- ============================================================================
-- 2) تحقق ذاتي
-- ============================================================================
do $$
declare v_def text;
declare v_tbl text;
begin
  if to_regprocedure('public.owner_list_requests(text, text)') is null then
    raise exception '142: دالة التجميع غير موجودة بعد التطبيق';
  end if;
  if not has_function_privilege('authenticated', 'public.owner_list_requests(text, text)'::regprocedure, 'EXECUTE') then
    raise exception '142: دالة التجميع ليست لـ authenticated';
  end if;
  if has_function_privilege('anon', 'public.owner_list_requests(text, text)'::regprocedure, 'EXECUTE') then
    raise exception '142: دالة التجميع مكشوفة لـ anon';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.owner_list_requests(text, text)'::regprocedure) is not true then
    raise exception '142: دالة التجميع ليست SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_class where relname = 'owner_requests' and relkind = 'r') then
    raise exception '142: أُنشئ جدول جديد — المجمّع قراءة على الجداول القائمة وحدها';
  end if;
  v_def := pg_get_functiondef('public.owner_list_requests(text, text)'::regprocedure);
  foreach v_tbl in array array['company_account_requests', 'saas_trial_requests',
                               'refund_requests', 'company_deletion_requests',
                               'suggestions'] loop
    if position(v_tbl in v_def) = 0 then
      raise exception '142: دالة التجميع لا تقرأ الجدول %', v_tbl;
    end if;
  end loop;
  if position('insert into' in lower(v_def)) > 0
     or position('update public.' in lower(v_def)) > 0
     or position('delete from public.' in lower(v_def)) > 0 then
    raise exception '142: دالة التجميع تكتب — القراءة فقط';
  end if;
end $$;
