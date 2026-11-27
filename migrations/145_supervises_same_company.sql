-- ============================================================================
-- 145_supervises_same_company.sql
--   تضييق supervises() لنفس الشركة فقط (الخيار (ج) — قرار محمود 2026-11-26).
--
-- الخطر (مُثبَت حيًا 2026-11-26، قراءة فقط): فرع supervises موجود حرفيًا في
-- tickets_select_policy و profiles_select_policy وفي ticket_in_my_scope،
-- والعلاقة خام بلا أي قيد شركة (p.super_user_id = auth.uid()). الحاجز الوحيد
-- على التذاكر هو علم العزل company_isolation_enforced (مفعّل منذ 2026-10-21)،
-- وسياسة profiles بلا أي عزل إطلاقًا. التسريب غير قابل للتنفيذ اليوم (شركة
-- واحدة، 0 تذكرة scope='company'، 0 عضوية متعددة) — الإصلاح وقائي قبل أي
-- شركة ثانية، وقبل أي لحظة يُطفأ فيها العلم (حارس 101 نائم اليوم: 0 نقل مكتمل).
--
-- التصميم — تضييق على مستويين (تصحيح 2026-11-26 ~21:31 EET):
--   كان الافتراض الأول («فيرثه كل مستهلكيها بلا لمس السياسات») خاطئًا لمسار
--   RLS: supervises() محددة بالمستخدم لا بالتذكرة، فـ supervises(OA, A2)
--   يبقى true (عضوية A2 الأساسية في أ) وسياسة tickets_select_policy تمنح
--   على supervises(user_id) بلا أي مرجعية لشركة الصف نفسه — فأثبت اختبار
--   145 التسريب عبر SELECT المباشر والعلم مطفأ رغم عمل ticket_in_my_scope.
--   ① دالة داخلية جديدة _supervises_same_company(p_user_id): العضوية الأساسية
--      النشطة للعميل في شركة يملكها المنادي. بلا عضوية أساسية، أو بلا شركة
--      للمنادي، تفشل مغلقًا (NULL لا يطابق شيئًا).
--   ② supervises() نفسها تُعاد صياغتها بالشرط الجديد — فيرثه مستهلكوها
--      المحددون بالمستخدم: profiles_select_policy و is_owner_or_super_of
--      (أما مسارات التذاكر فتحتاج طبقة الصف نفسها — انظر ⑤ و⑥).
--   ③ ticket_in_my_scope: طبقة على التذكرة نفسها — فرع supervises لا يمرّ
--      على تذكرة شركة تابعة لشركة أخرى ولو كان صاحبها تابعًا للمنادي
--      بعضوية ثانوية؛ وتذكرة mad3oom_support (بلا شركة) تبقى كما كانت.
--   ④ can_access_ticket: فحص super_user_id الخام المضمّن فيها يُضيَّق بالدالة
--      الداخلية نفسها (نفس العلاقة، كان مكررًا خارج supervises).
--   ⑤ tickets_select_policy (نص 070 حرفيًا إلا فرع supervises): السماح عبر
--      supervises يمرّ من دالة داخلية جديدة _ticket_supervises_visible(
--      user_id, company_id) — supervises + (التذكرة بلا شركة أو شركتها
--      مملوكة للمنادي). الدالة SECURITY DEFINER (كـ supervises نفسها) فلا
--      يعيقها RLS على companies، وممنوحة لـ authenticated كـ supervises
--      لأن qual السياسة يُقيَّم بسياق المنادي (بلا المنح يفشل التقييم
--      بـ permission denied). بهذا يُغلق SELECT المباشر مع حفظ رؤية
--      مالك الوجهة لتذاكر mad3oom القديمة (company_id NULL) بعد النقل.
--   ⑥ can_access_ticket: فرع supervises فيها يُقيَّد بشركة التذكرة نفسها
--      (مضمّنًا، لا عبر الدالة الجديدة — عمدًا: بلا إطفاء المعاينة هنا كما
--      في 028/107، فالدالة الجديدة تمرّ من supervises وتطفئها). بهذا تُغلق
--      المرفقات عبر «Owner can view own ticket attachments» أيضًا.
--   مسارا الردود/المرفقات الآخران مغطيان أصلًا: ticket_replies_select_policy
--   و«Company scope can view ticket attachments» يمران من ticket_in_my_scope
--   (طبقة ③)، وcompany_team_select يمرّ من _company_ticket_access (098،
--   صلاحيات لا supervises).
--
-- ما يحفظه التضييق (ويثبته الاختبار):
--   • مالك الشركة يرى تذاكر وملفات عملاء شركته كما كان — بلا أي تغيير.
--   • بعد نقل عميل A→B: مالك الوجهة B يشرف عليه (عضويته الأساسية صارت B
--     و super_user_id صار مالك B)، فيرى تذاكره القديمة (mad3oom_support،
--     بلا شركة) ويعيد فتحها/يغلقها — والعلم مطفأ؛ ومالك المصدر A لا يراها.
--     (مع العلم مفعّلًا كانت هذه الرؤية مغلقة أصلًا ببوابة 107 وسياسات 097،
--     فالتضييق لا يغيّر شيئًا هناك — يثبته الاختبار أيضًا.)
--   • لوحة الشركة (RPCs: company_inbox_list و company_customers_list وغيرها)
--     والموظفون (_company_ticket_row_access) لا يمران من supervises، فلا
--     يعميهما التضييق.
--   • معاينة العضو (041): إطفاء preview_mode محفوظ حرفيًا.
--
-- ما لا يفعله:
--   • لا يجعل العزل غير مشروط (الخيار (ب)) — زر الإطفاء الطارئ يبقى، وهو
--     مكمل لاحق على التذاكر فقط بعد هذا الترحيل لا قبله.
--   • لا ينشئ سياسة tenant_isolation مستقلة على profiles: غير لازمة — سياسة
--     القراءة الوحيدة على profiles (040) لا تمنح قراءة عبر المستخدمين إلا
--     للنفس وللمُرتفع ولـ supervises، وقد ضُيّق الأخير. سياسة العزل كانت
--     ستكرر المنع نفسه بلا أي صف إضافي تحجبه.
--   • لا يمسّ العلم company_isolation_enforced ولا حارس 101 ولا مسار النقل.
--
-- حافة متبقية موثقة (لا يغلقها هذا الترحيل): عميل أساسي في A وثانوي في B وله
-- تذكرة شركة في B — مالك A ما زال يشرف على ملفه (عضويته الأساسية في A)،
-- لكنه لا يرى تذكرة B نفسها (طبقة ③) ولا ردودها/مرفقاتها (107 + 097 مع العلم
-- مفعّلًا). إغلاق رؤية الملف نفسها في هذه الحالة يتطلب تعريف «شركة العميل»
-- لكل صف لا لكل حساب، وهو خارج نطاق هذا الترحيل.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/145_supervises_same_company.down.sql
--   (يعيد تعريفات 041/107 وسياسة 070 حرفيًا — أي يعيد التسريب؛ يُستعمل فقط للتراجع الطارئ).
-- ============================================================================
do $$
begin
  if to_regprocedure('public.supervises(uuid)') is null then
    raise exception '145 يتطلب public.supervises(uuid) (040/041)';
  end if;
  if to_regprocedure('public.ticket_in_my_scope(uuid)') is null then
    raise exception '145 يتطلب public.ticket_in_my_scope(uuid) (033/107)';
  end if;
  if to_regprocedure('public.can_access_ticket(uuid)') is null then
    raise exception '145 يتطلب public.can_access_ticket(uuid) (028/107)';
  end if;
  if to_regclass('public.company_memberships') is null then
    raise exception '145 يتطلب public.company_memberships (096)';
  end if;
  if to_regclass('public.companies') is null then
    raise exception '145 يتطلب public.companies';
  end if;
end $$;


-- ============================================================================
-- 1) الدالة الداخلية: نفس الشركة — عضوية أساسية نشطة في شركة يملكها المنادي
-- ============================================================================
-- داخلية فقط: بلا منح لأي دور (مثل _ticket_customer_company في 097). تُستدعى
-- من دوال SECURITY DEFINER فتصل إلى company_memberships رغم ذلك.
create or replace function public._supervises_same_company(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from public.company_memberships m
      join public.companies c on c.id = m.company_id
     where m.user_id = p_user_id
       and m.status = 'active'
       and m.is_primary
       and c.user_id = auth.uid()
  );
$$;

comment on function public._supervises_same_company(uuid) is
  '145: هل العضوية الأساسية النشطة لهذا الحساب في شركة يملكها المنادي؟ '
  'بلا عضوية أساسية، أو بلا شركة للمنادي، تفشل مغلقًا (لا صف يطابق).';

revoke all on function public._supervises_same_company(uuid) from public, anon, authenticated;


-- ============================================================================
-- 1ب) الدالة الداخلية: إشراف على تذكرة — supervises + شركة الصف نفسه
-- ============================================================================
-- (تصحيح 2026-11-26): طبقة الصف لسياسة tickets_select_policy. SECURITY
-- DEFINER (كـ supervises) فيصل إلى companies رغم RLS عليها.
create or replace function public._ticket_supervises_visible(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.supervises(p_user_id)
     and (p_company_id is null
          or exists (select 1 from public.companies c
                      where c.id = p_company_id
                        and c.user_id = auth.uid()));
$$;

comment on function public._ticket_supervises_visible(uuid, uuid) is
  '145: هل يشرف المنادي على صاحب هذه التذكرة وفي شركته؟ supervises (نفس '
  'الشركة) + التذكرة بلا شركة (mad3oom_support) أو شركتها مملوكة للمنادي.';

-- تُستدعى من qual السياسة بسياق المستخدم المنادي (لا بسياق SECURITY DEFINER
-- كما في ticket_in_my_scope)، فيجب أن تكون ممنوحة التنفيذ لـ authenticated —
-- كـ supervises() نفسها. وهي SECURITY DEFINER بمسار مقفل، ولا تكشف أكثر مما
-- تكشفه supervises() الممنوحة أصلًا (نفس النتيجة لذات المدخلات).
revoke all on function public._ticket_supervises_visible(uuid, uuid) from public, anon;
grant execute on function public._ticket_supervises_visible(uuid, uuid) to authenticated;


-- ============================================================================
-- 2) supervises() — نفس التعريف من 041 + شرط الشركة الواحدة
-- ============================================================================
create or replace function public.supervises(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and not public.preview_mode()
     and exists (
           select 1 from public.profiles p
            where p.id = p_user_id
              and p.super_user_id = auth.uid()
         )
     -- 145: نفس الشركة فقط — العضوية الأساسية للعميل في شركة يملكها المنادي.
     and public._supervises_same_company(p_user_id);
$$;

comment on function public.supervises(uuid) is
  'هل المنادي مالك شركة هذا الحساب؟ تُطفأ داخل معاينة العضو (041)، وتقتصر '
  'من 145 على الشركة الواحدة: العضوية الأساسية للعميل في شركة يملكها المنادي.';

revoke all on function public.supervises(uuid) from public, anon;
grant execute on function public.supervises(uuid) to authenticated;


-- ============================================================================
-- 3) ticket_in_my_scope() — نص 107 + حارس شركة التذكرة على فرع supervises
-- ============================================================================
create or replace function public.ticket_in_my_scope(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (t.user_id = auth.uid()
                   or (public.supervises(t.user_id)
                       -- 145: تذكرة شركة تابعة لشركة أخرى لا تدخل نطاق المالك
                       -- ولو كان صاحبها تابعًا له بعضوية ثانوية؛ وتذكرة
                       -- mad3oom_support (بلا شركة) تبقى كما كانت.
                       and (t.company_id is null
                            or exists (select 1 from public.companies c
                                        where c.id = t.company_id
                                          and c.user_id = auth.uid()))))
         )
     -- 107: مع العزل، نفس قاعدة الظهور في 097 (لا تذكرة لعميل مع مدعوم عبر super_user_id)
     and (not public._isolation_on() or public._ticket_id_visible(p_ticket_id));
$function$;

revoke all on function public.ticket_in_my_scope(uuid) from public, anon;
grant execute on function public.ticket_in_my_scope(uuid) to authenticated;


-- ============================================================================
-- 4) can_access_ticket() — نص 107 مع تضييق فحص super_user_id الخام
-- ============================================================================
-- كان الفحص مضمّنًا (p.super_user_id = auth.uid()) بلا المرور من supervises،
-- فيفلت من التضييق ومن إطفاء المعاينة معًا. الآن يمرّ من الدالة الداخلية نفسها
-- (بلا إطفاء المعاينة هنا عمدًا: سلوك 028/107 في المعاينة بلا تغيير).
-- (تصحيح) ويُقيَّد بشركة التذكرة نفسها (NULL أو مملوكة للمنادي) — وإلا بقيت
-- المرفقات مفتوحة عبر «Owner can view own ticket attachments» والعلم مطفأ.
create or replace function public.can_access_ticket(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select p_ticket_id is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (
            t.user_id = auth.uid()
         or public.is_platform_staff()
         or (t.user_id in (select p.id from public.profiles p
                            where p.super_user_id = auth.uid()
                              and public._supervises_same_company(p.id))
             -- 145 (تصحيح): شركة التذكرة نفسها — بلا طبقتها يبقى وصول
             -- المرفقات عبر can_access_ticket مفتوحًا والعلم مطفأ.
             and (t.company_id is null
                  or exists (select 1 from public.companies c
                              where c.id = t.company_id
                                and c.user_id = auth.uid())))
       )
  )
  -- 107: مع العزل، نفس قاعدة الظهور في 097
  and (not public._isolation_on() or public._ticket_id_visible(p_ticket_id));
$function$;

revoke all on function public.can_access_ticket(uuid) from public, anon;
grant execute on function public.can_access_ticket(uuid) to authenticated;


-- ============================================================================
-- 5) tickets_select_policy — نص 070 حرفيًا إلا فرع supervises
-- ============================================================================
-- (تصحيح 2026-11-26): supervises() وحدها لا تغلق مسار RLS — السياسة تمنح
-- على supervises(user_id) بلا مرجعية لشركة الصف. الطبقة هنا في الدالة
-- الداخلية _ticket_supervises_visible (نفس نمط ticket_in_my_scope §3).
-- نص 070 محفوظ حرفيًا في الفروع الثلاثة الأخرى (is_admin() لا role='admin').
alter policy tickets_select_policy on public.tickets
  using (
    user_id = auth.uid()
    or public.has_elevated_authority()
    or public.is_admin()
    or public._ticket_supervises_visible(user_id, company_id)
  );


-- ============================================================================
-- 6) تحقّق بَعدي — التضييق مثبَّت في التعريفات نفسها، و041/107 محفوظان
-- ============================================================================
do $$
declare
  v_sup  text := pg_get_functiondef('public.supervises(uuid)'::regprocedure);
  v_scope text := pg_get_functiondef('public.ticket_in_my_scope(uuid)'::regprocedure);
  v_acc  text := pg_get_functiondef('public.can_access_ticket(uuid)'::regprocedure);
  v_pol  text := (select qual from pg_policies where schemaname = 'public' and tablename = 'tickets' and policyname = 'tickets_select_policy');
begin
  if v_sup not like '%_supervises_same_company%' then
    raise exception '145: شرط الشركة الواحدة غائب من supervises()';
  end if;
  if v_sup not like '%preview_mode%' then
    raise exception '145: إطفاء المعاينة (041) مفقود من supervises()';
  end if;
  if v_scope not like '%company_id is null%' then
    raise exception '145: حارس شركة التذكرة غائب من ticket_in_my_scope()';
  end if;
  if v_scope not like '%_ticket_id_visible%' then
    raise exception '145: بوابة 107 مفقودة من ticket_in_my_scope()';
  end if;
  if v_acc not like '%_supervises_same_company%' then
    raise exception '145: تضييق super_user_id غائب من can_access_ticket()';
  end if;
  if v_acc not like '%t.company_id is null%' then
    raise exception '145: طبقة شركة التذكرة غائبة من can_access_ticket()';
  end if;
  if v_acc not like '%_ticket_id_visible%' then
    raise exception '145: بوابة 107 مفقودة من can_access_ticket()';
  end if;
  if v_pol is null or v_pol not like '%_ticket_supervises_visible%' then
    raise exception '145: طبقة شركة التذكرة غائبة من tickets_select_policy';
  end if;
  if v_pol not like '%is_admin()%' then
    raise exception '145: نص 070 مفقود من tickets_select_policy (is_admin)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.supervises(uuid)'::regprocedure) then
    raise exception '145: supervises() لم تعد SECURITY DEFINER';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public._supervises_same_company(uuid)'::regprocedure) then
    raise exception '145: _supervises_same_company() ليست SECURITY DEFINER';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public._ticket_supervises_visible(uuid,uuid)'::regprocedure) then
    raise exception '145: _ticket_supervises_visible() ليست SECURITY DEFINER';
  end if;
  if (select provolatile from pg_proc where oid = 'public.supervises(uuid)'::regprocedure) <> 's' then
    raise exception '145: supervises() لم تعد STABLE';
  end if;
  if has_function_privilege('authenticated', 'public._supervises_same_company(uuid)', 'execute') then
    raise exception '145: _supervises_same_company() ممنوحة لـ authenticated — يجب أن تبقى داخلية';
  end if;
  if has_function_privilege('authenticated', 'public._ticket_supervises_visible(uuid,uuid)', 'execute') then
    raise notice '145 postflight: _ticket_supervises_visible() ممنوحة لـ authenticated كما يجب (تُستدعى من السياسة)';
  else
    raise exception '145: _ticket_supervises_visible() غير ممنوحة لـ authenticated — السياسة تستدعيها بسياق المنادي فيفشل التقييم';
  end if;
  raise notice '145 postflight: التضييق مثبَّت، و041/107 محفوظان';
end $$;
