-- ============================================================================
-- 013_help_center.sql   —   مصدر المقالات الحقيقي لمركز المساعدة
--
-- سبب المشكلة (Root cause)
--   صفحة knowledge-base.html بتعرض "فشل تحميل المقالات" لأن الاستعلام:
--       supabase.from('knowledge_base').select('*')
--   بيضرب على **جدول غير موجود**. الجدول ما اتعملش في أي migration؛ الواجهتان
--   (واجهة العميل knowledge-base.html وواجهة الإدارة
--   admin/knowledge-base-admin.html) اتكتبتا الاتنين على جدول متخيَّل.
--   فالنتيجة: العميل بيشوف رسالة فشل، والأدمن بيشوف قائمة فاضية وأي حفظ
--   بيرجع خطأ. مش مشكلة عرض — مشكلة مصدر بيانات غير موجود أصلاً.
--
--   ومعاها مشكلة تانية: جدول suggested_questions (٦ أسئلة شائعة حقيقية)
--   عليه RLS مفعّل **بصفر سياسات**، يعني محجوب عن الجميع. محتوى موجود
--   ومدفوع له ثمن تحريري، وما حدش يقدر يقراه.
--
-- الحل
--   إنشاء الجدول اللي الواجهتان بتتوقعاه بنفس أسماء الأعمدة اللي بتكتبها
--   واجهة الإدارة فعلاً (title/category/excerpt/content/updated_at)، وزيادة
--   الحد الأدنى اللي يخلي منه مركز مساعدة محترم: حالة نشر، عدّاد قراءة،
--   وتقييم "هل ساعدك المقال؟". وفتح قراءة الأسئلة الشائعة النشطة.
--
-- الأمان
--   العميل يقرأ المنشور وغير الداخلي فقط. المسودّات والمقالات الداخلية
--   للأدمن/الدعم بس. الكتابة كلها محصورة في الأدمن/الدعم.
--   مفيش أي توسيع لصلاحيات على جداول تانية.
-- ============================================================================

-- ── 1) جدول المقالات ────────────────────────────────────────────────────────
create table if not exists public.knowledge_base (
  id           uuid primary key default gen_random_uuid(),
  title        text        not null,
  category     text        not null,
  excerpt      text,
  content      text        not null,

  -- حالة النشر: الافتراضي 'published' عن قصد، لأن واجهة الإدارة الحالية
  -- بتعمل insert من غير ما تبعت status. لو الافتراضي كان 'draft' كان كل
  -- مقال جديد هيتكتب ويختفي — نفس عرَض المشكلة اللي بنصلّحها.
  status       text        not null default 'published'
                           check (status in ('draft', 'published')),

  -- مقال داخلي = ملاحظات فريق الدعم. ما بيوصلش العميل مهما كانت حالة النشر.
  is_internal  boolean     not null default false,

  view_count   integer     not null default 0,
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz
);

comment on table public.knowledge_base is
  'مقالات مركز المساعدة. تُدار من admin/knowledge-base-admin.html ويقرأها العميل من knowledge-base.html.';
comment on column public.knowledge_base.is_internal is
  'مقال داخلي لفريق الدعم — لا يظهر للعميل أبداً حتى لو كان status=published.';

create index if not exists idx_kb_published
  on public.knowledge_base (status, is_internal, updated_at desc);
create index if not exists idx_kb_category
  on public.knowledge_base (category, updated_at desc);

-- published_at يتضبط لحظة النشر الأول ويفضل ثابت بعدها
create or replace function public.set_kb_published_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_kb_published_at on public.knowledge_base;
create trigger trg_kb_published_at
  before insert or update on public.knowledge_base
  for each row execute function public.set_kb_published_at();

alter table public.knowledge_base enable row level security;

-- القراءة: المنشور غير الداخلي لأي مستخدم مسجَّل
drop policy if exists "Anyone signed in can read published articles" on public.knowledge_base;
create policy "Anyone signed in can read published articles"
  on public.knowledge_base for select
  to authenticated
  using (status = 'published' and is_internal = false);

-- الأدمن/الدعم يقرأ كل شيء (المسودّات والداخلي)
drop policy if exists "Staff can read all articles" on public.knowledge_base;
create policy "Staff can read all articles"
  on public.knowledge_base for select
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

drop policy if exists "Staff can write articles" on public.knowledge_base;
create policy "Staff can write articles"
  on public.knowledge_base for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

-- ── 2) تقييم المقال ─────────────────────────────────────────────────────────
-- القيد الفريد (article_id, user_id) هو اللي بيمنع التصويت المكرر: العميل
-- يقدر يغيّر رأيه، لكن مش يزوّد العدّاد بالتكرار.
create table if not exists public.kb_article_feedback (
  id         uuid primary key default gen_random_uuid(),
  article_id uuid        not null references public.knowledge_base(id) on delete cascade,
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  is_helpful boolean     not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id, user_id)
);

comment on table public.kb_article_feedback is
  'تقييم العميل للمقال (هل ساعدك؟). القيد الفريد يمنع تكرار التصويت من نفس العميل على نفس المقال.';

create index if not exists idx_kb_feedback_article
  on public.kb_article_feedback (article_id, is_helpful);

alter table public.kb_article_feedback enable row level security;

drop policy if exists "Users manage their own article feedback" on public.kb_article_feedback;
create policy "Users manage their own article feedback"
  on public.kb_article_feedback for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Staff can read article feedback" on public.kb_article_feedback;
create policy "Staff can read article feedback"
  on public.kb_article_feedback for select
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));

-- ── 3) عدّاد القراءة ────────────────────────────────────────────────────────
-- العميل ما عندوش UPDATE على knowledge_base (وده صحيح)، فالزيادة بتتم عبر
-- دالة محصورة في عمود واحد بدل ما نفتح تعديل الجدول.
create or replace function public.increment_article_view(p_article_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.knowledge_base
     set view_count = view_count + 1
   where id = p_article_id
     and status = 'published'
     and is_internal = false;
end;
$function$;

revoke execute on function public.increment_article_view(uuid) from public, anon;
grant execute on function public.increment_article_view(uuid) to authenticated;

-- ── 4) بحث حقيقي في المقالات ────────────────────────────────────────────────
-- security invoker (الافتراضي) عن قصد: سياسات RLS فوق بتفضل سارية، فالمسودّات
-- والمقالات الداخلية ما بتظهرش في نتائج البحث للعميل.
-- الترتيب بالصلة: العنوان أقوى من المقتطف، والمقتطف أقوى من المتن.
create or replace function public.search_help_articles(
  p_query    text default null,
  p_category text default null,
  p_limit    integer default 20,
  p_offset   integer default 0
)
returns table (
  id          uuid,
  title       text,
  category    text,
  excerpt     text,
  updated_at  timestamptz,
  view_count  integer,
  relevance   integer
)
language sql
stable
set search_path to 'public'
as $function$
  with q as (select nullif(btrim(coalesce(p_query, '')), '') as term)
  select a.id, a.title, a.category, a.excerpt, a.updated_at, a.view_count,
         case
           when (select term from q) is null then 0
           when a.title    ilike '%' || (select term from q) || '%' then 3
           when a.excerpt  ilike '%' || (select term from q) || '%' then 2
           else 1
         end as relevance
    from public.knowledge_base a
   where (p_category is null or a.category = p_category)
     and (
       (select term from q) is null
       or a.title   ilike '%' || (select term from q) || '%'
       or a.excerpt ilike '%' || (select term from q) || '%'
       or a.content ilike '%' || (select term from q) || '%'
     )
   order by relevance desc, a.view_count desc, a.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

comment on function public.search_help_articles(text, text, integer, integer) is
  'بحث مركز المساعدة مرتّب بالصلة. security invoker فتبقى سياسات RLS سارية.';

revoke execute on function public.search_help_articles(text, text, integer, integer) from public, anon;
grant execute on function public.search_help_articles(text, text, integer, integer) to authenticated;

-- ── 5) فتح الأسئلة الشائعة المحجوبة ─────────────────────────────────────────
-- الجدول عليه RLS مفعّل بصفر سياسات، يعني محتواه (٦ أسئلة نشطة) غير مقروء
-- لأي أحد. السياسة هنا بتفتح النشط فقط للمسجَّلين — أضيق فتح ممكن يخلي
-- المحتوى الموجود يوصل لصاحبه.
drop policy if exists "Signed in users can read active questions" on public.suggested_questions;
create policy "Signed in users can read active questions"
  on public.suggested_questions for select
  to authenticated
  using (is_active is true);

drop policy if exists "Staff can manage suggested questions" on public.suggested_questions;
create policy "Staff can manage suggested questions"
  on public.suggested_questions for all
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ));
