-- ============================================================================
-- 017_subscription_business_rules.sql
--   قواعد عمل الاشتراكات: الامتيازات مصدر القرار، ومنع الاشتراكات المتداخلة،
--   وفتح مسار إنشاء المستخدم الفرعي.
--
-- المشاكل التي عولجت هنا (كلها مُثبَتة من بيانات الإنتاج، لا افتراضات)
--
--   1) لا يوجد أي منع للاشتراكات المتداخلة.
--      createSubscriptionTicket بيمنع طلبًا "pending" مكررًا لنفس الباقة فقط.
--      النتيجة في الإنتاج فعليًا: مستخدم اشترى "الدعم الفني" منفردًا بينما
--      باقته الشاملة سارية وتشمله أصلًا — فدفع مقابل خدمة يملكها.
--      (ملاحظة: الصفّان bundle:active لنفس المستخدم ليسا تكرارًا، بل سلسلة
--      تجديد متتابعة غير متداخلة — الثاني يبدأ حين ينتهي الأول. لذلك لا يصلح
--      فهرس فريد على (user_id, plan) للحالة active: كان سيكسر كل تجديد مشروع.)
--      => القرار لازم يتبني على الامتيازات المملوكة فعلًا، مش على اسم الباقة.
--
--   2) مصدرا حقيقة متعارضان للامتيازات.
--      has_feature_access() بتقرأ customer_subscriptions (جدول فاضي تمامًا،
--      وغير مستخدَم من أي كود في المشروع)، بينما كل المنصة بتشتغل على
--      whatsapp_subscriptions. يعني الدالة دي كانت هترجّع false لأي عميل
--      مهما كان اشتراكه — لو حد بنى عليها قرارًا كان هيتناقض مع اللوحات.
--      => توحيد المصدر: whatsapp_subscriptions هو مصدر الحقيقة الوحيد
--         للاشتراك، وplan_features هو تعريف ما تمنحه كل باقة.
--
--   3) check_super_user_creation بيمنع تعديل super_user_id إلا للأدمن الرئيسي،
--      من غير استثناء لمفتاح الخدمة — عكس كل الحرّاس التانية في المشروع
--      (guard_profile_role_change / guard_profile_points_change /
--       guard_aqar_enabled / enforce_2fa_change_requires_challenge) اللي كلها
--      بتبدأ بـ IF auth.uid() IS NULL THEN RETURN NEW.
--      النتيجة: Edge Function المسؤولة عن إنشاء المستخدمين الفرعيين
--      (create-sub-user) مش قادرة تكتب العمود، فالميزة معطّلة بالكامل
--      (صفر صفوف في profiles.super_user_id في الإنتاج).
--      => إضافة نفس الاستثناء القياسي، مع الحفاظ على المنع للمستخدمين.
--
-- ما الذي لم يتغيّر
--   * مفيش جدول اشتراكات جديد ولا نظام صلاحيات جديد.
--   * مفيش سياسة RLS اتشالت أو اتعدلت.
--   * الاشتراكات القائمة المخالفة للقاعدة الجديدة لم تُلمَس: الحارس بيمنع
--     الجديد فقط، والتنظيف قرار إداري (مذكور في التقرير).
-- ============================================================================

-- ── 1) الامتيازات: مصدر القرار الوحيد ───────────────────────────────────────

-- ما الذي تمنحه باقة بعينها؟
create or replace function public.plan_feature_keys(p_plan_key text)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(array_agg(pf.feature_key order by pf.feature_key), '{}'::text[])
    from public.subscription_plans sp
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where sp.key = p_plan_key;
$function$;

comment on function public.plan_feature_keys(text) is
  'الامتيازات التي تمنحها باقة. تعريف الباقة بيانات في plan_features، لا شرط في الكود.';

-- ما الذي يملكه المستخدم فعلًا الآن؟ (اتحاد امتيازات كل اشتراكاته الفعّالة)
-- نفس تعريف الفعالية المستخدم في كل المنصة: status='active' AND end_date > now()
create or replace function public.owned_feature_keys(p_user_id uuid default auth.uid())
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where s.user_id = p_user_id
     and s.status = 'active'
     and s.end_date > now();
$function$;

comment on function public.owned_feature_keys(uuid) is
  'الامتيازات التي يملكها المستخدم فعليًا عبر اشتراكاته الفعّالة. مصدر الحقيقة الوحيد للإجابة على "هو بيملك إيه؟".';

revoke all on function public.plan_feature_keys(text) from public, anon;
revoke all on function public.owned_feature_keys(uuid) from public, anon;
grant execute on function public.plan_feature_keys(text) to authenticated;
grant execute on function public.owned_feature_keys(uuid) to authenticated;

-- توحيد has_feature_access على نفس المصدر.
-- التوقيع لم يتغيّر (الدالة غير مستخدَمة في أي كود حاليًا، لكن تركها تقرأ
-- جدولًا فاضيًا كان بيخليها قنبلة موقوتة: أول من يستخدمها يحصل على false دائمًا).
create or replace function public.has_feature_access(p_feature_key text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p_feature_key = any(public.owned_feature_keys(p_user_id)) or public.is_admin();
$function$;

comment on function public.has_feature_access(text, uuid) is
  'هل يملك المستخدم هذا الامتياز عبر اشتراك فعّال؟ موحّدة مع owned_feature_keys — كانت تقرأ customer_subscriptions الفارغ فترجع false دائمًا.';


-- ── 2) قاعدة شراء الاشتراك ──────────────────────────────────────────────────
-- القاعدة بالنص:
--   أ) تجديد نفس الباقة التي يملكها المستخدم فعلًا  → مسموح (تمديد).
--   ب) شراء نفس الباقة وهي فعّالة (وليس تجديدًا)     → ممنوع (استخدم التجديد).
--   ج) شراء باقة كل امتيازاتها مملوكة بالفعل        → ممنوع (لا تضيف شيئًا).
--   د) شراء باقة تضيف امتيازًا واحدًا على الأقل      → مسموح (ترقية حقيقية).
--
-- ولأن (ج) مبنية على الامتيازات لا على الأسماء، فهي تغطي تلقائيًا:
--   الباقة الشاملة فعّالة → شراء واتساب أو الدعم الفني ممنوع،
--   وواتساب + الدعم الفني فعّالان → شراء الباقة الشاملة ممنوع،
--   بدون أي قائمة أسماء مكتوبة في الكود. أي باقة جديدة تُعرَّف في
--   plan_features وتدخل القاعدة من غير تعديل سطر واحد.
create or replace function public.subscription_purchase_check(
  p_plan       text,
  p_is_renewal boolean default false,
  p_user_id    uuid default auth.uid()
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_offered      text[];
  v_owned        text[];
  v_missing      text[];
  v_same_active  boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'code', 'not_authenticated',
                              'reason', 'يجب تسجيل الدخول أولًا');
  end if;

  if not exists (select 1 from public.subscription_plans where key = p_plan and is_active) then
    return jsonb_build_object('allowed', false, 'code', 'unknown_plan',
                              'reason', 'باقة غير معروفة أو غير مفعّلة');
  end if;

  v_offered := public.plan_feature_keys(p_plan);
  v_owned   := public.owned_feature_keys(p_user_id);

  select exists (
    select 1 from public.whatsapp_subscriptions s
     where s.user_id = p_user_id and s.plan = p_plan
       and s.status = 'active' and s.end_date > now()
  ) into v_same_active;

  -- (أ) تجديد باقة فعّالة يملكها فعلًا
  if p_is_renewal then
    if v_same_active then
      return jsonb_build_object('allowed', true, 'code', 'renewal',
                                'reason', 'تجديد اشتراك قائم');
    end if;
    -- تجديد بلا اشتراك فعّال = اشتراك جديد، يخضع لبقية القواعد
  end if;

  -- (ب) نفس الباقة فعّالة وليس تجديدًا
  if v_same_active then
    return jsonb_build_object(
      'allowed', false, 'code', 'duplicate_plan',
      'reason', 'لديك اشتراك فعّال في هذه الباقة بالفعل. استخدم زر التجديد لتمديده.');
  end if;

  -- (ج/د) هل تضيف الباقة أي امتياز جديد؟
  select coalesce(array_agg(f), '{}'::text[]) into v_missing
    from unnest(v_offered) f where not (f = any(v_owned));

  if array_length(v_missing, 1) is null then
    return jsonb_build_object(
      'allowed', false, 'code', 'redundant',
      'reason', 'كل خدمات هذه الباقة متاحة لك بالفعل ضمن اشتراكك الحالي.',
      'owned_features', to_jsonb(v_owned));
  end if;

  return jsonb_build_object(
    'allowed', true, 'code', 'adds_features',
    'reason', 'الباقة تضيف خدمات جديدة',
    'new_features', to_jsonb(v_missing));
end;
$function$;

comment on function public.subscription_purchase_check(text, boolean, uuid) is
  'هل يُسمح بشراء هذه الباقة لهذا المستخدم؟ القرار مبني على الامتيازات المملوكة فعليًا لا على اسم الباقة. تستخدمها الواجهة للعرض والقاعدة للمنع.';

revoke all on function public.subscription_purchase_check(text, boolean, uuid) from public, anon;
grant execute on function public.subscription_purchase_check(text, boolean, uuid) to authenticated;


-- ── 3) فرض القاعدة في القاعدة نفسها ─────────────────────────────────────────
-- الواجهة بتستخدم نفس الدالة للعرض، لكن المنع الحقيقي هنا: أي طلب مباشر على
-- الـAPI بيعدي على الـtrigger ده.
-- الأدمن مستثنى عمدًا (تسوية يدوية مشروعة)، ولوحة الإدارة بتحذّره وتعرض
-- الامتيازات الفعلية قبل التنفيذ بدل ما تمنعه.
create or replace function public.enforce_subscription_purchase_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_check jsonb;
begin
  -- الحالات النهائية (مرفوض/منتهي) مش شراء
  if new.status is distinct from 'pending' and new.status is distinct from 'active' then
    return new;
  end if;

  -- بدون JWT = مفتاح خدمة أو مهمة خلفية؛ والأدمن له تسوية يدوية
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);

  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_subscription_purchase_rules on public.whatsapp_subscriptions;
create trigger trg_enforce_subscription_purchase_rules
  before insert on public.whatsapp_subscriptions
  for each row execute function public.enforce_subscription_purchase_rules();


-- ── 4) فتح مسار إنشاء المستخدم الفرعي ───────────────────────────────────────
-- الحارس القائم بيمنع تعديل super_user_id إلا للأدمن الرئيسي، وناسي استثناء
-- مفتاح الخدمة اللي كل الحرّاس التانية في المشروع بتبدأ بيه. النتيجة إن
-- create-sub-user (وهي المسار الشرعي الوحيد) مش قادرة تكتب العمود.
-- الاستثناء ده مايفتحش أي باب للمستخدمين: بدون JWT يعني مفتاح خدمة، وسياسات
-- RLS على profiles مابتسمحش لمجهول يعدّل أصلًا. وحارس الإدخال المضاف في
-- الترحيل 016 باقٍ كما هو.
create or replace function public.check_super_user_creation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
    -- استثناء مفتاح الخدمة/المهام الخلفية — نفس نمط باقي الحرّاس في المشروع
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.role = 'super_user' THEN
        IF NOT public.is_main_admin() THEN
            RAISE EXCEPTION 'فقط support@mad3oom.online يمكنه إنشاء أو تعيين حسابات سوبر يوزر';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.super_user_id IS DISTINCT FROM NEW.super_user_id AND NOT public.is_main_admin() THEN
             RAISE EXCEPTION 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;
