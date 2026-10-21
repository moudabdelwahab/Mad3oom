-- ============================================================================
-- 112_company_invitation_email — بريد دعوة عميل الشركة وحالته ورابط القبول
--
-- على نسخة مطابقة للإنتاج (لقطة المخطط + 094→111 بترتيب الإنتاج) ثم 112. بيانات اصطناعية فقط.
--   ⓪ قبل 112: الدعوة لبريد بلا حساب = صف «معلّق» بلا إشعار ولا بريد ولا طريق لربطه بحساب لاحق
--   ① الكائنات والصلاحيات: دوال البريد لمفتاح الخدمة وحده، والجدول بلا منح مباشرة
--   ② الدعوة: معرّفها، نفس الصف لنفس البريد، ورفض البريد الخاطئ وغير المخوَّل والمفتاح المطفأ
--   ③ تحضير البريد ونتيجته: رمز مجزّأ وحده، لا تكرار، مهلة، حدود المحاولات وحد الشركة اليومي
--   ④ الربط بالرابط: البريد المؤكَّد نفسه وحده، بلا كاشف، ثم القبول = عضوية عميل في شركتها وحدها
--   ⑤ العزل: شركة أخرى لا ترى ولا تلغي ولا تُحضّر بريدًا لدعوة غيرها
--   ⑥ التراجع يعيد نصّي الإنتاج حرفيًا (md5) ثم إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
\i tests/fixtures/tenancy/harness.sql
\i migrations/095_account_boundaries.sql
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
SET check_function_bodies = off;
\i tests/fixtures/tenancy/tickets.sql
\i migrations/097_ticket_scope_isolation.sql
\i migrations/098_company_permissions_usage_ledger.sql
\i migrations/099_admin_hierarchy.sql
\i migrations/100_company_documents.sql
\i migrations/101_customer_transfers_carry.sql
\i migrations/102_company_conversations.sql
\i migrations/103_admin_hierarchy_followups.sql
\i migrations/104_company_documents_followups.sql
SET search_path = public, extensions;
SET check_function_bodies = on;
\i migrations/105_account_hierarchy_customers.sql
\i migrations/106_account_request_execution.sql
\i migrations/107_isolation_readiness.sql
\i migrations/109_registration_mode_public_read.sql
\i migrations/108_phase1_readiness_fixes.sql
\i migrations/110_api_token_credentials_immutable.sql
\i migrations/111_billing_ticket_isolation.sql
SET search_path = public, extensions;

-- البريد مؤكَّد لكل الفاعلين (الإنتاج: email_confirmed_at يضبطه GoTrue)
UPDATE auth.users SET email_confirmed_at = now() - interval '30 days';
UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'multi_company_memberships_enabled';

-- نداء بمفتاح الخدمة كما تفعل دالة Edge (دور service_role، بلا مستخدم)
CREATE FUNCTION t.svcj(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'set local role service_role';
  EXECUTE 'select to_jsonb((' || p_sql || '))' INTO v;
  EXECUTE 'reset role';
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'reset role';
  RAISE;
END $$;
CREATE FUNCTION t.inv(p_company text, p_email text) RETURNS uuid LANGUAGE sql AS $$
  select id from public.company_membership_invitations where company_id = t.u(p_company) and invited_email = p_email
   order by created_at desc limit 1 $$;
CREATE FUNCTION t.col(p_inv uuid, p_col text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; BEGIN
  EXECUTE format('select %I::text from public.company_membership_invitations where id = %L', p_col, p_inv) INTO v; RETURN v; END $$;
-- إرجاع آخر محاولة 61 ثانية للخلف (بدل الانتظار)
CREATE FUNCTION t.age(p_inv uuid, p_secs int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  update public.company_membership_invitations
     set email_last_attempt_at = email_last_attempt_at - make_interval(secs => p_secs) where id = p_inv; END $$;
CREATE FUNCTION t.digest6() RETURNS text LANGUAGE sql AS $$
  select string_agg(proname || ':' || md5(prosrc), ',' order by proname) from pg_proc
   where pronamespace = 'public'::regnamespace and proname in ('company_invite_customer', 'company_invitations_list') $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ قبل 112 ═══════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- نصّا الإنتاج قبل 112 (2026-10-21)
  PERFORM t.ok(t.digest6() = 'company_invitations_list:7216142626e934398acf959a71e9fd68,company_invite_customer:e7b07d28a7bc6cc8f26715b91d533e2e',
               '⓪ prod bodies');
  r := t.call(t.u('OA'), 'public.company_invite_customer(''late@tenancy.test'')');
  PERFORM t.ok(r = '{"status":"pending"}'::jsonb, '⓪ pending, no id');
  PERFORM t.ok((SELECT invitee_user_id IS NULL FROM public.company_membership_invitations WHERE invited_email = 'late@tenancy.test'),
               '⓪ no account resolved');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM net._calls), '⓪ no outbound call at all');
  PERFORM t.ok(to_regprocedure('public.company_invitation_claim(text)') IS NULL, '⓪ no way to link a later account');
  DELETE FROM public.company_membership_invitations WHERE invited_email = 'late@tenancy.test';
  RAISE NOTICE 'PASS ⓪ قبل 112: الدعوة صف معلّق بلا بريد ولا إشعار ولا ربط لاحق — السبب الجذري';
END $$;

\i migrations/112_company_invitation_email.sql
SET search_path = public, extensions;

-- ══ ① الكائنات والصلاحيات ═══════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._company_invitation_prepare_email(uuid, boolean)', 'execute')
           AND NOT has_function_privilege('anon', 'public._company_invitation_prepare_email(uuid, boolean)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public._company_invitation_email_result(uuid, boolean, text, text)', 'execute')
           AND has_function_privilege('service_role', 'public._company_invitation_email_result(uuid, boolean, text, text)', 'execute')
           AND NOT has_function_privilege('anon', 'public.company_invitation_claim(text)', 'execute')
           AND has_function_privilege('authenticated', 'public.company_invitation_claim(text)', 'execute'), '① privileges');
  PERFORM t.ok(t.err(t.u('OA'), 'public._company_invitation_prepare_email(gen_random_uuid(), false)') = '42501', '① owner cannot prepare');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                            WHERE table_schema = 'public' AND table_name = 'company_membership_invitations'
                              AND grantee IN ('anon', 'authenticated')), '① table not granted');
  RAISE NOTICE 'PASS ① دوال البريد لمفتاح الخدمة وحده، والجدول بلا منح مباشرة';
END $$;

-- ══ ② الدعوة ═════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb;
BEGIN
  r1 := t.call(t.u('OA'), 'public.company_invite_customer(''Late@Tenancy.test'')');
  r2 := t.call(t.u('OA'), 'public.company_invite_customer(''late@tenancy.test'')');
  r3 := t.call(t.u('OA'), 'public.company_invite_customer(''a1b@tenancy.test'')');
  PERFORM t.ok(r1 ->> 'status' = 'pending' AND r1 ->> 'existing' = 'false' AND (r1 ->> 'invitation_id')::uuid = t.inv('CA', 'late@tenancy.test'),
               '② id returned');
  PERFORM t.ok(r2 ->> 'invitation_id' = r1 ->> 'invitation_id' AND r2 ->> 'existing' = 'true', '② same row on retry');
  PERFORM t.ok((SELECT count(*) FROM public.company_membership_invitations WHERE invited_email = 'late@tenancy.test') = 1, '② one row');
  -- نفس شكل الرد لحساب قائم وغير قائم (لا كاشف)
  r3 := t.call(t.u('OA'), 'public.company_invite_customer(''dg@tenancy.test'')');
  PERFORM t.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r3) k) = (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r1) k),
               '② same response shape');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_invite_customer(''not-an-email'')') = '22023', '② invalid email');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_invite_customer(''a b@x.test'')') = '22023', '② invalid email (space)');
  PERFORM t.ok(t.err(t.u('A1'), 'public.company_invite_customer(''x@tenancy.test'')') = '42501', '② customer cannot invite');
  PERFORM t.ok(t.err(t.u('AS'), 'public.company_invite_customer(''x@tenancy.test'')') = '42501', '② supervisor cannot invite');
  PERFORM t.ok(t.err(t.u('AD'), 'public.company_invite_customer(''x@tenancy.test'')') = '42501', '② platform staff cannot invite');
  PERFORM t.ok(t.err(NULL, 'public.company_invite_customer(''x@tenancy.test'')') = '42501', '② anonymous cannot invite');
  UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'multi_company_memberships_enabled';
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_invite_customer(''y@tenancy.test'')') = '0A000', '② switch off');
  UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'multi_company_memberships_enabled';
  -- معلّقة منتهية لا تمنع دعوة جديدة (كانت تصطدم بالفهرس الفريد)
  UPDATE public.company_membership_invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '2 days'
   WHERE invited_email = 'a1b@tenancy.test';
  r3 := t.call(t.u('OA'), 'public.company_invite_customer(''a1b@tenancy.test'')');
  PERFORM t.ok(r3 ->> 'existing' = 'false'
           AND (SELECT array_agg(status ORDER BY created_at) FROM public.company_membership_invitations WHERE invited_email = 'a1b@tenancy.test')
               = array['expired', 'pending'], '② expired pending replaced');
  RAISE NOTICE 'PASS ② الدعوة تعيد معرّفها، صف واحد للبريد، ورفض الخاطئ وغير المخوَّل والمفتاح المطفأ';
END $$;

-- ══ ③ تحضير البريد ونتيجته ══════════════════════════════════════════════
DO $$
DECLARE inv uuid := t.inv('CA', 'late@tenancy.test'); p jsonb; p2 jsonb; tok text; old_tok text; i int;
BEGIN
  PERFORM t.ok(t.col(inv, 'email_status') = 'not_sent', '③ starts not_sent');
  p := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv));
  tok := p ->> 'token';
  PERFORM t.ok(p ->> 'send' = 'true' AND tok ~ '^[0-9a-f]{64}$' AND p ->> 'email' = 'late@tenancy.test'
           AND p ->> 'company_name' = 'شركة أ' AND p ->> 'attempt' = '1', '③ first send');
  PERFORM t.ok(t.col(inv, 'token_hash') = encode(extensions.digest(tok, 'sha256'), 'hex'), '③ only the hash stored');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.company_membership_invitations x WHERE x::text LIKE '%' || tok || '%'), '③ token never stored');
  PERFORM t.ok(t.col(inv, 'email_status') = 'sending', '③ sending');
  -- متزامن: لا إرسالين
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, true)', inv)) ->> 'reason' = 'in_flight', '③ in flight');
  -- قَبِل المزوّد
  PERFORM t.ok(t.svcj(format('public._company_invitation_email_result(%L::uuid, true, ''msg_123'', null)', inv)) ->> 'recorded' = 'true', '③ recorded');
  PERFORM t.ok(t.col(inv, 'email_status') = 'sent' AND t.col(inv, 'email_message_id') = 'msg_123' AND t.col(inv, 'email_sent_at') IS NOT NULL, '③ sent');
  -- نتيجة ثانية لا تغيّر شيئًا (ليست «sending»)
  PERFORM t.ok(t.svcj(format('public._company_invitation_email_result(%L::uuid, false, null, ''rejected'')', inv)) ->> 'recorded' = 'false'
           AND t.col(inv, 'email_status') = 'sent', '③ late result ignored');
  -- أُرسلت: لا إرسال ثانٍ بلا طلب صريح، ولا قبل المهلة
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv)) ->> 'reason' = 'already_sent', '③ no duplicate');
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, true)', inv)) ->> 'reason' = 'cooldown', '③ cooldown');
  PERFORM t.age(inv, 61);
  old_tok := tok;
  INSERT INTO t.saved VALUES ('late_old_token', old_tok);
  p2 := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, true)', inv));
  tok := p2 ->> 'token';
  PERFORM t.ok(p2 ->> 'send' = 'true' AND tok <> old_tok AND p2 ->> 'attempt' = '2', '③ explicit resend = new token');
  -- رفض المزوّد: failed برمز داخلي قصير، ونص حر يُستبدل
  PERFORM t.svcj(format('public._company_invitation_email_result(%L::uuid, false, null, %L)', inv, 'Domain not verified: <b>x</b>'));
  PERFORM t.ok(t.col(inv, 'email_status') = 'failed' AND t.col(inv, 'email_error') = 'provider_error', '③ failed, sanitized');
  -- الفشل يُعاد بلا طلب صريح بعد المهلة
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv)) ->> 'reason' = 'cooldown', '③ failed waits');
  PERFORM t.age(inv, 61);
  p2 := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv));
  tok := p2 ->> 'token';
  PERFORM t.svcj(format('public._company_invitation_email_result(%L::uuid, false, null, ''rate_limited'')', inv));
  PERFORM t.ok(p2 ->> 'attempt' = '3' AND t.col(inv, 'email_error') = 'rate_limited', '③ retry after failure');
  -- حد المحاولات
  FOR i IN 1..2 LOOP
    PERFORM t.age(inv, 61);
    tok := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv)) ->> 'token';
    PERFORM t.svcj(format('public._company_invitation_email_result(%L::uuid, false, null, ''network'')', inv));
  END LOOP;
  PERFORM t.age(inv, 61);
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv)) ->> 'reason' = 'too_many_attempts'
           AND t.col(inv, 'email_attempts') = '5', '③ attempts capped');
  -- الرمز الأخير يبقى صالحًا (آخر رابط مُرسل)
  INSERT INTO t.saved VALUES ('late_token', tok);
  -- معرّف عشوائي أو دعوة غير معلّقة
  PERFORM t.ok(t.svcj('public._company_invitation_prepare_email(gen_random_uuid(), false)') ->> 'reason' = 'not_pending', '③ unknown id');
  RAISE NOTICE 'PASS ③ رمز مجزّأ وحده، لا تكرار ولا تزامن، مهلة 60 ثانية، 5 محاولات، ورمز خطأ داخلي';
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  -- حد الشركة اليومي: 100 دعوة جرت محاولتها خلال 24 ساعة
  INSERT INTO public.company_membership_invitations (company_id, invited_email, invited_by, email_status, email_attempts, email_last_attempt_at)
  SELECT t.u('CB'), 'bulk' || g || '@tenancy.test', t.u('OB'), 'sent', 1, now() - interval '1 hour' FROM generate_series(1, 100) g;
  r := t.call(t.u('OB'), 'public.company_invite_customer(''one-more@tenancy.test'')');
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', r ->> 'invitation_id')) ->> 'reason' = 'company_daily_cap',
               '③ company daily cap');
  -- شركة أخرى غير متأثرة
  r := t.call(t.u('OA'), 'public.company_invite_customer(''a-ok@tenancy.test'')');
  PERFORM t.ok(t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', r ->> 'invitation_id')) ->> 'send' = 'true',
               '③ cap is per company');
  DELETE FROM public.company_membership_invitations WHERE company_id = t.u('CB') AND invited_email LIKE 'bulk%';
  RAISE NOTICE 'PASS ③ حد 100 بريد للشركة في 24 ساعة، لكل شركة على حدة';
END $$;

-- ══ ④ الربط بالرابط ثم القبول ════════════════════════════════════════════
-- حساب يُنشأ بعد الدعوة (LATE)، وحساب آخر (A2) معه الرابط، وحساب ببريد غير مؤكَّد
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('0a000000-0000-4000-8000-0000000000aa', 'late@tenancy.test', now()),
  ('0a000000-0000-4000-8000-0000000000ab', 'unconfirmed@tenancy.test', null);
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('0a000000-0000-4000-8000-0000000000aa', 'late@tenancy.test', 'عميل متأخر', 'user', '01100000031', '2026-09-01'),
  ('0a000000-0000-4000-8000-0000000000ab', 'unconfirmed@tenancy.test', 'غير مؤكَّد', 'user', '01100000032', '2026-09-01');
DO $$
DECLARE tok text := (SELECT v FROM t.saved WHERE k = 'late_token');
        late uuid := '0a000000-0000-4000-8000-0000000000aa';
        unc  uuid := '0a000000-0000-4000-8000-0000000000ab';
        inv uuid := t.inv('CA', 'late@tenancy.test');
        r jsonb; e_wrong text; e_missing text;
BEGIN
  PERFORM t.ok(t.call(late, 'public.my_company_invitations()') = '[]'::jsonb, '④ not visible before claim');
  -- حساب آخر معه الرابط: نفس رفض الرمز غير الموجود
  e_wrong   := t.errfull(t.u('A2'), format('public.company_invitation_claim(%L)', tok));
  e_missing := t.errfull(t.u('A2'), format('public.company_invitation_claim(%L)', repeat('ab', 32)));
  PERFORM t.ok(e_wrong = e_missing AND e_wrong LIKE 'P0002|%', '④ other account: no oracle');
  PERFORM t.ok(t.errfull(unc, format('public.company_invitation_claim(%L)', tok)) = e_missing, '④ unconfirmed email refused');
  PERFORM t.ok(t.err(late, 'public.company_invitation_claim(''short'')') = 'P0002', '④ malformed token');
  PERFORM t.ok(t.err(NULL, format('public.company_invitation_claim(%L)', tok)) = '42501', '④ anonymous');
  -- رمز قديم أُبدل بإعادة الإرسال
  PERFORM t.ok(t.err(late, format('public.company_invitation_claim(%L)', (SELECT v FROM t.saved WHERE k = 'late_old_token'))) = 'P0002', '④ stale token');
  -- صاحب البريد المؤكَّد
  r := t.call(late, format('public.company_invitation_claim(%L)', tok));
  PERFORM t.ok((r ->> 'invitation_id')::uuid = inv AND r ->> 'company_name' = 'شركة أ' AND r ->> 'account_active' = 'true', '④ claimed');
  PERFORM t.ok(t.col(inv, 'invitee_user_id') = late::text, '④ linked');
  PERFORM t.ok(t.call(late, format('public.company_invitation_claim(%L)', tok)) ->> 'invitation_id' = inv::text, '④ claim idempotent');
  PERFORM t.ok(t.call(late, 'public.my_company_invitations()') -> 0 ->> 'id' = inv::text, '④ now visible in portal');
  -- القبول (096 كما هو): عميل في شركة أ وحدها، لا فريق
  PERFORM t.ok(t.call(late, format('public.company_invitation_respond(%L::uuid, true)', inv)) ->> 'accepted' = 'true', '④ accepted');
  PERFORM t.ok((SELECT array_agg(company_id) FROM public.company_memberships WHERE user_id = late AND status = 'active') = array[t.u('CA')],
               '④ member of company A only');
  PERFORM t.ok(t.call(late, 'public.company_staff_role()') IS NULL
           AND t.call(late, 'public.my_account_kind()') #>> '{}' = 'company_customer', '④ customer, not staff');
  PERFORM t.ok(t.err(late, format('public.company_invitation_claim(%L)', tok)) = 'P0002', '④ claim after accept refused');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_invitations_list()') @> jsonb_build_array(jsonb_build_object('id', inv, 'status', 'accepted')),
               '④ company sees accepted');
  RAISE NOTICE 'PASS ④ الرابط يربط صاحب البريد المؤكَّد وحده بلا كاشف، والقبول عضوية عميل في شركتها وحدها';
END $$;

-- حساب في قائمة الانتظار: يُربط، ولا يقبل حتى يُفعَّل
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('0a000000-0000-4000-8000-0000000000ac', 'wait@tenancy.test', now());
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
VALUES ('0a000000-0000-4000-8000-0000000000ac', 'wait@tenancy.test', 'منتظر', 'user', '01100000033', now());
DO $$
DECLARE w uuid := '0a000000-0000-4000-8000-0000000000ac'; r jsonb; p jsonb; inv uuid;
BEGIN
  r := t.call(t.u('OA'), 'public.company_invite_customer(''wait@tenancy.test'')');
  inv := (r ->> 'invitation_id')::uuid;
  p := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', inv));
  PERFORM t.ok(t.call(w, format('public.company_invitation_claim(%L)', p ->> 'token')) ->> 'account_active' = 'false', '④ waitlisted: linked, inactive');
  PERFORM t.ok(t.err(w, format('public.company_invitation_respond(%L::uuid, true)', inv)) = '42501', '④ waitlisted cannot accept yet');
  RAISE NOTICE 'PASS ④ حساب قائمة الانتظار يُربط ولا يقبل قبل التفعيل';
END $$;

-- ══ ⑤ العزل بين الشركات ═════════════════════════════════════════════════
DO $$
DECLARE inv uuid := t.inv('CA', 'a-ok@tenancy.test'); r jsonb; p jsonb;
BEGIN
  PERFORM t.ok(NOT (t.call(t.u('OB'), 'public.company_invitations_list()')::text LIKE '%' || inv::text || '%'), '⑤ B does not list A');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_invitation_cancel(%L::uuid)', inv)) = 'P0002', '⑤ B cannot cancel A');
  -- نفس البريد في شركتين: دعوتان مستقلتان، ورمز كلٍّ لا يربط الأخرى
  r := t.call(t.u('OB'), 'public.company_invite_customer(''pu@tenancy.test'')');
  p := t.svcj(format('public._company_invitation_prepare_email(%L::uuid, false)', r ->> 'invitation_id'));
  PERFORM t.ok(t.call(t.u('PU'), format('public.company_invitation_claim(%L)', p ->> 'token')) ->> 'company_name' = 'شركة ب', '⑤ token bound to its company');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_invitations_list()') -> 0 ? 'email_status', '⑤ list exposes email_status');
  PERFORM t.ok(NOT (t.call(t.u('OA'), 'public.company_invitations_list()')::text ~ 'token|invitee_user_id|email_error|message_id'),
               '⑤ list hides token, invitee and provider details');
  RAISE NOTICE 'PASS ⑤ لا ترى شركة دعوات غيرها ولا تلغيها، والرمز مربوط بشركته';
END $$;

-- ══ ⑥ التراجع وإعادة التطبيق ═════════════════════════════════════════════
\i migrations/_rollback/112_company_invitation_email.down.sql
DO $$
BEGIN
  PERFORM t.ok(t.digest6() = 'company_invitations_list:7216142626e934398acf959a71e9fd68,company_invite_customer:e7b07d28a7bc6cc8f26715b91d533e2e',
               '⑥ exact prod bodies restored');
  PERFORM t.ok(to_regprocedure('public.company_invitation_claim(text)') IS NULL
           AND to_regprocedure('public._company_invitation_prepare_email(uuid, boolean)') IS NULL
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'company_membership_invitations' AND column_name = 'token_hash'),
               '⑥ objects removed');
END $$;
\i migrations/112_company_invitation_email.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_invite_customer(''again@tenancy.test'')') ? 'invitation_id', '⑥ re-applied');
  RAISE NOTICE 'PASS ⑥ التراجع يعيد نصّي الإنتاج حرفيًا، وإعادة التطبيق تعمل';
END $$;

SELECT 'ALL COMPANY INVITATION EMAIL TESTS PASSED';
