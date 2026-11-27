-- ============================================================================
-- 145_supervises_same_company.down.sql — تراجع طارئ فقط
--   يعيد تعريفات 041/107 وسياسة 070 حرفيًا — أي يعيد التسريب؛ يُستعمل فقط
--   للتراجع الطارئ.
-- ============================================================================
create or replace function public.supervises(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and not public.preview_mode()
     and exists (
           select 1 from public.profiles p
            where p.id = p_user_id
              and p.super_user_id = auth.uid()
         );
$$;

comment on function public.supervises(uuid) is
  'هل المنادي مالك شركة هذا الحساب؟ تُطفأ داخل معاينة العضو: العضو لا يشرف '
  'على أحد، فالمعاينة لا يجوز أن تشرف.';

revoke all on function public.supervises(uuid) from public, anon;
grant execute on function public.supervises(uuid) to authenticated;

create or replace function public.ticket_in_my_scope(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (t.user_id = auth.uid() or public.supervises(t.user_id))
         )
     -- 107: مع العزل، نفس قاعدة الظهور في 097 (لا تذكرة لعميل مع مدعوم عبر super_user_id)
     and (not public._isolation_on() or public._ticket_id_visible(p_ticket_id));
$function$;

create or replace function public.can_access_ticket(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select p_ticket_id is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (
            t.user_id = auth.uid()
         or public.is_platform_staff()
         or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid())
       )
  )
  -- 107: مع العزل، نفس قاعدة الظهور في 097
  and (not public._isolation_on() or public._ticket_id_visible(p_ticket_id));
$function$;

-- (تصحيح) إعادة سياسة 070 حرفيًا (بلا طبقة شركة التذكرة) — قبل حذف الدالة
-- المساعدة، لأن السياسة تعتمد عليها ولا يمكن حذفها قبل استعادتها.
alter policy tickets_select_policy on public.tickets
  using (
    user_id = auth.uid()
    or public.has_elevated_authority()
    or public.is_admin()
    or public.supervises(user_id)
  );

drop function if exists public._ticket_supervises_visible(uuid, uuid);
drop function if exists public._supervises_same_company(uuid);

do $$
begin
  if pg_get_functiondef('public.supervises(uuid)'::regprocedure) like '%_supervises_same_company%' then
    raise exception 'تراجع 145: شرط الشركة الواحدة ما زال في supervises()';
  end if;
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'tickets' and policyname = 'tickets_select_policy') like '%_ticket_supervises_visible%' then
    raise exception 'تراجع 145: طبقة شركة التذكرة ما زالت في tickets_select_policy';
  end if;
  raise notice '145 rollback: عادت تعريفات 041/107 وسياسة 070 (والتسريب معها — تراجع طارئ فقط)';
end $$;
