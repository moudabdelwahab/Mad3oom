-- 031_pi_auth_credential_closure.sql
-- إغلاق مسار كلمة المرور المشتقة لحسابات Pi
-- ============================================================================
--
-- الثغرة
--   `pi-auth` كانت تشتق كلمة المرور من **معرّف Pi**، والبريد من نفس المعرّف.
--   ومعرّف Pi ليس سرًّا. فمن عرفه ملك الزوج كاملًا وسجّل الدخول من **نقطة
--   المصادقة العادية**، متخطّيًا التحقق من Pi بالكامل لأنه ليس على ذلك المسار.
--
-- لماذا لا يكفي إصلاح الدالة وحدها
--   الدالة المصلَحة تغلق المسار للحسابات التي **تدخل بعد النشر** فقط. الحسابات
--   القائمة تحتفظ بكلمة المرور المشتقة إلى أن تدخل. وقُرئ على الإنتاج:
--   **حسابان، وكلاهما يحمل كلمة مرور صالحة** — أي أن الزوج المشتق حيّ لهما الآن.
--   هذا الترحيل يقتله فورًا دون انتظار.
--
-- ماذا يفعل بالضبط
--   يجعل حسابات Pi **بلا كلمة مرور**، وهو التمثيل المعتاد في Supabase لحساب
--   لا يسجّل الدخول بكلمة مرور (حسابات OAuth كذلك). النتيجة: signInWithPassword
--   يفشل لها نهائيًّا، ويبقى المسار المشروع الوحيد: توكن Pi ← magiclink.
--
-- هل يفقد مستخدم شرعي وصوله؟ لا.
--   مستخدم Pi لا يملك كلمة مرور يعرفها أصلًا (كانت مشتقة، لم تُعرض له قط)،
--   ولا يستعملها: تطبيق Pi ينادي pi-auth. المسار الشرعي لا يمرّ بكلمة مرور.
--
-- الرجوع: لا رجوع مطلوب — استعادة كلمة مرور مشتقة تعني إعادة فتح الثغرة.
--   الحساب يبقى كاملًا (نفس المعرّف، نفس البيانات، نفس الاشتراكات).

-- ── حارس: لا نلمس حسابًا يملك وسيلة دخول أخرى ─────────────────────────────
do $$
declare v_risky int;
begin
  select count(*) into v_risky
    from auth.users u
   where (u.email like 'pi\_%@pi.network' or u.raw_user_meta_data->>'pi_uid' is not null)
     and exists (
       select 1 from auth.identities i
        where i.user_id = u.id and i.provider <> 'email'
     );

  if v_risky > 0 then
    raise exception
      'توقف: % حساب Pi يملك هوية دخول أخرى (OAuth). راجعها يدويًا قبل إبطال كلمة المرور.',
      v_risky;
  end if;
end $$;

-- ── الإبطال ────────────────────────────────────────────────────────────────
update auth.users u
   set encrypted_password = null
 where (u.email like 'pi\_%@pi.network' or u.raw_user_meta_data->>'pi_uid' is not null)
   and u.encrypted_password is not null;

-- ── تحقق ───────────────────────────────────────────────────────────────────
do $$
declare v_left int; v_total int;
begin
  select count(*) into v_total from auth.users u
   where u.email like 'pi\_%@pi.network' or u.raw_user_meta_data->>'pi_uid' is not null;

  select count(*) into v_left from auth.users u
   where (u.email like 'pi\_%@pi.network' or u.raw_user_meta_data->>'pi_uid' is not null)
     and u.encrypted_password is not null
     and u.encrypted_password <> '';

  if v_left > 0 then
    raise exception '% من % حساب Pi ما زال يحمل كلمة مرور صالحة', v_left, v_total;
  end if;

  raise notice '031: % حساب Pi بلا كلمة مرور — المسار المشتق مغلق', v_total;
end $$;
