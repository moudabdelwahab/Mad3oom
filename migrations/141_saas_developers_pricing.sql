-- ============================================================================
-- 141_saas_developers_pricing.sql
--   مجموعة «المطوّرون والأسعار»: ثلاثة أجزاء مستقلة، بلا أي تغيير سعر.
--
--   ① Webhooks للشركة (جديد كليًا — لا يوجد أي جدول أو دالة Webhooks صادرة
--      للشركة قبل هذا الترحيل):
--      ihub_webhook_events الموجود (088) صندوق أحداث *واردة* من مزودي
--      التكاملات (دفترة/سلة/...) إلى المنصة، لا Webhooks تصدرها الشركة إلى
--      أنظمتها. فأُنشئ هنا:
--        • company_webhooks: وجهة URL + الأحداث المشترَك فيها + سرّ توقيع.
--        • company_webhook_deliveries: سجل محاولات التسليم الفعلية فقط.
--      السرّ يُخزَّن قيمةً لا بصمة، لأن المُرسِل يحتاجه ليوقّع الحمولة
--      (HMAC) عند التسليم — والبصمة لا تكفي للتوقيع. لذلك لا يملك أي دور
--      عميل SELECT على الجدول إطلاقًا (RLS مفعّلة بلا سياسات، وكل المنح
--      مسحوبة من anon/authenticated): السرّ لا يعود إلا مرة واحدة في ردّ
--      الإنشاء أو التدوير، تمامًا كسرّ مفتاح API. دوال الإدارة
--      SECURITY DEFINER وتتحقق أن المنادي مدير الشركة نفسها
--      (is_company_admin + company_of)، فمعرّف شركة أخرى لا يفتح شيئًا.
--      التسليم الفعلي عبر HTTP *ليس* جزءًا من هذا الترحيل: لا يوجد عامل
--      (worker) يتصل بالوجهات بعد، ودالة company_webhook_enqueue هي
--      نقطة الربط التي ستناديها المحفّزات/العامل لاحقًا (service_role
--      فقط). سجل التسليم يبقى فارغًا حتى تحدث محاولة حقيقية — لا صفوف
--      وهمية ولا «تسليم تجريبي» يُختلَق.
--      الأحداث الستة المسموحة هي أحداث موجودة فعلًا في نطاق المنصة
--      (تذاكر/عملاء/اشتراكات)، والقيد يمنع الاشتراك في غيرها.
--
--   ② ساندبوكس API: عمود api_tokens.environment ('live' | 'test'،
--      الافتراضي 'live'). مفتاح الاختبار يُصدره create-api-token ببادئة
--      مميزة (mad3oom_pk_test_ / mad3oom_bt_test_) ويُرفَض من
--      verifyApiToken على كل نقطة حية — فلا يصل إلى بيانات حية أبدًا.
--      هذا ساندبوكس API فقط، وليس بيئة تجريبية للتجربة المجانية، والنص
--      في الواجهة يقول ذلك صراحة. الترحيل نفسه لا يصدر أي مفتاح.
--
--   ③ الأسعار — واتساب مشمول في الخطة الفائقة (Ultimate) حتى إشعار آخر:
--      تُضاف مفاتيح واتساب الأربعة (whatsapp_sender, whatsapp_autoreply,
--      whatsapp_campaigns, whatsapp_wallet) إلى plan_features للفائقة،
--      بلا أي تغيير سعر: الفائقة 1999/19999، واتساب 1299/12999، الشاملة
--      2099/22999 كما هي، والتحقق الذاتي أدناه يرفع خطأً إن تغيّر أي منها.
--      الأثر الدقيق على subscription_upgrade_quote (019): العرض يقارن
--      مزايا الهدف بما يملكه المشترك (owned_feature_keys = اتحاد
--      اشتراكاته الفعّالة). قبل هذا الترحيل كان عرض الترقية لمالك
--      «المتقدمة» وحده يسمّي unlimited_tickets وحده ضمن المضاف، فبدت
--      الفائقة كأنها لا تشمل واتساب إطلاقًا؛ وبعدها صارت مزاياه المضافة
--      تشمل مفاتيح واتساب الأربعة، فالفائقة توحّد فعلًا اشتراكَي
--      «المتقدمة + واتساب» (999 + 1299) في اشتراك واحد أرخص منهما معًا.
--      وحدّ موثّق في tests/sql/saas-developers-pricing.test.sql: مالك
--      «الشاملة» وحده يبقى عرضه للفائقة redundant — مجموعتا المزايا
--      متطابقتان حرفيًا بعد هذا الترحيل (10 = 10)، والفائقة أرخص أصلًا
--      (1999 < 2099) فليست ترقية بحال؛ فلا يقلب هذا الترحيل أي مسار من
--      redundant إلى مؤهل، بل يصحّح ما يسمّيه العرض ضمن المضاف.
--      خطتا واتساب المستقلتان تبقيان مخفيتين من البيع كما هما
--      (SALE_PLAN_KEYS في plan-pricing-model.js لا تشملهما) — لا يمسّ
--      هذا الترحيل is_active لأي خطة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/141_down.sql
-- ============================================================================

begin;

-- ══════════════════════════════════════════════════════════════════════════
-- ① Webhooks للشركة
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.company_webhooks (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  user_id               uuid not null,
  name                  text not null check (char_length(btrim(name)) between 1 and 80),
  url                   text not null check (url like 'https://%'),
  events                text[] not null default '{}'::text[]
                          check (cardinality(events) > 0
                            and events <@ array['ticket.created', 'ticket.replied', 'ticket.closed',
                                               'customer.created', 'subscription.renewed',
                                               'subscription.upgraded']::text[]),
  secret                text not null,
  is_active             boolean not null default true,
  deliveries_count      integer not null default 0 check (deliveries_count >= 0),
  failed_count          integer not null default 0 check (failed_count >= 0),
  last_delivery_at      timestamptz,
  last_delivery_status  text check (last_delivery_status is null
                            or last_delivery_status in ('sent', 'failed', 'pending')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.company_webhooks is
  'وجهات Webhooks الصادرة التي تديرها الشركة من لوحتها (141). السرّ قيمة لا بصمة لأنه يُستخدم في توقيع الحمولة عند التسليم؛ لا SELECT لأي دور عميل، ويعود مرة واحدة عند الإنشاء أو التدوير فقط.';
comment on column public.company_webhooks.secret is
  'سرّ توقيع الحمولة (HMAC). لا يُقرأ من الواجهة أبدًا بعد لحظة الإنشاء/التدوير.';

create table if not exists public.company_webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  webhook_id      uuid not null references public.company_webhooks(id) on delete cascade,
  company_id      uuid not null references public.companies(id) on delete cascade,
  event           text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  response_status integer,
  response_body   text,
  next_attempt_at timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);
comment on table public.company_webhook_deliveries is
  'سجل محاولات تسليم Webhooks الفعلية فقط (141). بلا عامل تسليم بعد — الصفوف تُنشأ عبر company_webhook_enqueue من المحفّزات/العامل لاحقًا، فالسجل الفارغ حالة صحيحة لا نقص.';
create index if not exists company_webhook_deliveries_webhook_idx
  on public.company_webhook_deliveries (webhook_id, created_at desc);
create index if not exists company_webhook_deliveries_pending_idx
  on public.company_webhook_deliveries (next_attempt_at) where status = 'pending';

-- بلا أي سياسة قراءة/كتابة مباشرة: الوصول عبر دوال 141 وحدها.
alter table public.company_webhooks enable row level security;
alter table public.company_webhook_deliveries enable row level security;
revoke all on public.company_webhooks from public, anon, authenticated;
revoke all on public.company_webhook_deliveries from public, anon, authenticated;
grant all on public.company_webhooks to service_role;
grant all on public.company_webhook_deliveries to service_role;

-- ── البوابة: مدير هذه الشركة نفسها ───────────────────────────────────────
create or replace function public.company_webhook_scope(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_company_id is not null
     and auth.uid() is not null
     and public.is_company_admin()
     and public.company_of(auth.uid()) = p_company_id;
$$;
comment on function public.company_webhook_scope(uuid) is
  '141: المنادي مدير الشركة المطلوبة نفسها (الرتبة والعلاقة). منصة الإدارة تتصرف عبر service_role لا عبر هذه الدوال.';
revoke all on function public.company_webhook_scope(uuid) from public, anon;
grant execute on function public.company_webhook_scope(uuid) to authenticated;

-- ── عرض webhook بلا سرّ — الشكل الوحيد الذي يعود للقوائم ────────────────
create or replace function public.company_webhook_json(p_row public.company_webhooks)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'company_id', p_row.company_id,
    'name', p_row.name,
    'url', p_row.url,
    'events', to_jsonb(coalesce(p_row.events, '{}'::text[])),
    'is_active', p_row.is_active,
    'deliveries_count', p_row.deliveries_count,
    'failed_count', p_row.failed_count,
    'last_delivery_at', p_row.last_delivery_at,
    'last_delivery_status', p_row.last_delivery_status,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at
  );
$$;
revoke all on function public.company_webhook_json(public.company_webhooks) from public, anon;
grant execute on function public.company_webhook_json(public.company_webhooks) to authenticated;

create or replace function public.company_webhook_create(
  p_company_id uuid, p_name text, p_url text, p_events text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_name   text := btrim(coalesce(p_name, ''));
  v_url    text := btrim(coalesce(p_url, ''));
  v_events text[] := coalesce(p_events, '{}'::text[]);
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_row    public.company_webhooks;
begin
  if not public.company_webhook_scope(p_company_id) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'اسم الـWebhook بين حرف و80 حرفًا' using errcode = '22023';
  end if;
  if v_url not like 'https://%' or char_length(v_url) > 2048 then
    raise exception 'رابط الـWebhook يجب أن يبدأ بـ https://' using errcode = '22023';
  end if;
  if cardinality(v_events) = 0
     or not (v_events <@ array['ticket.created', 'ticket.replied', 'ticket.closed',
                              'customer.created', 'subscription.renewed',
                              'subscription.upgraded']::text[]) then
    raise exception 'اختر حدثًا واحدًا على الأقل من الأحداث المتاحة' using errcode = '22023';
  end if;

  insert into public.company_webhooks (company_id, user_id, name, url, events, secret)
  values (p_company_id, auth.uid(), v_name, v_url, v_events, v_secret)
  returning * into v_row;

  -- السرّ يعود هنا مرة واحدة فقط؛ القوائم لا تعيده أبدًا.
  return public.company_webhook_json(v_row) || jsonb_build_object('secret', v_secret);
end;
$$;
comment on function public.company_webhook_create(uuid, text, text, text[]) is
  '141: إنشاء Webhook لشركة المنادي. السرّ في الرد مرة واحدة فقط.';

create or replace function public.company_webhook_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.company_webhook_scope(p_company_id) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(public.company_webhook_json(w) order by w.created_at desc)
      from public.company_webhooks w where w.company_id = p_company_id
  ), '[]'::jsonb);
end;
$$;
comment on function public.company_webhook_list(uuid) is
  '141: قائمة Webhooks الشركة — بلا سرّ إطلاقًا.';

create or replace function public.company_webhook_update(
  p_webhook_id uuid, p_name text default null, p_url text default null,
  p_events text[] default null, p_is_active boolean default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_row public.company_webhooks;
begin
  select * into v_row from public.company_webhooks where id = p_webhook_id;
  if v_row.id is null then
    raise exception 'الـWebhook غير موجود' using errcode = 'P0002';
  end if;
  if not public.company_webhook_scope(v_row.company_id) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  if p_name is not null and (char_length(btrim(p_name)) < 1 or char_length(btrim(p_name)) > 80) then
    raise exception 'اسم الـWebhook بين حرف و80 حرفًا' using errcode = '22023';
  end if;
  if p_url is not null and (btrim(p_url) not like 'https://%' or char_length(btrim(p_url)) > 2048) then
    raise exception 'رابط الـWebhook يجب أن يبدأ بـ https://' using errcode = '22023';
  end if;
  if p_events is not null and (cardinality(p_events) = 0
     or not (p_events <@ array['ticket.created', 'ticket.replied', 'ticket.closed',
                              'customer.created', 'subscription.renewed',
                              'subscription.upgraded']::text[])) then
    raise exception 'اختر حدثًا واحدًا على الأقل من الأحداث المتاحة' using errcode = '22023';
  end if;

  update public.company_webhooks
     set name = coalesce(btrim(p_name), name),
         url = coalesce(btrim(p_url), url),
         events = coalesce(p_events, events),
         is_active = coalesce(p_is_active, is_active),
         updated_at = now()
   where id = p_webhook_id
   returning * into v_row;
  return public.company_webhook_json(v_row);
end;
$$;
comment on function public.company_webhook_update(uuid, text, text, text[], boolean) is
  '141: تعديل Webhook. القيم null تعني «بلا تغيير»؛ السرّ لا يتغير هنا.';

create or replace function public.company_webhook_delete(p_webhook_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.company_webhooks where id = p_webhook_id;
  if v_company is null then
    raise exception 'الـWebhook غير موجود' using errcode = 'P0002';
  end if;
  if not public.company_webhook_scope(v_company) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  delete from public.company_webhooks where id = p_webhook_id;
  return jsonb_build_object('deleted', true, 'id', p_webhook_id);
end;
$$;
comment on function public.company_webhook_delete(uuid) is
  '141: حذف Webhook — وحذف سجل تسليمه معه (cascade).';

create or replace function public.company_webhook_rotate_secret(p_webhook_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_row    public.company_webhooks;
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select * into v_row from public.company_webhooks where id = p_webhook_id;
  if v_row.id is null then
    raise exception 'الـWebhook غير موجود' using errcode = 'P0002';
  end if;
  if not public.company_webhook_scope(v_row.company_id) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  update public.company_webhooks
     set secret = v_secret, updated_at = now()
   where id = p_webhook_id
   returning * into v_row;
  return public.company_webhook_json(v_row) || jsonb_build_object('secret', v_secret);
end;
$$;
comment on function public.company_webhook_rotate_secret(uuid) is
  '141: تدوير سرّ توقيع Webhook. السرّ الجديد في الرد مرة واحدة فقط.';

create or replace function public.company_webhook_deliveries(p_webhook_id uuid, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.company_webhooks where id = p_webhook_id;
  if v_company is null then
    raise exception 'الـWebhook غير موجود' using errcode = 'P0002';
  end if;
  if not public.company_webhook_scope(v_company) then
    raise exception 'إدارة Webhooks متاحة لمدير الشركة نفسها فقط' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'event', d.event, 'status', d.status, 'attempts', d.attempts,
      'response_status', d.response_status,
      'response_body', left(coalesce(d.response_body, ''), 500),
      'delivered_at', d.delivered_at, 'created_at', d.created_at
    ) order by d.created_at desc)
    from (select * from public.company_webhook_deliveries
           where webhook_id = p_webhook_id
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 100))) d
  ), '[]'::jsonb);
end;
$$;
comment on function public.company_webhook_deliveries(uuid, integer) is
  '141: سجل تسليم Webhook — محاولات فعلية فقط، والأحدث أولًا. بلا محاولات يعود [].';

-- ── نقطة ربط التسليم (للمحفّزات/العامل لاحقًا — service_role فقط) ───────
create or replace function public.company_webhook_enqueue(
  p_company_id uuid, p_event text, p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_count integer := 0;
begin
  -- بلا فحص رتبة داخل الجسم عمدًا: البوابة هي المنح أدناه (service_role
  -- وحده). فحص auth.role() هنا كان سيكسر النداء حتى من service_role، لأن
  -- مطالَبة JWT لا تُضبَط في كل مسار خادم — كما في دوال ihub_svc_* (088).
  if p_event not in ('ticket.created', 'ticket.replied', 'ticket.closed',
                     'customer.created', 'subscription.renewed', 'subscription.upgraded') then
    raise exception 'حدث Webhook غير معروف' using errcode = '22023';
  end if;

  insert into public.company_webhook_deliveries (webhook_id, company_id, event, payload, status)
  select w.id, w.company_id, p_event, coalesce(p_payload, '{}'::jsonb), 'pending'
    from public.company_webhooks w
   where w.company_id = p_company_id
     and w.is_active
     and p_event = any(w.events);

  get diagnostics v_count = row_count;

  update public.company_webhooks
     set deliveries_count = deliveries_count + v_count
   where company_id = p_company_id and is_active and p_event = any(events);

  return jsonb_build_object('event', p_event, 'enqueued', v_count);
end;
$$;
comment on function public.company_webhook_enqueue(uuid, text, jsonb) is
  '141: صف تسليم معلّق لكل Webhook فعّال مشترك في الحدث. المنح service_role وحده (بلا فحص رتبة في الجسم، كما في ihub_svc_*)؛ عامل التسليم عبر HTTP خطوة لاحقة منفصلة.';

revoke all on function public.company_webhook_create(uuid, text, text, text[]) from public, anon;
revoke all on function public.company_webhook_list(uuid) from public, anon;
revoke all on function public.company_webhook_update(uuid, text, text, text[], boolean) from public, anon;
revoke all on function public.company_webhook_delete(uuid) from public, anon;
revoke all on function public.company_webhook_rotate_secret(uuid) from public, anon;
revoke all on function public.company_webhook_deliveries(uuid, integer) from public, anon;
revoke all on function public.company_webhook_enqueue(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.company_webhook_create(uuid, text, text, text[]) to authenticated;
grant execute on function public.company_webhook_list(uuid) to authenticated;
grant execute on function public.company_webhook_update(uuid, text, text, text[], boolean) to authenticated;
grant execute on function public.company_webhook_delete(uuid) to authenticated;
grant execute on function public.company_webhook_rotate_secret(uuid) to authenticated;
grant execute on function public.company_webhook_deliveries(uuid, integer) to authenticated;
grant execute on function public.company_webhook_enqueue(uuid, text, jsonb) to service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- ② ساندبوكس API: بيئة المفتاح
-- ══════════════════════════════════════════════════════════════════════════

alter table public.api_tokens
  add column if not exists environment text not null default 'live'
  check (environment in ('live', 'test'));
comment on column public.api_tokens.environment is
  '141: بيئة المفتاح — live للحي، test لمفتاح الاختبار (ساندبوكس API). مفتاح الاختبار يُرفَض من verifyApiToken على كل نقطة حية فلا يصل إلى بيانات حية أبدًا.';
create index if not exists api_tokens_user_environment_idx
  on public.api_tokens (user_id, environment);

-- ══════════════════════════════════════════════════════════════════════════
-- ③ واتساب مشمول في الخطة الفائقة — بلا أي تغيير سعر
-- ══════════════════════════════════════════════════════════════════════════

insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, f.key, true, '{}'::jsonb
  from public.subscription_plans sp
  cross join (values ('whatsapp_sender'), ('whatsapp_autoreply'),
                     ('whatsapp_campaigns'), ('whatsapp_wallet')) as f(key)
 where sp.key = 'ultimate'
on conflict (plan_id, feature_key) do update set enabled = true;

-- ══════════════════════════════════════════════════════════════════════════
-- تحقق ذاتي
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_ultimate_features integer;
  v_price numeric;
begin
  if to_regprocedure('public.company_webhook_create(uuid,text,text,text[])') is null
     or to_regprocedure('public.company_webhook_list(uuid)') is null
     or to_regprocedure('public.company_webhook_update(uuid,text,text,text[],boolean)') is null
     or to_regprocedure('public.company_webhook_delete(uuid)') is null
     or to_regprocedure('public.company_webhook_rotate_secret(uuid)') is null
     or to_regprocedure('public.company_webhook_deliveries(uuid,integer)') is null
     or to_regprocedure('public.company_webhook_enqueue(uuid,text,jsonb)') is null then
    raise exception '141: دوال Webhooks لم تُنشأ';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'api_tokens'
                    and column_name = 'environment') then
    raise exception '141: عمود api_tokens.environment غائب';
  end if;

  select count(*) into v_ultimate_features
    from public.plan_features pf
    join public.subscription_plans sp on sp.id = pf.plan_id
   where sp.key = 'ultimate' and pf.enabled
     and pf.feature_key in ('whatsapp_sender', 'whatsapp_autoreply',
                            'whatsapp_campaigns', 'whatsapp_wallet');
  if v_ultimate_features <> 4 then
    raise exception '141: الفائقة يجب أن تحمل مفاتيح واتساب الأربعة (وجد %)', v_ultimate_features;
  end if;

  -- بلا أي تغيير سعر: أي انحراف هنا يعني أن الترحيل مسّ سعرًا بالخطأ.
  for v_price in
    select price_monthly from public.subscription_plans where key = 'ultimate'
  loop
    if v_price <> 1999 then raise exception '141: سعر الفائقة الشهري تغيّر (%)', v_price; end if;
  end loop;
  if (select price_yearly from public.subscription_plans where key = 'ultimate') <> 19999 then
    raise exception '141: سعر الفائقة السنوي تغيّر';
  end if;
  if (select price_monthly from public.subscription_plans where key = 'whatsapp') <> 1299
     or (select price_yearly from public.subscription_plans where key = 'whatsapp') <> 12999 then
    raise exception '141: سعر خطة واتساب تغيّر';
  end if;
  if (select price_monthly from public.subscription_plans where key = 'bundle') <> 2099
     or (select price_yearly from public.subscription_plans where key = 'bundle') <> 22999 then
    raise exception '141: سعر الباقة الشاملة تغيّر';
  end if;

  raise notice 'OK 141: Webhooks للشركة + بيئة مفتاح الاختبار + واتساب في الفائقة بلا تغيير سعر';
end $$;

commit;
