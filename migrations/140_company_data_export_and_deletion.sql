-- ============================================================================
-- 140_company_data_export_and_deletion.sql
--   تصدير بيانات الشركة + طلب حذف حسابها ذاتيًا، من لوحة الشركة.
--
--   البند 2 — تصدير كامل لبيانات الشركة في ملف JSON واحد:
--     company_export_data() تجمع — لمدير الشركة وحده — الملف الشخصي
--     للشركة والأعضاء والتذاكر والاشتراكات وسجل النشاط، وتكتب صف تدقيق
--     في company_data_exports (من صدّر ومتى وماذا شمل التصدير).
--     الفواتير غير متاحة على مستوى الشركة (موثّق في
--     assets/js/company/company-invoices-model.js بأن
--     COMPANY_INVOICE_SOURCE.available = false: جدول accounting_invoices
--     بلا عمود company_id، والفاتورة تُرفق داخل تذكرة طلب الاشتراك) —
--     فالتصدير يذكر غيابها صراحةً في قسم invoices (available=false مع
--     السبب وموطن الفاتورة) بدل اختراع صفوف.
--     ما لا يدخل الملف عمدًا: هواتف الأعضاء (قاعدة خصوصية الأعضاء 085
--     تحجبها عن عرض المدير نفسه)، وبيانات الدفع في الاشتراكات
--     (payment_method/payment_reference/price_snapshot لا تدخل ملفًا
--     قابلًا لإعادة الإرسال)، وعناوين IP ووكلاء المستخدم في سجل النشاط.
--
--   البند 3 — حذف حساب ذاتي واضح:
--     company_request_account_deletion(p_reason) — مدير الشركة وحده،
--     سبب إلزامي (20 حرفًا على الأقل)، وطلب واحد قيد الانتظار لكل شركة
--     (مانعة للتكرار: الثاني 23505). الطلب نفسه لا يحذف شيئًا ولا يوقف
--     الشركة؛ يبقى قيد الانتظار حتى يراجعه مالك المنصة وينفّذ.
--     company_cancel_deletion_request() يلغي الطلب المعلّق.
--     سياسة التنفيذ الموثقة (في تعليق الدالة وفي الواجهة):
--       • يُحذف/يُجهَّل عند التنفيذ: الحقول الشخصية في صف الشركة (البريد
--         والهاتف والعنوان)، وبيانات الأعضاء الشخصية (الأسماء والبريد
--         والهاتف)، ومحتوى تذاكر الشركة؛ تُجهَّل الهويات فلا يبقى رابط
--         إلى شخص.
--       • يُحتفظ به ولِمَ: الاشتراكات والسجلات المالية وصفوف
--         accounting_invoices وسجلات التدقيق (سجل التصدير هذا، وطلبات
--         الحذف، وسجل العضويات) — للاحتفاظ القانوني والمحاسبي، بلا
--         بيانات شخصية قابلة للربط بعد التجهيل.
--     لا يوجد مسار حذف ذاتي اليوم (data-deletion.html صفحة ثابتة تحيل
--     لبريد الدعم فقط) — هذا الترحيل والواجهة يبنيانه.
--
--   قابل لإعادة التشغيل. التراجع: migrations/_rollback/140_company_data_export_and_deletion.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات — ما يعتمد عليه الترحيل من ترحيلات سابقة
-- ============================================================================
do $$
declare
  missing text;
begin
  foreach missing in array array[
    'public.current_company_id()', 'public.is_company_admin()'
  ] loop
    if to_regprocedure(missing) is null then
      raise exception '140 يتطلب % (016/035/040/095)', missing;
    end if;
  end loop;
  foreach missing in array array[
    'public.companies', 'public.company_memberships', 'public.profiles',
    'public.tickets', 'public.whatsapp_subscriptions', 'public.activity_logs',
    'public.company_membership_events'
  ] loop
    if to_regclass(missing) is null then
      raise exception '140 يتطلب جدول %', missing;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'tickets' and column_name = 'scope')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'tickets' and column_name = 'company_id') then
    raise exception '140 يتطلب عمودي scope و company_id في tickets (097)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'whatsapp_subscriptions' and column_name = 'company_id') then
    raise exception '140 يتطلب عمود company_id في whatsapp_subscriptions (016)';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول — سجل تدقيق التصدير، وطلبات الحذف
-- ============================================================================
create table if not exists public.company_data_exports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  exported_by uuid not null,
  exported_at timestamptz not null default now(),
  sections    jsonb not null default '{}'::jsonb,
  file_name   text not null,
  format      text not null default 'json' check (format = 'json')
);
comment on table public.company_data_exports is
  '140: سجل تدقيق تصدير بيانات الشركة — من صدّر ومتى وماذا شمل التصدير (عدّادات الأقسام) واسم الملف. لا وصول مباشر لأي دور؛ الكتابة عبر company_export_data() والقراءة عبر company_data_exports_list().';
alter table public.company_data_exports enable row level security;
revoke all on table public.company_data_exports from public, anon, authenticated, service_role;
create index if not exists company_data_exports_company_at
  on public.company_data_exports (company_id, exported_at desc);

create table if not exists public.company_deletion_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  requested_by  uuid not null,
  reason        text not null check (char_length(reason) >= 20),
  status        text not null default 'pending'
                  check (status in ('pending', 'cancelled', 'executed')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid,
  decision_note text
);
comment on table public.company_deletion_requests is
  '140: طلبات حذف حساب الشركة الذاتية. الطلب قيد الانتظار لا يحذف شيئًا ولا يوقف الشركة؛ التنفيذ يدوي من مالك المنصة وفق السياسة الموثقة في تعليق company_request_account_deletion(). لا وصول مباشر لأي دور.';
alter table public.company_deletion_requests enable row level security;
revoke all on table public.company_deletion_requests from public, anon, authenticated, service_role;
create unique index if not exists company_deletion_requests_one_pending
  on public.company_deletion_requests (company_id) where status = 'pending';
create index if not exists company_deletion_requests_company_at
  on public.company_deletion_requests (company_id, created_at desc);


-- ============================================================================
-- 2) company_export_data() — التصدير الكامل + صف التدقيق
-- ============================================================================
--   البوابة: مدير الشركة وحده (is_company_admin). الشركة من
--   current_company_id() — سياق المنادي، لا معرّف من المتصفح.
--   التذاكر بحدّ company_tickets_list نفسه (500)؛ النشاط بحدّ 500،
--   وأحداث العضويات بحدّ 200. الفواتير قسم صريح available=false.
create or replace function public.company_export_data()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_owner_id   uuid;
  v_company    jsonb;
  v_members    jsonb;
  v_member_ids uuid[];
  v_tickets    jsonb;
  v_subs       jsonb;
  v_activity   jsonb;
  v_mem_events jsonb;
  v_counts     jsonb;
  v_file       text;
  v_invoices   jsonb := jsonb_build_object(
    'available', false,
    'table', 'accounting_invoices',
    'reason', 'الفواتير لا تُسجَّل على مستوى الشركة: جدول الفواتير بلا عمود يربط الفاتورة بشركة، والفاتورة تُرفق داخل تذكرة طلب الاشتراك نفسها.',
    'invoice_home', 'subscription_request_ticket',
    'rows', '[]'::jsonb);
begin
  if auth.uid() is null then
    raise exception 'سجّل الدخول أولًا' using errcode = '42501';
  end if;
  if not coalesce(public.is_company_admin(), false) then
    raise exception 'تصدير بيانات الشركة لمدير الشركة وحده' using errcode = '42501';
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    raise exception 'لا توجد شركة في سياقك الحالي' using errcode = 'P0002';
  end if;

  select user_id into v_owner_id from public.companies where id = v_company_id;
  if v_owner_id is null then
    raise exception 'لا توجد شركة في سياقك الحالي' using errcode = 'P0002';
  end if;

  -- الملف الشخصي للشركة — كل أعمدة صف companies (بلا أسرار فيه).
  select jsonb_build_object(
           'id', c.id,
           'name', c.company_name,
           'cr_number', c.commercial_registration_number,
           'cr_expiry', c.commercial_registration_expiry,
           'status', c.status,
           'email', c.company_email,
           'phone', c.company_phone,
           'address', c.address,
           'city', c.city,
           'country', c.country,
           'website', c.website,
           'industry', c.industry,
           'employee_count', c.employee_count,
           'tax_id', c.tax_id,
           'created_at', c.created_at,
           'updated_at', c.updated_at)
    into v_company
    from public.companies c where c.id = v_company_id;

  -- الأعضاء: المالك + العضويات النشطة. بلا هواتف — قاعدة خصوصية
  -- الأعضاء (085) تحجبها عن عرض المدير نفسه، فلا تدخل ملفًا محمولًا.
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id,
             'name', coalesce(p.full_name, p.username, p.email),
             'email', p.email,
             'role', case when p.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (p.id = v_owner_id),
             'is_primary', coalesce(cm.is_primary, false),
             'joined_at', cm.joined_at,
             'created_at', p.created_at)
           order by (p.id = v_owner_id) desc, p.created_at), '[]'::jsonb)
    into v_members
    from public.profiles p
    left join public.company_memberships cm
      on cm.user_id = p.id and cm.company_id = v_company_id and cm.status = 'active'
   where p.id = v_owner_id
      or exists (select 1 from public.company_memberships cm2
                  where cm2.company_id = v_company_id and cm2.user_id = p.id and cm2.status = 'active');

  select coalesce(array_agg(p.id), '{}'::uuid[])
    into v_member_ids
    from public.profiles p
   where p.id = v_owner_id
      or exists (select 1 from public.company_memberships cm2
                  where cm2.company_id = v_company_id and cm2.user_id = p.id and cm2.status = 'active');

  -- التذاكر: نطاق الشركة وحدها، بحدّ company_tickets_list نفسه (500).
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id,
             'ticket_number', t.ticket_number,
             'title', t.title,
             'description', t.description,
             'status', t.status,
             'priority', t.priority,
             'category', t.category,
             'ticket_type', t.ticket_type,
             'user_id', t.user_id,
             'assigned_to', t.assigned_to,
             'created_at', t.created_at,
             'first_response_at', t.first_response_at,
             'resolved_at', t.resolved_at,
             'last_updated_at', t.last_updated_at)
           order by t.created_at desc), '[]'::jsonb)
    into v_tickets
    from (select * from public.tickets
           where scope = 'company' and company_id = v_company_id
           order by created_at desc limit 500) t;

  -- الاشتراكات: المرتبطة بالشركة صراحةً أو بمالكها — نفس مساواة
  -- get_my_company_dashboard() (016)، فالشركة المنشأة بعد اشتراك قائم
  -- ترى اشتراكها بلا backfill. بلا بيانات دفع (payment_method /
  -- payment_reference / price_snapshot لا تدخل ملفًا قابلًا لإعادة الإرسال).
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id,
             'plan', s.plan,
             'status', s.status,
             'billing_cycle', s.billing_cycle,
             'start_date', s.start_date,
             'end_date', s.end_date,
             'duration_days', s.duration_days,
             'created_at', s.created_at)
           order by s.end_date desc), '[]'::jsonb)
    into v_subs
    from public.whatsapp_subscriptions s
   where s.company_id = v_company_id or s.user_id = v_owner_id;

  -- سجل النشاط: صفوف activity_logs لأعضاء الشركة (المالك + النشطون).
  -- بلا ip_address ولا user_agent — معرّفات شخصية لا يلزمها نسخة بيانات.
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id,
             'user_id', a.user_id,
             'action', a.action,
             'details', a.details,
             'created_at', a.created_at)
           order by a.created_at desc), '[]'::jsonb)
    into v_activity
    from (select * from public.activity_logs
           where user_id = any(v_member_ids)
           order by created_at desc limit 500) a;

  -- أحداث العضويات: سجل إلحاقي يبقى بعد حذف الحساب أو الشركة (096).
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', e.id,
             'user_id', e.user_id,
             'actor_id', e.actor_id,
             'action', e.action,
             'detail', e.detail,
             'created_at', e.created_at)
           order by e.created_at desc), '[]'::jsonb)
    into v_mem_events
    from (select * from public.company_membership_events
           where company_id = v_company_id
           order by created_at desc limit 200) e;

  v_counts := jsonb_build_object(
    'members', jsonb_array_length(v_members),
    'tickets', jsonb_array_length(v_tickets),
    'subscriptions', jsonb_array_length(v_subs),
    'activity', jsonb_array_length(v_activity),
    'membership_events', jsonb_array_length(v_mem_events),
    'invoices', 0);
  v_file := 'mad3oom-company-data-' || to_char(now(), 'YYYY-MM-DD') || '.json';

  -- صف التدقيق — يُكتب قبل الرد، فكل تصدير ناجح مسجَّل.
  insert into public.company_data_exports (company_id, exported_by, sections, file_name)
  values (v_company_id, auth.uid(), v_counts, v_file);

  return jsonb_build_object(
    'format', 'mad3oom-company-data-export',
    'format_version', 1,
    'exported_at', now(),
    'exported_by', auth.uid(),
    'company', v_company,
    'members', v_members,
    'tickets', v_tickets,
    'subscriptions', v_subs,
    'invoices', v_invoices,
    'activity', v_activity,
    'membership_events', v_mem_events,
    'counts', v_counts,
    'file_name', v_file);
end $$;

comment on function public.company_export_data() is
  '140: تصدير كامل لبيانات الشركة (الملف الشخصي والأعضاء والتذاكر والاشتراكات وسجل النشاط) في JSON واحد، لمدير الشركة وحده، مع صف تدقيق في company_data_exports. الفواتير قسم صريح available=false — لا مصدر موثوق لها على مستوى الشركة. بلا هواتف أعضاء (085) وبلا بيانات دفع وبلا IP في النشاط.';


-- ============================================================================
-- 3) company_data_exports_list() — آخر عمليات التصدير للمدير
-- ============================================================================
create or replace function public.company_data_exports_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_company_admin(), false) then
    return null;
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    return null;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'exported_at', x.exported_at,
             'exported_by', x.exported_by,
             'sections', x.sections,
             'file_name', x.file_name)
           order by x.exported_at desc), '[]'::jsonb)
            from (select * from public.company_data_exports
                   where company_id = v_company_id
                   order by exported_at desc limit 10) x);
end $$;

comment on function public.company_data_exports_list() is
  '140: آخر 10 عمليات تصدير لبيانات الشركة — لمدير الشركة وحده، وإلا null.';


-- ============================================================================
-- 4) company_request_account_deletion() — طلب حذف الحساب الذاتي
-- ============================================================================
--   سياسة التنفيذ (تُنفَّذ يدويًا من مالك المنصة بعد مراجعة الطلب؛
--   الطلب نفسه لا يحذف شيئًا ولا يوقف الشركة):
--     • يُحذف/يُجهَّل: الحقول الشخصية في صف الشركة (البريد والهاتف
--       والعنوان)، وبيانات الأعضاء الشخصية (الأسماء والبريد والهاتف)،
--       ومحتوى تذاكر الشركة؛ تُجهَّل الهويات فلا يبقى رابط إلى شخص.
--     • يُحتفظ به ولِمَ: الاشتراكات والسجلات المالية وصفوف
--       accounting_invoices وسجلات التدقيق (سجل التصدير هذا، وطلبات
--       الحذف، وسجل العضويات) — للاحتفاظ القانوني والمحاسبي، بلا
--       بيانات شخصية قابلة للربط بعد التجهيل.
create or replace function public.company_request_account_deletion(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id         uuid;
  v_created    timestamptz;
begin
  if auth.uid() is null then
    raise exception 'سجّل الدخول أولًا' using errcode = '42501';
  end if;
  if not coalesce(public.is_company_admin(), false) then
    raise exception 'طلب حذف حساب الشركة لمدير الشركة وحده' using errcode = '42501';
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    raise exception 'لا توجد شركة في سياقك الحالي' using errcode = 'P0002';
  end if;
  if v_reason is null or char_length(v_reason) < 20 then
    raise exception 'سبب الحذف مطلوب (20 حرفًا على الأقل) — يراجعه مالك المنصة قبل أي إجراء' using errcode = '22023';
  end if;
  if exists (select 1 from public.company_deletion_requests
              where company_id = v_company_id and status = 'pending') then
    raise exception 'يوجد طلب حذف قيد الانتظار لهذه الشركة — ألغِه أولًا إن غيّرت رأيك' using errcode = '23505';
  end if;

  insert into public.company_deletion_requests (company_id, requested_by, reason)
  values (v_company_id, auth.uid(), v_reason)
  returning id, created_at into v_id, v_created;

  return jsonb_build_object(
    'id', v_id,
    'company_id', v_company_id,
    'status', 'pending',
    'reason', v_reason,
    'created_at', v_created,
    'note', 'الطلب قيد الانتظار: لا يُحذف شيء فورًا، وتبقى الشركة نشطة حتى يراجع مالك المنصة الطلب وينفّذ التعطيل وحذف/تجهيل البيانات الشخصية وفق السياسة الموثقة.');
end $$;

comment on function public.company_request_account_deletion(text) is
  '140: طلب حذف حساب الشركة ذاتيًا — مدير الشركة وحده، سبب إلزامي (20 حرفًا على الأقل)، طلب واحد قيد الانتظار لكل شركة. الطلب لا يحذف شيئًا ولا يوقف الشركة؛ التنفيذ يدوي من مالك المنصة. ما يُحذف/يُجهَّل عند التنفيذ: الحقول الشخصية في صف الشركة وبيانات الأعضاء الشخصية ومحتوى تذاكر الشركة. ما يُحتفظ به ولِمَ: الاشتراكات والسجلات المالية وصفوف accounting_invoices وسجلات التدقيق — للاحتفاظ القانوني والمحاسبي.';


-- ============================================================================
-- 5) company_deletion_request_status() + company_cancel_deletion_request()
-- ============================================================================
create or replace function public.company_deletion_request_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_company_admin(), false) then
    return null;
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    return null;
  end if;
  return (select jsonb_build_object(
             'id', r.id,
             'company_id', r.company_id,
             'status', r.status,
             'reason', r.reason,
             'created_at', r.created_at)
            from public.company_deletion_requests r
           where r.company_id = v_company_id and r.status = 'pending'
           order by r.created_at desc limit 1);
end $$;

comment on function public.company_deletion_request_status() is
  '140: طلب الحذف المعلّق للشركة، أو null — لمدير الشركة وحده.';

create or replace function public.company_cancel_deletion_request()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_id         uuid;
  v_created    timestamptz;
begin
  if auth.uid() is null then
    raise exception 'سجّل الدخول أولًا' using errcode = '42501';
  end if;
  if not coalesce(public.is_company_admin(), false) then
    raise exception 'إلغاء طلب الحذف لمدير الشركة وحده' using errcode = '42501';
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    raise exception 'لا توجد شركة في سياقك الحالي' using errcode = 'P0002';
  end if;
  update public.company_deletion_requests
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid(),
         decision_note = 'ألغاه مدير الشركة'
   where company_id = v_company_id and status = 'pending'
  returning id, created_at into v_id, v_created;
  if v_id is null then
    raise exception 'لا يوجد طلب حذف قيد الانتظار لهذه الشركة' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', v_id,
    'company_id', v_company_id,
    'status', 'cancelled',
    'created_at', v_created,
    'cancelled_at', now());
end $$;

comment on function public.company_cancel_deletion_request() is
  '140: إلغاء طلب الحذف المعلّق — مدير الشركة وحده. بلا طلب معلّق P0002.';


-- ============================================================================
-- 6) الصلاحيات — الدوال الخمس لـ authenticated وحده
-- ============================================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.company_export_data()',
    'public.company_data_exports_list()',
    'public.company_request_account_deletion(text)',
    'public.company_deletion_request_status()',
    'public.company_cancel_deletion_request()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي — على نمط 130/133/135
-- ============================================================================
do $$
declare
  v_def text;
begin
  if to_regprocedure('public.company_export_data()') is null
     or to_regprocedure('public.company_data_exports_list()') is null
     or to_regprocedure('public.company_request_account_deletion(text)') is null
     or to_regprocedure('public.company_deletion_request_status()') is null
     or to_regprocedure('public.company_cancel_deletion_request()') is null then
    raise exception '140: إحدى دوال التصدير/الحذف غائبة';
  end if;
  if to_regclass('public.company_data_exports') is null
     or to_regclass('public.company_deletion_requests') is null then
    raise exception '140: جدولا التدقيق والطلبات غائبان';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'company_deletion_requests_one_pending') then
    raise exception '140: فهرس الطلب المعلّق الواحد غائب — التكرار ممكن';
  end if;
  v_def := pg_get_functiondef('public.company_export_data()'::regprocedure);
  if v_def not like '%is_company_admin%' then
    raise exception '140: بوابة مدير الشركة غائبة من company_export_data()';
  end if;
  if v_def not like '%accounting_invoices%' or v_def not like '%available%' then
    raise exception '140: قسم الفواتير الصريح (available=false) غائب من التصدير';
  end if;
  if v_def not like '%company_data_exports%' then
    raise exception '140: صف التدقيق غائب من company_export_data()';
  end if;
  v_def := pg_get_functiondef('public.company_request_account_deletion(text)'::regprocedure);
  if v_def not like '%is_company_admin%' then
    raise exception '140: بوابة مدير الشركة غائبة من company_request_account_deletion()';
  end if;
  if v_def not like '%char_length(v_reason) < 20%' then
    raise exception '140: حدّ السبب (20 حرفًا) غائب من company_request_account_deletion()';
  end if;
  if v_def not like '%23505%' then
    raise exception '140: مانع التكرار (23505) غائب من company_request_account_deletion()';
  end if;
  if coalesce(obj_description('public.company_request_account_deletion(text)'::regprocedure), '')
     not like '%accounting_invoices%' then
    raise exception '140: سياسة الاحتفاظ (accounting_invoices) غائبة من تعليق طلب الحذف';
  end if;
  if not has_function_privilege('authenticated', 'public.company_export_data()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.company_request_account_deletion(text)', 'EXECUTE') then
    raise exception '140: دوال 140 غير ممنوحة لـ authenticated';
  end if;
  if has_function_privilege('anon', 'public.company_export_data()', 'EXECUTE')
     or has_function_privilege('anon', 'public.company_request_account_deletion(text)', 'EXECUTE') then
    raise exception '140: دوال 140 مكشوفة لـ anon';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.company_data_exports'::regclass) is distinct from true
     or (select relrowsecurity from pg_class where oid = 'public.company_deletion_requests'::regclass) is distinct from true then
    raise exception '140: RLS غير مفعّل على جدولي 140';
  end if;
  raise notice '140: تصدير بيانات الشركة وطلب حذف حسابها جاهزان — الفواتير مذكورة صراحةً كغير متاحة';
end $$;
