-- ============================================================================
-- التراجع عن 146_company_five_sections
--   يحذف الدوال الـ12 العامة والـ8 الداخلية.
--   ما لا يسترجعه هذا الملف وحده (موثّق عمدًا):
--   • صفوف مساحات الشركة (continuity_workspaces kind='company') وسجلاتها
--     وملاحظاتها وأحداثها تبقى: حذف بيانات شركة حية ليس إجراء تراجع آمنًا،
--     والتراجع هنا كود لا بيانات. لحذف بيانات شركة بعينها يلزم إجراء
--     منفصل بموافقة مالك المنصة.
--   • لا جداول جديدة في 146 أصلًا (إعادة استعمال جداول 073/077/093)،
--     فلا حذف جداول هنا.
-- ============================================================================

drop function if exists public.company_continuity_my_access();
drop function if exists public.company_continuity_list(jsonb);
drop function if exists public.company_continuity_get(uuid);
drop function if exists public.company_continuity_create(jsonb);
drop function if exists public.company_continuity_update(uuid, jsonb, integer);
drop function if exists public.company_continuity_transition(uuid, text, jsonb, integer);
drop function if exists public.company_continuity_assign(uuid, uuid, integer);
drop function if exists public.company_continuity_note_add(uuid, text);
drop function if exists public.company_continuity_notes_for(uuid);
drop function if exists public.company_continuity_events_for(uuid, bigint, integer);
drop function if exists public.company_customer_history(uuid);
drop function if exists public.company_team_performance(date, date);

-- الداخلية: CASCADE لأن دوال SQL منها يعتمد بعضها على بعض (can_access على
-- is_supervisor مثلًا)؛ لا يعتمد عليها شيء خارج 146.
drop function if exists public._company_continuity_workspace() cascade;
drop function if exists public._company_continuity_ensure_workspace() cascade;
drop function if exists public._company_continuity_require_member() cascade;
drop function if exists public._company_continuity_is_supervisor() cascade;
drop function if exists public._company_continuity_can_access(uuid) cascade;
drop function if exists public._company_continuity_can_edit(public.continuity_records) cascade;
drop function if exists public._company_continuity_lock_for_write(uuid, integer) cascade;
drop function if exists public._company_continuity_full(uuid, boolean) cascade;
