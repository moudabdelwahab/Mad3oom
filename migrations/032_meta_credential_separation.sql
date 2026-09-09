-- 032_meta_credential_separation.sql
-- رمز Meta ليس بيانات اعتماد للمنصة
-- ============================================================================
--
-- الثغرة (V11)
--   `whatsapp-session` — دالة عامة (verify_jwt=off) — تصادق هكذا:
--       integrations.access_token == Bearer <ما أرسله المتصل>
--   أي أن **رمز Meta الخام للمستأجر هو مفتاح المنصة**. ثلاث مشاكل في واحدة:
--     1. الاعتماد مخزَّن ومقارَن **نصًّا صريحًا** (لا تجزئة).
--     2. لا نطاقات ولا حدّ معدّل ولا إبطال — بخلاف مسار مفاتيح المنصة الحقيقي.
--     3. الرمز نفسه يُستعمل بعدها لمخاطبة Meta، فخلط بين «من أنت» و«بم تتصرف».
--
-- لماذا هذا الإصلاح لا يحتاج معمارية جديدة
--   البنية الصحيحة **موجودة ومطبَّقة فعلًا** في هذا المشروع: `integration_api_keys`
--   فيها key_hash وscopes وstatus وexpires_at وrevoked_at وrotated_from،
--   وتستعملها `integrations-api` عبر integration_api_key_verify(). فالمطلوب ليس
--   بناء نظام مفاتيح، بل **الكفّ عن استعمال رمز Meta كبديل عنه**.
--
--   وأقلّ إصلاح آمن ممكن هو إفراغ العمود النصّي:
--     • يزيل اعتماد Meta الخام من التخزين (تعرّض ساكن حقيقي).
--     • ويُبطل مصادقة `whatsapp-session` **من جذرها**، لأن مصدر اعتمادها
--       الوحيد هو ذلك العمود. لا حاجة لنشر لإغلاق الثغرة.
--
-- هل يفقد أحد وظيفة؟ لا — تحقق قبل التنفيذ لا بعده
--   قُرئ على الإنتاج: 4 صفوف whatsapp، **الأربعة لديها encrypted_access_token**،
--   و**صفر صف نصّي فقط**. أي أن كل مستأجر يحتفظ باعتماده المشفَّر.
--   و`whatsapp-graph-request` كان بها المسار البديل النصّي الوحيد، وقد أُزيل
--   في نفس هذه الدفعة (تعليق TODO فيها كان يطلب إزالته عند اكتمال الترحيل).
--   و`whatsapp-session` بلا أي مستدعٍ في المستودع، ومكسورة بنيويًّا أصلًا:
--   تُدرج أربعة أعمدة غير موجودة في `public.messages`.
--
-- إجراء متمّم خارج القاعدة (لا يُنفَّذ هنا): **احذف `whatsapp-session` من
-- لوحة Supabase.** هذا الترحيل يجعلها عاجزة، وحذفها يزيلها.

-- ── حارس: لا نترك مستأجرًا بلا اعتماد ──────────────────────────────────────
do $$
declare v_orphan int;
begin
  select count(*) into v_orphan
    from public.integrations
   where access_token is not null
     and encrypted_access_token is null;

  if v_orphan > 0 then
    raise exception
      'توقف: % صفًّا يحمل رمزًا نصّيًا بلا نسخة مشفَّرة. إفراغ العمود كان سيقطع '
      'الخدمة عن هؤلاء المستأجرين. رحّلهم إلى encrypted_access_token أولًا.',
      v_orphan;
  end if;
end $$;

-- ── الإفراغ ────────────────────────────────────────────────────────────────
update public.integrations
   set access_token = null
 where access_token is not null;

-- ── تحقق ───────────────────────────────────────────────────────────────────
do $$
declare v_left int; v_enc int; v_total int;
begin
  select count(*),
         count(*) filter (where access_token is not null),
         count(*) filter (where encrypted_access_token is not null)
    into v_total, v_left, v_enc
    from public.integrations;

  if v_left > 0 then
    raise exception 'بقي % صفًّا يحمل رمز Meta نصًّا', v_left;
  end if;

  if v_enc <> v_total then
    raise exception 'خلل: % من % صفًّا بلا اعتماد مشفَّر بعد الإفراغ', v_total - v_enc, v_total;
  end if;

  raise notice '032: لا رمز Meta نصّي باقٍ (% صفًّا، كلها مشفَّرة)', v_total;
end $$;
