-- ============================================================================
-- 016_company_dashboard.sql
--   لوحة الشركة (Company Dashboard): كيان الشركة + ربطه بالاشتراكات + عزل كامل
--
-- ما الذي كان موجودًا بالفعل (تم إثباته بالفحص قبل كتابة أي سطر هنا)
--   * public.companies موجود فعلًا ومستخدَم في مسار تسجيل حساب "شركة"
--     (auth-user-types.js → signUpCompany). عليه RLS صحيح (كل مستخدم يرى صفه)
--     وقيد UNIQUE على user_id و على commercial_registration_number.
--     => الشركة مش كيان جديد نخترعه، هي موجودة وناقصها: تاريخ انتهاء السجل،
--        وربط بالاشتراك، ولوحة تعرضها.
--
--   * مصدر الحقيقة الفعلي للاشتراكات هو public.whatsapp_subscriptions
--     (بها بيانات إنتاج فعلية): plan ∈ (support, whatsapp, bundle)،
--     status ∈ (active, pending, expired, rejected)، end_date.
--     وعليها بالفعل expire_stale_subscriptions() المجدولة بـpg_cron كل ساعة.
--     => الاشتراك الفعّال = status='active' AND end_date > now(). مفيش منطق
--        صلاحية جديد هنا، بنقرأ نفس التعريف.
--
--   * طبقة الباقات العامة موجودة كذلك: subscription_plans (بها الصفوف الثلاثة
--     بنفس المفاتيح support/whatsapp/bundle) و plan_features و feature_flags.
--     plan_features.feature_key عليه FK إلى feature_flags(key).
--     => امتيازات الشركة بتتعرّف هنا كبيانات (INSERT)، مش كشرط في الكود.
--        إضافة باقة جديدة مستقبلًا = صف في subscription_plans + صفوف في
--        plan_features، بدون أي تعديل في كود اللوحة.
--
--   * تسلسل المستخدمين موجود: profiles.super_user_id (مستخدم فرعي تابع
--     لمستخدم رئيسي) ودالة is_owner_or_super_of().
--     => عضوية الشركة بتتشتق من نفس التسلسل — مفيش جدول أعضاء جديد ولا نظام
--        صلاحيات مواز.
--
-- ما الذي يضيفه هذا الترحيل
--   1) أعمدة على companies: تاريخ انتهاء السجل التجاري + حالة الشركة،
--      وتخفيف NOT NULL عن الحقول التشغيلية عشان الشركة تتكوّن من مسار
--      الاشتراك بالبيانات القانونية الأساسية فقط.
--   2) subscription_plans.requires_company: أي باقة تستوجب شركة — قرار بيانات
--      مش شرط مكتوب في الواجهة.
--   3) whatsapp_subscriptions.company_id: ربط الاشتراك بالشركة (nullable،
--      فمفيش أي كسر لصفوف أو مسارات قائمة).
--   4) دوال العزل والقراءة: current_company_id() و get_my_company_dashboard()
--      و company_has_feature() و upsert_my_company() و
--      link_subscription_to_my_company().
--   5) Trigger يمنع ربط اشتراك بشركة لا تخص المنادي (دفاع على مستوى القاعدة،
--      مش إخفاء في الواجهة).
--
-- ما الذي لم يتغيّر (متعمّد)
--   * مفيش سياسة RLS قديمة اتشالت أو اتعدلت — إضافة فقط.
--   * مفيش تغيير في سلوك الاشتراك الحالي ولا في expire_stale_subscriptions().
--   * customer_subscriptions لم يُكتب فيها شيء، فلوحة العميل تظل كما هي حرفيًا.
--   * الترحيل idempotent بالكامل (IF NOT EXISTS / ON CONFLICT / OR REPLACE)
--     وقابل للتطبيق على قاعدة البيانات الحالية بأمان.
-- ============================================================================

-- ── 1) كيان الشركة ──────────────────────────────────────────────────────────
-- تاريخ انتهاء السجل التجاري: بيتخزن كبيانات للشركة ويُعرض في اللوحة. مفيش
-- نظام تنبيهات ولا تجديد هنا — ده أساس البيانات فقط، زي المطلوب.
alter table public.companies
  add column if not exists commercial_registration_expiry date,
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_status_check') then
    alter table public.companies
      add constraint companies_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

-- مسار التسجيل القديم (signUpCompany) بيملأ كل الحقول دي، لكن مسار "إنشاء شركة
-- عند الاشتراك" بيطلب البيانات القانونية الأساسية فقط. تخفيف NOT NULL توسيع
-- للمسموح به، فمش بيكسر أي صف موجود ولا أي كود بيكتب القيم دي.
alter table public.companies alter column company_email drop not null;
alter table public.companies alter column company_phone drop not null;
alter table public.companies alter column address       drop not null;
alter table public.companies alter column city          drop not null;
alter table public.companies alter column country       drop not null;

comment on column public.companies.commercial_registration_expiry is
  'تاريخ انتهاء السجل التجاري/الترخيص. يُخزَّن للعرض والتحقق المستقبلي؛ لا يوجد نظام تنبيهات مرتبط به حاليًا.';
comment on column public.companies.status is
  'حالة الشركة داخل المنصة (active/suspended). لا تُشتق منها صلاحيات الاشتراك — الاشتراك هو مصدر الامتيازات.';


-- ── 2) أي باقة تستوجب وجود شركة؟ ────────────────────────────────────────────
-- بيانات مش كود: باقة جديدة تحدد بنفسها هل تحتاج شركة أم لا، والواجهة بتقرأ
-- العمود ده ولا تعرف أسماء الباقات.
alter table public.subscription_plans
  add column if not exists requires_company boolean not null default false;

update public.subscription_plans
   set requires_company = true
 where key in ('support', 'whatsapp', 'bundle')
   and requires_company is distinct from true;

comment on column public.subscription_plans.requires_company is
  'هل الاشتراك في هذه الباقة يستلزم كيان شركة؟ تقرأه واجهة الاشتراك لتطلب بيانات الشركة قبل إرسال الطلب.';


-- ── 3) ربط الاشتراك بالشركة ─────────────────────────────────────────────────
-- nullable + ON DELETE SET NULL: الاشتراك يظل قائمًا لو حُذفت الشركة، ولا
-- ينكسر أي صف من الصفوف الحالية (كلها هتفضل NULL).
alter table public.whatsapp_subscriptions
  add column if not exists company_id uuid references public.companies(id) on delete set null;

create index if not exists idx_whatsapp_subscriptions_company_id
  on public.whatsapp_subscriptions(company_id);

comment on column public.whatsapp_subscriptions.company_id is
  'الشركة المرتبطة بالاشتراك. NULL للاشتراكات الفردية أو الاشتراكات الأقدم من لوحة الشركة.';


-- ── 4) كتالوج امتيازات الباقات (بيانات) ─────────────────────────────────────
-- plan_features.feature_key عليه FK إلى feature_flags(key)، فأي مفتاح جديد
-- لازم يتسجل في feature_flags الأول. الصفوف دي بتوصف خدمات موجودة فعلًا في
-- المنصة، وبتتقرأ في لوحة الشركة فقط (fetchEntitlements في لوحة العميل غير
-- مستدعاة من أي مكان، فمفيش أثر على لوحة العميل).
insert into public.feature_flags (key, name, name_ar, description) values
  ('whatsapp_sender',    'WhatsApp Sender',      'إرسال رسائل واتساب',   'إرسال الرسائل والقوالب عبر واتساب بيزنس'),
  ('whatsapp_autoreply', 'WhatsApp Auto Reply',  'الردود التلقائية',     'بناء تدفقات الرد التلقائي على رسائل واتساب'),
  ('whatsapp_campaigns', 'WhatsApp Campaigns',   'الحملات الجماعية',     'إنشاء ومتابعة حملات الإرسال الجماعي وتقاريرها'),
  ('whatsapp_wallet',    'WhatsApp Wallet',      'رصيد الواتساب',        'متابعة رصيد استخدام خدمات واتساب وسجل عملياته'),
  ('support_tickets',    'Support Tickets',      'تذاكر الدعم الفني',    'فتح تذاكر الدعم الفني ومتابعتها'),
  ('priority_support',   'Priority Support',     'أولوية في الدعم',      'أولوية في زمن الاستجابة وفق أهداف الـSLA المعلنة'),
  ('sub_users',          'Sub Users',            'المستخدمون الفرعيون',  'إضافة مستخدمين فرعيين تابعين لحساب الشركة')
on conflict (key) do nothing;

-- ربط الامتيازات بالباقات. المفتاح المركّب (plan_id, feature_key) هو الـPK،
-- فالإدخال idempotent.
insert into public.plan_features (plan_id, feature_key, enabled)
select sp.id, f.feature_key, true
from public.subscription_plans sp
join (values
        ('whatsapp', 'whatsapp_sender'),
        ('whatsapp', 'whatsapp_autoreply'),
        ('whatsapp', 'whatsapp_campaigns'),
        ('whatsapp', 'whatsapp_wallet'),
        ('support',  'support_tickets'),
        ('support',  'priority_support'),
        ('support',  'sub_users'),
        ('support',  'api_tokens'),
        ('bundle',   'whatsapp_sender'),
        ('bundle',   'whatsapp_autoreply'),
        ('bundle',   'whatsapp_campaigns'),
        ('bundle',   'whatsapp_wallet'),
        ('bundle',   'support_tickets'),
        ('bundle',   'priority_support'),
        ('bundle',   'sub_users'),
        ('bundle',   'api_tokens'),
        ('bundle',   'mcp_client')
     ) as f(plan_key, feature_key) on f.plan_key = sp.key
on conflict (plan_id, feature_key) do nothing;


-- ── 5) عضوية الشركة والعزل ──────────────────────────────────────────────────
-- مفيش جدول أعضاء جديد: العضوية بتتشتق من التسلسل الموجود أصلًا في المنصة
--   * مالك الشركة  = companies.user_id
--   * عضو الشركة   = مستخدم فرعي (profiles.super_user_id) تابع للمالك
-- SECURITY DEFINER عشان الدالة تقدر تقرأ companies/profiles بدون ما تدخل في
-- تكرار لا نهائي مع سياسات RLS اللي بتستدعيها.
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select c.id
    from public.companies c
   where auth.uid() is not null
     and (
       c.user_id = auth.uid()
       or c.user_id = (select p.super_user_id from public.profiles p where p.id = auth.uid())
     )
   -- المالك أولًا لو حصل تداخل نظري بين الحالتين
   order by (c.user_id = auth.uid()) desc
   limit 1;
$function$;

comment on function public.current_company_id() is
  'معرّف شركة المستخدم الحالي (مالكًا أو مستخدمًا فرعيًا تابعًا للمالك)، أو NULL. أساس العزل بين الشركات.';

revoke all on function public.current_company_id() from public, anon;
grant execute on function public.current_company_id() to authenticated;

-- أعضاء الشركة (المستخدمون الفرعيون) يقرأون بيانات شركتهم. سياسة إضافية
-- بالكامل: سياسة المالك القديمة (user_id = auth.uid()) لم تُمس.
drop policy if exists "Company members can view their company" on public.companies;
create policy "Company members can view their company"
  on public.companies
  for select
  using (id = public.current_company_id());


-- ── 6) امتيازات الشركة من اشتراكاتها الفعّالة ───────────────────────────────
-- نفس تعريف "الاشتراك الفعّال" المستخدم في باقي المنصة حرفيًا:
--   status = 'active' AND end_date > now()
-- فانتهاء الاشتراك (يدويًا أو عبر expire_stale_subscriptions المجدولة) بيغيّر
-- امتيازات الشركة تلقائيًا بدون أي كود إضافي هنا.
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s
        on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.end_date > now()
       and pf.feature_key = p_feature_key
  );
$function$;

comment on function public.company_has_feature(text) is
  'هل تملك شركة المستخدم الحالي هذا الامتياز عبر اشتراك فعّال؟ لا تأخذ معرّف شركة كمُعامل عمدًا — لا يوجد ما يُلاعَب به.';

revoke all on function public.company_has_feature(text) from public, anon;
grant execute on function public.company_has_feature(text) to authenticated;


-- ── 7) قراءة لوحة الشركة كاملة في نداء واحد ─────────────────────────────────
-- الدالة **لا تأخذ معرّف شركة كمُعامل**. الشركة بتتحدد من auth.uid() جوه
-- الدالة نفسها، فمفيش أي وسيلة لمستخدم إنه يطلب بيانات شركة تانية بتغيير ID
-- في الطلب — العزل هنا خاصية في التوقيع نفسه، مش فحص ممكن يُنسى.
create or replace function public.get_my_company_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_company_id   uuid;
  v_company      public.companies%rowtype;
  v_active_plans text[];
  v_subs         jsonb;
  v_features     jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return null;
  end if;

  select * into v_company from public.companies where id = v_company_id;

  -- الاشتراكات المحسوبة على الشركة: المرتبطة بها صراحةً (company_id) أو
  -- اشتراكات مالكها. الشرط التاني بيخلي الشركة اللي اتعملت بعد اشتراك قائم
  -- تشوف اشتراكها من غير أي backfill.
  select coalesce(array_agg(distinct s.plan), '{}'::text[])
    into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active'
     and s.end_date > now();

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',             s.id,
               'plan',           s.plan,
               'plan_name_ar',   coalesce(sp.name_ar, sp.name, s.plan),
               'status',         s.status,
               'billing_cycle',  s.billing_cycle,
               'start_date',     s.start_date,
               'end_date',       s.end_date,
               'is_active',      (s.status = 'active' and s.end_date > now()),
               'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int
             ) order by s.end_date desc
           ),
           '[]'::jsonb
         )
    into v_subs
    from public.whatsapp_subscriptions s
    left join public.subscription_plans sp on sp.key = s.plan
   where (s.company_id = v_company_id or s.user_id = v_company.user_id);

  -- الامتيازات: اتحاد امتيازات كل الباقات الفعّالة، مع ذكر الباقة/الباقات
  -- اللي منحت كل امتياز. لو مفيش اشتراك فعّال بترجع قائمة فاضية.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'feature_key',  f.feature_key,
               'name_ar',      coalesce(ff.name_ar, ff.name, f.feature_key),
               'description',  coalesce(ff.description, ''),
               'limits',       f.limits,
               'granted_by',   f.plan_keys
             ) order by f.feature_key
           ),
           '[]'::jsonb
         )
    into v_features
    from (
      select pf.feature_key,
             jsonb_agg(distinct sp.key)   as plan_keys,
             (array_agg(pf.limits))[1]    as limits
        from public.subscription_plans sp
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where sp.key = any(v_active_plans)
       group by pf.feature_key
    ) f
    left join public.feature_flags ff on ff.key = f.feature_key;

  return jsonb_build_object(
    'company', jsonb_build_object(
      'id',            v_company.id,
      'name',          v_company.company_name,
      'cr_number',     v_company.commercial_registration_number,
      'cr_expiry',     v_company.commercial_registration_expiry,
      'status',        v_company.status,
      'email',         v_company.company_email,
      'phone',         v_company.company_phone,
      'address',       v_company.address,
      'city',          v_company.city,
      'country',       v_company.country,
      'website',       v_company.website,
      'industry',      v_company.industry,
      'tax_id',        v_company.tax_id,
      'created_at',    v_company.created_at,
      'is_owner',      (v_company.user_id = auth.uid())
    ),
    'registration', jsonb_build_object(
      'expiry_date',    v_company.commercial_registration_expiry,
      'is_expired',     (v_company.commercial_registration_expiry is not null
                          and v_company.commercial_registration_expiry < current_date),
      'days_to_expiry', case
                          when v_company.commercial_registration_expiry is null then null
                          else (v_company.commercial_registration_expiry - current_date)
                        end
    ),
    'subscriptions', v_subs,
    'entitlements',  v_features,
    'access', jsonb_build_object(
      'active_plans',           to_jsonb(v_active_plans),
      'has_active_subscription', (array_length(v_active_plans, 1) is not null)
    )
  );
end;
$function$;

comment on function public.get_my_company_dashboard() is
  'كل ما تعرضه لوحة الشركة في نداء واحد: بيانات الشركة + اشتراكاتها + امتيازاتها الفعّالة. بدون مُعاملات — الشركة تُشتق من auth.uid().';

revoke all on function public.get_my_company_dashboard() from public, anon;
grant execute on function public.get_my_company_dashboard() to authenticated;


-- ── 8) إنشاء/تحديث بيانات الشركة ────────────────────────────────────────────
-- نقطة دخول واحدة لمسار "اشتراك يحتاج شركة". بتكتب دايمًا على شركة المنادي
-- نفسه (auth.uid())، فمفيش مُعامل يحدد شركة الهدف — العزل مبني في التوقيع.
-- المستخدم الفرعي لا يملك تعديل بيانات الشركة (المالك فقط).
create or replace function public.upsert_my_company(
  p_company_name                   text,
  p_commercial_registration_number text,
  p_commercial_registration_expiry date,
  p_company_email                  text default null,
  p_company_phone                  text default null,
  p_address                        text default null,
  p_city                           text default null,
  p_country                        text default null,
  p_tax_id                         text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid        uuid := auth.uid();
  v_name       text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_cr         text := nullif(btrim(coalesce(p_commercial_registration_number, '')), '');
  v_existing   uuid;
  v_member_of  uuid;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'اسم الشركة مطلوب';
  end if;

  if v_cr is null or char_length(v_cr) < 3 then
    raise exception 'رقم السجل التجاري مطلوب';
  end if;

  if p_commercial_registration_expiry is null then
    raise exception 'تاريخ انتهاء السجل التجاري مطلوب';
  end if;

  select id into v_existing from public.companies where user_id = v_uid;

  if v_existing is null then
    -- عضو في شركة قائمة (مستخدم فرعي) لا ينشئ شركة موازية
    v_member_of := public.current_company_id();
    if v_member_of is not null then
      raise exception 'حسابك عضو في شركة قائمة بالفعل';
    end if;

    -- رقم السجل التجاري فريد على مستوى المنصة (قيد UNIQUE موجود أصلًا).
    -- الفحص هنا لإعطاء رسالة عربية واضحة بدل خطأ قاعدة بيانات خام.
    if exists (select 1 from public.companies where commercial_registration_number = v_cr) then
      raise exception 'رقم السجل التجاري مسجل بالفعل';
    end if;

    insert into public.companies (
      user_id, company_name, commercial_registration_number,
      commercial_registration_expiry, company_email, company_phone,
      address, city, country, tax_id
    ) values (
      v_uid, v_name, v_cr,
      p_commercial_registration_expiry, nullif(btrim(coalesce(p_company_email, '')), ''),
      nullif(btrim(coalesce(p_company_phone, '')), ''),
      nullif(btrim(coalesce(p_address, '')), ''),
      nullif(btrim(coalesce(p_city, '')), ''),
      nullif(btrim(coalesce(p_country, '')), ''),
      nullif(btrim(coalesce(p_tax_id, '')), '')
    )
    returning id into v_existing;

    return v_existing;
  end if;

  if exists (
    select 1 from public.companies
     where commercial_registration_number = v_cr and id <> v_existing
  ) then
    raise exception 'رقم السجل التجاري مسجل بالفعل';
  end if;

  update public.companies
     set company_name                   = v_name,
         commercial_registration_number = v_cr,
         commercial_registration_expiry = p_commercial_registration_expiry,
         company_email = coalesce(nullif(btrim(coalesce(p_company_email, '')), ''), company_email),
         company_phone = coalesce(nullif(btrim(coalesce(p_company_phone, '')), ''), company_phone),
         address       = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
         city          = coalesce(nullif(btrim(coalesce(p_city, '')), ''), city),
         country       = coalesce(nullif(btrim(coalesce(p_country, '')), ''), country),
         tax_id        = coalesce(nullif(btrim(coalesce(p_tax_id, '')), ''), tax_id)
   where id = v_existing;

  return v_existing;
end;
$function$;

comment on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) is
  'إنشاء أو تحديث شركة المستخدم الحالي. المالك فقط يعدّل؛ العضو الفرعي يُرفض. لا تأخذ معرّف شركة كمُعامل.';

revoke all on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) to authenticated;


-- ── 9) ربط اشتراك بشركة المنادي ─────────────────────────────────────────────
-- بتربط اشتراك **يخص المنادي** بشركة **المنادي**. الطرفان مشتقان من
-- auth.uid()، فمفيش تركيبة مُعاملات تربط اشتراك غيرك بشركة غيرك.
create or replace function public.link_subscription_to_my_company(p_subscription_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_updated    int;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return false;
  end if;

  update public.whatsapp_subscriptions
     set company_id = v_company_id,
         updated_at = now()
   where id = p_subscription_id
     and user_id = auth.uid()
     and company_id is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$;

comment on function public.link_subscription_to_my_company(uuid) is
  'تربط اشتراك المستخدم الحالي بشركته. لا تلمس اشتراكات الغير ولا تعيد ربط اشتراك مرتبط بالفعل.';

revoke all on function public.link_subscription_to_my_company(uuid) from public, anon;
grant execute on function public.link_subscription_to_my_company(uuid) to authenticated;


-- ── 10) منع ربط اشتراك بشركة لا تخص المنادي (دفاع في القاعدة) ───────────────
-- حتى لو اتوسعت سياسة INSERT/UPDATE على whatsapp_subscriptions غلط في
-- المستقبل، الـtrigger ده بيمنع كتابة company_id لشركة تانية من أي عميل
-- بيحمل JWT مستخدم. الخدمات الداخلية (service_role/pg_cron، بدون JWT)
-- والأدمن مستثنون لأن مسارات الإدارة والتفعيل بتشتغل بيهم.
create or replace function public.enforce_subscription_company_owner()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.company_id is null then
    return new;
  end if;

  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.company_id is distinct from public.current_company_id() then
    raise exception 'لا يمكن ربط الاشتراك بشركة لا تخص حسابك';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_subscription_company_owner on public.whatsapp_subscriptions;
create trigger trg_enforce_subscription_company_owner
  before insert or update of company_id on public.whatsapp_subscriptions
  for each row execute function public.enforce_subscription_company_owner();
