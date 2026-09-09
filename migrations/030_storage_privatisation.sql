-- 030_storage_privatisation.sql
-- قلب المستودعات الحسّاسة إلى خاصة + ترحيل الروابط القائمة
-- ============================================================================
--
-- يُطبَّق بعد 028 (الذي أضاف حدّ التذكرة الموحّد وسياسات القراءة) وبعد نشر
-- كود الواجهة الذي يقرأ file_path ويوقّع الروابط.
--
-- ما قبل هذا الملف: `/object/public/tickets/<path>` يُخدَم **بلا أي مصادقة**،
-- وticket_attachments.file_url يخزّن ذلك الرابط المطلق. من رآه مرة يحتفظ به
-- إلى الأبد ويمرّره. بعده: لا رابط دائم، والتوقيع يمرّ بـRLS في كل مرة.
--
-- الحجم الحقيقي (قراءة من الإنتاج): 6 صفوف تحمل روابط تخزين عامة في
-- ticket_attachments، و3 صفوف أخرى تحمل رابط فاتورة (ليست تخزينًا فتُترك).

do $$
begin
  if to_regprocedure('public.can_access_ticket(uuid)') is null then
    raise exception 'يجب تطبيق migrations/028 أولًا';
  end if;
end $$;

-- ============================================================================
-- 1) المسار بدل الرابط
-- ============================================================================

alter table public.ticket_attachments add column if not exists file_path text;

update public.ticket_attachments
   set file_path = regexp_replace(file_url, '^.*/object/public/tickets/', '')
 where file_path is null
   and file_url like '%/object/public/tickets/%';

-- تحقق: كل صف مُرحَّل يقابله كائن فعلي في المستودع. لو لا، نتوقف قبل قلب
-- المستودع — وإلا صار المرفق غير قابل للعرض بلا وسيلة رجوع سهلة.
do $$
declare v_missing int; v_migrated int;
begin
  select count(*) into v_migrated from public.ticket_attachments where file_path is not null;

  select count(*) into v_missing
    from public.ticket_attachments a
   where a.file_path is not null
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'tickets' and o.name = a.file_path);

  if v_missing > 0 then
    raise exception 'توقف: % من % صفًّا مُرحَّلًا يشير إلى ملف غير موجود في المستودع',
      v_missing, v_migrated;
  end if;

  raise notice '030: رُحّل % صفًّا، وكلها تقابل ملفات فعلية', v_migrated;
end $$;

-- `file_url` يبقى كما هو **عمدًا**: هو وسيلة الرجوع لو احتجنا قلب المستودع
-- عامًّا ثانيةً. ولا يُقرأ بعد اليوم إلا كمصدر مسار للصفوف القديمة.

-- ============================================================================
-- 2) الكتابة في التخزين — كل مستودع بحدّه
-- ============================================================================
--
-- ما كان قائمًا (وأُثبت بالمحاولة):
--   • chat-attachments: شرط الرفع `bucket_id = 'chat-attachments'` فقط، وممنوح
--     لـPUBLIC ⇒ **زائر غير مسجَّل يرفع**. أُغلق في 027 ويُعاد تثبيته هنا.
--   • tickets: `auth.role() = 'authenticated'` فقط ⇒ رفع داخل مسار عميل آخر.
--   • avatars: `auth.role() = 'authenticated'` فقط ⇒ **رفع داخل مسار مستخدم آخر**.
--     (الكتابة فوق ملف قائم يمنعها فحص المالك في سياسة UPDATE، لكن زرع ملف
--     جديد باسم غيره كان ممكنًا.)

do $$
begin
  -- ── tickets ──────────────────────────────────────────────────────────────
  drop policy if exists "Allow authenticated uploads" on storage.objects;
  create policy "Allow authenticated uploads" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'tickets'
      and (
            public.is_platform_staff()
        or  (storage.foldername(name))[1] = auth.uid()::text
        or  public.can_access_ticket(public.storage_ticket_id(name))
      )
    );

  -- ── chat-attachments ─────────────────────────────────────────────────────
  drop policy if exists "Allow authenticated users to upload" on storage.objects;
  create policy "Allow authenticated users to upload" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'chat-attachments'
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  -- ── avatars ──────────────────────────────────────────────────────────────
  -- تبقى القراءة عامة: الصورة الرمزية تُعرض لمستخدمين آخرين في المنتدى
  -- (forum.js يرسم صورة كاتب كل موضوع ورد). جعلها خاصة كان سيكسر المنتدى
  -- مقابل لا شيء — صورة شخصية معروضة لكل مسجَّل ليست سرًّا. الحدّ هنا على
  -- **الكتابة**: لا أحد يكتب داخل مسار غيره.
  drop policy if exists "Allow Authenticated Insert" on storage.objects;
  create policy "Allow Authenticated Insert" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  drop policy if exists "Allow Owner Update" on storage.objects;
  create policy "Allow Owner Update" on storage.objects
    for update to authenticated
    using (bucket_id = 'avatars' and owner = auth.uid())
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  drop policy if exists "Allow Owner Delete" on storage.objects;
  create policy "Allow Owner Delete" on storage.objects
    for delete to authenticated
    using (bucket_id = 'avatars' and owner = auth.uid());
exception
  when insufficient_privilege then
    raise warning 'لا صلاحية لتعديل سياسات storage.objects بهذا الدور — طبّقها بدور مالك التخزين';
end $$;

-- ملاحظة مقصودة: لا سياسة UPDATE ولا DELETE لـ tickets أو chat-attachments.
-- الغياب هنا **قرار**: لا أحد — ولا صاحب الملف — يعدّل أو يحذف مرفق تذكرة عبر
-- واجهة التخزين. المرفق دليل في نزاع محتمل، وحذفه يكون بقرار إداري لا بنداء
-- من المتصفح. (RLS تمنع بالغياب: ما لا سياسة له مرفوض.)

-- ============================================================================
-- 3) قلب المستودعين
-- ============================================================================
--
-- الرجوع فوري وبلا فقد بيانات: الملفات لا تتحرك في أي اتجاه، والعمود file_url
-- ما زال يحمل الرابط العام القديم.
--   للرجوع: update storage.buckets set public = true where id in ('tickets','chat-attachments');

update storage.buckets set public = false where id in ('tickets', 'chat-attachments');

-- ============================================================================
-- 4) تحقق
-- ============================================================================
do $$
declare v int; v_txt text;
begin
  select count(*) into v from storage.buckets
   where id in ('tickets','chat-attachments') and public;
  if v > 0 then raise exception 'ما زال % مستودعًا حسّاسًا عامًّا', v; end if;

  select count(*) into v from storage.buckets where id = 'avatars' and public;
  if v <> 1 then raise exception 'avatars يجب أن يبقى عامًّا (يُعرض في المنتدى)'; end if;

  -- لا سياسة كتابة بلا قيد مسار على المستودعات الثلاثة
  select string_agg(pol.polname, ', ') into v_txt
    from pg_policy pol
   where pol.polrelid = 'storage.objects'::regclass
     and pol.polcmd = 'a'
     and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') !~ 'foldername|storage_ticket_id'
     and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ '(tickets|chat-attachments|avatars)';
  if v_txt is not null then
    raise exception 'سياسات رفع بلا قيد مسار: %', v_txt;
  end if;

  select count(*) into v from public.ticket_attachments
   where file_url like '%/object/public/tickets/%' and file_path is null;
  if v > 0 then raise exception '% صفًّا لم يُرحَّل', v; end if;

  raise notice '030: المستودعان خاصان، والكتابة مقيدة بالمسار، والصفوف مُرحَّلة';
end $$;
