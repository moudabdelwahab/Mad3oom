-- ============================================================================
-- 043_blog.sql   —   مدوّنة المنصة: مصدر المحتوى، ومن يكتبه، ومن يقرأه
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا جدول جديد، ولماذا لا يكفي knowledge_base
-- ════════════════════════════════════════════════════════════════════════════
--
-- مركز المساعدة (013) ومدوّنة المنصة يبدوان متشابهين — «مقالات لها عنوان
-- وتصنيف ومتن» — والفرق بينهما ليس في الشكل بل في **من يُسمح له بالقراءة**:
--
--   knowledge_base : القارئ **مسجَّل دخوله** (to authenticated)، والمقال
--                    جواب على مشكلة في منتج يملكه القارئ بالفعل.
--   blog_posts     : القارئ **زائر مجهول** — الغرض كله أن يصل المحتوى لمن
--                    لا حساب له، فيقرأ ثم يقرّر. صفحة محجوبة عن anon ليست
--                    مدوّنة، هي مركز مساعدة ثانٍ.
--
-- فرق الجمهور ده بيجرّ وراه فروقًا بنيوية لا تُحلّ بعمود إضافي على الجدول
-- القائم:
--   • القراءة مفتوحة لـanon ⇒ كل عمود في الصف صار محتوى عامًّا. لو أضفنا
--     عمود «عام/خاص» على knowledge_base لكان صفٌّ واحد خاطئ يكشف ملاحظات
--     الدعم الداخلية للإنترنت كله. الفصل بجدولين يجعل التسريب **مستحيلًا
--     بنيويًا** لا مجرّد مُتجنَّب بعمود.
--   • اسم الكاتب: الزائر المجهول لا يقرأ profiles (وهذا صحيح ويجب أن يبقى)،
--     فاسم الكاتب مخزَّن على الصف نفسه — لقطة عرض، لا مصدر هوية.
--   • المدوّنة تحتاج slug وصورة غلاف وحقول SEO ومقالات مميّزة ووسوم؛ وكلها
--     بلا معنى في مركز المساعدة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الأمان — من يكتب
-- ════════════════════════════════════════════════════════════════════════════
--
-- الطلب: التحرير من **لوحة الإدارة أو لوحة المالك فقط**. وهذا بالضبط ما
-- تعنيه public.is_platform_staff() بعد الترحيل 040:
--
--     role in ('admin','support')  ⋁  owner_capability('staff')
--
-- ولأن owner_capability تقاطعُ منحٍ بسياق (038)، فمالك المنصة يكتب في
-- واجهتَي «مالك المنصة» و«الإدارة» وحدهما؛ ومن دخل واجهة العميل أو الشركة
-- لا يكتب سطرًا ولو كان مالكًا. لا رتبة شركة ولا اشتراك ولا ملكية شركة تمنح
-- الكتابة هنا بأي حال — وهو ما يثبته tests/sql/blog.test.sql.
--
-- ولا نكرّر تعريف السلطة هنا بشرط مكتوب بخط اليد: أي تعريف ثانٍ للطاقم كان
-- سيتفرّع عن الأول عند أول تعديل. مصدر واحد، تنادِيه كل سياسة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما لا يفعله هذا الترحيل
-- ════════════════════════════════════════════════════════════════════════════
--   • لا يمسّ جدولًا قائمًا ولا سياسة قائمة — إضافي بالكامل
--   • لا يمنح anon قراءةً على أي شيء غير المنشور من هذين الجدولين
--   • لا يزرع مقالات: المحتوى التحريري يكتبه أصحابه من اللوحة
-- ============================================================================

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null then
    raise exception 'يجب تطبيق migrations/024 و040 أولًا (is_platform_staff غير معرَّفة)';
  end if;
end $$;


-- ============================================================================
-- 1) التصنيفات — بيانات لا ثوابت في الكود
-- ============================================================================
--
-- تصنيفات مركز المساعدة مكتوبة كـ<option> داخل صفحة الإدارة، فإضافة تصنيف
-- تستلزم تعديل ملف ونشرًا. هنا التصنيف صفّ: تُضيفه الإدارة من اللوحة فيظهر
-- في المدوّنة العامة فورًا بلا نشر.

create table if not exists public.blog_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  sort_order  integer not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- شكل الـslug: قائمة **منع** لا قائمة سماح. قائمة السماح الطبيعية
  -- ([[:alnum:]]) تتبع ترتيب المحارف (collation) الخاص بالعنقود، فتقبل
  -- الحروف العربية على عنقود UTF-8 وترفضها على عنقود C — أي أن نفس الترحيل
  -- كان سيسلك سلوكين مختلفين حسب بيئة التشغيل. المنع الصريح للمحارف التي
  -- تكسر المسار أو الاستعلام مستقل عن كل ذلك، ويسمح بالـslug العربي وهو
  -- المطلوب في مدوّنة عربية.
  constraint blog_categories_slug_shape check (
    char_length(slug) between 2 and 80
    and slug = lower(btrim(slug))
    and slug !~ '[[:space:]/?#&=%.]'
    and slug !~ '^-|-$'
  )
);

comment on table public.blog_categories is
  'تصنيفات مدوّنة المنصة. تُدار من admin/blog.html ويقرأها الزائر المجهول.';

create index if not exists idx_blog_categories_active
  on public.blog_categories (is_active, sort_order, name);


-- ============================================================================
-- 2) المقالات
-- ============================================================================

create table if not exists public.blog_posts (
  id               uuid primary key default gen_random_uuid(),

  -- الـslug هو عنوان المقال على الإنترنت. فريد، ولا يتغيّر بتغيّر العنوان
  -- إلا بقرار صريح من المحرّر — تغييره يكسر كل رابط منشور له.
  slug             text not null unique,

  title            text not null,
  subtitle         text,
  excerpt          text,
  content          text not null,

  cover_url        text,
  cover_alt        text,

  category_id      uuid references public.blog_categories(id) on delete set null,
  tags             text[] not null default '{}',

  -- الحالة الافتراضية **مسودّة**، عكس knowledge_base التي جعلتها 'published'
  -- لأن واجهة إدارتها القديمة لم تكن ترسل status أصلًا. هنا الواجهة ترسلها
  -- دائمًا، والخطأ المكلف معكوس: مقال داخلي يظهر على الإنترنت أسوأ بكثير من
  -- مقال جاهز ينتظر ضغطة نشر.
  status           text not null default 'draft'
                   check (status in ('draft', 'published', 'archived')),

  is_featured      boolean not null default false,

  -- محسوبان في القاعدة لا في المتصفح: الرقم الذي يراه القارئ يجب أن يكون
  -- واحدًا مهما اختلف العميل الذي رسمه.
  reading_minutes  integer not null default 1,
  word_count       integer not null default 0,

  view_count       integer not null default 0,

  seo_title        text,
  seo_description  text,

  -- author_id للنسبة والتدقيق، واسم الكاتب لقطة **للعرض**.
  -- الزائر المجهول لا يقرأ profiles — ولا يجب أن يقرأها — فلو كان الاسم
  -- يُجلب بانضمام لظهرت كل المقالات بلا كاتب لمن لا حساب له، وهو أغلب
  -- جمهور المدوّنة. اللقطة تحل ذلك بلا فتح أي جدول هوية.
  author_id        uuid references auth.users(id) on delete set null,
  author_name      text not null default 'فريق مدعوم',
  author_title     text,

  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint blog_posts_slug_shape check (
    char_length(slug) between 2 and 120
    and slug = lower(btrim(slug))
    and slug !~ '[[:space:]/?#&=%.]'
    and slug !~ '^-|-$'
  ),
  constraint blog_posts_title_not_blank check (btrim(title) <> ''),
  constraint blog_posts_content_not_blank check (btrim(content) <> '')
);

comment on table public.blog_posts is
  'مقالات مدوّنة المنصة. القراءة العامة للمنشور وحده؛ الكتابة لطاقم المنصة '
  '(لوحة الإدارة أو لوحة المالك) عبر is_platform_staff().';
comment on column public.blog_posts.author_name is
  'اسم الكاتب للعرض — لقطة على الصف لأن الزائر المجهول لا يقرأ profiles.';
comment on column public.blog_posts.published_at is
  'لحظة أول نشر. تبقى ثابتة بعد ذلك؛ ولو كانت في المستقبل فالمقال مجدول ولا '
  'يراه الزائر حتى يحين موعده.';

-- الفهرس الذي تخدمه صفحة المدوّنة: المنشور مرتَّبًا بتاريخ النشر تنازليًا.
create index if not exists idx_blog_posts_public
  on public.blog_posts (status, published_at desc)
  where status = 'published';

create index if not exists idx_blog_posts_category
  on public.blog_posts (category_id, published_at desc);

create index if not exists idx_blog_posts_featured
  on public.blog_posts (is_featured, published_at desc)
  where is_featured = true;

create index if not exists idx_blog_posts_tags
  on public.blog_posts using gin (tags);

create index if not exists idx_blog_posts_updated
  on public.blog_posts (updated_at desc);


-- ============================================================================
-- 3) المحفّزات — ما لا يُترك للواجهة
-- ============================================================================
--
-- زمن القراءة والوسوم وlحظة النشر كلها قابلة للحساب من الصف نفسه. تركها
-- للعميل يعني أن مقالًا أُنشئ من اللوحة يختلف عن مقال أُنشئ من نداء REST
-- مباشر — فتظهر في الصفحة أرقام متضاربة بلا مصدر واحد يُرجَع إليه.

create or replace function public.blog_normalize_post()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_words integer;
begin
  -- الوسوم: تنظيف وتوحيد وإسقاط المكرّر. بدونه يصير «واتساب» و«واتساب  »
  -- وسمين مختلفين في صفحة التصفية.
  if new.tags is null then
    new.tags := '{}'::text[];
  else
    select coalesce(array_agg(distinct s.v order by s.v), '{}'::text[])
      into new.tags
      from (
        select lower(btrim(raw)) as v
          from unnest(new.tags) as raw
         where btrim(coalesce(raw, '')) <> ''
      ) s;
  end if;

  -- عدّ الكلمات: تقسيم على الفراغ بعد إسقاط علامات التنسيق البسيطة.
  -- تقريب مقصود — الغرض رقم صادق للقارئ لا قياس نصّي دقيق.
  -- الشرطة في آخر مجموعة المحارف لا في وسطها: داخل [] تعني المدى، وتهريبها
  -- بـ\ سلوكٌ غير منقول بين محرّكات الأنماط. آخر المجموعة موضعها الآمن.
  v_words := coalesce(
    array_length(
      regexp_split_to_array(btrim(regexp_replace(new.content, '[#*_`>-]+', ' ', 'g')), '[[:space:]]+'),
      1),
    0);

  new.word_count := v_words;
  -- 200 كلمة/دقيقة متوسط قراءة عربية شائع، والحدّ الأدنى دقيقة واحدة لأن
  -- «٠ دقيقة» ليست معلومة.
  new.reading_minutes := greatest(1, ceil(v_words::numeric / 200)::integer);

  -- لحظة النشر تُضبط مرة واحدة: إعادة النشر بعد أرشفة لا تغيّر تاريخ المقال
  -- ولا ترتيبه في الفهرس، وإلا كان كل تعديل يقفز بالمقال لأعلى الصفحة.
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_blog_normalize_post on public.blog_posts;
create trigger trg_blog_normalize_post
  before insert or update on public.blog_posts
  for each row execute function public.blog_normalize_post();


create or replace function public.blog_touch_category()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_blog_touch_category on public.blog_categories;
create trigger trg_blog_touch_category
  before update on public.blog_categories
  for each row execute function public.blog_touch_category();


-- ============================================================================
-- 4) الصلاحيات — القراءة عامة، الكتابة للطاقم
-- ============================================================================

alter table public.blog_posts      enable row level security;
alter table public.blog_categories enable row level security;

-- ── القراءة العامة ────────────────────────────────────────────────────────
-- `published_at <= now()` ليست تجميلًا: هي ما يجعل الجدولة ممكنة. مقال
-- بتاريخ نشر مستقبلي موجود في الجدول ومحجوب عن الزائر حتى يحين موعده،
-- ويظهر وحده دون أي مهمة مجدولة.
drop policy if exists blog_posts_public_read on public.blog_posts;
create policy blog_posts_public_read on public.blog_posts
  for select to anon, authenticated
  using (
    status = 'published'
    and published_at is not null
    and published_at <= now()
  );

drop policy if exists blog_categories_public_read on public.blog_categories;
create policy blog_categories_public_read on public.blog_categories
  for select to anon, authenticated
  using (is_active is true);

-- ── الطاقم: يقرأ كل شيء ويكتب كل شيء ─────────────────────────────────────
drop policy if exists blog_posts_staff_read on public.blog_posts;
create policy blog_posts_staff_read on public.blog_posts
  for select to authenticated
  using (public.is_platform_staff());

drop policy if exists blog_posts_staff_write on public.blog_posts;
create policy blog_posts_staff_write on public.blog_posts
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

drop policy if exists blog_categories_staff_read on public.blog_categories;
create policy blog_categories_staff_read on public.blog_categories
  for select to authenticated
  using (public.is_platform_staff());

drop policy if exists blog_categories_staff_write on public.blog_categories;
create policy blog_categories_staff_write on public.blog_categories
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

-- المنح الجدولية: القراءة وحدها لـanon. من دون هذا السطر تكون سياسة القراءة
-- العامة أعلاه بلا أثر — السياسة تُرشِّح الصفوف، والمنح هو ما يسمح بالوصول
-- للجدول أصلًا.
revoke all on table public.blog_posts      from public, anon, authenticated;
revoke all on table public.blog_categories from public, anon, authenticated;

grant select on table public.blog_posts      to anon, authenticated;
grant select on table public.blog_categories to anon, authenticated;
grant insert, update, delete on table public.blog_posts      to authenticated;
grant insert, update, delete on table public.blog_categories to authenticated;


-- ============================================================================
-- 5) الفهرس والبحث — دالة واحدة تخدم كل أوضاع الصفحة
-- ============================================================================
--
-- security invoker (الافتراضي) عن قصد: سياسات RLS أعلاه تبقى سارية داخل
-- الدالة، فالمسودّة لا تظهر في نتيجة بحث الزائر، ويرى الطاقم من اللوحة ما
-- يراه من الجدول بالضبط — بلا مسار قراءة ثانٍ له قواعد أخرى.
--
-- total_count عمود محسوب بـcount(*) over(): الترقيم يحتاج العدد الكلي، وبلا
-- ذلك كانت الصفحة ستطلب النتائج مرتين (مرة للعدّ ومرة للعرض) على نفس
-- الفلاتر — رحلتا شبكة واحتمال تضارب بينهما.

create or replace function public.blog_feed(
  p_query      text    default null,
  p_category   text    default null,
  p_tag        text    default null,
  p_featured   boolean default null,
  p_limit      integer default 9,
  p_offset     integer default 0
)
returns table (
  id              uuid,
  slug            text,
  title           text,
  subtitle        text,
  excerpt         text,
  cover_url       text,
  cover_alt       text,
  category_slug   text,
  category_name   text,
  tags            text[],
  is_featured     boolean,
  reading_minutes integer,
  view_count      integer,
  author_name     text,
  author_title    text,
  published_at    timestamptz,
  relevance       integer,
  total_count     bigint
)
language sql
stable
set search_path to 'public'
as $function$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select p.*, c.slug as c_slug, c.name as c_name,
           case
             when (select term from q) is null then 0
             when p.title    ilike '%' || (select term from q) || '%' then 4
             when p.excerpt  ilike '%' || (select term from q) || '%' then 3
             when p.subtitle ilike '%' || (select term from q) || '%' then 2
             else 1
           end as rel
      from public.blog_posts p
      left join public.blog_categories c on c.id = p.category_id
     where (p_category is null or c.slug = p_category)
       and (p_tag      is null or lower(btrim(p_tag)) = any (p.tags))
       and (p_featured is null or p.is_featured = p_featured)
       and (
         (select term from q) is null
         or p.title    ilike '%' || (select term from q) || '%'
         or p.subtitle ilike '%' || (select term from q) || '%'
         or p.excerpt  ilike '%' || (select term from q) || '%'
         or p.content  ilike '%' || (select term from q) || '%'
         or exists (
              select 1 from unnest(p.tags) as t(tag)
               where t.tag ilike '%' || (select term from q) || '%'
            )
       )
  )
  select m.id, m.slug, m.title, m.subtitle, m.excerpt, m.cover_url, m.cover_alt,
         m.c_slug, m.c_name, m.tags, m.is_featured, m.reading_minutes,
         m.view_count, m.author_name, m.author_title, m.published_at,
         m.rel,
         count(*) over () as total_count
    from matched m
   order by m.rel desc, m.is_featured desc, m.published_at desc nulls last, m.created_at desc
   limit  greatest(1, least(coalesce(p_limit, 9), 50))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

comment on function public.blog_feed(text, text, text, boolean, integer, integer) is
  'فهرس المدوّنة وبحثها. security invoker فتبقى RLS سارية: الزائر لا يرى '
  'مسودّة ولا مقالًا مجدولًا مهما كان نص البحث.';

grant execute on function public.blog_feed(text, text, text, boolean, integer, integer)
  to anon, authenticated;


-- ── مقالات ذات صلة ────────────────────────────────────────────────────────
-- الترتيب: التصنيف نفسه أقوى من وسم مشترك، والوسوم المشتركة الأكثر أقوى من
-- الأقل. لا «مقالات عشوائية» — القارئ الذي وصل لآخر المقال يستحق التالي
-- المناسب لا صفًّا مملوءًا.
create or replace function public.blog_related(
  p_slug  text,
  p_limit integer default 3
)
returns table (
  slug            text,
  title           text,
  excerpt         text,
  cover_url       text,
  category_name   text,
  reading_minutes integer,
  published_at    timestamptz
)
language sql
stable
set search_path to 'public'
as $function$
  -- كل مرجع مؤهَّل باسم الجدول عمدًا: أسماء أعمدة RETURNS TABLE تصير
  -- معاملات مرئية داخل الجسم، فمرجع غير مؤهَّل مثل `slug` يصير غامضًا
  -- ويفشل الترحيل عند الإنشاء لا عند أول نداء.
  with base as (
    select b0.id, b0.category_id, b0.tags
      from public.blog_posts b0
     where b0.slug = p_slug
  )
  select p.slug, p.title, p.excerpt, p.cover_url, c.name,
         p.reading_minutes, p.published_at
    from public.blog_posts p
    left join public.blog_categories c on c.id = p.category_id
    cross join base b
   where p.id <> b.id
     and (p.category_id = b.category_id or p.tags && b.tags)
   order by (p.category_id is not distinct from b.category_id) desc,
            (select count(*) from unnest(p.tags) as x(tag) where x.tag = any (b.tags)) desc,
            p.published_at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 3), 12));
$function$;

comment on function public.blog_related(text, integer) is
  'مقالات ذات صلة بالتصنيف ثم بالوسوم المشتركة. security invoker فلا تقترح '
  'مسودّة على زائر.';

grant execute on function public.blog_related(text, integer) to anon, authenticated;


-- ── أرشيف التصفّح ─────────────────────────────────────────────────────────
-- عدد المقالات لكل تصنيف، محسوبًا من الصفوف التي يراها المنادي فعلًا. لذلك
-- يرى الزائر «٣ مقالات» ويرى المحرّر «٥» في نفس التصنيف — والرقمان صادقان
-- كلٌّ لصاحبه، لأن المصدر واحد والفارق هو RLS لا منطق مكتوب مرتين.
create or replace function public.blog_categories_with_counts()
returns table (
  slug        text,
  name        text,
  description text,
  sort_order  integer,
  post_count  bigint
)
language sql
stable
set search_path to 'public'
as $function$
  select c.slug, c.name, c.description, c.sort_order,
         count(p.id) as post_count
    from public.blog_categories c
    left join public.blog_posts p on p.category_id = c.id
   group by c.slug, c.name, c.description, c.sort_order
   order by c.sort_order, c.name;
$function$;

grant execute on function public.blog_categories_with_counts() to anon, authenticated;


-- ── الوسوم الأكثر استخدامًا ───────────────────────────────────────────────
create or replace function public.blog_tags(p_limit integer default 20)
returns table (tag text, post_count bigint)
language sql
stable
set search_path to 'public'
as $function$
  select t.tag, count(*) as post_count
    from public.blog_posts p
   cross join lateral unnest(p.tags) as t(tag)
   group by t.tag
   order by count(*) desc, t.tag
   limit greatest(1, least(coalesce(p_limit, 20), 60));
$function$;

grant execute on function public.blog_tags(integer) to anon, authenticated;


-- ============================================================================
-- 6) عدّاد القراءة
-- ============================================================================
--
-- القارئ (بما فيه الزائر المجهول) لا يملك UPDATE على blog_posts وهذا صحيح.
-- الزيادة تمرّ بدالة محصورة في عمود واحد وفي المقالات المنشورة وحدها، فأوسع
-- ما يستطيعه مستخدمها هو تضخيم عدّاد مشاهدات مقال معروض للعامة أصلًا — وهو
-- المدى المقصود، لا أثر جانبي غير محسوب.

create or replace function public.increment_blog_view(p_slug text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.blog_posts
     set view_count = view_count + 1
   where slug = p_slug
     and status = 'published'
     and published_at is not null
     and published_at <= now();
end;
$function$;

revoke execute on function public.increment_blog_view(text) from public;
grant execute on function public.increment_blog_view(text) to anon, authenticated;


-- ============================================================================
-- 7) بذرة التصنيفات
-- ============================================================================
--
-- تصنيفات فقط، ولا مقال واحد. المدوّنة سطح تحريري للمنصة، وأي مقال نزرعه هنا
-- كان سيُنشَر باسمها على الإنترنت بمحتوًى لم يكتبه أحد من أهلها. الفهرس
-- الفارغ يقول للمحرّر «ابدأ من هنا»، والمقال المزروع يقول للزائر شيئًا غير
-- صحيح — والفرق بينهما ليس تقنيًا.
--
-- on conflict do nothing: إعادة تشغيل الترحيل لا تدوس على تسميات عدّلتها
-- الإدارة بعد أول تطبيق.

insert into public.blog_categories (slug, name, description, sort_order) values
  ('whatsapp-api', 'واتساب والـAPI',
   'كل ما يخص WhatsApp Business Platform: الربط والقوالب والجودة وحدود الإرسال.', 10),
  ('ai-automation', 'الذكاء والأتمتة',
   'المحرّك الذكي، الردود الآلية، وبناء تدفّقات تخدم العميل بلا انتظار.', 20),
  ('customer-support', 'خدمة العملاء',
   'ممارسات الدعم الفني: التذاكر، زمن الاستجابة، ورضا العميل.', 30),
  ('product-updates', 'تحديثات المنصة',
   'ما الجديد في مدعوم — ميزات، تحسينات، وقرارات تصميم نشرحها بصراحة.', 40),
  ('security-compliance', 'الأمان والامتثال',
   'حماية بيانات العملاء، الصلاحيات، والالتزام بسياسات Meta.', 50),
  ('growth-playbooks', 'أدلّة النمو',
   'حالات عملية وأرقام من السوق: كيف تحوّل قناة تواصل إلى قناة نمو.', 60)
on conflict (slug) do nothing;
