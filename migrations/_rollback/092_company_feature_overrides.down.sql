-- ============================================================================
-- التراجع عن 092_company_feature_overrides
--   يعيد company_has_feature() إلى تعريف 021 حرفيًا (بصمة الإنتاج قبل 092:
--   md5(pg_get_functiondef) = 82ff4a3898fe0a0bdac756767119f0cf) ويحذف جدول الاستثناءات.
--   أي شركة كانت مستحقة باستثناء فقط تفقد الامتياز فورًا (مركز التكاملات يعود للعرض فقط).
-- ============================================================================
create or replace function public.company_has_feature(p_feature_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key);
$function$;

comment on function public.company_has_feature(text) is
  'هل تملك شركة المستخدم الحالي هذا الامتياز عبر اشتراك فعّال؟ لا تأخذ معرّف شركة كمُعامل عمدًا — لا يوجد ما يُلاعَب به.';

drop table if exists public.company_feature_overrides;
