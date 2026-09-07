-- ============================================================================
-- 022_revoke_trigger_function_execute.sql
--   دوال الـtrigger لا يجب أن تكون قابلة للنداء كـRPC.
--
-- كشفها فحص Supabase الأمني بعد تطبيق السلسلة: كل دالة SECURITY DEFINER في
-- سكيما public تُعرَض تلقائيًا على /rest/v1/rpc، ودوال الـtrigger ليست
-- استثناءً — رغم أن نداءها المباشر يفشل دائمًا بـ
-- "trigger functions can only be called as triggers".
--
-- فمفيش ثغرة قائمة، لكن مفيش سبب كذلك لتعريضها. سحب صلاحية التنفيذ لا يؤثر
-- على عمل الـtrigger: PostgreSQL يفحص صلاحية EXECUTE عند CREATE TRIGGER لا
-- عند إطلاقه (تم التحقق من ذلك عمليًا بعد السحب: الحارسان ما زالا يرفضان
-- الشراء المتداخل وتزوير التبعية).
-- ============================================================================

revoke all on function public.check_super_user_creation()            from public, anon, authenticated;
revoke all on function public.guard_profile_super_user_id_insert()   from public, anon, authenticated;
revoke all on function public.enforce_subscription_purchase_rules()  from public, anon, authenticated;
revoke all on function public.enforce_subscription_company_owner()   from public, anon, authenticated;
