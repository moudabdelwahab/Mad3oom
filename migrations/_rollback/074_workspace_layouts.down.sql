-- ============================================================================
-- تراجع 074_workspace_layouts
--
-- يحذف ترتيبات مساحة العمل المحفوظة على الخادم. هي تفضيل واجهة لا أكثر:
-- الواجهة تعود للحفظ المحلي (localStorage) تلقائيًا حين تختفي الدالتان، ولا
-- يُفقد أي سجل دعم (محادثة، تذكرة، عميل). لا شيء آخر يعتمد على الجدول.
-- ============================================================================

begin;

drop function if exists public.workspace_save_layout(jsonb, bigint);
drop function if exists public.workspace_get_layout();
drop table if exists public.workspace_layouts;

do $$
begin
  if to_regclass('public.workspace_layouts') is not null
     or to_regprocedure('public.workspace_get_layout()') is not null
     or to_regprocedure('public.workspace_save_layout(jsonb,bigint)') is not null then
    raise exception 'تراجع 074: كائنات ما زالت موجودة';
  end if;
  raise notice 'تراجع 074: اكتمل';
end $$;

commit;
