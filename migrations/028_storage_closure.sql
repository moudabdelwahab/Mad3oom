-- 028_storage_closure.sql
-- إغلاق حدود التخزين — حدّ الملف = حدّ التذكرة
-- ============================================================================
--
-- المشكلة (R1 من تقرير المرحلة السابقة)
--   المستودعات الخمسة كلها `public = true`. المستودع العام يعني أن
--   `/storage/v1/object/public/<bucket>/<path>` يُخدَم **بلا أي مصادقة**.
--   ومستودع `tickets` يحوي إيصالات دفع العملاء، و`ticket_attachments.file_url`
--   يخزّن الرابط العام **المطلق** لكل مرفق. أي رابط يُرى مرة يبقى صالحًا
--   للأبد ويُمرَّر لأي أحد.
--
-- لماذا لا نقلب المستودع خاصًّا في هذا الملف
--   قلب `public=false` يبطل كل رابط مخزَّن **لحظتها**، فتظهر المرفقات مكسورة
--   في كل تذكرة. الترتيب الصحيح: سياسات القراءة أولًا، ثم عمود المسار، ثم
--   كود الواجهة يوقّع الروابط، **ثم** يُقلب المستودع. القسمان 4 و5 معطّلان
--   عمدًا حتى تكتمل الخطوة الثالثة.
--
-- ما يفعله هذا الملف الآن (كله غير كاسر)
--   1. تعريف واحد لحدّ التذكرة، يُستعمل في الجدول والتخزين معًا.
--   2. إصلاح تعارض قائم: مالك الشركة يقرأ تذكرة عضوه ولا يقرأ مرفقاتها.
--   3. سياسات SELECT على storage.objects — لا توجد ولا واحدة اليوم، فالقراءة
--      عبر واجهة المصادقة (وتوقيع الروابط) مستحيلة أصلًا.

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null then
    raise exception 'يجب تطبيق migrations/024 و 027 أولًا';
  end if;
end $$;

-- ============================================================================
-- 1) حدّ التذكرة — تعريف واحد
-- ============================================================================
--
-- مأخوذ حرفيًا من tickets_select_policy القائمة على الإنتاج:
--   صاحب التذكرة، أو الإدارة، أو **مالك الشركة على تذاكر أعضائه**.
-- لا يوسّع شيئًا؛ يجمع ما هو مبعثر في موضعين متعارضين.

create or replace function public.can_access_ticket(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_ticket_id is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (
            t.user_id = auth.uid()
         or public.is_platform_staff()
         or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid())
       )
  );
$$;

revoke all on function public.can_access_ticket(uuid) from public, anon;
grant execute on function public.can_access_ticket(uuid) to authenticated;

-- ============================================================================
-- 2) تعارض قائم: التذكرة مقروءة والمرفق لا
-- ============================================================================
--
-- «Owner can view own ticket attachments» تسمح لصاحب التذكرة وحده، بينما
-- tickets_select_policy تسمح لمالك الشركة بقراءة تذكرة عضوه. وكان مالك الشركة
-- يصل للمرفقات عبر مسار الطاقم القديم (super_user) الذي يزيله 025 — فبعد 025
-- يرى التذكرة بلا مرفقاتها. التعريف الواحد يزيل التعارض في الاتجاهين.

drop policy if exists "Owner can view own ticket attachments" on public.ticket_attachments;
create policy "Owner can view own ticket attachments" on public.ticket_attachments
  for select using (public.can_access_ticket(ticket_id));

drop policy if exists "Owner can upload attachments to own ticket" on public.ticket_attachments;
create policy "Owner can upload attachments to own ticket" on public.ticket_attachments
  for insert with check (public.can_access_ticket(ticket_id));

-- ============================================================================
-- 3) قراءة التخزين — لا سياسة SELECT واحدة على storage.objects اليوم
-- ============================================================================
--
-- أثره اليوم: القراءة عبر واجهة المصادقة و`createSignedUrl` **مرفوضة للجميع**،
-- فالمسار الوحيد العامل هو الرابط العام. أي أن غياب السياسة هو ما يجعل
-- المستودع العام ضرورة. هذه السياسات تفتح المسار الصحيح قبل إغلاق الخطأ.
--
-- عرفا المسار في مستودع tickets موجودان معًا على الإنتاج:
--     <ticket_id>/<file>              (عمق 2)
--     <user_id>/<ticket_id>/<file>    (عمق 3)
-- فالدالة أدناه تستخرج معرّف التذكرة من الاثنين، وترجع NULL لأي شكل آخر
-- (فيُرفض) بدل أن تخمّن.

create or replace function public.storage_ticket_id(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare parts text[]; v uuid;
begin
  parts := string_to_array(coalesce(p_name,''), '/');
  -- عمق 3: الجزء الثاني هو التذكرة
  if array_length(parts,1) >= 3 then
    begin v := parts[2]::uuid; return v; exception when others then null; end;
  end if;
  -- عمق 2: الجزء الأول هو التذكرة
  if array_length(parts,1) >= 2 then
    begin v := parts[1]::uuid; return v; exception when others then null; end;
  end if;
  return null;
end $$;

grant execute on function public.storage_ticket_id(text) to authenticated;

do $$
begin
  -- مرفقات التذاكر: نفس حدّ التذكرة بالضبط
  drop policy if exists "tickets_read_own_or_staff" on storage.objects;
  create policy "tickets_read_own_or_staff" on storage.objects
    for select to authenticated
    using (
      bucket_id = 'tickets'
      and (
            public.is_platform_staff()
        or  (storage.foldername(name))[1] = auth.uid()::text
        or  public.can_access_ticket(public.storage_ticket_id(name))
      )
    );

  -- مرفقات المحادثة: صاحب المسار أو الطاقم
  drop policy if exists "chat_attachments_read_own_or_staff" on storage.objects;
  create policy "chat_attachments_read_own_or_staff" on storage.objects
    for select to authenticated
    using (
      bucket_id = 'chat-attachments'
      and ( public.is_platform_staff()
         or (storage.foldername(name))[1] = auth.uid()::text )
    );

  -- الصور الرمزية والأصول العامة والشعارات: عامة بطبيعتها، تبقى مقروءة
  drop policy if exists "public_assets_read" on storage.objects;
  create policy "public_assets_read" on storage.objects
    for select to authenticated, anon
    using (bucket_id in ('avatars','platform-assets','subdomain-logos'));
exception
  when insufficient_privilege then
    raise warning 'لا صلاحية لتعديل سياسات storage.objects بهذا الدور — طبّقها بدور مالك التخزين';
end $$;

-- ============================================================================
-- 4) ⛔ معطَّل — ترحيل البيانات: تخزين المسار بدل الرابط
-- ============================================================================
--
-- الحجم الحقيقي (قراءة من الإنتاج): **6 صفوف فقط** في ticket_attachments
-- تحمل رابطًا عامًّا، و3 صفوف أخرى تحمل رابط فاتورة (ليست تخزينًا). وصف واحد
-- في profiles.avatar_url. أي أن الترحيل صغير — الكلفة في الكود لا في البيانات.
--
-- لا يُفعَّل إلا بعد نشر كود الواجهة الذي يقرأ file_path ويوقّع الرابط.
--
-- alter table public.ticket_attachments add column if not exists file_path text;
--
-- update public.ticket_attachments
--    set file_path = regexp_replace(file_url, '^.*/object/public/tickets/', '')
--  where file_url like '%/object/public/tickets/%'
--    and file_path is null;
--
-- -- تحقق: كل صف مُرحَّل يقابله كائن فعلي في المستودع
-- do $$
-- declare v_missing int;
-- begin
--   select count(*) into v_missing
--     from public.ticket_attachments a
--    where a.file_path is not null
--      and not exists (select 1 from storage.objects o
--                       where o.bucket_id='tickets' and o.name = a.file_path);
--   if v_missing > 0 then
--     raise exception 'الترحيل توقف: % صفًّا يشير إلى ملف غير موجود', v_missing;
--   end if;
-- end $$;

-- ============================================================================
-- 5) ⛔ معطَّل — قلب المستودعات الحسّاسة إلى خاصة
-- ============================================================================
--
-- الخطوة الأخيرة، وبعدها لا يعمل أي رابط عام قديم. لا تُنفَّذ قبل:
--   (أ) القسم 3 مطبَّق  (ب) القسم 4 مطبَّق  (ج) الواجهة تستعمل createSignedUrl
--
-- update storage.buckets set public = false where id in ('tickets','chat-attachments');
--
-- الرجوع: update storage.buckets set public = true where id in ('tickets','chat-attachments');
-- (الرجوع فوري وبلا فقد بيانات — الملفات لا تتحرك في أي اتجاه.)

-- ============================================================================
-- 6) تحقق
-- ============================================================================
do $$
declare v int;
begin
  if to_regprocedure('public.can_access_ticket(uuid)') is null then
    raise exception 'can_access_ticket غير معرَّفة';
  end if;

  select count(*) into v from pg_policy pol
    join pg_class c on c.oid=pol.polrelid
   where c.relname='ticket_attachments'
     and pg_get_expr(pol.polqual,pol.polrelid) ~ 'can_access_ticket';
  if v < 1 then
    raise exception 'مرفقات التذاكر لا تستعمل التعريف الموحّد';
  end if;

  raise notice '028: حدّ الملف صار مطابقًا لحدّ التذكرة';
end $$;
