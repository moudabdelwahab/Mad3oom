-- ============================================================================
-- تسجيل 068 في supabase_migrations.schema_migrations — سجل فقط
--
-- 068 متطبّق على Production بالفعل من SQL Editor (2026-10-09 06:22:30 UTC، مثبت
-- في postgres_logs: «statement: -- 068_company_account_requests.sql …»، source:
-- dashboard). التشغيل من SQL Editor مابيكتبش في السجل، والأداة مقدرتش تطبّقه:
-- أي جملة فيها DROP بتستنى تأكيد ما بيظهرش في الجلسة فبتنتهي مهلتها.
-- الملف ده بيضيف صف واحد بنفس شكل register_064_067.sql:
--   version         = وقت التطبيق الفعلي UTC (YYYYMMDDHHMMSS)
--   name            = اسم الملف من غير .sql
--   statements      = مصفوفة فيها عنصر واحد = نص الملف حرفيًا
--   created_by      = info@mad3oom.online
--   idempotency_key = NULL, rollback = NULL
--
-- مابيشغّلش أي migration، ومابيلمسش أي جدول غير schema_migrations.
-- الصف بيتضاف بس لو md5 النص = md5 الملف في الـ repo (c9fabd071894c35ccf923f0c8f622676)، ولو مش موجود قبل كده.
-- في الآخر تحقق: لو مش صف واحد بالظبط ⇒ استثناء ⇒ كله بيترجع.
-- النتيجة المتوقعة: NOTICE «ledger: 068 متسجل مرة واحدة».
-- ============================================================================

insert into supabase_migrations.schema_migrations (version, statements, name, created_by, idempotency_key, rollback)
select '20261009062230', array[s.c], '068_company_account_requests', 'info@mad3oom.online', null, null
from (select $ledger$-- ============================================================================
-- 068_company_account_requests.sql
--   «فرد أم شركة؟» عند الاشتراك — وحساب الشركة لا يتكوّن إلا بموافقة الإدارة
--
-- المطلوب (من صاحب المنصة):
--   العميل يضغط «اشترك الآن» فيُسأل: فرد أم شركة؟
--     • فرد  → بيانات الدفع ← طلب الاشتراك المعتاد (لا تغيير هنا).
--     • شركة → يملأ بيانات الشركة ويرسلها ← «طلب حساب شركة» ينتظر المراجعة،
--              وعند موافقة الإدارة يتحوّل حسابه إلى حساب شركة.
--
-- ما كان قائمًا (مقروء من نسخة الإنتاج tests/fixtures/prod-shape، 2026-10-07)
--   • upsert_my_company() تُنشئ صف companies **فورًا** من جلسة العميل، ومحفّز
--     sync_company_owner_role يرقّيه إلى company_admin في نفس اللحظة. أي أن
--     «الشركة» كانت تُمنح ذاتيًا بلا مراجعة.
--   • سياسة "Users can insert their own company" تسمح بنفس الشيء مباشرةً عبر
--     PostgREST، فحتى لو تغيّرت الواجهة يظل الإنشاء الذاتي ممكنًا.
--   • والمسار نفسه **معطوب في الإنتاج**: الترقية تمر بـ guard_profile_role_change
--     من جلسة صاحب الحساب، فيرفضها بـ«لا يمكنك تغيير صلاحية حسابك بنفسك» وتُلغى
--     المعاملة كلها. أي عميل عادي يحفظ نموذج «بيانات الشركة» يحصل على خطأ.
--     (مُثبَت في tests/sql/company-account-requests.test.sql، القسم ⓪.)
--
-- ما يضيفه هذا الترحيل
--   1) جدول company_account_requests: البيانات القانونية للشركة + الباقة التي
--      كان العميل يشتريها + حالة الطلب (pending/approved/rejected). طلب واحد
--      قيد المراجعة لكل حساب، بفهرس فريد جزئي لا بفحص في الواجهة.
--   2) submit_company_account_request(): العميل يرسل طلبه. بلا مُعامل يحدد
--      صاحب الطلب — الحساب من auth.uid().
--   3) my_company_account_request(): آخر طلب للمنادي (لعرض «قيد المراجعة» أو
--      سبب الرفض في نافذة الاشتراك).
--   4) admin_list_company_account_requests() و admin_review_company_account_request():
--      للإدارة فقط (is_admin()، نفس حارس 018). الموافقة تُنشئ صف companies باسم
--      صاحب الطلب، فيشتق المحفّز القائم الدور company_admin — لا شيء يكتب
--      الدور يدويًا.
--   5) guard_profile_role_change: يسمح بدور الشركة **فقط** حين يكتبه محفّز
--      (pg_trigger_depth() > 1) **و** يطابق العلاقة الفعلية. بدون هذا الاستثناء
--      كانت الموافقة نفسها تُرفض بـ«أدوار الشركة تُشتق من العلاقة…» لأن الأدمن
--      هو المنادي. المنح اليدوي (عمق 1) ما زال مرفوضًا لكل الناس.
--   6) إغلاق الإنشاء الذاتي: إسقاط سياسة الإدراج المباشر، و upsert_my_company
--      تحدّث شركة قائمة فقط (لوحة الشركة) وترفض الإنشاء بإشارة لمسار الطلب.
--
-- ما لم يتغيّر (متعمّد)
--   • مسار الاشتراك نفسه (تذكرة + صف pending في whatsapp_subscriptions) كما هو.
--   • subscription_plans.requires_company لم تُمس (الواجهة لم تعد تقرؤها في
--     مسار الشراء: السؤال يُطرح لكل باقة).
--   • تعديل مالك شركة قائمة لبياناتها من لوحة الشركة — نفس السلوك حرفيًا.
--
-- التراجع: migrations/_rollback/068_company_account_requests.down.sql
-- ============================================================================


-- ============================================================================
-- 0) تحقّق قبلي
-- ============================================================================
do $$
declare v_companies int; v_insert_policy int;
begin
  select count(*) into v_companies from public.companies;
  select count(*) into v_insert_policy from pg_policy
   where polrelid = 'public.companies'::regclass
     and polname  = 'Users can insert their own company';
  raise notice '068 preflight: شركات قائمة=% · سياسة الإدراج الذاتي موجودة=%',
    v_companies, (v_insert_policy > 0);
end $$;


-- ============================================================================
-- 1) جدول طلبات حساب الشركة
-- ============================================================================
create table if not exists public.company_account_requests (
  id                             uuid primary key default gen_random_uuid(),
  user_id                        uuid not null references auth.users(id) on delete cascade,
  company_name                   text not null,
  commercial_registration_number text not null,
  commercial_registration_expiry date not null,
  company_email                  text,
  company_phone                  text,
  -- الباقة التي ضغط العميل «اشترك الآن» عليها؛ لإخطاره بعد الموافقة ليكمل الدفع
  requested_plan                 text,
  requested_billing_cycle        text,
  status                         text not null default 'pending',
  review_note                    text,
  reviewed_by                    uuid references public.profiles(id) on delete set null,
  reviewed_at                    timestamptz,
  company_id                     uuid references public.companies(id) on delete set null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint company_account_requests_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint company_account_requests_cycle_check
    check (requested_billing_cycle is null or requested_billing_cycle in ('monthly', 'yearly')),
  constraint company_account_requests_name_check
    check (char_length(btrim(company_name)) >= 2),
  constraint company_account_requests_cr_check
    check (char_length(btrim(commercial_registration_number)) >= 3)
);

comment on table public.company_account_requests is
  'طلبات تحويل حساب عميل إلى حساب شركة. تُكتب عبر submit_company_account_request وتُراجَع عبر admin_review_company_account_request فقط.';

-- طلب واحد قيد المراجعة لكل حساب: القاعدة تفرضه، حتى مع ضغطتين متزامنتين
create unique index if not exists company_account_requests_one_pending
  on public.company_account_requests (user_id) where status = 'pending';

create index if not exists company_account_requests_status_created
  on public.company_account_requests (status, created_at desc);

alter table public.company_account_requests enable row level security;

-- القراءة: صاحب الطلب يرى طلباته. الإدارة تقرأ عبر الدالة لا عبر الجدول.
-- لا سياسات كتابة إطلاقًا: كل كتابة تمر بدوال SECURITY DEFINER أدناه، فلا
-- يقدر عميل يعدّل حالة طلبه إلى approved ولا يكتب review_note بنفسه.
drop policy if exists company_account_requests_select_own on public.company_account_requests;
create policy company_account_requests_select_own
  on public.company_account_requests
  for select to authenticated
  using (user_id = auth.uid());

revoke all on table public.company_account_requests from public, anon, authenticated;
grant select on table public.company_account_requests to authenticated;
grant all on table public.company_account_requests to service_role;

-- نفس حارس المعاينة المركّب على كل جدول بـRLS في 041
drop trigger if exists trg_preview_read_only on public.company_account_requests;
create trigger trg_preview_read_only
  before insert or update or delete on public.company_account_requests
  for each statement execute function public.guard_preview_read_only();


-- ============================================================================
-- 2) العميل يرسل طلبه
-- ============================================================================
create or replace function public.submit_company_account_request(
  p_company_name                   text,
  p_commercial_registration_number text,
  p_commercial_registration_expiry date,
  p_company_email                  text default null,
  p_company_phone                  text default null,
  p_requested_plan                 text default null,
  p_requested_billing_cycle        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid      uuid := auth.uid();
  v_name     text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_cr       text := nullif(btrim(coalesce(p_commercial_registration_number, '')), '');
  v_email    text := nullif(btrim(coalesce(p_company_email, '')), '');
  v_phone    text := nullif(btrim(coalesce(p_company_phone, '')), '');
  v_plan     text := nullif(btrim(coalesce(p_requested_plan, '')), '');
  v_cycle    text := nullif(btrim(coalesce(p_requested_billing_cycle, '')), '');
  v_customer text;
  v_row      public.company_account_requests%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  -- نفس بوابة الحساب (042/066): حساب غير مفعّل لا يفتح طلبات
  if not public.account_is_active() then
    raise exception 'حسابك غير مفعّل بعد، فلا يمكن إرسال طلب حساب شركة' using errcode = '42501';
  end if;

  if public.owns_a_company(v_uid) then
    raise exception 'حسابك حساب شركة بالفعل';
  end if;
  if public.belongs_to_a_company(v_uid) then
    raise exception 'حسابك عضو في شركة قائمة بالفعل';
  end if;

  -- نفس قواعد upsert_my_company حرفيًا
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'اسم الشركة مطلوب';
  end if;
  if v_cr is null or char_length(v_cr) < 3 then
    raise exception 'رقم السجل التجاري مطلوب';
  end if;
  if p_commercial_registration_expiry is null then
    raise exception 'تاريخ انتهاء السجل التجاري مطلوب';
  end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'بريد إلكتروني غير صالح';
  end if;

  if v_plan is not null
     and not exists (select 1 from public.subscription_plans where key = v_plan and is_active) then
    raise exception 'باقة غير معروفة: %', v_plan;
  end if;
  if v_cycle is not null and v_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير معروفة: %', v_cycle;
  end if;

  if exists (select 1 from public.company_account_requests
              where user_id = v_uid and status = 'pending') then
    raise exception 'لديك طلب حساب شركة قيد المراجعة بالفعل';
  end if;

  -- رقم السجل فريد على المنصة: مسجّل لشركة، أو محجوز بطلب آخر قيد المراجعة
  if exists (select 1 from public.companies where commercial_registration_number = v_cr) then
    raise exception 'رقم السجل التجاري مسجل بالفعل';
  end if;
  if exists (select 1 from public.company_account_requests
              where commercial_registration_number = v_cr
                and status = 'pending' and user_id <> v_uid) then
    raise exception 'رقم السجل التجاري مرتبط بطلب آخر قيد المراجعة';
  end if;

  begin
    insert into public.company_account_requests (
      user_id, company_name, commercial_registration_number,
      commercial_registration_expiry, company_email, company_phone,
      requested_plan, requested_billing_cycle
    ) values (
      v_uid, v_name, v_cr, p_commercial_registration_expiry, v_email, v_phone, v_plan, v_cycle
    )
    returning * into v_row;
  exception when unique_violation then
    -- ضغطتان متزامنتان: الفهرس الجزئي يسمح بواحدة فقط
    raise exception 'لديك طلب حساب شركة قيد المراجعة بالفعل';
  end;

  -- إخطار الإدارة بنفس أسلوب notify_admins_of_service_report
  select coalesce(nullif(btrim(full_name), ''), email, 'عميل')
    into v_customer from public.profiles where id = v_uid;

  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  select p.id,
         'طلب حساب شركة جديد',
         format('العميل "%s" طلب تحويل حسابه إلى حساب شركة باسم "%s".', v_customer, v_name),
         'info',
         '/admin/company-requests.html',
         'system',
         v_row.id
    from public.profiles p
   where p.role = 'admin';

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'created_at', v_row.created_at);
end;
$function$;

comment on function public.submit_company_account_request(text, text, date, text, text, text, text) is
  'العميل يطلب تحويل حسابه إلى حساب شركة. لا تُنشئ شركة — تنتظر موافقة الإدارة. صاحب الطلب من auth.uid().';

revoke all on function public.submit_company_account_request(text, text, date, text, text, text, text) from public, anon;
grant execute on function public.submit_company_account_request(text, text, date, text, text, text, text) to authenticated;


-- ============================================================================
-- 3) آخر طلب للمنادي
-- ============================================================================
create or replace function public.my_company_account_request()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
           'id',             r.id,
           'status',         r.status,
           'company_name',   r.company_name,
           'requested_plan', r.requested_plan,
           'review_note',    r.review_note,
           'created_at',     r.created_at,
           'reviewed_at',    r.reviewed_at
         )
    from public.company_account_requests r
   where auth.uid() is not null
     and r.user_id = auth.uid()
   order by (r.status = 'pending') desc, r.created_at desc
   limit 1;
$function$;

revoke all on function public.my_company_account_request() from public, anon;
grant execute on function public.my_company_account_request() to authenticated;


-- ============================================================================
-- 4) الإدارة: القائمة والمراجعة
-- ============================================================================
create or replace function public.admin_list_company_account_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(q.item order by q.r_created desc), '[]'::jsonb)
    into v_rows
    from (
      select r.created_at as r_created,
             jsonb_build_object(
               'id',                             r.id,
               'user_id',                        r.user_id,
               'customer_name',                  coalesce(nullif(btrim(p.full_name), ''), p.email),
               'customer_email',                 p.email,
               'customer_phone',                 p.phone,
               'company_name',                   r.company_name,
               'commercial_registration_number', r.commercial_registration_number,
               'commercial_registration_expiry', r.commercial_registration_expiry,
               'company_email',                  r.company_email,
               'company_phone',                  r.company_phone,
               'requested_plan',                 r.requested_plan,
               'requested_plan_name_ar',         coalesce(sp.name_ar, sp.name, r.requested_plan),
               'requested_billing_cycle',        r.requested_billing_cycle,
               'status',                         r.status,
               'review_note',                    r.review_note,
               'reviewed_at',                    r.reviewed_at,
               'reviewer_name',                  coalesce(nullif(btrim(rv.full_name), ''), rv.email),
               'company_id',                     r.company_id,
               'created_at',                     r.created_at
             ) as item
        from public.company_account_requests r
        left join public.profiles p  on p.id  = r.user_id
        left join public.profiles rv on rv.id = r.reviewed_by
        left join public.subscription_plans sp on sp.key = r.requested_plan
    ) q;

  return v_rows;
end;
$function$;

revoke all on function public.admin_list_company_account_requests() from public, anon;
grant execute on function public.admin_list_company_account_requests() to authenticated;


create or replace function public.admin_review_company_account_request(
  p_request_id uuid,
  p_decision   text,
  p_note       text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_req        public.company_account_requests%rowtype;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_company_id uuid;
  v_plan_name  text;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  if p_decision not in ('approve', 'reject') then
    raise exception 'قرار غير معروف: %', p_decision;
  end if;

  -- القفل يمنع موافقتين متزامنتين على نفس الطلب
  select * into v_req
    from public.company_account_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'الطلب غير موجود';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'تمت مراجعة هذا الطلب بالفعل';
  end if;

  if p_decision = 'reject' then
    if v_note is null then
      raise exception 'سبب الرفض مطلوب ليظهر للعميل';
    end if;

    update public.company_account_requests
       set status = 'rejected', review_note = v_note,
           reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
     where id = v_req.id;

    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    values (v_req.user_id,
            'تعذّر قبول طلب حساب الشركة',
            format('لم تتم الموافقة على طلب حساب الشركة "%s". السبب: %s. يمكنك تعديل البيانات وإرسال طلب جديد.',
                   v_req.company_name, v_note),
            'warning', '/subscriptions.html', 'system', v_req.id);

    return jsonb_build_object('id', v_req.id, 'status', 'rejected');
  end if;

  -- الموافقة: نفس شروط الإنشاء، لكن تُفحص الآن لا وقت الإرسال — الحال قد تغيّر
  if public.owns_a_company(v_req.user_id) then
    raise exception 'الحساب يملك شركة بالفعل';
  end if;
  if public.belongs_to_a_company(v_req.user_id) then
    raise exception 'الحساب أصبح عضوًا في شركة قائمة';
  end if;
  if exists (select 1 from public.companies
              where commercial_registration_number = v_req.commercial_registration_number) then
    raise exception 'رقم السجل التجاري مسجل لشركة أخرى';
  end if;

  -- إنشاء الشركة هو ما يحوّل الحساب: sync_company_owner_role يشتق company_admin
  -- من الصف الجديد، ولا شيء هنا يكتب الدور بنفسه.
  insert into public.companies (
    user_id, company_name, commercial_registration_number,
    commercial_registration_expiry, company_email, company_phone
  ) values (
    v_req.user_id, v_req.company_name, v_req.commercial_registration_number,
    v_req.commercial_registration_expiry, v_req.company_email, v_req.company_phone
  )
  returning id into v_company_id;

  -- user_type وصف عرض (customer-data.js، MCP) لا مصدر صلاحية — يتبع الحالة
  update public.profiles
     set user_type = 'company'
   where id = v_req.user_id
     and user_type is distinct from 'company';

  update public.company_account_requests
     set status = 'approved', review_note = v_note, company_id = v_company_id,
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = v_req.id;

  select coalesce(sp.name_ar, sp.name) into v_plan_name
    from public.subscription_plans sp where sp.key = v_req.requested_plan;

  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  values (v_req.user_id,
          'تمت الموافقة على حساب الشركة',
          case
            when v_plan_name is not null then
              format('أصبح حسابك حساب شركة باسم "%s". أكمل الآن الاشتراك في %s كشركة.',
                     v_req.company_name, v_plan_name)
            else
              format('أصبح حسابك حساب شركة باسم "%s"، ولوحة الشركة متاحة لك الآن.', v_req.company_name)
          end,
          'success',
          case when v_plan_name is not null then '/subscriptions.html' else '/company-dashboard/' end,
          'system', v_req.id);

  return jsonb_build_object('id', v_req.id, 'status', 'approved', 'company_id', v_company_id);
end;
$function$;

comment on function public.admin_review_company_account_request(uuid, text, text) is
  'موافقة/رفض طلب حساب شركة (للإدارة فقط). الموافقة تُنشئ صف companies باسم صاحب الطلب، فيُشتق الدور company_admin بالمحفّز القائم.';

revoke all on function public.admin_review_company_account_request(uuid, text, text) from public, anon;
grant execute on function public.admin_review_company_account_request(uuid, text, text) to authenticated;


-- ============================================================================
-- 5) حارس الرتب: دور الشركة يمر فقط حين يشتقّه محفّز من علاقة قائمة
-- ============================================================================
--
-- نص الإنتاج حرفيًا، والتغيير الوحيد هو كتلة أدوار الشركة. قبله كان الحارس
-- يرفض company_admin حتى حين يكتبه sync_company_owner_role بعد إنشاء شركة
-- فعلية من جلسة أدمن — فلا مسار موافقة ممكن أصلًا.
--
-- الشرطان معًا:
--   • pg_trigger_depth() > 1 — الكتابة جاءت من محفّز (إدراج في companies)، لا
--     من UPDATE مباشر على profiles. فالمنح اليدوي مرفوض كما كان، حتى للأدمن.
--   • الدور = ما تقتضيه العلاقة الآن — company_admin لمن يملك شركة فعلًا،
--     company_user لمن يتبع مالك شركة. دور بلا علاقة مرفوض في كل الأحوال.
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;
  if new.role = 'platform_owner' then
    raise exception 'رتبة مالك المنصة لا تُمنح من أي جلسة' using errcode = '42501';
  end if;
  if new.role in ('company_admin', 'company_user') then
    if pg_trigger_depth() > 1
       and new.role = (case
                         when public.owns_a_company(new.id)       then 'company_admin'
                         when public.belongs_to_a_company(new.id) then 'company_user'
                       end) then
      return new;
    end if;
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;
  if new.role = 'admin' or old.role = 'admin'
     or exists (select 1 from public.platform_authority a where a.user_id = new.id) then
    if public.owner_critical_ok() then return new; end if;
    raise exception 'منح رتبة الإدارة أو سحبها لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if new.role = 'support' or old.role = 'support' then
    if public.owner_critical_ok() or public.has_capability('staff.support') then
      return new;
    end if;
    raise exception 'إدارة فريق الدعم تتطلب تفويضًا من مالك المنصة' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;


-- ============================================================================
-- 6) إغلاق الإنشاء الذاتي للشركة
-- ============================================================================

-- الإدراج المباشر عبر PostgREST كان يتخطى أي مراجعة. سياسات القراءة والتحديث
-- (للمالك ولأعضاء شركته) باقية كما هي.
drop policy if exists "Users can insert their own company" on public.companies;

-- upsert_my_company: مسار التحديث كما هو حرفيًا (لوحة الشركة)، والإنشاء صار
-- رسالة واضحة بدل صف شركة غير مُراجَع.
create or replace function public.upsert_my_company(
  p_company_name                   text,
  p_commercial_registration_number text,
  p_commercial_registration_expiry date,
  p_company_email                  text default null,
  p_company_phone                  text default null,
  p_address                        text default null,
  p_city                           text default null,
  p_country                        text default null,
  p_tax_id                         text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid        uuid := auth.uid();
  v_name       text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_cr         text := nullif(btrim(coalesce(p_commercial_registration_number, '')), '');
  v_existing   uuid;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'اسم الشركة مطلوب';
  end if;

  if v_cr is null or char_length(v_cr) < 3 then
    raise exception 'رقم السجل التجاري مطلوب';
  end if;

  if p_commercial_registration_expiry is null then
    raise exception 'تاريخ انتهاء السجل التجاري مطلوب';
  end if;

  select id into v_existing from public.companies where user_id = v_uid;

  if v_existing is null then
    if public.current_company_id() is not null then
      raise exception 'حسابك عضو في شركة قائمة بالفعل';
    end if;
    -- 068: حساب الشركة لا يُنشأ ذاتيًا
    raise exception 'إنشاء حساب شركة يتم بطلب يراجعه فريق الإدارة'
      using hint = 'submit_company_account_request';
  end if;

  if exists (
    select 1 from public.companies
     where commercial_registration_number = v_cr and id <> v_existing
  ) then
    raise exception 'رقم السجل التجاري مسجل بالفعل';
  end if;

  update public.companies
     set company_name                   = v_name,
         commercial_registration_number = v_cr,
         commercial_registration_expiry = p_commercial_registration_expiry,
         company_email = coalesce(nullif(btrim(coalesce(p_company_email, '')), ''), company_email),
         company_phone = coalesce(nullif(btrim(coalesce(p_company_phone, '')), ''), company_phone),
         address       = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
         city          = coalesce(nullif(btrim(coalesce(p_city, '')), ''), city),
         country       = coalesce(nullif(btrim(coalesce(p_country, '')), ''), country),
         tax_id        = coalesce(nullif(btrim(coalesce(p_tax_id, '')), ''), tax_id)
   where id = v_existing;

  return v_existing;
end;
$function$;

comment on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) is
  'تحديث بيانات شركة المستخدم الحالي (المالك فقط). الإنشاء يتم عبر submit_company_account_request وموافقة الإدارة (068).';

revoke all on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) to authenticated;


-- ============================================================================
-- 7) تحقّق بَعدي
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_policy
              where polrelid = 'public.companies'::regclass
                and polcmd in ('a', '*')) then
    raise exception '068: ما زالت هناك سياسة إدراج على companies';
  end if;
  if exists (select 1 from pg_policy
              where polrelid = 'public.company_account_requests'::regclass
                and polcmd <> 'r') then
    raise exception '068: سياسة كتابة على company_account_requests — الكتابة عبر الدوال فقط';
  end if;
  raise notice '068: طلبات حساب الشركة جاهزة، والإنشاء الذاتي مغلق';
end $$;
$ledger$::text as c) s
where md5(s.c) = 'c9fabd071894c35ccf923f0c8f622676'
  and not exists (select 1 from supabase_migrations.schema_migrations m
                   where m.version = '20261009062230' or m.name = '068_company_account_requests');

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations
       where name = '068_company_account_requests' and version = '20261009062230'
         and md5(statements[1]) = 'c9fabd071894c35ccf923f0c8f622676') <> 1
     or (select count(*) from supabase_migrations.schema_migrations where name = '068_company_account_requests') <> 1 then
    raise exception 'ledger: 068 مش متسجل مرة واحدة بالنص الصح — مفيش حاجة اتكتبت';
  end if;
  raise notice 'ledger: 068 متسجل مرة واحدة';
end $$;
