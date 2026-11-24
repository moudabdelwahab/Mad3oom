-- ============================================================================
-- 127_company_of_auth_check.sql
--   P0 — شرط إطلاق: إغلاق ثغرة عزل المستأجرين في company_of().
--
-- ما كان قائمًا (035_company_roles.sql، السطور ~268-285):
--   company_of(p_user_id uuid default auth.uid()) SECURITY DEFINER، ممنوحة
--   لـ authenticated، وتعيد شركة **أي** مستخدم يُمرَّر لها. فأي مستخدم موثَّق
--   كان يستطيع تمرير أي UUID واستكشاف شركة مستخدم آخر (وجودها ومعرّفها)،
--   مع أن الدالة هي «أساس عزل المستأجرين» حسب تعليقها في 035.
--
-- ما يفعله
--   1) الاستدعاء عن مستخدم آخر (p_user_id متمايز عن auth.uid()) يُعاد NULL
--      بصمت — لا يُكشَف وجود الشركة ولا يُرفَع خطأ يسرّب معلومات — ما لم
--      يكن المتصل صاحب امتياز موثَّق: مالك المنصة (is_platform_owner())
--      أو دور إداري (is_admin(): رتبة admin، أو المالك في سياق admin).
--      الدعم (support) ليس إداريًا هنا عمدًا: is_admin() لا تشمله أصلًا،
--      والإبقاء على is_admin() بدل توسيعها يطابق قاعدة 035 («الثلاث لم
--      تشمل support أصلًا، فنُبقيها على is_admin() حتى لا يوسّع الإصلاح»).
--   2) مسار الخادم الموثوق: service_role (auth.role() = 'service_role' بلا
--      JWT مستخدم) يمرّ كما كان — وهو أصلًا يتجاوز RLS ويقرأ companies
--      مباشرة، فالسماح له هنا لا يمنحه شيئًا جديدًا، ويُبقي مسارًا
--      للمهام الخلفية وEdge Functions دون دالة تجاوز منفصلة.
--   3) الاستدعاء بلا مُعامل (الافتراضي auth.uid()) والاستدعاء عن النفس
--      صراحةً: بلا أي تغيير في السلوك — نفس الاستعلام حرفيًا.
--
-- ما لا يفعله
--   • لا ينشئ دالة داخلية منفصلة (company_of_internal): الفحص الكامل
--     أثبت أنه لا يوجد أي مستدعٍ حيّ يمرّر معرّف مستخدم غير المتصل، فدالة
--     تجاوز بلا مستهلك كانت ستكون سطح هجوم ميتًا. الاستثناء للأدوار
--     المخوّلة وservice_role داخل company_of() نفسها هو المسار الموثوق.
--   • لا يغيّر التوقيع ولا المنح ولا التقلّب (stable) ولا SECURITY DEFINER.
--   • لا يمسّ الاستدعاءات الداخلية التي تمرّر auth.uid() نفسه: 036
--     (api_token_issue_context) و038 (available_contexts) و095/096
--     (my_account_kind / my_company_portal) — كلها عن النفس فتمرّ كما هي.
--   • لا يمسّ مسار التذاكر: _ticket_customer_company و_ticket_scope_stamp
--     (097) لا يناديان company_of() أصلًا، بل يقرآن company_memberships
--     مباشرة. ولا يمسّ نقل العملاء (101) ولا مراجعة طلبات الشركات
--     (105/106) ولا إدارة الأعضاء (113) — كلها تقرأ companies /
--     company_memberships مباشرة ولا تنادي company_of().
--
-- ملاحظة نطاق: owns_a_company(uuid) وbelongs_to_a_company(uuid) في 035
--   فيهما النمط نفسه (مُعامل uuid حرّ + SECURITY DEFINER + منح
--   authenticated)، لكنهما خارج نطاق هذا الترحيل؛ تُرفَعان كمتابعة منفصلة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/127_company_of_auth_check.down.sql
--   (يعيد تعريف 035 حرفيًا — أي يعيد الثغرة؛ يُستعمل فقط للتراجع الطارئ).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public.is_platform_owner()') is null then
    raise exception '127 يتطلب public.is_platform_owner() (038)';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '127 يتطلب public.is_admin() (040)';
  end if;
  if to_regprocedure('public.company_of(uuid)') is null then
    raise exception '127 يتطلب public.company_of(uuid) (035)';
  end if;
end $$;


-- ============================================================================
-- 1) company_of() — فحص المتصل قبل الرد عن مستخدم آخر
-- ============================================================================
--
-- القاعدة: عن النفس (أو بلا مُعامل) كما كان؛ عن غيرك NULL ما لم تكن مالك
-- المنصة أو إداريًا أو service_role. NULL بصمت لا خطأ: الخطأ نفسه يسرّب
-- أن المستخدم المستهدَف موجود وله شركة.
create or replace function public.company_of(p_user_id uuid default auth.uid())
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_user_id is null then
    return null;
  end if;

  -- is distinct from: يتعامل مع auth.uid() الفارغ (anon بلا JWT) كتمايز،
  -- فلا يمرّ مجهول الهوية بسؤال عن غيره.
  if p_user_id is distinct from auth.uid()
     and not coalesce(public.is_platform_owner(), false)
     and not coalesce(public.is_admin(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    return null;
  end if;

  -- الاستعلام الأصلي من 035 حرفيًا: الشركة المملوكة مباشرة أولًا، ثم شركة
  -- المالك الأعلى (super_user_id) للتابع.
  return (
    select c.id
      from public.companies c
     where c.user_id = p_user_id
        or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id)
     order by (c.user_id = p_user_id) desc
     limit 1
  );
end;
$$;

comment on function public.company_of(uuid) is
  '127: شركة حساب ما. عن النفس (أو بلا مُعامل) كما كان؛ عن مستخدم آخر NULL '
  'بصمت ما لم يكن المتصل مالك المنصة (is_platform_owner) أو إداريًا '
  '(is_admin) أو service_role. لا دالة تجاوز منفصلة: لا مستدعٍ حيّ يحتاجها.';

-- المنح كما هي في 035 بلا تغيير.
revoke all on function public.company_of(uuid) from public, anon;
grant execute on function public.company_of(uuid) to authenticated;


-- ============================================================================
-- 2) تحقق ذاتي — بنيوي فقط (بلا بيانات بذور هنا)
-- ============================================================================
-- السلوك يُثبَت في tests/sql/company-of-auth-check.test.sql. هنا نثبّت فقط
-- أن الحارس موجود في التعريف، وأن الخصائص البنيوية لم تتغير.
do $$
declare
  v_def text := pg_get_functiondef('public.company_of(uuid)'::regprocedure);
begin
  if v_def not like '%is distinct from auth.uid()%' then
    raise exception '127: حارس التمايز عن auth.uid() غائب من company_of()';
  end if;
  if v_def not like '%is_platform_owner()%' or v_def not like '%is_admin()%' then
    raise exception '127: استثناء الامتياز (owner/admin) غائب من company_of()';
  end if;
  if v_def not like '%service_role%' then
    raise exception '127: مسار service_role غائب من company_of()';
  end if;
  if v_def not like '%super_user_id%' then
    raise exception '127: مسار التابع (super_user_id) تغيّر في company_of()';
  end if;
  if not (select prosecdef from pg_proc
           where oid = 'public.company_of(uuid)'::regprocedure) then
    raise exception '127: company_of() لم تعد SECURITY DEFINER';
  end if;
  if (select provolatile from pg_proc
       where oid = 'public.company_of(uuid)'::regprocedure) <> 's' then
    raise exception '127: company_of() لم تعد STABLE';
  end if;
end $$;
