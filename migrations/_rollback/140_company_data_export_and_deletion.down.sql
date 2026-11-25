-- ============================================================================
-- التراجع عن 140_company_data_export_and_deletion
--   يسقط الدوال الخمس والجدولين.
--   ما لا يسترجعه هذا الملف وحده (موثّق عمدًا):
--   • صفوف التدقيق (company_data_exports) وطلبات الحذف
--     (company_deletion_requests) تُحذف مع الجدولين — سجل التدقيق
--     يُفقد؛ احتفظ بنسخة قبل التراجع إن لزم.
--   • طلب حذف قيد الانتظار يُلغى ضمنًا بسقوط الجدول؛ أعد إنشاءه من
--     الواجهة بعد إعادة تطبيق 140 إن كان ما زال مطلوبًا.
-- ============================================================================
drop function if exists public.company_cancel_deletion_request();
drop function if exists public.company_deletion_request_status();
drop function if exists public.company_request_account_deletion(text);
drop function if exists public.company_data_exports_list();
drop function if exists public.company_export_data();
drop table if exists public.company_deletion_requests;
drop table if exists public.company_data_exports;
