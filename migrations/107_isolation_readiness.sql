-- ============================================================================
-- 107_isolation_readiness.sql
--   سدّ ثغرتين تمنعان تفعيل company_isolation_enforced بأمان (تدقيق 2026-10-19، docs/tenancy/ISOLATION_READINESS_107.md):
--   دالتان بامتياز المالك (SECURITY DEFINER) تتجاوزان سياسات tenant_isolation لأن RLS لا تنطبق داخلهما:
--     • ticket_in_my_scope — تبوّب close_ticket_in_my_scope و reopen_ticket_in_my_scope (لوحة الشركة) و
--       _ihub_ticket_viewer. كانت تقبل أي تذكرة لتابع عبر supervises(): بعد العزل يظل مالك الشركة قادرًا
--       على إغلاق تذكرة قديمة لعميله مع مدعوم أو إعادة فتحها بمعرّفها، ويكشف اختلاف الخطأ وجودها وحالتها.
--     • can_access_ticket — فحص منطقي بنفس الثغرة (super_user_id).
--   الإصلاح: الشرط القديم كما هو، و— حين العزل مفعّل — يجب أن تكون التذكرة ظاهرة بقاعدة 097 نفسها
--   (_ticket_id_visible). مع العزل مطفأً لا يتغير أي سلوك.
--
-- لا مفتاح يُفعَّل. قابل لإعادة التشغيل. التراجع: migrations/_rollback/107_isolation_readiness.down.sql
-- ============================================================================
do $$
begin
  if to_regprocedure('public._ticket_id_visible(uuid)') is null or to_regprocedure('public._isolation_on()') is null then
    raise exception '107 يتطلب 097_ticket_scope_isolation';
  end if;
end $$;

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

do $$
begin
  if position('_ticket_id_visible' in pg_get_functiondef('public.ticket_in_my_scope(uuid)'::regprocedure)) = 0
     or position('_ticket_id_visible' in pg_get_functiondef('public.can_access_ticket(uuid)'::regprocedure)) = 0 then
    raise exception '107: الشرط غير مركّب';
  end if;
end $$;
