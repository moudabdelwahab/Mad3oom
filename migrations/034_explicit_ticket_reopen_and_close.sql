-- ============================================================================
-- 034_explicit_ticket_reopen_and_close.sql
--   الردّ فعل، وإعادة الفتح فعل آخر. ولا يجوز أن يُغني أحدهما عن الآخر.
--
-- ما الذي تغيّر في المنتج
--   كان الترحيل 012 يجعل ردّ صاحب التذكرة على تذكرة 'resolved' يعيد فتحها
--   **تلقائيًا**. القرار الجديد: الردّ لا يغيّر الحالة إطلاقًا، وإعادة الفتح
--   إجراء صريح بزرّ مستقل. السبب منتَجي: من يريد إضافة معلومة على تذكرة
--   مغلقة لا يريد بالضرورة إعادة فتحها لطابور الدعم، والعكس صحيح.
--
-- خلل حقيقي انكشف بالتحقق على قاعدة الإنتاج (لا بقراءة كود)
--   محاولة ردّ مالك شركة على تذكرة عميله ارتدّت بـ:
--     "غير مسموح للعميل بتعديل هذا الحقل في التذكرة"
--     CONTEXT: track_first_response() → UPDATE tickets SET first_response_at
--
--   السبب: track_first_response يحدّث التذكرة **بدون** بوابة التجاوز
--   app.bypass_ticket_restrictions، فيصطدم بالحارس
--   enforce_customer_ticket_update_restrictions الذي يرفض تغيير
--   first_response_at لغير الأدمن. وشرطه على الرتبة ('admin','super_user')
--   يجعله يشتعل تحديدًا لحساب الشركة — أي أن ردّ أي super_user على أي
--   تذكرة كان **مكسورًا دائمًا** على الإنتاج، والميزة الجديدة كشفته فقط.
--
--   ملاحظة على الاختبار: اختبار SQL السابق لم يلتقط هذا لأنه يحاكي السياسات
--   وحدها. الاختبار المرافق لهذا الترحيل يعيد بناء سلسلة المحفّزات كاملة.
--
-- المبدأ الأمني الحاكم
--   لا UPDATE على tickets يُمنَح لصاحب الشركة. الحارس أعلاه يقيّد الأعمدة
--   فقط حين auth.uid() = OLD.user_id — أي أنه لا يقيّد المالك، فمنحه UPDATE
--   كان سيسمح بتغيير user_id وتحويل مسار التذكرة. البديل هنا: دالتان
--   SECURITY DEFINER تكتبان **الحالة وحدها**، فملكية التذكرة غير قابلة
--   للمساس بها من هذا الطريق أصلًا.
--
-- النطاق مُعرَّف مرة واحدة: ticket_in_my_scope() من الترحيل 033.
-- بلا رتب جديدة، وبلا تغيير في المخطط: محفّزات ودوال فقط.
-- ============================================================================

-- ── 1) إصلاح track_first_response ──────────────────────────────────────────
--
-- تغييران:
--   • بوابة التجاوز حول التحديث النظامي — نفس النمط الذي أقرّه الترحيل 012
--     وتستعمله reopen_ticket_on_owner_reply و wf_update_ticket_status.
--   • تعريف «أول ردّ» صار **من ليس صاحب التذكرة**، بدل قائمة رتب جامدة.
--     القائمة القديمة ('admin','super_user') صارت خاطئة من طرفيها: super_user
--     لم تعد رتبة طاقم (الترحيل 024)، و support غائبة عنها رغم أنها الرتبة
--     التي تردّ فعلًا. والتعريف الجديد صحيح للمسارين معًا: ردّ مدعوم على
--     تذكرة الشركة، وردّ الشركة على تذكرة عميلها — كلاهما «أول استجابة».
create or replace function public.track_first_response()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner uuid;
begin
  if new.is_internal is true then
    return new;
  end if;

  select t.user_id into v_owner from public.tickets t where t.id = new.ticket_id;

  -- ردّ صاحب التذكرة على نفسه ليس استجابة
  if v_owner is null or new.user_id = v_owner then
    return new;
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set first_response_at = now()
   where id = new.ticket_id
     and first_response_at is null;

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return new;
end;
$function$;


-- ── 2) الردّ لم يعد يعيد الفتح ─────────────────────────────────────────────
--
-- المحفّز يُحذَف لا يُعطَّل: محفّز معطَّل يعود بالخطأ عند أي إعادة تفعيل،
-- والدالة تبقى موجودة كأثر ميت. إعادة الفتح صارت مسارًا واحدًا صريحًا أدناه.
drop trigger if exists trg_reopen_ticket_on_owner_reply on public.ticket_replies;
drop function if exists public.reopen_ticket_on_owner_reply();


-- ── 3) إعادة الفتح كإجراء صريح ─────────────────────────────────────────────
--
-- 'confirmed' و'rejected' مستثناتان عمدًا: هما نتيجتا قرار (شراء تم تأكيده /
-- طلب رُفض)، وإعادتهما إلى طابور الدعم بضغطة ليست إعادة فتح بل نقض قرار.
-- نفس الحد الذي أقرّه الترحيل 012 حرفيًا.
create or replace function public.reopen_ticket_in_my_scope(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولاً' using errcode = '42501';
  end if;

  -- النطاق: تذكرتي، أو تذكرة مستخدم تابع لي. لا مُعامل هوية هنا إطلاقًا،
  -- فلا سبيل لتوجيه الطلب إلى تذكرة خارج النطاق مهما عُدِّل.
  if not public.ticket_in_my_scope(p_ticket_id) then
    raise exception 'التذكرة غير موجودة أو خارج نطاق حسابك' using errcode = '42501';
  end if;

  select t.status into v_status from public.tickets t where t.id = p_ticket_id;

  if v_status <> 'resolved' then
    raise exception 'لا يمكن إعادة فتح تذكرة حالتها %', coalesce(v_status, 'غير معروفة')
      using errcode = '22023';
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set status           = 'open',
         reopen_count     = coalesce(reopen_count, 0) + 1,
         last_reopened_at = now(),
         resolved_at      = null,
         last_updated_by  = auth.uid(),
         last_updated_at  = now()
   where id = p_ticket_id
     and status = 'resolved';

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object('id', p_ticket_id, 'status', 'open');
end;
$function$;

comment on function public.reopen_ticket_in_my_scope(uuid) is
  'إعادة فتح تذكرة في نطاق المنادي. تكتب الحالة وحدها — ملكية التذكرة '
  'غير قابلة للمساس بها من هذا الطريق.';

revoke all on function public.reopen_ticket_in_my_scope(uuid) from public, anon;
grant execute on function public.reopen_ticket_in_my_scope(uuid) to authenticated;


-- ── 4) الإغلاق كإجراء صريح ─────────────────────────────────────────────────
create or replace function public.close_ticket_in_my_scope(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولاً' using errcode = '42501';
  end if;

  if not public.ticket_in_my_scope(p_ticket_id) then
    raise exception 'التذكرة غير موجودة أو خارج نطاق حسابك' using errcode = '42501';
  end if;

  select t.status into v_status from public.tickets t where t.id = p_ticket_id;

  if v_status not in ('open', 'in-progress') then
    raise exception 'التذكرة ليست مفتوحة لإغلاقها' using errcode = '22023';
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set status          = 'resolved',
         resolved_at     = now(),
         last_updated_by = auth.uid(),
         last_updated_at = now()
   where id = p_ticket_id
     and status in ('open', 'in-progress');

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object('id', p_ticket_id, 'status', 'resolved');
end;
$function$;

comment on function public.close_ticket_in_my_scope(uuid) is
  'إغلاق تذكرة في نطاق المنادي (open/in-progress ← resolved). الحالة وحدها.';

revoke all on function public.close_ticket_in_my_scope(uuid) from public, anon;
grant execute on function public.close_ticket_in_my_scope(uuid) to authenticated;


-- ── 5) تحقّق ذاتي بعد التطبيق ──────────────────────────────────────────────
do $$
begin
  if exists (
       select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'ticket_replies'
          and t.tgname = 'trg_reopen_ticket_on_owner_reply'
     ) then
    raise exception 'الردّ ما زال يعيد فتح التذكرة تلقائيًا';
  end if;

  if not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'reopen_ticket_in_my_scope' and p.prosecdef
     ) then
    raise exception 'دالة إعادة الفتح الصريحة غير موجودة';
  end if;

  if not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'close_ticket_in_my_scope' and p.prosecdef
     ) then
    raise exception 'دالة الإغلاق الصريحة غير موجودة';
  end if;

  raise notice 'OK 034: الردّ فعل، وإعادة الفتح والإغلاق فعلان صريحان';
end $$;
