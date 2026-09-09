-- 025_purge_super_user_from_staff_policies.sql
-- إصلاح N6: مالك الشركة كان يُعدّ «طاقمًا» في 22 سياسة RLS.
-- ============================================================================
--
-- ما اكتُشف
--   الرتبة super_user لم تكن مجرد تسمية: **22 سياسة RLS** تضعها في مصفوفة
--   الطاقم إلى جانب admin و support. فمالك الشركة — و`is_admin()` تعيد false
--   له — كان يقرأ ويكتب بيانات داخلية لا تخصه.
--
--   مُثبَت على الإنتاج (قراءة فقط، داخل معاملة READ ONLY انتهت بـROLLBACK)
--   بانتحال هوية المالك الوحيد القائم:
--       ticket_activity      → 119 صفًّا (نشاط تذاكر كل العملاء)
--       ticket_attachments   →   9 صفوف (مرفقات كل العملاء، ومنها إثباتات الدفع)
--       accounting_invoices  →   3 صفوف (فواتير كل العملاء)
--       canned_responses / ticket_tags → مقروءة
--       customer_notes       → الجدول فارغ اليوم، لكن السياسة تمنحه CRUD كاملًا
--                              على الملاحظات الداخلية عن العملاء
--       is_chat_engine_staff() → true
--
--   ولم يكن هذا كامنًا: كان يعمل فعليًا لحظة الفحص. وكان سيصير عامًّا لكل
--   مشترٍ لباقة الدعم لحظة نجاح الترقية التلقائية التي كانت تفشل صامتة (H4).
--
-- الإصلاح
--   استبدال المصفوفة المكرّرة 22 مرة بدالة واحدة is_platform_staff() المعرَّفة
--   في 024. المكسب مزدوج: تُنزع super_user من كل موضع، ويصير للطاقم **تعريف
--   واحد** بدل 22 نسخة قد تنحرف عن بعضها.
--
--   السياسات محفوظة حرفيًا كما هي عدا استبدال شرط الرتبة — لم تُضَف صلاحية
--   ولم تُوسَّع أي قراءة.
--
-- ترتيب التطبيق: بعد 024 (التي تعرّف is_platform_staff).

-- ── تحقق من الترتيب ────────────────────────────────────────────────────────
-- هذا الترحيل يستبدل شرط الرتبة بـis_platform_staff() المعرَّفة في 024. تطبيقه
-- قبلها كان سيفشل بخطأ «function does not exist» في منتصف الطريق تاركًا نصف
-- السياسات محذوفة. نتوقف هنا برسالة واضحة بدل ذلك.
do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null then
    raise exception 'يجب تطبيق migrations/024 أولًا (is_platform_staff غير معرَّفة)';
  end if;
end $$;

-- ── جداول التذاكر ──────────────────────────────────────────────────────────

drop policy if exists "Staff can view activity" on public.ticket_activity;
create policy "Staff can view activity" on public.ticket_activity
  for select using (public.is_platform_staff());

drop policy if exists "Staff can insert activity" on public.ticket_activity;
create policy "Staff can insert activity" on public.ticket_activity
  for insert with check (public.is_platform_staff());

drop policy if exists "Staff can view all attachments" on public.ticket_attachments;
create policy "Staff can view all attachments" on public.ticket_attachments
  for select using (public.is_platform_staff());

drop policy if exists "Staff can upload attachments" on public.ticket_attachments;
create policy "Staff can upload attachments" on public.ticket_attachments
  for insert with check (public.is_platform_staff());

drop policy if exists "Staff can delete attachments" on public.ticket_attachments;
create policy "Staff can delete attachments" on public.ticket_attachments
  for delete using (public.is_platform_staff());

drop policy if exists "Staff can view all ratings" on public.ticket_ratings;
create policy "Staff can view all ratings" on public.ticket_ratings
  for select using (public.is_platform_staff());

drop policy if exists "Staff can view tags" on public.ticket_tags;
create policy "Staff can view tags" on public.ticket_tags
  for select using (public.is_platform_staff());

drop policy if exists "Staff can view tag links" on public.ticket_tag_links;
create policy "Staff can view tag links" on public.ticket_tag_links
  for select using (public.is_platform_staff());

drop policy if exists "Staff can manage tag links" on public.ticket_tag_links;
create policy "Staff can manage tag links" on public.ticket_tag_links
  for all using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can view canned responses" on public.canned_responses;
create policy "Staff can view canned responses" on public.canned_responses
  for select using (public.is_platform_staff());

-- ── ملاحظات العملاء الداخلية ───────────────────────────────────────────────

drop policy if exists "Admins can view customer notes" on public.customer_notes;
create policy "Admins can view customer notes" on public.customer_notes
  for select using (public.is_platform_staff());

drop policy if exists "Admins can insert customer notes" on public.customer_notes;
create policy "Admins can insert customer notes" on public.customer_notes
  for insert with check (public.is_platform_staff());

drop policy if exists "Admins can update their own notes" on public.customer_notes;
create policy "Admins can update their own notes" on public.customer_notes
  for update using (public.is_platform_staff());

drop policy if exists "Admins can delete customer notes" on public.customer_notes;
create policy "Admins can delete customer notes" on public.customer_notes
  for delete using (public.is_platform_staff());

-- ── الفوترة والويبهوكس (كانت admin + super_user فقط، بلا support) ──────────
--
-- ملاحظة: هذه الثلاث لم تكن تشمل support أصلًا، فنُبقيها على is_admin() حتى
-- لا يوسّع الإصلاح صلاحية لم تكن ممنوحة.

drop policy if exists "own_invoices_select" on public.accounting_invoices;
create policy "own_invoices_select" on public.accounting_invoices
  for select using ((user_id = auth.uid()) or public.is_admin());

drop policy if exists "Admins can view webhook deliveries" on public.webhook_deliveries;
create policy "Admins can view webhook deliveries" on public.webhook_deliveries
  for select using (public.is_admin());

drop policy if exists "Admins can manage webhooks" on public.webhooks;
create policy "Admins can manage webhooks" on public.webhooks
  for all using (public.is_admin()) with check (public.is_admin());

-- ── الشارات ────────────────────────────────────────────────────────────────

drop policy if exists "badge_definitions_admin_write" on public.badge_definitions;
create policy "badge_definitions_admin_write" on public.badge_definitions
  for all using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "badge_definitions_select_active" on public.badge_definitions;
create policy "badge_definitions_select_active" on public.badge_definitions
  for select using ((is_active = true) or public.is_platform_staff());

drop policy if exists "customer_badges_select_own" on public.customer_badges;
create policy "customer_badges_select_own" on public.customer_badges
  for select using ((user_id = auth.uid()) or public.is_platform_staff());

-- ── حذف البروفايلات ────────────────────────────────────────────────────────
--
-- كانت: is_main_admin() OR (super_user_id = uid AND role <> 'super_user')
-- أي أن مالك الشركة يستطيع **حذف صف بروفايل عضوه**. هذا لا يحذف حساب auth،
-- فينتج حساب قادر على الدخول بلا بروفايل — وهو ما تعالجه remove_company_member
-- بقطع العلاقة بدل الحذف. نُبقي الحذف للإدارة العليا وحدها.

drop policy if exists "profiles_delete_policy" on public.profiles;
create policy "profiles_delete_policy" on public.profiles
  for delete using (public.is_main_admin());

-- ============================================================================
-- تحقق: لا سياسة واحدة تبقى تذكر الرتبة القديمة
-- ============================================================================
do $$
declare v_left text;
begin
  select string_agg(c.relname || '.' || p.polname, ', ')
    into v_left
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ '''super_user''';

  if v_left is not null then
    raise exception 'ما زالت سياسات تمنح سلطة للرتبة القديمة: %', v_left;
  end if;
end $$;
