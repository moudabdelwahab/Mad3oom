-- ============================================================================
-- المالك في سياق الإدارة وطلبات الاشتراك/الشحن (071) — على نسخة مطابقة للإنتاج
--
-- الإعداد: 070 مطبّق (زي الإنتاج دلوقتي)، وتذكرتين لعميل: طلب اشتراك pending
--   وطلب شحن رصيد pending — نفس شكل التذكرة #1121.
-- ⓪ (قبل 071): المالك في سياق admin يشوف التذكرة لكن مايشوفش صف الاشتراك ولا
--    طلب الشحن (فاللوحة ماترسمش أزرار التأكيد/الرفض)، وتعديلهم 0 صفوف، و
--    admin_recompute_user_access مش موجودة أصلًا — بلاغ الإنتاج نفسه.
-- ① (بعد 071): المالك في سياق admin بيمشي مسار الواجهة كامل زي الأدمن (تأكيد
--    + إعادة حساب الامتيازات + التذكرة + الإشعار، رفض، شحن الرصيد)؛ في سياق
--    customer/company_admin أو بعد انتهاء السياق مالوش حاجة؛ الأدمن والدعم
--    والعميل زي ما كانوا.
-- ② التراجع وإعادة التطبيق.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;
\i migrations/070_owner_admin_context_tickets.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
CREATE FUNCTION t.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  raise exception using errcode = 'TT000';
exception when others then
  return case when sqlstate = 'TT000' then 'ok' else sqlstate end;
end $$;
-- عدد صفوف يتأثر بالتعديل (والأثر بيرجع)
CREATE FUNCTION t.rows(p_sql text) RETURNS int LANGUAGE plpgsql AS $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  raise exception using errcode = 'TT001', message = n::text;
exception when sqlstate 'TT001' then
  return sqlerrm::int;
end $$;
-- سياق المالك (مسار enter_context في الإنتاج، هنا مباشرةً كإعداد)
CREATE FUNCTION t.ctx(p_context text, p_live boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values ('00000000-0000-4000-8000-0000000000f0', p_context, now(),
          case when p_live then now() + interval '12 hours' else now() - interval '1 minute' end)
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون: C1 عميل، AD أدمن، SP دعم، OW مالك المنصة ─────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'),
  ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io'), ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000041', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000042', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io', 'دعم', 'support', '01000000043', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000044', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES ('00000000-0000-4000-8000-0000000000f0', 'owner');
INSERT INTO public.tickets (id, user_id, title, description, status, priority, category) VALUES
  ('22222222-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'طلب اشتراك', 'وصف', 'open', 'medium', 'subscription'),
  ('22222222-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000c1', 'طلب اشتراك تاني', 'وصف', 'open', 'medium', 'subscription'),
  ('22222222-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'شحن رصيد', 'وصف', 'open', 'medium', 'whatsapp_wallet_topup');
-- كأن العميل طلبها (as superuser: محفّز قواعد الشراء بيعدّي الطلبات من غير جلسة)
INSERT INTO public.whatsapp_subscriptions (id, user_id, ticket_id, status, plan, billing_cycle, start_date, end_date, payment_method) VALUES
  ('33333333-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000a1',
   'pending', 'whatsapp', 'monthly', now(), now() + interval '30 days', 'instapay'),
  ('33333333-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000a2',
   'pending', 'support', 'yearly', now(), now() + interval '365 days', 'instapay');
INSERT INTO public.whatsapp_wallet_topup_requests (id, user_id, ticket_id, amount, status, payment_method) VALUES
  ('44444444-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000b1',
   150, 'pending', 'instapay');

-- ما يراه حساب: التذكرة / صف الاشتراك المرتبط بيها (اللي اللوحة بتقراه بـ
-- .eq('ticket_id', …)) / طلب الشحن المرتبط بتذكرته
CREATE FUNCTION t.seen() RETURNS text LANGUAGE sql AS $$
  select (select count(*) from public.tickets where id = '22222222-0000-4000-8000-0000000000a1')
         || '/' || (select count(*) from public.whatsapp_subscriptions where ticket_id = '22222222-0000-4000-8000-0000000000a1')
         || '/' || (select count(*) from public.whatsapp_wallet_topup_requests where ticket_id = '22222222-0000-4000-8000-0000000000b1') $$;
GRANT EXECUTE ON FUNCTION t.seen() TO authenticated;

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  IF NOT public.is_platform_owner() OR public.active_context() <> 'admin' OR NOT public.is_admin()
     OR public.has_elevated_authority() THEN
    RAISE EXCEPTION 'SETUP: المالك مش في سياق admin بصلاحيات الإنتاج';
  END IF;
  PERFORM t.act(NULL);
  IF (select whatsapp_enabled from public.profiles where id = '00000000-0000-4000-8000-0000000000c1') THEN
    RAISE EXCEPTION 'SETUP: العميل واتساب مفعّل عنده من الأول';
  END IF;
  RAISE NOTICE 'PASS SETUP: 070 مطبّق، المالك في سياق admin، وتذكرتا اشتراك pending وطلب شحن pending لعميل';
END $$;

-- ============================================================================
-- ⓪ قبل 071
-- ============================================================================
DO $$
DECLARE s_ow text; s_ad text; upd int; topup int; rc text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  s_ow := t.seen();
  upd := t.rows($s$update public.whatsapp_subscriptions set status = 'active' where id = '33333333-0000-4000-8000-0000000000a1' and status = 'pending'$s$);
  topup := t.rows($s$update public.whatsapp_wallet_topup_requests set status = 'approved' where id = '44444444-0000-4000-8000-0000000000b1' and status = 'pending'$s$);
  rc := t.try($s$select public.admin_recompute_user_access('00000000-0000-4000-8000-0000000000c1')$s$);
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated; s_ad := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  IF s_ow <> '1/0/0' OR upd <> 0 OR topup <> 0 OR rc <> '42883' OR s_ad <> '1/1/1' THEN
    RAISE EXCEPTION 'FAIL ⓪: السلوك قبل 071 مش زي الإنتاج (المالك % تعديل % شحن % recompute % الأدمن %)', s_ow, upd, topup, rc, s_ad;
  END IF;
  RAISE NOTICE 'PROVEN GAP ⓪ (قبل 071): المالك في سياق admin بيشوف التذكرة بس (%)، لا الاشتراك ولا طلب الشحن ⇒ مفيش أزرار؛ التعديل 0 صفوف؛ admin_recompute_user_access مش موجودة (%)؛ الأدمن الفعلي % ', s_ow, rc, s_ad;
END $$;

-- ============================================================================
-- ① بعد 071
-- ============================================================================
\i migrations/071_owner_admin_context_billing_requests.sql
SET search_path = public, extensions;

-- ── B1: المالك في سياق admin — مسار confirmPurchaseTicket كما تنفّذه الواجهة ──
DO $$
DECLARE seen text; upd int; acc jsonb; tk int; feats text[];
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  seen := t.seen();
  upd := t.rows($s$update public.whatsapp_subscriptions
                     set status = 'active', start_date = now(), end_date = now() + interval '30 days',
                         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
                   where id = '33333333-0000-4000-8000-0000000000a1' and status = 'pending'$s$);
  -- t.rows بيرجّع الأثر؛ التأكيد الفعلي هنا عشان الخطوات اللي بعده تشوفه
  UPDATE public.whatsapp_subscriptions
     SET status = 'active', start_date = now(), end_date = now() + interval '30 days',
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE id = '33333333-0000-4000-8000-0000000000a1' AND status = 'pending';
  acc := public.admin_recompute_user_access('00000000-0000-4000-8000-0000000000c1');
  tk := t.rows($s$update public.tickets set status = 'confirmed', last_updated_by = auth.uid(), last_updated_at = now()
                  where id = '22222222-0000-4000-8000-0000000000a1'$s$);
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES ('00000000-0000-4000-8000-0000000000c1', '✓ تم تفعيل اشتراكك', 'تم التأكيد', 'success', '/customer-subscriptions.html');
  RESET ROLE;
  PERFORM t.act(NULL);
  feats := public.owned_feature_keys('00000000-0000-4000-8000-0000000000c1');
  IF seen <> '1/1/1' OR upd <> 1 OR tk <> 1 OR (acc->>'whatsapp_enabled')::boolean IS NOT TRUE
     OR NOT (select whatsapp_enabled from public.profiles where id = '00000000-0000-4000-8000-0000000000c1')
     OR NOT ('whatsapp_sender' = any(feats))
     OR (select reviewed_by from public.whatsapp_subscriptions where id = '33333333-0000-4000-8000-0000000000a1')
        <> '00000000-0000-4000-8000-0000000000f0' THEN
    RAISE EXCEPTION 'FAIL B1: المالك في سياق admin (شاف % أكّد % تذكرة % امتيازات %)', seen, upd, tk, acc;
  END IF;
  RAISE NOTICE 'PASS B1: المالك في سياق admin شاف الاشتراك وطلب الشحن (%)، أكّد الاشتراك، إعادة الحساب فعّلت واتساب للعميل، التذكرة confirmed، والإشعار اتبعت', seen;
END $$;

-- ── B2: الرفض وشحن الرصيد من نفس الحساب ─────────────────────────────────────
DO $$
DECLARE rej int; ap int; bal numeric;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  -- rejectPurchaseTicket: التذكرة ثم الاشتراك
  UPDATE public.tickets SET status = 'rejected', last_updated_by = auth.uid() WHERE id = '22222222-0000-4000-8000-0000000000a2';
  rej := t.rows($s$update public.whatsapp_subscriptions set status = 'rejected', rejection_reason = 'التحويل لم يصل',
                     reviewed_by = auth.uid(), reviewed_at = now() where ticket_id = '22222222-0000-4000-8000-0000000000a2'$s$);
  -- confirmWalletTopupTicket: الطلب ثم wa_wallet_adjust
  ap := t.rows($s$update public.whatsapp_wallet_topup_requests set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
                  where id = '44444444-0000-4000-8000-0000000000b1' and status = 'pending'$s$);
  PERFORM public.wa_wallet_adjust('00000000-0000-4000-8000-0000000000c1', 150, 'topup', 'شحن رصيد', '22222222-0000-4000-8000-0000000000b1');
  RESET ROLE;
  PERFORM t.act(NULL);
  SELECT balance INTO bal FROM public.whatsapp_wallets WHERE user_id = '00000000-0000-4000-8000-0000000000c1';
  IF rej <> 1 OR ap <> 1 OR bal <> 150 THEN
    RAISE EXCEPTION 'FAIL B2: رفض % شحن % رصيد %', rej, ap, bal;
  END IF;
  RAISE NOTICE 'PASS B2: المالك في سياق admin رفض طلب اشتراك بسبب، وأكّد طلب الشحن والمحفظة بقت %', bal;
END $$;

-- ── B3: الاحتواء — سياق customer/company_admin أو سياق منتهي ⇒ ولا حاجة ────
DO $$
DECLARE s_cust text; s_comp text; s_exp text; upd int; rc text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  PERFORM t.ctx('customer');
  SET LOCAL ROLE authenticated;
  s_cust := t.seen();
  upd := t.rows($s$update public.whatsapp_subscriptions set status = 'expired' where ticket_id = '22222222-0000-4000-8000-0000000000a1'$s$);
  rc := t.try($s$select public.admin_recompute_user_access('00000000-0000-4000-8000-0000000000c1')$s$);
  RESET ROLE;
  PERFORM t.ctx('company_admin');
  SET LOCAL ROLE authenticated; s_comp := t.seen(); RESET ROLE;
  PERFORM t.ctx('admin', false);
  SET LOCAL ROLE authenticated; s_exp := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  IF s_cust <> '0/0/0' OR s_comp <> '0/0/0' OR s_exp <> '0/0/0' OR upd <> 0 OR rc <> '42501' THEN
    RAISE EXCEPTION 'FAIL B3: الاحتواء انكسر (customer=% company_admin=% منتهي=% تعديل=% recompute=%)', s_cust, s_comp, s_exp, upd, rc;
  END IF;
  RAISE NOTICE 'PASS B3: المالك في سياق customer/company_admin أو بعد انتهاء السياق ⇒ 0/0/0، التعديل 0 صفوف، recompute 42501';
END $$;

-- ── B4: الباقي كما كان ─────────────────────────────────────────────────────
DO $$
DECLARE s_owner text; s_ad text; s_sp text; s_c1 text; upd_sp int; upd_c1 int; rc_sp text; rc_c1 text;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');  SET LOCAL ROLE authenticated; s_owner := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');  SET LOCAL ROLE authenticated; s_ad := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated;
  s_sp := t.seen();
  upd_sp := t.rows($s$update public.whatsapp_subscriptions set status = 'expired' where ticket_id = '22222222-0000-4000-8000-0000000000a1'$s$);
  rc_sp := t.try($s$select public.admin_recompute_user_access('00000000-0000-4000-8000-0000000000c1')$s$);
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  s_c1 := t.seen();
  upd_c1 := t.rows($s$update public.whatsapp_subscriptions set end_date = now() + interval '10 years' where user_id = auth.uid()$s$);
  rc_c1 := t.try($s$select public.admin_recompute_user_access(auth.uid())$s$);
  RESET ROLE;
  PERFORM t.act(NULL);
  -- الدعم: يشوف التذكرة بس زي قبل 071 (الجدولين للأدمن حصرًا من الأول)
  IF s_owner <> '1/1/1' OR s_ad <> '1/1/1' OR s_sp <> '1/0/0' OR upd_sp <> 0 OR rc_sp <> '42501'
     OR s_c1 <> '1/1/1' OR upd_c1 <> 0 OR rc_c1 <> '42501' THEN
    RAISE EXCEPTION 'FAIL B4: owner=% admin=% support=%/%/% c1=%/%/%', s_owner, s_ad, s_sp, upd_sp, rc_sp, s_c1, upd_c1, rc_c1;
  END IF;
  RAISE NOTICE 'PASS B4: المالك في سياق owner والأدمن 1/1/1؛ الدعم التذكرة بس (1/0/0) ومالوش تعديل ولا recompute؛ العميل بيشوف طلباته ومايقدرش يعدّلها ولا ينادي recompute';
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/_rollback/071_owner_admin_context_billing_requests.down.sql
DO $$
DECLARE seen text; rc text;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  seen := t.seen();
  rc := t.try($s$select public.admin_recompute_user_access('00000000-0000-4000-8000-0000000000c1')$s$);
  RESET ROLE;
  PERFORM t.act(NULL);
  IF seen <> '1/0/0' OR rc <> '42883' THEN RAISE EXCEPTION 'FAIL RB1: التراجع مارجّعش سلوك الإنتاج (% / %)', seen, rc; END IF;
  RAISE NOTICE 'PASS RB1: التراجع بيرجّع نص الإنتاج (المالك في admin ⇒ 1/0/0، والدالة اتشالت)';
END $$;
\i migrations/071_owner_admin_context_billing_requests.sql
DO $$
DECLARE seen text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated; seen := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  IF seen <> '1/1/1' THEN RAISE EXCEPTION 'FAIL RB2 (%)', seen; END IF;
  RAISE NOTICE 'PASS RB2: إعادة التطبيق idempotent';
END $$;

SELECT 'ALL OWNER ADMIN CONTEXT BILLING REQUEST TESTS PASSED';
