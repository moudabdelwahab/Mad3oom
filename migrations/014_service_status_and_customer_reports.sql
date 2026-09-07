-- ============================================================================
-- 014_service_status_and_customer_reports.sql
--   حالة النظام تبقى بيانات حيّة + بلاغ العميل عن خدمة متعطّلة
--
-- ما وجدناه في التدقيق
--   1) جدول services فيه بيانات حقيقية، لكنها **بذرة migration 001 ولم تتغير
--      منذ إنشائها**، وجدول incidents فارغ تماماً (0 صفوف).
--      السبب مش إن حد نسي يحدّث: الجداول عليها سياسات SELECT فقط
--      (USING true) و**صفر سياسات INSERT/UPDATE**. يعني حتى لو الأدمن ضغط
--      أي زر، الكتابة مرفوضة بصمت من RLS. وserviceStatusManager فيه
--      createIncident و updateServiceStatus جاهزين ومحدش بينادي عليهم
--      لأن صفحة الحالة في لوحة الإدارة للعرض فقط.
--      فالمسار كله: قراءة حقيقية من مصدر لا يمكن تحديثه = حالة نظام ميتة.
--
--   2) مفيش وقت لبداية المشكلة. الواجهة محتاجة تقول "المشكلة بدأت الساعة
--      كذا" لخدمة متدهورة بدون حادثة معلنة، ومفيش عمود يحمل المعلومة دي.
--
--   3) مفيش أي رابط بين صف الخدمة وبين ما يستخدمه العميل فعلاً. الربط
--      بالاسم العربي المعروض هشّ ويتكسر مع أول تعديل تحريري.
--
-- ما يفعله هذا الملف
--   • service_key: مفتاح ثابت يربط الخدمة بما يملكه العميل (بدل الاسم).
--   • status_changed_at: لحظة بداية الحالة الحالية — تُدار بـtrigger.
--   • حالتان جديدتان: partial_outage و maintenance.
--   • سياسات كتابة للأدمن/الدعم على services و incidents و history.
--   • customer_service_reports: بلاغ العميل عن خدمة متعطّلة — **ليس تذكرة**.
--   • إشعار للإدارة عبر نظام الإشعارات الموجود، مرة واحدة لكل حادثة.
--
-- الأمان
--   العميل: يقرأ بلاغاته هو فقط، وينشئ بلاغاً باسمه هو فقط.
--   الأدمن/الدعم: يقرأ كل البلاغات ويغيّر حالتها.
--   لا توسيع لأي صلاحية قائمة على جداول أخرى.
-- ============================================================================

-- ── 1) الخدمات: مفتاح ثابت، وقت بداية الحالة، وحالات أوسع ──────────────────
alter table public.services
  add column if not exists service_key       text,
  add column if not exists status_changed_at timestamptz;

comment on column public.services.service_key is
  'مفتاح ثابت للخدمة (whatsapp/sie/core/…) تربط به الواجهة الخدمة بما يملكه العميل. الاسم المعروض تحريري ولا يصلح للربط.';
comment on column public.services.status_changed_at is
  'لحظة دخول الخدمة حالتها الحالية — مصدر "المشكلة بدأت الساعة كذا" للخدمة بدون حادثة معلنة.';

create unique index if not exists idx_services_service_key
  on public.services (service_key) where service_key is not null;

-- توسيع الحالات المسموحة: partial_outage (عطل جزئي) و maintenance (صيانة)
alter table public.services drop constraint if exists services_status_check;
alter table public.services add constraint services_status_check
  check (status in ('operational', 'degraded', 'partial_outage', 'down', 'maintenance'));

alter table public.service_status_history drop constraint if exists service_status_history_status_check;
alter table public.service_status_history add constraint service_status_history_status_check
  check (status in ('operational', 'degraded', 'partial_outage', 'down', 'maintenance'));

-- الحالة الحالية بدأت وقت آخر تغيير فعلي للحالة، مش وقت آخر فحص.
create or replace function public.track_service_status_change()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  elsif new.status is distinct from old.status then
    new.status_changed_at := now();
    new.updated_at := now();
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_track_service_status_change on public.services;
create trigger trg_track_service_status_change
  before insert or update on public.services
  for each row execute function public.track_service_status_change();

-- الصفوف الموجودة: أقرب تقدير صادق متاح هو آخر تحديث مسجَّل عليها
update public.services
   set status_changed_at = coalesce(updated_at, created_at, now())
 where status_changed_at is null;

-- ── 2) سياسات الكتابة الناقصة (سبب جمود حالة النظام) ───────────────────────
drop policy if exists "Staff can write services" on public.services;
create policy "Staff can write services"
  on public.services for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

drop policy if exists "Staff can write incidents" on public.incidents;
create policy "Staff can write incidents"
  on public.incidents for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

drop policy if exists "Staff can write service history" on public.service_status_history;
create policy "Staff can write service history"
  on public.service_status_history for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

-- ── 3) بلاغ العميل عن خدمة متعطّلة ─────────────────────────────────────────
-- ليس تذكرة عن قصد: التذكرة محادثة تحتاج ردًا ومتابعة، والبلاغ هنا إشارة
-- "أنا كمان واقع عليّ العطل ده" — قيمتها في العدد لا في النص.
-- وليس user_reports كذلك: هذا الجدول لبلاغات المكافآت (estimated_points/
-- actual_points/approved_at) ودمج المعنيين فيه يفسد دلالته.
create table if not exists public.customer_service_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  service_id  uuid        not null references public.services(id) on delete cascade,
  incident_id uuid                 references public.incidents(id) on delete set null,

  -- مفتاح "النوبة": يحدد أي عطل بالضبط يخص البلاغ، وهو أساس منع التكرار.
  -- مع حادثة معلنة  → معرّف الحادثة.
  -- بدون حادثة       → الخدمة + لحظة دخولها حالتها الحالية.
  -- فلو الخدمة رجعت واتعطلت تاني، المفتاح بيتغيّر والعميل يقدر يبلّغ من جديد.
  episode_key text        not null,

  status      text        not null default 'open'
                          check (status in ('open', 'acknowledged', 'resolved')),
  source      text        not null default 'customer_portal',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (user_id, episode_key)
);

comment on table public.customer_service_reports is
  'بلاغ عميل بأنه متأثر بعطل في خدمة. ليس تذكرة دعم؛ قيمته في قياس اتساع أثر العطل.';
comment on column public.customer_service_reports.episode_key is
  'يميّز نوبة العطل الواحدة: معرّف الحادثة إن وُجدت، وإلا الخدمة + لحظة تغيّر حالتها. أساس منع البلاغ المكرر.';

create index if not exists idx_csr_service   on public.customer_service_reports (service_id, created_at desc);
create index if not exists idx_csr_incident  on public.customer_service_reports (incident_id) where incident_id is not null;
create index if not exists idx_csr_episode   on public.customer_service_reports (episode_key, created_at);

-- المفتاح يُحسب على السيرفر دائماً: لو العميل بعته بنفسه كان يقدر يتحايل
-- على منع التكرار بمجرد تغيير النص.
create or replace function public.set_service_report_episode()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_changed_at timestamptz;
begin
  if new.incident_id is not null then
    new.episode_key := 'incident:' || new.incident_id::text;
  else
    select s.status_changed_at into v_changed_at
      from public.services s where s.id = new.service_id;
    new.episode_key := 'service:' || new.service_id::text || ':'
                    || coalesce(extract(epoch from v_changed_at)::bigint, 0)::text;
  end if;

  new.source := 'customer_portal';
  return new;
end;
$function$;

drop trigger if exists trg_set_service_report_episode on public.customer_service_reports;
create trigger trg_set_service_report_episode
  before insert on public.customer_service_reports
  for each row execute function public.set_service_report_episode();

alter table public.customer_service_reports enable row level security;

drop policy if exists "Users read their own service reports" on public.customer_service_reports;
create policy "Users read their own service reports"
  on public.customer_service_reports for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users create their own service reports" on public.customer_service_reports;
create policy "Users create their own service reports"
  on public.customer_service_reports for insert
  to authenticated
  with check (user_id = auth.uid());

-- لا UPDATE ولا DELETE للعميل: البلاغ إشارة مؤرَّخة، وتعديلها بعد إرسالها
-- يفقدها معناها. تغيير الحالة قرار إداري.
drop policy if exists "Staff manage service reports" on public.customer_service_reports;
create policy "Staff manage service reports"
  on public.customer_service_reports for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

-- ── 4) إشعار الإدارة عبر نظام الإشعارات الموجود ────────────────────────────
-- SECURITY DEFINER لأن سياسة notifications بتمنع العميل من إنشاء إشعار
-- لمستخدم غير نفسه — وده منع صحيح ما اتفكّش؛ الـtrigger هو المسار المصرّح به.
--
-- إشعار واحد لكل نوبة عطل، مش لكل بلاغ: لو ١٧ عميل بلّغوا عن نفس الحادثة،
-- الإدارة بتاخد إشعارًا واحدًا وتشوف العدد في صفحة الحالة. الضجيج هنا
-- بيقتل الإشعار نفسه.
create or replace function public.notify_admins_of_service_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_service_name text;
  v_is_first     boolean;
  v_link         text;
begin
  select count(*) = 1 into v_is_first
    from public.customer_service_reports r
   where r.episode_key = new.episode_key;

  if not v_is_first then
    return new;
  end if;

  select s.name into v_service_name from public.services s where s.id = new.service_id;

  v_link := case
    when new.incident_id is not null
      then '/admin/status-page.html?incident=' || new.incident_id::text
    else '/admin/status-page.html?service=' || new.service_id::text
  end;

  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  select p.id,
         'عميل أبلغ عن مشكلة',
         'قام أحد العملاء بالإبلاغ عن مشكلة في ' || coalesce(v_service_name, 'إحدى الخدمات') || '.',
         'warning',
         v_link,
         'system',
         coalesce(new.incident_id, new.service_id)
    from public.profiles p
   where p.role = 'admin';

  return new;
end;
$function$;

drop trigger if exists trg_notify_admins_of_service_report on public.customer_service_reports;
create trigger trg_notify_admins_of_service_report
  after insert on public.customer_service_reports
  for each row execute function public.notify_admins_of_service_report();

-- ── 5) ملخّص البلاغات للإدارة ──────────────────────────────────────────────
-- صف واحد لكل خدمة متأثرة، بدل ما تجيب لوحة الإدارة كل البلاغات وتعدّها
-- في المتصفح. SECURITY DEFINER مع فحص دور صريح: أسماء العملاء تخرج هنا
-- فلازم البوابة تكون واضحة ومقروءة في مكان واحد.
create or replace function public.get_service_report_summary()
returns table (
  service_id     uuid,
  service_name   text,
  incident_id    uuid,
  episode_key    text,
  report_count   bigint,
  first_reported timestamptz,
  last_reported  timestamptz,
  reporters      jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ) then
    raise exception 'غير مصرّح';
  end if;

  return query
  select r.service_id,
         s.name::text,
         r.incident_id,
         r.episode_key,
         count(*)          as report_count,
         min(r.created_at) as first_reported,
         max(r.created_at) as last_reported,
         jsonb_agg(
           jsonb_build_object(
             'user_id',     r.user_id,
             'name',        coalesce(pr.full_name, pr.email, 'عميل'),
             'reported_at', r.created_at
           ) order by r.created_at
         ) as reporters
    from public.customer_service_reports r
    join public.services s  on s.id = r.service_id
    left join public.profiles pr on pr.id = r.user_id
   where r.status <> 'resolved'
   group by r.service_id, s.name, r.incident_id, r.episode_key
   order by count(*) desc, max(r.created_at) desc;
end;
$function$;

revoke execute on function public.get_service_report_summary() from public, anon;
grant execute on function public.get_service_report_summary() to authenticated;

-- ── 6) إعطاء الخدمات الموجودة مفاتيحها ─────────────────────────────────────
-- ربط لمرة واحدة بالاسم المزروع في 001 (لم يتغيّر منذ إنشائه). بعد كده
-- المفتاح هو المرجع، والاسم يفضل تحريريًا يتغيّر بحرية.
-- ملاحظة: مفيش صفوف لخدمتَي واتساب والمحرك الذكي في الجدول أصلاً — ما بنخترعهاش
-- هنا؛ الأدمن يقدر يضيفها بمفتاحها من صفحة الحالة (الكتابة بقت متاحة له).
update public.services set service_key = 'core'          where service_key is null and name = 'API الرئيسية';
update public.services set service_key = 'database'      where service_key is null and name = 'قاعدة البيانات';
update public.services set service_key = 'auth'          where service_key is null and name = 'خدمة المصادقة';
update public.services set service_key = 'payments'      where service_key is null and name = 'خدمة الدفع';
update public.services set service_key = 'email'         where service_key is null and name = 'خدمة البريد الإلكتروني';
update public.services set service_key = 'storage'       where service_key is null and name = 'خدمة التخزين السحابي';
update public.services set service_key = 'notifications' where service_key is null and name = 'خدمة الإشعارات';
update public.services set service_key = 'dashboard'     where service_key is null and name = 'لوحة التحكم';
