-- 029_entitlement_and_points_guard.sql
-- استحقاق المحادثة الآلية، وإزالة لغم تجاوز حارس النقاط
-- ============================================================================

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.owned_feature_keys(uuid)') is null then
    raise exception 'يجب تطبيق migrations/024 و 027 أولًا';
  end if;
end $$;

-- ============================================================================
-- 1) has_chatbot_entitlement — نزع الرتبة القديمة، بلا فقد وصول لأحد
-- ============================================================================
--
-- الحالة قبل: (whatsapp_enabled = true OR role IN ('super_user','admin'))
--   الفرع الأول كان يقرأ عمودًا **يكتبه المستخدم بنفسه** — أي أن أي عميل كان
--   يمنح نفسه ميزة مدفوعة بنداء واحد. أُغلق ذلك في 027 بقفل العمود.
--   والفرع الثاني يمنح الاستحقاق لمالك شركة بحكم رتبته لا بحكم اشتراكه.
--
-- قِيس على الإنتاج قبل التغيير — الصفوف الثمانية التي يعنيها الأمر:
--   الذاكرة المؤقتة (whatsapp_enabled) وسلسلة الاستحقاق (owned_feature_keys)
--   **متفقتان في كل صف، بلا استثناء واحد**. وصاحب الرتبة القديمة عنده اشتراك
--   فعّال يمنح whatsapp_sender فعلًا — فنزع فرع الرتبة لا يسحب وصوله.
--   والأدمن الخمسة يصلهم الاستحقاق من فرع الطاقم لا من الرتبة القديمة.
--
-- أي أن هذا التغيير **مقيس لا مقدَّر**: صفر صف يتغيّر نتيجته.

create or replace function public.has_chatbot_entitlement(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user_id
       and (whatsapp_enabled = true or role in ('admin','support'))
  );
$$;

revoke all on function public.has_chatbot_entitlement(uuid) from public, anon;
grant execute on function public.has_chatbot_entitlement(uuid) to authenticated;

-- ============================================================================
-- 2) حارس النقاط — لا يثق بعلَم، يتحقق من السلطة
-- ============================================================================
--
-- الحالة قبل: الحارس يمرّ إذا كان `app.bypass_profile_points_guard = 'on'`.
--
-- هل كان قابلًا للاستغلال من العميل؟ **لا** — أُثبت لا افتُرض:
--   • `set_config` في pg_catalog ولا غلاف لها في public، فليست نقطة RPC.
--   • الدالة الوحيدة المتاحة للعميل التي تضبط العلَم — approve_reward_report —
--     تتحقق من `role='admin'` في **أول سطر** قبل بلوغه. جُرّب بهوية عميل:
--     رُفض بـ«غير مصرح: هذا الإجراء متاح للأدمن فقط».
--   • العلَم transaction-local، وPostgREST معاملة لكل طلب، فلا يُضبط في طلب
--     ويُستغل في آخر. قُرئ داخل طلب عميل: «(unset)».
--
-- لماذا يُزال إذن: لأنه لغم لا ثغرة. لحظة أن تنسى دالة جديدة متاحة للعميل
-- فحص الصلاحية قبل ضبط العلَم، يصير سكّ نقاط. جُرّب بضبط العلَم قسرًا داخل
-- المعاملة: الكتابة مرّت (0 → 777777). الحارس يجب أن يسأل عن السلطة نفسها.
--
-- ولا يكسر شيئًا: approve_reward_report تشترط الأدمن أصلًا، فتمرّ من فرع
-- is_admin() بلا حاجة لأي علَم.

create or replace function public.guard_profile_points_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.points is not distinct from old.points then
    return new;
  end if;

  -- service_role أو مهمة خلفية
  if auth.uid() is null then
    return new;
  end if;

  -- السلطة تُسأل مباشرة، لا تُستنتج من علَم يضبطه المتصل
  if public.is_admin() then
    return new;
  end if;

  if auth.uid() = new.id then
    raise exception 'لا يمكنك تعديل نقاط حسابك بنفسك' using errcode = '42501';
  end if;

  return new;
end $$;

-- ============================================================================
-- 3) الحظر — أداة القراءة فقط. الإنفاذ يحتاج قرارًا خارج هذا الملف
-- ============================================================================
--
-- ما وُجد على الإنتاج:
--   • `profiles.ban_status` قيمته 'none' في **كل** الصفوف الـ27، وافتراضها 'none'.
--   • **لا دالة ولا سياسة واحدة في القاعدة تقرأ** ban_status أو is_locked أو ban_until.
--   • `auth.users.banned_until` فارغ في كل الصفوف — آلية الحظر الحقيقية غير مستعملة.
--   • لوحة الأدمن تكتب `{ status: 'banned' }` — و**لا يوجد عمود اسمه status**
--     في profiles (الاسم ban_status). أي أن زر الحظر يفشل بخطأ من PostgREST.
--   • بينما customer-dashboard.js و account-health.js و dashboard-logic.js
--     **تقرأ** ban_status وتعرضه.
--
-- الخلاصة: نظام الحظر **معطَّل بالكامل** — الكتابة تفشل، ولا شيء يُنفِّذ العلم
-- لو كُتب، والمستخدم «المحظور» يدخل ويستعمل كل الخدمات. ميزة عرض لا أكثر.
--
-- الدالة أدناه تُعرَّف ولا تُربط بأي سياسة عمدًا: ربطها بجداول الخدمة قرار
-- منتج (ما الذي يُمنع بالضبط؟) وليس إغلاق ثغرة مثبتة.

create or replace function public.is_banned(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select p.ban_status is not null
       and p.ban_status not in ('none','active')
       and (p.ban_until is null or p.ban_until > now())
      from public.profiles p where p.id = p_user_id
  ), false);
$$;

revoke all on function public.is_banned(uuid) from public, anon;
grant execute on function public.is_banned(uuid) to authenticated;

-- ============================================================================
-- 4) تحقق
-- ============================================================================
do $$
declare v text;
begin
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='has_chatbot_entitlement' limit 1) ~ '''super_user''' then
    raise exception 'has_chatbot_entitlement ما زالت تمنح الاستحقاق للرتبة القديمة';
  end if;

  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='guard_profile_points_change' limit 1) ~ 'app\.bypass' then
    raise exception 'حارس النقاط ما زال يثق بعلَم التجاوز';
  end if;

  raise notice '029: الاستحقاق من الاشتراك، والحارس من السلطة';
end $$;
