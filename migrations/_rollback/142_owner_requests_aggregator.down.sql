-- ============================================================================
-- التراجع عن 142_owner_requests_aggregator
--   يحذف دالة التجميع وحدها.
--   ما لا يسترجعه هذا الملف (موثّق عمدًا):
--   • الجداول الخمسة المقروءة (company_account_requests و
--     saas_trial_requests و refund_requests و
--     company_deletion_requests و suggestions): بلا مساس إطلاقًا.
--   • أي صف طلب: المجمّع قراءة فقط، فلا صفوف له ليسترجعها.
-- ============================================================================
drop function if exists public.owner_list_requests(text, text);
