-- ============================================================================
-- 040_context_aware_authority.sql
--   نزع البريد من التفويض، وإدخال السياق كمُرشِّح على السلطة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما يُنزَع، ولماذا هو ثغرة لا مجرد أسلوب قديم
-- ════════════════════════════════════════════════════════════════════════════
--
-- خمس دوال كانت تقرأ **public.profiles.email** لتقرر السلطة:
--   is_admin() · is_support_user() · is_platform_staff() · is_admin_user()
--   · is_whatsapp_billing_admin()
--
-- والعمود قابل للكتابة من العميل — موثَّق في 027 بمحاولة فعلية انتهت
-- بـALLOWED، وبصفٍّ حقيقي في الإنتاج يحمل email='' بينما auth.users يحمل
-- عنوانًا صحيحًا. المانع الوحيد اليوم أن العنوانين محجوزان فيرتدّ التعارض
-- بخطأ مفتاح فريد لا بخطأ تفويض. **هذا حظّ لا حاجز.**
--
-- ولاحظ أن 027 كان قد شخّص هذا وكتب علاجه — لكن الفحص أثبت أن الإنتاج ما زال
-- يحمل النسخة ما قبل 027 (is_admin تقرأ profiles.email حتى اليوم). فهذا
-- الترحيل يُغلق الثغرة ويُطبّق ما لم يُطبَّق.
--
-- والبديل ليس بريدًا آخر بل **معرّف**: platform_authority المزروع في 039.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ثلاث قواعد تحكم كل سطر هنا
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① لا توسيع بالخطأ. كل مُسنَد يُعاد بنفس نطاقه السابق حرفيًا، ويُضاف إليه
--      فرع المالك وحده — مشروطًا بسياقه. من كان يمرّ يمرّ، ومن كان يُردّ يُردّ.
--
--   ② السياق مُرشِّح لا مصدر. فرع المالك يمرّ عبر owner_capability() دائمًا،
--      وهي تشترط الملكية **و** سماح السياق **و** العلاقة. فلا يفتح سياقٌ بابًا
--      لا يملكه صاحبه أصلًا.
--
--   ③ إعادة الاستخدام لا التكرار. التعديل في أجساد الدوال المركزية، فتلتقطه
--      76 سياسة بلا لمسها. ولا تُعاد كتابة سياسة إلا إن كانت تسمّي
--      is_main_admin صراحةً — وهي ثلاث عشرة.
--
-- ما لا يفعله هذا الترحيل
--   • لا يمنح أحدًا سلطة جديدة: الزرع تمّ في 039
--   • لا يغيّر رتبة أي مستخدم
--   • لا يقترب من emp_ops ولا من مسار تسجيل الدخول
-- ============================================================================

do $$
begin
  if to_regprocedure('public.owner_capability(text)') is null then
    raise exception 'يجب تطبيق migrations/038 أولًا';
  end if;
  if not exists (select 1 from public.platform_authority where level = 'owner') then
    raise exception 'يجب تطبيق migrations/039 أولًا — لا مالك مزروع، ونزع البريد الآن يُسقط صلاحيات قائمة';
  end if;
  if (select count(*) from public.platform_authority where level = 'elevated_admin') < 2 then
    raise exception 'الحسابان المرتفعان غير مزروعَين — 040 كان سيُسقط صلاحياتهما';
  end if;
end $$;


-- ============================================================================
-- 1) علاقة الإشراف كدالة — تمهيدًا لاحتواء المعاينة في 041
-- ============================================================================
--
-- أربع سياسات كانت تكتب الشرط `super_user_id = auth.uid()` سطرًا داخلها.
-- استخراجه إلى دالة لا يغيّر سلوكًا اليوم (المعادلة متطابقة حرفيًا)، لكنه
-- يجعل احتواء المعاينة في 041 تعديلًا في **موضع واحد** بدل أربع سياسات —
-- وكل سياسة لا تُعاد كتابتها هي سياسة لا يمكن أن تُكتب خطأً.
create or replace function public.supervises(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (
           select 1 from public.profiles p
            where p.id = p_user_id
              and p.super_user_id = auth.uid()
         );
$$;

comment on function public.supervises(uuid) is
  'هل المنادي هو مالك شركة هذا الحساب؟ علاقة خام. 041 يضيف إليها نزع '
  'الامتداد داخل معاينة العضو.';

revoke all on function public.supervises(uuid) from public, anon;
grant execute on function public.supervises(uuid) to authenticated;


-- ============================================================================
-- 2) دوال سلطة المنصة — بلا بريد، وبفرع مالك مشروط بالسياق
-- ============================================================================

-- ── is_admin ──────────────────────────────────────────────────────────────
-- قبل: role='admin' OR profiles.email IN (عنوانان)
-- بعد: role='admin' OR (مالك في سياق يسمح بالإدارة)
-- الحسابان المميّزان يحملان role='admin' في الإنتاج فعلًا، ففرع البريد كان
-- احتياطيًا بحتًا ونزعه لا يغيّر لهما شيئًا.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or public.owner_capability('admin');
$$;

comment on function public.is_admin() is
  'إدارة المنصة. لا تقرأ بريدًا. فرع المالك مشروط بسياق admin أو owner.';

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;


-- ── is_support_user ───────────────────────────────────────────────────────
-- قبل: profiles.email='support@…' OR role='admin'
-- بعد: role='admin' OR (مالك في سياق يسمح بالطاقم)
-- لاحظ ألا رتبة 'support' هنا: الدالة لم تكن تشملها، وإضافتها كانت ستوسّع
-- خمس سياسات بلا طلب. الاسم مضلّل تاريخيًا، والنطاق يبقى كما كان.
create or replace function public.is_support_user()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or public.owner_capability('staff');
$$;

revoke all on function public.is_support_user() from public, anon;
grant execute on function public.is_support_user() to authenticated;


-- ── is_platform_staff ─────────────────────────────────────────────────────
-- قبل: role IN (platform_owner, admin, support) OR profiles.email IN (عنوانان)
-- بعد: role IN (admin, support) OR (مالك في سياق يسمح بالطاقم)
--
-- سقوط 'platform_owner' من قائمة الرتب مقصود: الرتبة وحدها ما عادت تمنح.
-- المالك يمرّ من owner_capability التي تشترط صف السلطة والسياق معًا — فصارت
-- رتبة platform_owner المزروعة بلا صف سلطة **عديمة الأثر**، وهو المطلوب.
create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
           select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'support')
         )
      or public.owner_capability('staff');
$$;

comment on function public.is_platform_staff() is
  'سلطة على مستوى المنصة. أدوار الشركة ليست منها بأي حال، وتوسيعها لتشملها '
  'يكسر الفصل الأمني ويفشل اختبار company-roles.';

revoke all on function public.is_platform_staff() from public, anon;
grant execute on function public.is_platform_staff() to authenticated;


-- ── is_admin_user(uuid) ───────────────────────────────────────────────────
-- تسأل عن حساب آخر لا عن المنادي، فلا معنى لتقييدها بسياق **المنادي**.
-- البريد يُستبدَل بصف السلطة، والنطاق يبقى: الحسابان المرتفعان كانا يمرّان
-- بالبريد وبالرتبة معًا، ويمرّان الآن بالسلطة وبالرتبة.
create or replace function public.is_admin_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and (
       coalesce((select p.role = 'admin' from public.profiles p where p.id = p_user_id), false)
       or exists (
            select 1
              from public.platform_authority a
              join public.profiles p2 on p2.id = a.user_id
             where a.user_id = p_user_id
               and (   (a.level = 'owner'          and p2.role = 'platform_owner')
                    or (a.level = 'elevated_admin' and p2.role = 'admin') )
          )
     );
$$;

revoke all on function public.is_admin_user(uuid) from public, anon;
grant execute on function public.is_admin_user(uuid) to authenticated;


-- ── is_main_admin — يبقى الاسم، ويزول أساسه ──────────────────────────────
--
-- لم تُحذف الدالة عمدًا. المطلوب نزع **الأساس البريدي**، وقد زال. أما إبقاء
-- الرمز فشبكة أمان: أحد عشر موضعًا في القاعدة ينادونها، وقد يوجد في الكود
-- المنشور ما لم نره. حذفها كان سيحوّل أي نداء فاتنا إلى خطأ وقت التشغيل، أو
-- أسوأ: إلى مسار يُعاد كتابته على عجل. أما الغلاف فيُبقي كل مستدعٍ يعمل بنفس
-- المعنى تمامًا، من مصدر صريح.
create or replace function public.is_main_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.has_elevated_authority();
$$;

comment on function public.is_main_admin() is
  'مهجورة: غلاف لـhas_elevated_authority(). لا تقرأ بريدًا. لا تُستعمل في '
  'كود جديد — استعمل has_elevated_authority() أو is_platform_owner().';

revoke all on function public.is_main_admin() from public, anon;
grant execute on function public.is_main_admin() to authenticated;


-- ── has_elevated_authority — السلطة المرتفعة تخضع هي أيضًا للسياق ─────────
--
-- 038 عرّفها منحًا خامًّا لأن دوال السياق لم تكن قد وُجدت بعد في نفس الملف.
-- وتركها كذلك كان ثغرة حقيقية لا تفصيلة ترتيب: has_elevated_authority() تحرس
-- سياسة profiles_update_policy وحذفَ الحسابات وقراءةَ كل المحادثات. فلو ظلت
-- صادقة للمالك في **كل** سياق، لكان المالك داخل «معاينة عضو الشركة» قادرًا
-- على تعديل أي حساب في المنصة — وهو نقيض المعاينة، ونقض للقاعدة الحاكمة.
--
-- بعد هذا التعديل:
--   • حامل elevated_admin — لا سياق له أصلًا، فسلطته كما كانت بلا تغيير
--   • المالك — يملكها في سياق owner وحده، لا في admin ولا الشركة ولا العميل
create or replace function public.has_elevated_authority()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
           select 1
             from public.platform_authority a
             join public.profiles p on p.id = a.user_id
            where a.user_id = auth.uid()
              and a.level   = 'elevated_admin'
              and p.role    = 'admin'
         )
      or public.owner_capability('owner_only');
$$;

comment on function public.has_elevated_authority() is
  'السلطة المرتفعة بمنح صريح لا ببريد. المالك ينالها في سياق owner وحده — '
  'فالسياق يقيّد أعلى سلطة في النظام كما يقيّد أدناها.';

revoke all on function public.has_elevated_authority() from public, anon;
grant execute on function public.has_elevated_authority() to authenticated;


-- ============================================================================
-- 3) فوترة واتساب — مسار بريد ثالث كان حيًّا ولم يكن في الحسبان
-- ============================================================================
--
-- ما وجدناه:
--   is_whatsapp_billing_admin() = role='admin'
--                              OR profiles.email IN (select email from whatsapp_billing_admins)
--
-- أي أنها تقارن **العمود القابل للكتابة** بجدولٍ مفتاحه البريد. فمن كتب
-- profiles.email = 'support@mad3oom.online' نال صلاحية الفوترة. الجدول نفسه
-- يحمل صفًّا واحدًا، ومفتاحه بريد.
--
-- العلاج: عمود user_id يُملأ مرة واحدة من auth.users (محدِّد بيانات، لا آلية
-- تفويض)، ثم لا يُقرأ البريد بعدها أبدًا. عمود email يبقى للعرض والسجل.

alter table public.whatsapp_billing_admins
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

update public.whatsapp_billing_admins b
   set user_id = u.id
  from auth.users u
 where lower(u.email) = lower(b.email)
   and b.user_id is null;

create unique index if not exists whatsapp_billing_admins_user_id_key
  on public.whatsapp_billing_admins (user_id) where user_id is not null;

do $$
declare v_orphans int;
begin
  select count(*) into v_orphans from public.whatsapp_billing_admins where user_id is null;
  if v_orphans > 0 then
    raise warning '040: % صف في whatsapp_billing_admins بلا حساب مطابق — فقدت صلاحيتها بنزع البريد', v_orphans;
  end if;
end $$;

comment on column public.whatsapp_billing_admins.email is
  'للعرض والسجل فقط. التفويض يقرأ user_id وحده منذ 040.';

create or replace function public.is_whatsapp_billing_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or exists (select 1 from public.whatsapp_billing_admins b where b.user_id = auth.uid())
      or public.owner_capability('admin');
$$;

revoke all on function public.is_whatsapp_billing_admin() from public, anon;
grant execute on function public.is_whatsapp_billing_admin() to authenticated;


-- عضوية جدول الفوترة وحدها، بلا فرع الرتبة.
--
-- تلزم لأن واجهة واتساب تحرس تعديل طريقة الفوترة بحسابٍ **واحد بعينه**
-- (`profile.email === 'support@mad3oom.online'`)، لا بكل أدمن. ولو استبدلناها
-- بـis_whatsapp_billing_admin() لاتّسعت البوابة إلى ستة حسابات بلا طلب —
-- والمطلوب نقل المصدر من البريد إلى المعرّف، لا توسيع الصلاحية معه.
create or replace function public.in_whatsapp_billing_admins()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.whatsapp_billing_admins b where b.user_id = auth.uid());
$$;

comment on function public.in_whatsapp_billing_admins() is
  'عضوية جدول الفوترة بمعرّف الحساب. تحفظ بوابة الحساب الواحد في واجهة '
  'واتساب دون توسيعها إلى كل أدمن.';

revoke all on function public.in_whatsapp_billing_admins() from public, anon;
grant execute on function public.in_whatsapp_billing_admins() to authenticated;


-- ============================================================================
-- 4) أدوار الشركة — السياق يفتحها للمالك، والعلاقة تحدّ نطاقها
-- ============================================================================
--
-- عقيدة 035 تبقى كما هي: «الرتبة والعلاقة معًا». وكل ما يجري هنا تعميم شقّ
-- **الرتبة** ليصير «الرتبة أو سياق مُصرَّح به». أما شقّ **العلاقة** فيبقى
-- شرطًا مطلقًا لا يُخترق — ومنه يأتي أن سياق الشركة لا يفتح للمالك شركةً
-- لا يملكها: owner_capability('company_admin') تشترط owns_a_company() داخلها،
-- وهي تُقيَّم على auth.uid() وحده فلا معامل يوجّهها إلى شركة أخرى.

create or replace function public.is_company_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.owns_a_company(auth.uid())
     and (
           exists (select 1 from public.profiles p
                    where p.id = auth.uid() and p.role = 'company_admin')
           or public.owner_capability('company_admin')
         );
$$;

comment on function public.is_company_admin() is
  'مدير شركة = صف في companies باسمه **و** (الرتبة أو سياق مُصرَّح به). '
  'العلاقة شرط مطلق: لا يفتح أي سياق شركةً لا يملكها المنادي.';

revoke all on function public.is_company_admin() from public, anon;
grant execute on function public.is_company_admin() to authenticated;


-- ── عضو الشركة، ومعاينته ─────────────────────────────────────────────────
--
-- المالك ليس عضوًا في أي شركة ولا نجعله كذلك: لا super_user_id يُكتب له ولا
-- صف عضوية يُختلَق. الفرع الثاني **محاكاة** مشروطة بملكيته لشركته، ويقابله
-- في 041 نزعُ كل ما يمنحه إياه كونه مالكًا — فتصير المعاينة مجموعة جزئية من
-- صلاحيات العضو الحقيقي لا أوسع منها.
create or replace function public.is_company_member()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select (
           exists (select 1 from public.profiles p
                    where p.id = auth.uid() and p.role = 'company_user')
           and public.belongs_to_a_company(auth.uid())
         )
      or public.owner_capability('company_member');
$$;

comment on function public.is_company_member() is
  'عضو شركة حقيقي (رتبة وعلاقة)، أو مالك المنصة داخل معاينة العضو. '
  'لا يرث صلاحيات company_admin بحال.';

revoke all on function public.is_company_member() from public, anon;
grant execute on function public.is_company_member() to authenticated;


-- ── company_role للواجهة: يُبلّغ عن **السياق** لا عن الرتبة المخزَّنة ─────
-- مشتقّة من الدالتين أعلاه فتتبعهما تلقائيًا. تظل profiles.role كما هي
-- ('platform_owner')، ويظل هذا هو ما تعرضه لوحة الشركة — وهو المطلوب:
-- السياق يُعرَض، والهوية لا تتغير.


-- ============================================================================
-- 5) حارس الرتب — من يمنح ماذا، بعد زوال البريد
-- ============================================================================
--
-- إضافتان على الحارس القائم، وكلتاهما تضييق لا توسيع:
--
--   ① رتبة المالك **ثابتة**: لا تُغيَّر من أي جلسة، ولو جلسة حامل السلطة
--      المرتفعة. وهذا يمنع حالتين معًا — إقفال المالك خارج حسابه (فسلطته
--      تشترط الرتبة)، وخلعه بيد حساب أدنى منه.
--
--   ② منح رتبة 'platform_owner' للمالك وحده. وهي على أي حال **عديمة الأثر**
--      بلا صف في platform_authority، وهو ما لا تكتبه أي جلسة. فالتضييق هنا
--      طبقة ثانية فوق طبقة قائمة، لا الطبقة الوحيدة.
--
-- وما عدا ذلك يبقى حرفيًا: منح admin/support يتطلب سلطة مرتفعة — وهي نفس
-- من كان يملكه بالبريد قبل اليوم.

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;

  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;

  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;

  if new.role = 'platform_owner' and not public.is_platform_owner() then
    raise exception 'منح رتبة platform_owner لمالك المنصة وحده' using errcode = '42501';
  end if;

  if new.role in ('admin', 'support') and not public.has_elevated_authority() then
    raise exception 'منح رتبة % يتطلب سلطة مرتفعة', new.role using errcode = '42501';
  end if;

  if new.role in ('company_admin', 'company_user') then
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;


-- ============================================================================
-- 6) السياسات الثلاث عشرة التي تسمّي is_main_admin صراحةً
-- ============================================================================
--
-- محفوظة **حرفيًا** عدا استبدالين لا ثالث لهما:
--   is_main_admin()          → has_elevated_authority()
--   super_user_id = auth.uid() → supervises(...)   [نفس المعادلة، موضع واحد لـ041]
--
-- لا شرط يُضاف ولا يُحذف. ولمن يراجع: كل جملة أدناه قابلة للمقارنة سطرًا
-- بسطر بمخرج pg_policies قبل الترحيل.

-- ── profiles ──────────────────────────────────────────────────────────────
drop policy if exists profiles_select_policy on public.profiles;
create policy profiles_select_policy on public.profiles
  for select using (
    auth.uid() = id
    or public.has_elevated_authority()
    or public.supervises(id)
  );

drop policy if exists profiles_update_policy on public.profiles;
create policy profiles_update_policy on public.profiles
  for update using (
    auth.uid() = id
    or public.has_elevated_authority()
    or public.supervises(id)
  );

drop policy if exists profiles_delete_policy on public.profiles;
create policy profiles_delete_policy on public.profiles
  for delete using (public.has_elevated_authority());

-- ── notifications ─────────────────────────────────────────────────────────
drop policy if exists "Admins can read notifications" on public.notifications;
create policy "Admins can read notifications" on public.notifications
  for select using (public.has_elevated_authority());

-- ── chat_sessions ─────────────────────────────────────────────────────────
drop policy if exists chat_sessions_select_own_or_admin on public.chat_sessions;
create policy chat_sessions_select_own_or_admin on public.chat_sessions
  for select using (user_id = auth.uid() or public.has_elevated_authority());

drop policy if exists chat_sessions_insert_own on public.chat_sessions;
create policy chat_sessions_insert_own on public.chat_sessions
  for insert with check (user_id = auth.uid() or public.has_elevated_authority());

drop policy if exists chat_sessions_update_own_or_admin on public.chat_sessions;
create policy chat_sessions_update_own_or_admin on public.chat_sessions
  for update using (user_id = auth.uid() or public.has_elevated_authority());

-- ── chat_messages ─────────────────────────────────────────────────────────
drop policy if exists chat_messages_select_own_or_admin on public.chat_messages;
create policy chat_messages_select_own_or_admin on public.chat_messages
  for select using (
    public.has_elevated_authority()
    or sender_id = auth.uid()
    or session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid())
  );

drop policy if exists chat_messages_insert_own_or_admin on public.chat_messages;
create policy chat_messages_insert_own_or_admin on public.chat_messages
  for insert with check (
    public.has_elevated_authority()
    or (
      session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid())
      and (sender_id = auth.uid() or sender_id is null)
    )
  );

-- ── activity_logs ─────────────────────────────────────────────────────────
drop policy if exists activity_logs_select_policy on public.activity_logs;
create policy activity_logs_select_policy on public.activity_logs
  for select using (
    user_id = auth.uid()
    or public.has_elevated_authority()
    or (select p.role from public.profiles p where p.id = auth.uid()) = 'admin'
    or public.supervises(user_id)
  );

-- ── tickets ───────────────────────────────────────────────────────────────
drop policy if exists tickets_select_policy on public.tickets;
create policy tickets_select_policy on public.tickets
  for select using (
    user_id = auth.uid()
    or public.has_elevated_authority()
    or (select p.role from public.profiles p where p.id = auth.uid()) = 'admin'
    or public.supervises(user_id)
  );

-- ── ticket_replies ────────────────────────────────────────────────────────
drop policy if exists ticket_replies_select_policy on public.ticket_replies;
create policy ticket_replies_select_policy on public.ticket_replies
  for select using (
    public.has_elevated_authority()
    or (select p.role from public.profiles p where p.id = auth.uid()) = any (array['admin', 'support'])
    or (coalesce(is_internal, false) = false and public.ticket_in_my_scope(ticket_id))
  );

drop policy if exists "Users can add replies to their tickets" on public.ticket_replies;
create policy "Users can add replies to their tickets" on public.ticket_replies
  for insert with check (
    user_id = auth.uid()
    and (
      public.has_elevated_authority()
      or (select p.role from public.profiles p where p.id = auth.uid()) = 'admin'
      or public.ticket_in_my_scope(ticket_id)
    )
  );


-- ============================================================================
-- 7) تحقّق بَعدي — لا بريد بقي في أي مُسنَد تفويض
-- ============================================================================
do $$
declare
  v_fn   text;
  v_bad  text := '';
begin
  foreach v_fn in array array[
    'public.is_admin()', 'public.is_support_user()', 'public.is_platform_staff()',
    'public.is_main_admin()', 'public.is_whatsapp_billing_admin()',
    'public.is_platform_owner()', 'public.has_elevated_authority()'
  ] loop
    if pg_get_functiondef(v_fn::regprocedure) ~* '(profiles\.email|\.email\s+in|email\s*=\s*''|mad3oom\.online|mad3oom\.com)' then
      v_bad := v_bad || v_fn || ' ';
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 'ما زال البريد أساسًا للتفويض في: %', v_bad;
  end if;

  if pg_get_functiondef('public.is_admin_user(uuid)'::regprocedure) ~* '(mad3oom\.online|mad3oom\.com)' then
    raise exception 'is_admin_user ما زالت تحمل عناوين بريد محروقة';
  end if;

  raise notice '040 postflight: لا بريد في أي مُسنَد تفويض';
end $$;
