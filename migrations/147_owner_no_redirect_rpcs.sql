-- ============================================================================
-- 147_owner_no_redirect_rpcs.sql — دوال المالك لعرض لوحة المالك بلا تحويل
-- إلى لوحة الإدارة.
--
-- السياق: قاعدة «لا زر/رابط داخل أي لوحة ينقلك إلى لوحة مختلفة» (2026-11-26).
-- المالك في سياق owner يمرّ أصلًا من `is_admin()` (040: role='admin' أو
-- `owner_capability('admin')`، و`context_allows()` تقبل 'admin' في سياق
-- 'owner')، فمعظم دوال الإدارة قابلة لإعادة الاستخدام من كود المالك كما هي.
-- هذا الترحيل يبني السبع دوال التي لا تُعاد استخدامها حرفيًا، بالأسماء
-- والتوقيعات التي تناديها مجموعات الواجهة المتوازية — لا تُعاد تسميتها:
--
--   ① `owner_service_status()` — حالة الخدمات + الحوادث + ملخص البلاغات.
--   ② `owner_set_service_status(p_service, p_status)` — تغيير حالة خدمة.
--   ③ `owner_company_store_overview(p_company)` — نظرة متجر شركة بعينها.
--   ④ `owner_list_mcp_servers()` — خوادم MCP واتصالاتها بلا أي سر.
--   ⑤ `owner_set_user_role(p_user, p_role)` — رتبة user↔admin فقط.
--   ⑥ `owner_ban_user(p_user, p_reason, p_until)` — حظر (دائم/مؤقت)
--      أو رفع حظر حين تكون `p_until` في الماضي أو الآن.
--   ⑦ `owner_set_user_points(p_user, p_points)` — نقاط + محفظة.
--
-- الحراس:
--   • ①–④: `perform _owner_require()` وحده (قراءة/تشغيل، بلا تحقق بخطوتين).
--   • ⑤–⑦: `_owner_require()` + `owner_critical_ok()` (مالك + تحقق حديث،
--     053) — عمليات حرجة تمسّ حسابات.
--   • كل الدوال SECURITY DEFINER مع `set search_path to 'public'`، وممنوعة
--     عن public/anon، وممنوحة لـ authenticated (نمط 129).
--
-- انحرافات موثَّقة عن «النص الحرفي» — كل واحد لسبب أمني أو وظيفي مثبت:
--
--   أ) التدقيق في ⑤ و⑥ ليس إدخالًا ثانيًا من الـRPC: محفِّز 053
--      `trg_audit_profile_privileged` (بعد UPDATE على profiles) يكتب
--      'role.change' و'account.restriction' أصلًا، فإدخالٌ من الـRPC كان
--      سيُضاعف السطر لكل حدث في سجل إلحاقي. التدقيق موجود إذن بلا تكرار،
--      ويثبته الاختبار بعدّ السطور (سطر واحد بالضبط لكل تغيير). أما ⑦
--      فالمحفِّز لا يسجّل تغيير النقاط إطلاقًا، فيُدخل الـRPC
--      `log_privileged('points.change', …)` صراحةً.
--   ب) ③ ليست نسخة حرفية من `store_overview()` (119): الاستحقاقات تُحسب
--      لشركة `p_company` نفسها عبر `_owner_company_has_feature()` الداخلية،
--      لأن `company_has_feature()` (092) تقرأ `current_company_id()` —
--      شركة المنادي، لا شركة الهدف. وعدّادات التذاكر تعدّ تذاكر الشركة
--      مباشرةً، لأن `_company_ticket_access()` (098) مبني على عضوية فريق
--      الشركة فيعيد false للمالك على شركة ليس موظفًا فيها، فنسخة حرفية
--      كانت ستبلّغ صفرًا صامتًا. و`my_role` = 'owner' (المنادي مالك منصة
--      لا موظف شركة). باقي الجسم — الاتصال والتقارير والطلبات والنشاط —
--      مطابق لـ 119.
--   ج) ⑥ حظر ورفع حظر في دالة واحدة: `p_until` في المستقبل = حظر
--      (دائم إن كان NULL، مؤقت غير ذلك)، و`p_until` في الماضي أو الآن =
--      رفع حظر (ban_status='none' بلا حتى ولا سبب)، لأن `is_banned()`
--      (029) يعتبر الحظر منتهيًا حينها. فاستدعاء F3 لرفع الحظر
--      (`p_reason='إلغاء الحظر'`، `p_until=now()`) يعمل كما هو، بلا RPC
--      منفصل؛ ومسار الإدارة القائم (users.js: `ban_status='none'`) يبقى
--      كما هو. شرط السبب (≥5 أحرف) لا يُفرض على مسار رفع الحظر.
--   د) ⑦ ترفض النقاط السالبة (22023) وتغيير نقاط الذات (42501): نسخة
--      users.js تقبل أي عدد صحيح، لكن سالبًا يفسد منطق المحفظة، ومحفِّز
--      008 يمنع تعديل الذات أصلًا إلا للمالك الرئيسي — والرفض الصريح
--      أوضح من خطأ المحفِّز. تحديث المحفظة بلا إدخال صف جديد إن غاب،
--      مطابقًا لـ users.js حرفيًا.
--   هـ) ① لا تعدّل `get_service_report_summary()` (014) ولا فحصها الحرفي
--      للدور (`role in ('admin','support')`) — التجميع منسوخ داخل RPC
--      المالك بدل استدعائها، حتى لا يُفتح مسار الإدارة للمالك عبرها.
--   و) ⑤ ترفض الرتب خارج {user, admin}: أدوار الشركة تُشتق من العلاقة
--      (053)، و'platform_owner' لا تُمنح من جلسة إطلاقًا (053).
--   ز) ⑧ توسيع بوابة `manage_user_points` (134) من بريد JWT وحده إلى
--      `can_manage_central_wallet()` (117) — وهو التغيير الوحيد في هذا
--      الترحيل لدالة قائمة، وجاء بطلب متابعة F3: واجهة التجميد تُظهر الزر
--      للمالك لأن `can_manage_central_wallet()` يسمح له، لكن الـRPC كان
--      يرفضه ببوابة البريد فيفشل التجميد وقت التشغيل. التوسيع آمن: 117
--      نفسها عرّفت هذا المُسنَد بأنه «نفس الشرط ∨ owner_capability»،
--      وحوّلت سياسات user_wallets إليه فالمالك يجمّد أصلًا بتحديث مباشر،
--      وتعليق users-hub-model.js:145 يوثّق الـRPC على أنه يفرض هذا
--      المُسنَد، والمالك لا يكسب سلطة جديدة (النقاط يضبطها أصلًا عبر ⑦
--      بتحقق بخطوتين). بلا تحقق بخطوتين هنا — اتساقًا مع وضع support@
--      القائم ومع سياسات 117. الجسم منسوخ من 134 حرفيًا عدا سطر البوابة.
--      و`transfer_points_from_central` بقي على بوابته عمدًا (خارج نطاق
--      التجميد — يُقرر بشأنه لاحقًا).
--
-- ما لم يُغيَّره هذا الترحيل (نتائج فحص «تحقق أولًا»، 2026-11-26):
--   • سياسات RLS على `canned_responses` و`ticket_tags` و`ticket_tag_links`
--     و`ticket_attachments` كلها `is_platform_staff()` (035) أو
--     `is_admin()` (117) — و`is_platform_staff()` تمرّ للمالك في سياق
--     owner عبر `owner_capability('staff')` (038: `context_allows`
--     تقبل 'staff' في سياق 'owner') — فلا توسيع مطلوب: «لا تغيير».
--   • سياسات حاوية `tickets` في التخزين: `is_platform_staff()` (028)
--     و`_ticket_object_allowed()` (097: `has_elevated_authority()` أو
--     `is_platform_staff()`) و`_company_ticket_access()` (098) — بلا
--     فحص رتبة حرفي: «لا تغيير».
--   • `run_data_retention_cleanup` (035) محروسة بـ `is_admin()` —
--     قابلة لإعادة الاستخدام من المالك كما هي.
--   • `send_test_telegram_alert` (134) بلا حارس دور أصلًا: ترسل إلى
--     `telegram_chat_id` الخاص بالمنادي وحده — بلا فحص حرفي: «لا تغيير».
--   • `admin_set_subscription_status` (018:248) محروسة بـ `is_admin()`.
--   • Edge Function ‏`approve-waitlist-entry`: ترفض فقط إن فشل
--     `role='admin'` **و** `rpc("is_admin")` معًا — فالمالك يمرّ عبر
--     الـRPC؛ بلا إصلاح مطلوب (ولا نشر هنا).
--   • Edge Functions الخاصة بـ MCP ‏(`save-mcp-credentials` و
--     `test-mcp-server` و`mcp-oauth-start` و`mcp-server-info`): كلها
--     تحرس بـ `rpc("is_admin")` → 403؛ و`mcp-invoke-tool` بـ
--     `rpc("can_use_mcp_client")`، و`mcp` برمز API ونطاقاته،
--     و`mcp-oauth-callback` بمعامل state — بلا فحص رتبة حرفي: «لا تغيير».
--
-- قابل لإعادة التشغيل. التراجع:
-- `migrations/_rollback/147_owner_no_redirect_rpcs.down.sql` (إسقاط الدوال
-- الثماني الجديدة + إعادة `manage_user_points` إلى بوابة بريد 134).
-- ============================================================================

begin;

-- ── 0) الشروط المسبقة ────────────────────────────────────────────────────
-- فشل واضح بدل تعريف دوال تستدعي ما لا وجود له.
do $$
begin
  if to_regprocedure('public._owner_require()') is null then
    raise exception '147 يتطلب public._owner_require() من الترحيل 119';
  end if;
  if to_regprocedure('public.owner_critical_ok()') is null then
    raise exception '147 يتطلب public.owner_critical_ok() من الترحيل 053';
  end if;
  if to_regprocedure('public.log_privileged(text,uuid,jsonb,jsonb)') is null then
    raise exception '147 يتطلب public.log_privileged(text,uuid,jsonb,jsonb) من الترحيل 053';
  end if;
  if to_regprocedure('public.account_tier(uuid)') is null then
    raise exception '147 يتطلب public.account_tier(uuid) من الترحيل 053';
  end if;
  if to_regprocedure('public._ihub_connection_json(public.ihub_connections)') is null then
    raise exception '147 يتطلب public._ihub_connection_json(ihub_connections) من الترحيل 119';
  end if;
  if to_regprocedure('public.can_manage_central_wallet()') is null then
    raise exception '147 يتطلب public.can_manage_central_wallet() من الترحيل 117';
  end if;
  if to_regclass('public.central_wallet_transactions') is null then
    raise exception '147 يتطلب الجدول central_wallet_transactions من الترحيل 134';
  end if;
  if to_regclass('public.services') is null
     or to_regclass('public.incidents') is null
     or to_regclass('public.service_status_history') is null
     or to_regclass('public.customer_service_reports') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.user_wallets') is null
     or to_regclass('public.mcp_servers') is null
     or to_regclass('public.mcp_server_connections') is null
     or to_regclass('public.companies') is null
     or to_regclass('public.tickets') is null
     or to_regclass('public.whatsapp_subscriptions') is null
     or to_regclass('public.subscription_plans') is null
     or to_regclass('public.plan_features') is null
     or to_regclass('public.company_feature_overrides') is null
     or to_regclass('public.ihub_connections') is null
     or to_regclass('public.ihub_providers') is null
     or to_regclass('public.store_order_requests') is null
     or to_regclass('public.store_order_request_events') is null
     or to_regclass('public.ihub_ticket_links') is null then
    raise exception '147 يتطلب جداول الخدمات/البلاغات/الحسابات/المتاجر/MCP (001/014/119/134)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name in ('ban_status', 'ban_until', 'ban_reason', 'points')
                  group by table_name having count(*) = 4) then
    raise exception '147 يتطلب أعمدة profiles.ban_status/ban_until/ban_reason/points';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'companies'
                    and column_name = 'account_kind') then
    raise exception '147 يتطلب العمود companies.account_kind من الترحيل 118';
  end if;
end $$;


-- ============================================================================
-- ① حالة الخدمات والحوادث وملخص البلاغات للمالك
-- ============================================================================
-- نفس صفوف `services` و`incidents` كاملةً، ونفس تجميع
-- `get_service_report_summary()` (014) — منسوخًا لا مستدعًى (انظر (هـ) أعلاه).
create or replace function public.owner_service_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'services', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at, s.id), '[]'::jsonb)
                   from public.services s),
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc, i.id), '[]'::jsonb)
                    from public.incidents i),
    'report_summary', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select r.service_id,
             s.name::text as service_name,
             r.incident_id,
             r.episode_key,
             count(*)          as report_count,
             min(r.created_at) as first_reported,
             max(r.created_at) as last_reported,
             jsonb_agg(
               jsonb_build_object(
                 'user_id',     r.user_id,
                 'name',        coalesce(pr.full_name, pr.email, 'عميل'),
                 'reported_at', r.created_at
               ) order by r.created_at
             ) as reporters
        from public.customer_service_reports r
        join public.services s  on s.id = r.service_id
        left join public.profiles pr on pr.id = r.user_id
       where r.status <> 'resolved'
       group by r.service_id, s.name, r.incident_id, r.episode_key
       order by count(*) desc, max(r.created_at) desc
    ) x));
end $$;

comment on function public.owner_service_status() is
  'حالة الخدمات والحوادث وملخص بلاغات العملاء للوحة المالك (147). التجميع مطابق لـ get_service_report_summary() (014) — منسوخ لا مستدعًى لأن فحصها الحرفي للدور لا يمرّر المالك.';


-- ============================================================================
-- ② تغيير حالة خدمة + سجل الحالات
-- ============================================================================
-- نفس الكتابتين اللتين تقوم بهما `updateServiceStatus()` في service-status.js:
-- تحديث services (status + last_checked) ثم إدخال صف في service_status_history.
create or replace function public.owner_set_service_status(p_service uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_row public.services%rowtype;
begin
  perform public._owner_require();
  if p_service is null then
    raise exception 'معرّف الخدمة مطلوب' using errcode = '22023';
  end if;
  if p_status not in ('operational', 'degraded', 'down') then
    raise exception 'حالة خدمة غير صالحة: %' , p_status using errcode = '22023';
  end if;

  update public.services
     set status = p_status, last_checked = now()
   where id = p_service
   returning * into v_row;
  if v_row.id is null then
    raise exception 'الخدمة غير موجودة' using errcode = 'P0002';
  end if;

  insert into public.service_status_history (service_id, status, response_time)
  values (p_service, p_status, null);

  return to_jsonb(v_row);
end $$;

comment on function public.owner_set_service_status(uuid, text) is
  'تغيير حالة خدمة من لوحة المالك (147): تحديث services + إدخال service_status_history، كما في updateServiceStatus() في service-status.js. الحالات: operational/degraded/down.';


-- ============================================================================
-- داخلية: استحقاق شركة بعينها — company_has_feature() لشركة هدف لا للمنادي
-- ============================================================================
-- منطق 092 حرفيًا، لكن بـ `c.id = p_company` بدل `current_company_id()`.
-- داخلية: لا تُمنح لأي دور.
create or replace function public._owner_company_has_feature(p_company uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = p_company
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key)
  or exists (
    select 1
      from public.company_feature_overrides o
     where o.company_id = p_company
       and o.feature_key = p_feature_key
       and (o.expires_at is null or o.expires_at > now()));
$$;

comment on function public._owner_company_has_feature(uuid, text) is
  'داخلية (147): هل تملك شركة بعينها الامتياز عبر اشتراك فعّال أو استثناء سارٍ — نفس منطق company_has_feature() (092) لكن لشركة هدف لا لشركة المنادي.';


-- ============================================================================
-- ③ نظرة متجر شركة بعينها للمالك
-- ============================================================================
-- جسم `store_overview()` (119) مع `v_company := p_company`، والانحرافان
-- الموثَّقان في (ب) أعلاه: الاستحقاقات لشركة الهدف، وعدّادات التذاكر مباشرة.
create or replace function public.owner_company_store_overview(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_entitled boolean;
begin
  perform public._owner_require();
  if p_company is null then
    raise exception 'معرّف الشركة مطلوب' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.companies c
                  where c.id = p_company and c.account_kind = 'ecommerce_store') then
    raise exception 'هذه الصفحة لحسابات المتاجر' using errcode = 'P0002',
      detail = '{"code":"not_a_store"}';
  end if;

  v_entitled := coalesce(public._owner_company_has_feature(p_company, 'store_support'), false);
  return jsonb_build_object(
    'company_id', p_company,
    'my_role', 'owner',
    'entitlements', jsonb_build_object(
       'store_support', v_entitled,
       'shopify_integration', coalesce(public._owner_company_has_feature(p_company, 'shopify_integration'), false),
       'integrations_hub', coalesce(public._owner_company_has_feature(p_company, 'integrations_hub'), false)),
    'connection', (select public._ihub_connection_json(c) from public.ihub_connections c
                    where c.company_id = p_company and c.provider = 'shopify' and c.status <> 'disconnected'
                    order by c.created_at desc limit 1),
    'shopify_enabled', exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled),
    'open_tickets', (select count(*) from public.tickets t where t.scope = 'company' and t.company_id = p_company
                       and t.status in ('open', 'in-progress')),
    'active_conversations', case when to_regclass('public.company_conversations') is null then null
                              else (select count(*) from public.company_conversations x
                                     where x.company_id = p_company and x.status = 'open') end,
    'unresolved_requests', case when v_entitled then (select count(*) from public.store_order_requests q
                              where q.company_id = p_company and q.status not in ('resolved', 'declined')) end,
    'overdue_requests', case when v_entitled then (select count(*) from public.store_order_requests q
                           where q.company_id = p_company and q.status not in ('resolved', 'declined')
                             and q.due_at < now()) end,
    'order_linked_open_tickets', (select count(distinct t.id) from public.tickets t
                                    join public.ihub_ticket_links l on l.ticket_id = t.id and l.unlinked_at is null
                                   where t.scope = 'company' and t.company_id = p_company
                                     and t.status in ('open', 'in-progress')),
    'recent_activity', case when v_entitled then (select coalesce(jsonb_agg(jsonb_build_object(
                          'request_id', e.request_id, 'action', e.action, 'to_status', e.to_status,
                          'kind', q.kind, 'order_ref', q.order_ref, 'created_at', e.created_at) order by e.id desc), '[]'::jsonb)
                          from (select * from public.store_order_request_events where company_id = p_company
                                 order by id desc limit 10) e
                          join public.store_order_requests q on q.id = e.request_id) else '[]'::jsonb end);
end $$;

comment on function public.owner_company_store_overview(uuid) is
  'نظرة متجر شركة بعينها للوحة المالك (147): جسم store_overview() (119) مع v_company = p_company. الاستحقاقات لشركة الهدف، وعدّادات التذاكر مباشرة (‎_company_ticket_access مبني على عضوية الفريق فيعيد false للمالك)، وmy_role = owner.';


-- ============================================================================
-- ④ خوادم MCP واتصالاتها — بلا أي عمود سرّي
-- ============================================================================
-- قائمة سماح صريحة بالأعمدة غير السرّية. المستبعَد عمدًا:
--   • mcp_servers: env وheaders (قد يحملان مفاتيح/ترويسات مصادقة).
--   • mcp_server_connections: كل *_encrypted، وoauth_client_id، وoauth_state.
-- أي عمود سرّي يُضاف مستقبلًا يبقى محجوبًا افتراضيًا لأنه خارج القائمة.
create or replace function public.owner_list_mcp_servers()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'servers', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'transport', s.transport, 'url', s.url,
        'command', s.command, 'args', s.args, 'description', s.description,
        'category', s.category, 'enabled', s.enabled, 'created_by', s.created_by,
        'created_at', s.created_at, 'updated_at', s.updated_at,
        'connector_type', s.connector_type, 'owner_id', s.owner_id)
        order by s.created_at, s.id), '[]'::jsonb)
      from public.mcp_servers s),
    'connections', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'server_id', c.server_id, 'owner_id', c.owner_id,
        'auth_type', c.auth_type,
        'oauth_authorize_url', c.oauth_authorize_url, 'oauth_token_url', c.oauth_token_url,
        'oauth_scope', c.oauth_scope, 'oauth_token_expires_at', c.oauth_token_expires_at,
        'status', c.status, 'tools', c.tools, 'last_checked_at', c.last_checked_at,
        'last_error', c.last_error, 'created_at', c.created_at, 'updated_at', c.updated_at)
        order by c.created_at, c.id), '[]'::jsonb)
      from public.mcp_server_connections c));
end $$;

comment on function public.owner_list_mcp_servers() is
  'خوادم MCP واتصالاتها للوحة المالك (147). قائمة سماح بالأعمدة غير السرّية فقط — لا env/headers ولا أي *_encrypted ولا oauth_client_id/state أبدًا.';


-- ============================================================================
-- ⑤ تغيير رتبة مستخدم — user↔admin فقط
-- ============================================================================
-- التدقيق: محفِّز 053 `trg_audit_profile_privileged` يكتب 'role.change' —
-- بلا إدخال ثانٍ من هنا (انظر (أ) أعلاه). والحراس `guard_profile_role_change`
-- و`guard_privileged_accounts` (053) طبقة ثانية خلف فحوصات هذه الدالة.
create or replace function public.owner_set_user_role(p_user uuid, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_old text; v_tier text;
begin
  perform public._owner_require();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'تغيير الرتب يتطلب تحقق المالك بخطوتين' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'معرّف المستخدم مطلوب' using errcode = '22023';
  end if;
  if p_role not in ('user', 'admin') then
    raise exception 'الرتبة المسموح تغييرها هنا: user أو admin فقط' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;

  select role into v_old from public.profiles where id = p_user;
  if v_old is null then
    raise exception 'المستخدم غير موجود' using errcode = 'P0002';
  end if;
  v_tier := public.account_tier(p_user);
  if v_tier = 'owner' then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة' using errcode = '42501';
  end if;
  if v_old = p_role then
    return jsonb_build_object('user_id', p_user, 'old_role', v_old, 'new_role', p_role, 'changed', false);
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user;
  return jsonb_build_object('user_id', p_user, 'old_role', v_old, 'new_role', p_role, 'changed', true);
end $$;

comment on function public.owner_set_user_role(uuid, text) is
  'تغيير رتبة مستخدم من لوحة المالك (147): user↔admin فقط، تحقق بخطوتين، بلا تغيير للذات ولا لمالك المنصة. التدقيق عبر محفِّز 053 (role.change) — بلا إدخال ثانٍ.';


-- ============================================================================
-- ⑥ حظر مستخدم — دائم أو مؤقت — أو رفع حظره
-- ============================================================================
-- `p_until` في المستقبل = حظر (دائم إن كانت NULL، مؤقت غير ذلك)؛ و`p_until`
-- في الماضي أو الآن = رفع حظر (ban_status='none' بلا حتى ولا سبب)، لأن
-- `is_banned()` (029) يعتبر الحظر منتهيًا حينها — وهذا ما يعتمد عليه
-- استدعاء F3 لرفع الحظر (`p_reason='إلغاء الحظر'`، `p_until=now()`).
-- السبب ≥5 أحرف مقصوصة كما في مسار الإدارة (users.js) — لمسار الحظر وحده.
-- الحارس الثاني `guard_privileged_accounts` (053): حظر المالك محظور من
-- المنبع، وحظر فريق المنصة يتطلب التحقق بخطوتين.
-- التدقيق: محفِّز 053 يكتب 'account.restriction' — بلا إدخال ثانٍ (انظر (أ)).
create or replace function public.owner_ban_user(p_user uuid, p_reason text, p_until timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
declare v_status text; v_tier text;
declare v_unban boolean := p_until is not null and p_until <= now();
begin
  perform public._owner_require();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'حظر الحسابات يتطلب تحقق المالك بخطوتين' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'معرّف المستخدم مطلوب' using errcode = '22023';
  end if;
  -- شرط السبب لمسار الحظر وحده؛ رفع الحظر بلا شرط سبب (كمسار الإدارة).
  if not v_unban and (v_reason is null or char_length(v_reason) < 5) then
    raise exception 'اكتب سببًا واضحًا (5 أحرف على الأقل)' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'لا يمكنك حظر حسابك بنفسك' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'المستخدم غير موجود' using errcode = 'P0002';
  end if;
  v_tier := public.account_tier(p_user);
  if v_tier = 'owner' then
    raise exception 'لا يمكن حظر مالك المنصة' using errcode = '42501';
  end if;

  if v_unban then
    update public.profiles
       set ban_status = 'none', ban_until = null, ban_reason = null, updated_at = now()
     where id = p_user;
    return jsonb_build_object('user_id', p_user, 'ban_status', 'none',
                              'ban_until', null, 'ban_reason', null);
  end if;

  v_status := case when p_until is null then 'permanent' else 'temporary' end;
  update public.profiles
     set ban_status = v_status, ban_until = p_until, ban_reason = v_reason, updated_at = now()
   where id = p_user;
  return jsonb_build_object('user_id', p_user, 'ban_status', v_status,
                            'ban_until', p_until, 'ban_reason', v_reason);
end $$;

comment on function public.owner_ban_user(uuid, text, timestamptz) is
  'حظر مستخدم من لوحة المالك (147): دائم (p_until NULL) أو مؤقت، أو رفع حظر حين تكون p_until في الماضي أو الآن (ban_status=none). سبب ≥5 أحرف لمسار الحظر وحده. بلا حظر للذات ولا لمالك المنصة. التدقيق عبر محفِّز 053 (account.restriction) — بلا إدخال ثانٍ.';


-- ============================================================================
-- ⑦ ضبط نقاط مستخدم + محفظته
-- ============================================================================
-- نفس الكتابتين في users.js (269-286): profiles.points ثم
-- user_wallets.total_points/available_points (بلا إدخال صف محفظة إن غاب).
-- التدقيق هنا صريح لأن محفِّز 053 لا يسجّل تغيير النقاط (انظر (أ) أعلاه).
create or replace function public.owner_set_user_points(p_user uuid, p_points int)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_old_points int; v_old_total int; v_old_avail int;
declare v_new_total int; v_new_avail int;
begin
  perform public._owner_require();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'تغيير النقاط يتطلب تحقق المالك بخطوتين' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'معرّف المستخدم مطلوب' using errcode = '22023';
  end if;
  if p_points is null or p_points < 0 then
    raise exception 'النقاط عدد صحيح غير سالب' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'لا يمكنك تعديل نقاط حسابك بنفسك' using errcode = '42501';
  end if;

  select p.points into v_old_points from public.profiles p where p.id = p_user;
  if v_old_points is null and not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'المستخدم غير موجود' using errcode = 'P0002';
  end if;
  select w.total_points, w.available_points into v_old_total, v_old_avail
    from public.user_wallets w where w.user_id = p_user;

  update public.profiles set points = p_points, updated_at = now() where id = p_user;
  update public.user_wallets
     set total_points = p_points, available_points = p_points
   where user_id = p_user;

  -- قيم المحفظة الفعلية بعد الكتابة: NULL إن لم يكن للمستخدم صف محفظة
  -- (users.js لا يُدخل صفًا جديدًا، وهذه الدالة كذلك).
  select w.total_points, w.available_points into v_new_total, v_new_avail
    from public.user_wallets w where w.user_id = p_user;

  perform public.log_privileged('points.change', p_user,
    jsonb_build_object('points', v_old_points, 'total_points', v_old_total, 'available_points', v_old_avail),
    jsonb_build_object('points', p_points, 'total_points', v_new_total, 'available_points', v_new_avail));

  return jsonb_build_object('user_id', p_user, 'points', p_points,
                            'wallet_total_points', v_new_total,
                            'wallet_available_points', v_new_avail);
end $$;

comment on function public.owner_set_user_points(uuid, int) is
  'ضبط نقاط مستخدم ومحفظته من لوحة المالك (147): profiles.points + user_wallets.total/available_points كما في users.js. تحقق بخطوتين، بلا سالب ولا تعديل للذات، وتدقيق points.change صريح.';


-- ============================================================================
-- ⑧ توسيع بوابة manage_user_points إلى can_manage_central_wallet()
-- ============================================================================
-- الجسم منسوخ من 134 حرفيًا عدا سطر البوابة الواحد (انظر (ز) أعلاه): كان
-- البريد `support@mad3oom.online` وحده، فصار المُسنَد الذي عرّفته 117
-- للمحفظة المركزية (نفس البريد ∨ مالك المنصة في سياقه). بلا أي تغيير
-- آخر: الأفعال الأربعة، والتحقق من الرصيد، وصف central_wallet_transactions.
-- CREATE OR REPLACE يحفظ منح 134؛ وتُعاد المنح هنا حرفيًا كما في 134
-- (70_grants.sql): إلغاء من PUBLIC وanon وauthenticated وservice_role،
-- ثم منح authenticated وservice_role.
CREATE OR REPLACE FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    admin_uid UUID;
    current_balance BIGINT;
    new_balance BIGINT;
    transaction_id UUID;
BEGIN
    admin_uid := auth.uid();

    IF NOT COALESCE(public.can_manage_central_wallet(), false) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF action_type NOT IN ('add', 'deduct', 'freeze', 'unfreeze') THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'نوع العملية غير صحيح',
            'error_code', 'INVALID_ACTION'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT available_points INTO current_balance
    FROM user_wallets
    WHERE user_id = target_uid;

    IF current_balance IS NULL THEN
        current_balance := 0;
    END IF;

    IF action_type = 'add' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        UPDATE user_wallets
        SET available_points = available_points + amount_change,
            total_points = total_points + amount_change,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance + amount_change;

    ELSIF action_type = 'deduct' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        IF current_balance < amount_change THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'رصيد العميل غير كافٍ. الرصيد الحالي: ' || current_balance,
                'error_code', 'INSUFFICIENT_BALANCE',
                'current_balance', current_balance
            );
        END IF;

        UPDATE user_wallets
        SET available_points = GREATEST(0, available_points - amount_change),
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := GREATEST(0, current_balance - amount_change);

    ELSIF action_type = 'freeze' THEN
        UPDATE user_wallets
        SET is_frozen = TRUE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;

    ELSIF action_type = 'unfreeze' THEN
        UPDATE user_wallets
        SET is_frozen = FALSE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_change,
        action_type,
        current_balance,
        new_balance,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تمت العملية بنجاح',
        'transaction_id', transaction_id,
        'action_type', action_type,
        'amount', amount_change,
        'user_email', target_user_email,
        'previous_balance', current_balance,
        'new_balance', new_balance
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

comment on function public.manage_user_points(text, bigint, text) is
  'إدارة نقاط مستخدم مركزيًا (إضافة/خصم/تجميد/إلغاء تجميد). البوابة موسَّعة في 147 إلى can_manage_central_wallet() (117): support@ كما كان، أو مالك المنصة في سياقه. الجسم من 134 حرفيًا عدا سطر البوابة.';

revoke all on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) from public, anon, authenticated, service_role;
grant execute on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) to authenticated;
grant execute on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) to service_role;


-- ── الصلاحيات ────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['public._owner_company_has_feature(uuid,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.owner_service_status()',
                           'public.owner_set_service_status(uuid,text)',
                           'public.owner_company_store_overview(uuid)',
                           'public.owner_list_mcp_servers()',
                           'public.owner_set_user_role(uuid,text)',
                           'public.owner_ban_user(uuid,text,timestamptz)',
                           'public.owner_set_user_points(uuid,int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ── التحقق ──────────────────────────────────────────────────────────────
do $$
declare v_missing text[];
begin
  select array_agg(x) into v_missing from (values
    ('public.owner_service_status()'),
    ('public.owner_set_service_status(uuid,text)'),
    ('public.owner_company_store_overview(uuid)'),
    ('public.owner_list_mcp_servers()'),
    ('public.owner_set_user_role(uuid,text)'),
    ('public.owner_ban_user(uuid,text,timestamptz)'),
    ('public.owner_set_user_points(uuid,int)'),
    ('public._owner_company_has_feature(uuid,text)')
  ) as t(x)
  where to_regprocedure(t.x) is null;
  if v_missing is not null then
    raise exception '147: دوال مفقودة بعد التطبيق: %', v_missing;
  end if;
  if not has_function_privilege('authenticated', 'public.owner_service_status()', 'EXECUTE')
     or has_function_privilege('anon', 'public.owner_service_status()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._owner_company_has_feature(uuid,text)', 'EXECUTE') then
    raise exception '147: صلاحيات الدوال تغيّرت';
  end if;
  -- بوابة manage_user_points موسَّعة فعلًا (وإلا فالتوسيع لم يُطبَّق):
  if position('can_manage_central_wallet' in pg_get_functiondef('public.manage_user_points(text,bigint,text)'::regprocedure)) = 0
     or position('support@mad3oom.online' in pg_get_functiondef('public.manage_user_points(text,bigint,text)'::regprocedure)) <> 0 then
    raise exception '147: بوابة manage_user_points لم تُوسَّع إلى can_manage_central_wallet()';
  end if;
  raise notice 'OK 147: دوال المالك السبع + الداخلية جاهزة — بلا تغيير سياسات، وبوابة manage_user_points موسَّعة';
end $$;

commit;
