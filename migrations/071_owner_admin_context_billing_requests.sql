-- ============================================================================
-- 071_owner_admin_context_billing_requests.sql
--   مالك المنصة في سياق «الإدارة» يؤكّد ويرفض طلبات الاشتراك وشحن الرصيد
--
-- البلاغ (من صاحب المنصة): «المفترض في تذاكر الاشتراك يكون في زر تاكيد
-- الاشتراك او رفض … ملقيتش الزر موجود فقط تغيير الحاله ده من حساب مالك
-- المنصه … لكن لما دخلت من حساب ادمن فعلي لقيت الزر» (التذكرة #1121).
--
-- السبب (مقروء من الإنتاج 2026-10-09)
--   • لوحة التذاكر تعرض «تأكيد الاشتراك / رفض الاشتراك» فقط لو قرأت صف
--     whatsapp_subscriptions المرتبط بالتذكرة وحالته pending. وسياسة الإدارة
--     على الجدول مكتوبة بالرتبة حرفيًا (profiles.role = 'admin')، والمالك رتبته
--     platform_owner — فالقراءة ترجع فاضية والأزرار لا تُرسم. نفس الفجوة اللي
--     سدّها 070 للتذاكر، ونفسها على whatsapp_wallet_topup_requests (أزرار
--     «تأكيد الشحن / رفض الطلب»).
--   • باقي مسار التأكيد سياقي أصلًا: محفّزا الاشتراك (enforce_subscription_
--     purchase_rules و enforce_subscription_company_owner) و wa_wallet_adjust
--     و admin_confirm_subscription_upgrade على is_admin()، والإشعار على
--     is_platform_staff()، وتعديل التذكرة سدّه 070.
--   • admin_recompute_user_access اللي بتناديها الواجهة بعد التأكيد (عرّفها
--     024) **غير موجودة على الإنتاج**: النداء بيفشل في console من غير ما حد
--     يشوفه، فـ profiles.whatsapp_enabled ما بيتحدّثش لما يتأكّد اشتراك فيه
--     واتساب من التذكرة. بنعرّفها هنا بنص 024 حرفيًا (is_admin() ثم
--     recompute_user_access الموجودة على الإنتاج).
--
-- التغيير
--   • ALTER POLICY على السياستين بنفس اسميهما: الشرط الحرفي للرتبة يصير
--     is_admin() (= الرتبة admin **أو** المالك في سياق owner/admin). كل بديل
--     يتضمن الشرط القديم، فلا أحد يفقد وصولًا، و support لسه برّه زي ما كان.
--   • CREATE OR REPLACE لـ admin_recompute_user_access (authenticated فقط).
-- والاحتواء كما هو: المالك في سياق customer أو company_admin أو المعاينة لا
-- يملك is_admin().
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/071_owner_admin_context_billing_requests.down.sql
-- ============================================================================

alter policy "Admins can manage all subscriptions" on public.whatsapp_subscriptions
  using (public.is_admin());

alter policy "Admins can manage all wallet topup requests" on public.whatsapp_wallet_topup_requests
  using (public.is_admin());

create or replace function public.admin_recompute_user_access(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  return public.recompute_user_access(p_user_id);
end;
$$;

revoke all on function public.admin_recompute_user_access(uuid) from public, anon;
grant execute on function public.admin_recompute_user_access(uuid) to authenticated;

do $$
begin
  if (select count(*) from pg_policy
       where (polrelid = 'public.whatsapp_subscriptions'::regclass
              and polname = 'Admins can manage all subscriptions')
          or (polrelid = 'public.whatsapp_wallet_topup_requests'::regclass
              and polname = 'Admins can manage all wallet topup requests')) <> 2 then
    raise exception '071: سياسة ناقصة';
  end if;
  raise notice '071: المالك في سياق الإدارة يؤكّد ويرفض طلبات الاشتراك وشحن الرصيد';
end $$;
