-- ============================================================================
-- التراجع عن 137_saas_trial_3_days
--   يحذف دوال التجربة وجدول طلباتها.
--   ما لا يسترجعه هذا الملف (موثّق عمدًا):
--   • اشتراكات تجربة أُنشئت بموافقة مالك: صفوف في whatsapp_subscriptions
--     تبقى كما هي (فعّالة حتى انتهائها ثم تنتهي تلقائيًا عبر
--     expire_stale_subscriptions) — حذف التراجع لها كان سيُسقط امتيازًا
--     ممنوحًا بقرار مالك دون أثر؛ أوقفها من مسار الاشتراكات إن لزم.
--   • صفوف privileged_audit / subscription_audit_log للقرارات: سجل
--     تدقيق append-only لا يُحذف.
-- ============================================================================
drop function if exists public.expire_saas_trials();
drop function if exists public.owner_decide_saas_trial(uuid, text, text);
drop function if exists public.owner_list_saas_trial_requests(text);
drop function if exists public.my_saas_trial_status();
drop function if exists public.cancel_saas_trial(uuid);
drop function if exists public.request_saas_trial(text);
drop function if exists public._trial_plan_allowed(text, text);
drop function if exists public._trial_request_json(uuid);
drop table if exists public.saas_trial_requests cascade;
