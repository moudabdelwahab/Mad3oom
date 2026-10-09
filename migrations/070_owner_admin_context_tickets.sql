-- ============================================================================
-- 070_owner_admin_context_tickets.sql
--   مالك المنصة في سياق «الإدارة» يرى تذاكر العملاء ويدير ردودها كالأدمن
--
-- البلاغ (من صاحب المنصة): «لما دخلت من حساب المالك علي لوحة الادارة التذاكر
-- بتاعت العملا مظهرتش».
--
-- السبب (مقروء من الإنتاج 2026-10-09)
--   • 040 جعل سلطة المالك سياقية: في سياق admin يملك is_admin() و
--     is_platform_staff()، وفي سياق owner يملك has_elevated_authority().
--     والقصد معلن: «مالك المنصة داخل سياق الإدارة يرى ما يراه الأدمن».
--   • لكن سياسات tickets و ticket_replies مكتوبة بالرتبة حرفيًا
--     (profiles.role = 'admin') أو بـ has_elevated_authority() — والمالك رتبته
--     platform_owner، وسياق admin لا يسمح بـ owner_only. فلا يرى إلا تذاكره:
--     على الإنتاج 33 تذكرة عميل مخفية عنه وهو في سياق admin (منذ 06:57 UTC).
--   • باقي صفحة التذاكر (المرفقات، السجل، الوسوم، الملاحظات، التقييمات) على
--     is_platform_staff() السياقية أصلًا — سليمة.
--
-- التغيير
--   • ALTER POLICY على خمس سياسات بنفس أسمائها: الشرط الحرفي للرتبة يصير
--     is_admin() (= الرتبة admin **أو** المالك في سياق owner/admin)، وقراءة
--     الردود للطاقم تصير is_platform_staff().
--   • محفّزا تعديل التذكرة (enforce_customer_ticket_update_restrictions و
--     restrict_customer_ticket_update) فيهما نفس الفحص الحرفي، فكانا يعاملان
--     المالك كعميل ويرفضان تغيير الحالة/الأولوية. نص الإنتاج حرفيًا، والتغيير
--     الوحيد: `role = 'admin'` ← is_admin(). قيود العميل كما هي.
-- كل بديل يتضمن الشرط القديم، فلا أحد يفقد وصولًا. والاحتواء كما هو: المالك
-- في سياق customer أو company_admin أو المعاينة لا يملك is_admin() ولا
-- is_platform_staff().
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/070_owner_admin_context_tickets.down.sql
-- ============================================================================

alter policy tickets_select_policy on public.tickets
  using (
    user_id = auth.uid()
    or public.has_elevated_authority()
    or public.is_admin()
    or public.supervises(user_id)
  );

alter policy "Admin can update tickets" on public.tickets
  using (public.is_admin());

alter policy "Admin can delete tickets" on public.tickets
  using (public.is_admin());

alter policy ticket_replies_select_policy on public.ticket_replies
  using (
    public.has_elevated_authority()
    or public.is_platform_staff()
    or (coalesce(is_internal, false) = false and public.ticket_in_my_scope(ticket_id))
  );

alter policy "Users can add replies to their tickets" on public.ticket_replies
  with check (
    user_id = auth.uid()
    and (
      public.has_elevated_authority()
      or public.is_admin()
      or public.ticket_in_my_scope(ticket_id)
    )
  );

create or replace function public.enforce_customer_ticket_update_restrictions()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
    is_admin boolean;
BEGIN
    IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
        RETURN NEW;
    END IF;

    -- 070: is_admin() بدل الرتبة الحرفية — تشمل المالك في سياق owner/admin
    SELECT (public.is_main_admin() OR public.is_admin()) INTO is_admin;

    IF COALESCE(is_admin, false) THEN
        RETURN NEW; -- الأدمن يقدر يعدل أي عمود
    END IF;

    -- أي عمود غير أعمدة الأرشفة اتغيّر ومنفذّه مش أدمن؟ نرفض العملية بالكامل
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number
       OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.ticket_type IS DISTINCT FROM OLD.ticket_type
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.subdomain_id IS DISTINCT FROM OLD.subdomain_id
       OR NEW.contact_info IS DISTINCT FROM OLD.contact_info
       OR NEW.first_response_at IS DISTINCT FROM OLD.first_response_at
       OR NEW.sla_alert_sent IS DISTINCT FROM OLD.sla_alert_sent
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'غير مسموح للعميل بتعديل هذا الحقل في التذكرة';
    END IF;

    RETURN NEW;
END;
$function$;

create or replace function public.restrict_customer_ticket_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  is_caller_admin boolean;
BEGIN
  IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- 070: is_admin() بدل الرتبة الحرفية — تشمل المالك في سياق owner/admin
  SELECT public.is_admin() INTO is_caller_admin;

  IF is_caller_admin THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.user_id THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number THEN
      RAISE EXCEPTION 'العميل غير مسموح له بتعديل هذه الحقول، يمكنه فقط أرشفة التذكرة';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

do $$
begin
  if (select count(*) from pg_policy
       where (polrelid = 'public.tickets'::regclass
              and polname in ('tickets_select_policy', 'Admin can update tickets', 'Admin can delete tickets'))
          or (polrelid = 'public.ticket_replies'::regclass
              and polname in ('ticket_replies_select_policy', 'Users can add replies to their tickets'))) <> 5 then
    raise exception '070: سياسة ناقصة';
  end if;
  raise notice '070: المالك في سياق الإدارة يرى تذاكر العملاء ويرد عليها ويعدّلها كالأدمن';
end $$;
