-- ============================================================================
-- تراجع 080_company_members_privacy
--
-- يعيد company_members() لنص الإنتاج قبل 080 حرفيًا (md5 pg_get_functiondef =
-- 0e4030f30af1586d7f8f2ced6c3e7307، مقروء من الإنتاج 2026-10-12).
--
-- تحذير: التراجع يعيد الثغرة F4 — كل تابع (عميل) يرى أسماء وبريد كل تابعي
-- شركته. استعمله فقط لو كسر 080 مسارًا مشروعًا لمدير الشركة، وأصلح بعده.
--
-- لا بيانات تتغير: الدالة قراءة فقط. لا يلمس أي جدول أو سياسة أخرى.
-- ============================================================================

begin;

create or replace function public.company_members()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_company_id uuid; v_owner_id uuid; v_members jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select user_id into v_owner_id from public.companies where id = v_company_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'name', coalesce(m.full_name, m.username, m.email),
           'email', m.email,
           'role', m.role,
           'is_owner', (m.id = v_owner_id),
           'is_me', (m.id = auth.uid()),
           'created_at', m.created_at
         ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
    into v_members
    from public.profiles m
   where m.id = v_owner_id or m.super_user_id = v_owner_id;
  return jsonb_build_object(
    'company_id', v_company_id,
    'company_role', public.company_role(),
    'is_owner', (v_owner_id = auth.uid()),
    'can_manage', public.can_manage_company_members(),
    'members', v_members);
end;
$function$;

comment on function public.company_members() is
  'أعضاء شركة المستخدم الحالي. بلا مُعاملات — الشركة تُشتق من auth.uid()، فلا وصول لأعضاء شركة أخرى.';

do $$
begin
  if md5(pg_get_functiondef('public.company_members()'::regprocedure)) <> '0e4030f30af1586d7f8f2ced6c3e7307' then
    raise exception 'تراجع 080: النص المستعاد لا يطابق نص الإنتاج قبل 080';
  end if;
end $$;

commit;
