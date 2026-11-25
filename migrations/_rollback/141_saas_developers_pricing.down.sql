-- ============================================================================
-- التراجع عن 141_saas_developers_pricing
--   يحذف جداول ودوال Webhooks، وعمود بيئة المفتاح، ومفاتيح واتساب من الفائقة.
--   ما لا يسترجعه هذا الملف وحده (موثّق عمدًا):
--   • مفاتيح اختبار صُدرت أثناء سريان 141 تبقى ببادئتها المميزة
--     (mad3oom_pk_test_ / mad3oom_bt_test_) لكن عمود environment يزول،
--     فتُعامَل كمفاتيح حية ما لم تُسحَب — اسحبها قبل التراجع.
--   • سجل تسليم Webhooks يُحذف مع جداوله (لا نسخة احتياطية هنا).
--   • الأسعار لا تُمسّ أصلًا في 141، فلا شيء يُستعاد فيها.
-- ============================================================================

drop function if exists public.company_webhook_enqueue(uuid, text, jsonb);
drop function if exists public.company_webhook_deliveries(uuid, integer);
drop function if exists public.company_webhook_rotate_secret(uuid);
drop function if exists public.company_webhook_delete(uuid);
drop function if exists public.company_webhook_update(uuid, text, text, text[], boolean);
drop function if exists public.company_webhook_list(uuid);
drop function if exists public.company_webhook_create(uuid, text, text, text[]);
drop function if exists public.company_webhook_json(public.company_webhooks);
drop function if exists public.company_webhook_scope(uuid);

drop table if exists public.company_webhook_deliveries;
drop table if exists public.company_webhooks;

alter table public.api_tokens drop column if exists environment;

delete from public.plan_features pf
 using public.subscription_plans sp
 where pf.plan_id = sp.id and sp.key = 'ultimate'
   and pf.feature_key in ('whatsapp_sender', 'whatsapp_autoreply',
                          'whatsapp_campaigns', 'whatsapp_wallet');
