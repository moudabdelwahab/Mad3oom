-- ============================================================================
-- _rollback/134_admin_fix_suggestions_wallet_workflows.down.sql
--   تراجع ترحيل 134: يحذف الدوال الجديدة وجدول suggestions فقط.
--   الجداول المثبّتة في القسم 2 لا تُحذف عمدًا — حذفها قد يمحو بيانات حية
--   وُجدت أصلًا قبل الترحيل؛ التثبيت بـ IF NOT EXISTS لا ينشئ شيئًا
--   جديدًا على قاعدة حية، فلا شيء يُسترجع منه.
-- ============================================================================

drop function if exists public.publish_workflow_version(uuid);
drop function if exists public.publish_workflow(uuid, text);
drop function if exists public.create_workflow_draft_version(uuid, uuid, text);
drop function if exists public.send_test_telegram_alert();
drop function if exists public.transfer_points_from_central(text, bigint);
drop function if exists public.manage_user_points(text, bigint, text);
drop function if exists public.send_telegram_message(text, text);

drop table if exists public.suggestions;
