-- ============================================================================
-- 121: مركز سلطة المالك وأمانه — على نسخة مطابقة للإنتاج حتى 117، مع auth.sessions وأعمدة auth.users
-- كما في Supabase Auth.
--
--   ① جلسة التحرير: مدة السياسة تُفرض في القاعدة، تقصيرها يسري فورًا، الانتهاء يغلق، الرمز لا يُعاد،
--      رمز الاسترداد يُستهلك ويُنبَّه، وسجل الجلسات وعملياتها
--   ② السياسة: للمالك وحده بعد التحقق، رفض الآخرين يُسجَّل، حدود القيم
--   ③ سجل الأمان: لا تعديل ولا حذف ولا TRUNCATE ولا إضافة من جلسة، المالك وحده يقرأ، والسلسلة تكشف العبث
--   ④ مصفوفة الصلاحيات: الافتراضي = السلوك الحالي، المالك يقيّد admin/support فتفرضها القاعدة، المالك لا يُقيَّد،
--      وما يحتاج تحققًا للمالك يرفض بلا جلسة تحرير
--   ⑤ سجل التغييرات والتراجع
--   ⑥ مراقبة الدخول: auth.sessions ⇒ دخول/خروج بـIP، IP مشترك، تنبيه دخول المالك من IP جديد، والدخول لا يُكسر
--   ⑦ الجلسات والأجهزة: قائمة، إلغاء، خروج عام، وحماية الجلسة الحالية
--   ⑧ كلمة مرور المالك وبريده: الحجز، التنبيه، الموافقة بتحقق، الرفض برمز، والحسابات الأخرى بلا تغيير
--   ⑨ التراجع يعيد 053 حرفيًا، ثم يُعاد 121
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
\i migrations/112_company_invitation_email.sql
\i migrations/113_company_member_management.sql
\i migrations/114_ticket_email_payload.sql
\i migrations/115_pi_network_integration.sql
\i migrations/116_pi_auto_settlement.sql
\i migrations/117_owner_admin_parity.sql
SET search_path = public, extensions;

-- ── Supabase Auth كما في الإنتاج (information_schema على srnelrdpqkcntbgudyto) ──
CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), factor_id uuid, aal auth.aal_level,
  not_after timestamptz, refreshed_at timestamp, user_agent text, ip inet, tag text);
CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, token text, user_id text, revoked boolean,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE);
ALTER TABLE auth.users ADD COLUMN encrypted_password text, ADD COLUMN email_change text DEFAULT '',
  ADD COLUMN email_change_token_new text DEFAULT '', ADD COLUMN email_change_token_current text DEFAULT '',
  ADD COLUMN email_change_sent_at timestamptz, ADD COLUMN updated_at timestamptz;
UPDATE auth.users SET email_confirmed_at = now() - interval '30 days', encrypted_password = '$2a$10$old-' || id::text;

-- 053 قبل 121: بصمة الدوال الثلاث التي يعيد 121 تعريفها (يُعيدها التراجع حرفيًا)
CREATE TABLE t.fp (name text PRIMARY KEY, md5 text);
INSERT INTO t.fp SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('owner_step_up', 'log_privileged', 'owner_security_status');

\i migrations/121_owner_security_center.sql
\i migrations/121_owner_security_center.sql
SET search_path = public, extensions;

-- ── أدوات: هوية بجلسة دخول محددة (session_id = معرّف صف auth.sessions) ──
CREATE FUNCTION t.callx(p uuid, p_sess text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', p::text, false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated', 'session_id', p_sess)::text, false);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.totp(p_offset int DEFAULT 0) RETURNS text LANGUAGE sql AS $$
  select public._totp_code(public._base32_decode('JBSWY3DPEHPK3PXP'), floor(extract(epoch from now()) / 30)::bigint + p_offset) $$;
CREATE FUNCTION t.reset_counter() RETURNS void LANGUAGE sql AS $$
  update public.privileged_step_ups set last_counter = 0 where user_id = t.u('OW');
  update public.twofa_rate_limits set failed_attempts = 0, locked_until = null where user_id = t.u('OW') $$;
CREATE FUNCTION t.ev(p_type text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.security_events where event_type = p_type $$;
CREATE FUNCTION t.calls(p_kind text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from net._calls where url like '%/security-alert' and body ->> 'kind' = p_kind $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO public.user_mfa_secrets (user_id, totp_secret, recovery_code_hashes)
VALUES (t.u('OW'), 'JBSWY3DPEHPK3PXP', array[public.hash_recovery_code('ABCDEFGHJK'), public.hash_recovery_code('MNPQRSTUVW')]);
INSERT INTO public.advanced_settings (key, value) VALUES ('sec_probe', '"v1"'::jsonb);
DO $$ BEGIN PERFORM t.ctx('owner'); END $$;

-- ══ ① جلسة التحرير ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_exp timestamptz;
BEGIN
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_step_up(''000000'')') ->> 'error' = 'invalid_code', '① رمز خاطئ');
  PERFORM t.ok(t.ev('step_up.failed') = 1, '① الفشل في سجل الأمان');
  PERFORM t.reset_counter();
  r := t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.ok((r ->> 'verified')::boolean and r ->> 'method' = 'totp' and (r ->> 'minutes')::int = 10, '① TOTP بالمدة الافتراضية 10: ' || r::text);
  v_exp := (r ->> 'expires_at')::timestamptz;
  PERFORM t.ok(v_exp between now() + interval '9 minutes 50 seconds' and now() + interval '10 minutes 10 seconds', '① النافذة 10 دقائق');
  PERFORM t.ok(t.call(t.u('OW'), 'public.step_up_fresh()')::text = 'true', '① مفتوحة');
  -- نفس الرمز مرة ثانية: لا إعادة
  PERFORM t.ok(t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp())) ->> 'error' = 'invalid_code', '① لا إعادة للرمز');
  PERFORM t.reset_counter();

  -- جلسة غير جلسة الدخول نفسها ⇒ مغلقة
  PERFORM t.ok(t.callx(t.u('OW'), 'another-session', 'public.step_up_fresh()')::text = 'false', '① مربوطة بجلسة الدخول');

  -- المدة من السياسة
  r := t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 5}''::jsonb)');
  PERFORM t.ok((r ->> 'ok')::boolean, '① ضبط 5 دقائق: ' || r::text);
  PERFORM t.ok((SELECT expires_at <= verified_at + interval '5 minutes' FROM public.privileged_step_ups WHERE user_id = t.u('OW')),
               '① التقصير يسري على الجلسة المفتوحة فورًا');
  PERFORM t.ok((SELECT expires_at <= started_at + interval '5 minutes' FROM public.owner_step_up_sessions
                 WHERE user_id = t.u('OW') AND ended_at IS NULL), '① وفي سجل الجلسة');
  r := t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.ok((r ->> 'minutes')::int = 5 and (r ->> 'expires_at')::timestamptz <= now() + interval '5 minutes 1 second', '① جلسة جديدة بـ5 دقائق');
  PERFORM t.ok((SELECT count(*) FROM public.owner_step_up_sessions WHERE user_id = t.u('OW') AND end_reason = 'replaced') >= 1,
               '① الجلسة السابقة «استُبدلت»');
  PERFORM t.reset_counter();

  -- انتهاء المهلة ⇒ العمليات الحساسة مغلقة في القاعدة
  UPDATE public.privileged_step_ups SET expires_at = now() - interval '1 second' WHERE user_id = t.u('OW');
  PERFORM t.ok(t.call(t.u('OW'), 'public.step_up_fresh()')::text = 'false', '① المنتهية مغلقة');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 15}''::jsonb)') ->> 'error' = 'step_up_required',
               '① تعديل السياسة بعد الانتهاء مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_set_staff_role(%L::uuid, ''support'')', t.u('AD'))) = '42501',
               '① عمليات 053 الحرجة مغلقة بعد الانتهاء');

  -- رمز الاسترداد: يفتح جلسة، يُستهلك، ويُنبَّه
  r := t.call(t.u('OW'), 'public.owner_step_up(''abcdefghjk'')');
  PERFORM t.ok((r ->> 'verified')::boolean and r ->> 'method' = 'recovery_code', '① رمز الاسترداد: ' || r::text);
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_step_up(''ABCDEFGHJK'')') ->> 'error' = 'invalid_code', '① يُستهلك');
  PERFORM t.ok((SELECT array_length(recovery_code_hashes, 1) FROM public.user_mfa_secrets WHERE user_id = t.u('OW')) = 1, '① بقي رمز واحد');
  PERFORM t.ok((SELECT severity FROM public.security_events WHERE event_type = 'step_up.verified' ORDER BY id DESC LIMIT 1) = 'critical',
               '① استخدام رمز الاسترداد حدث حرج');
  PERFORM t.ok(t.calls('recovery_code_used') = 1, '① وتنبيه بالبريد');
  PERFORM t.ok((t.call(t.u('OW'), 'public.owner_security_status()') ->> 'recovery_codes_left')::int = 1, '① الحالة تعرض الرموز المتبقية');

  -- إنهاء يدوي
  PERFORM t.ok((t.call(t.u('OW'), 'public.owner_end_step_up()') ->> 'ok')::boolean, '① إنهاء يدوي');
  PERFORM t.ok(t.call(t.u('OW'), 'public.step_up_fresh()')::text = 'false', '① أُغلقت');
  PERFORM t.ok(t.call(t.u('AD'), 'public.owner_end_step_up()') ->> 'error' = 'forbidden', '① الأدمن لا ينهي جلسة');
  RAISE NOTICE 'PASS ① جلسة التحرير: المدة من السياسة، التقصير فوري، الانتهاء يغلق، لا إعادة للرمز، رمز الاسترداد يُستهلك ويُنبَّه';
END $$;

-- ══ ② السياسة ═══════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.reset_counter();
  PERFORM t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 0}''::jsonb)') ->> 'error' = 'out_of_range', '② أقل من دقيقة');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 241}''::jsonb)') ->> 'error' = 'out_of_range', '② أكثر من 4 ساعات');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_security_policy(''{"role": "x"}''::jsonb)') ->> 'error' = 'invalid', '② مفتاح غير معروف');
  r := t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 30, "shared_ip_window_days": 14}''::jsonb)');
  PERFORM t.ok((r ->> 'ok')::boolean and (r #>> '{policy,step_up_minutes}')::int = 30, '② 30 دقيقة');

  FOREACH r IN ARRAY array[to_jsonb('AD'::text), to_jsonb('EA'::text), to_jsonb('SUP'::text), to_jsonb('PU'::text)] LOOP
    PERFORM t.ok(t.call(t.u(r #>> '{}'), 'public.owner_set_security_policy(''{"step_up_minutes": 240}''::jsonb)') ->> 'error' = 'forbidden',
                 '② ' || (r #>> '{}') || ' مرفوض');
  END LOOP;
  PERFORM t.ok((SELECT step_up_minutes FROM public.owner_security_policy) = 30, '② لم يتغير شيء');
  PERFORM t.ok(t.ev('access.denied') >= 4, '② كل رفض مسجَّل في سجل الأمان');
  PERFORM t.ok(t.exec(t.u('AD'), 'update public.owner_security_policy set step_up_minutes = 240') <> 'ok', '② لا كتابة مباشرة للأدمن');
  PERFORM t.ok(t.affected(t.u('OW'), 'update public.owner_security_policy set step_up_minutes = 240') <= 0, '② ولا للمالك (الدالة وحدها)');
  -- المالك في سياق الإدارة: ليس داخل واجهته ⇒ مرفوض
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_security_policy(''{"step_up_minutes": 20}''::jsonb)') ->> 'error' = 'forbidden', '② سياق الإدارة');
  PERFORM t.ctx('owner');
  -- سجل الجلسات: عملية تعديل السياسة مربوطة بالجلسة
  r := t.call(t.u('OW'), 'public.owner_step_up_history(10)');
  PERFORM t.ok((r -> 0 ->> 'active')::boolean and (r -> 0 ->> 'operations')::int >= 1, '② عمليات الجلسة تُعدّ: ' || (r -> 0)::text);
  PERFORM t.ok(r -> 0 -> 'audit_actions' @> '[{"action": "security_policy.set"}]', '② وتُسمّى');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_step_up_history(10)') = '42501', '② السجل للمالك');
  RAISE NOTICE 'PASS ② السياسة: للمالك داخل واجهته بعد التحقق، حدود القيم، رفض الآخرين مسجَّل، وعمليات كل جلسة مربوطة بها';
END $$;

-- ══ ③ سجل الأمان ════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  v_n := (SELECT count(*) FROM public.security_events);
  PERFORM t.ok(v_n > 0, '③ سجل غير فارغ');
  PERFORM t.ok(t.rows(t.u('OW'), 'public.security_events') = v_n, '③ المالك يقرأ كله');
  PERFORM t.ok(t.rows(t.u('AD'), 'public.security_events') = 0 and t.rows(t.u('EA'), 'public.security_events') = 0
               and t.rows(t.u('SUP'), 'public.security_events') = 0, '③ الأدمن والمرتفع والدعم لا يقرؤون');
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.security_events (event_type, hash) values (''x.y'', ''h'')') = '42501', '③ لا إضافة من جلسة');
  PERFORM t.ok(t.exec(t.u('OW'), 'delete from public.security_events') = '42501', '③ لا حذف للمالك');
  BEGIN UPDATE public.security_events SET severity = 'info'; RAISE EXCEPTION 'FAIL ③ superuser عدّل';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.security_events; RAISE EXCEPTION 'FAIL ③ superuser حذف';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.security_events; RAISE EXCEPTION 'FAIL ③ TRUNCATE';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- service_role (الدوال الطرفية): إضافة فقط، والبصمة تُحسب في القاعدة لا من المُرسل
  SET LOCAL ROLE service_role;
  INSERT INTO public.security_events (event_type, severity, target_email, ip, details, source, hash, prev_hash)
  VALUES ('auth.login_failed', 'warning', 'pu@tenancy.test', '203.0.113.9', '{"reason":"invalid_credentials"}', 'client_report', 'forged', 'forged');
  RESET ROLE;
  PERFORM t.ok((SELECT hash <> 'forged' AND prev_hash <> 'forged' FROM public.security_events ORDER BY id DESC LIMIT 1), '③ البصمة لا تُزوَّر');

  r := t.call(t.u('OW'), 'public.owner_verify_security_log()');
  PERFORM t.ok((r ->> 'ok')::boolean and (r ->> 'checked')::int = v_n + 1, '③ السلسلة سليمة: ' || r::text);
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_verify_security_log()') = '42501', '③ التحقق للمالك');

  -- عبث بصلاحية superuser (تعطيل المحفّز) ⇒ يُكشف. داخل معاملة فرعية تُلغى
  BEGIN
    ALTER TABLE public.security_events DISABLE TRIGGER trg_security_events_chain;
    UPDATE public.security_events SET details = '{"tampered":true}' WHERE id = (SELECT min(id) + 1 FROM public.security_events);
    ALTER TABLE public.security_events ENABLE TRIGGER trg_security_events_chain;
    r := t.call(t.u('OW'), 'public.owner_verify_security_log()');
    PERFORM t.ok(NOT (r ->> 'ok')::boolean AND (r ->> 'broken_at')::bigint = (SELECT min(id) + 1 FROM public.security_events), '③ العبث مكشوف: ' || r::text);
    RAISE EXCEPTION 'rollback-tamper';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-tamper' THEN RAISE; END IF;
  END;
  PERFORM t.ok((t.call(t.u('OW'), 'public.owner_verify_security_log()') ->> 'ok')::boolean, '③ وبعد الإلغاء سليمة');
  RAISE NOTICE 'PASS ③ سجل الأمان: لا تعديل/حذف/TRUNCATE حتى من superuser، لا إضافة من جلسة، المالك وحده يقرأ، والعبث مكشوف';
END $$;

-- ══ ④ مصفوفة الصلاحيات ══════════════════════════════════════════════════
INSERT INTO public.tickets (id, user_id, title, description, status)
VALUES ('7c000000-0000-4000-8000-000000000001', t.u('PU'), 'تذكرة 121', 'وصف', 'open');
DO $$
DECLARE r jsonb; e text;
BEGIN
  -- الافتراضي = السلوك الحالي
  PERFORM t.ok(t.affected(t.u('AD'), 'update public.advanced_settings set value = ''"a1"'' where key = ''sec_probe''') = 1, '④ الأدمن يعدّل الإعدادات افتراضيًا');
  PERFORM t.ok(t.exec(t.u('SUP'), 'insert into public.ticket_replies (ticket_id, user_id, message) values (''7c000000-0000-4000-8000-000000000001'', ''' || t.u('SUP') || ''', ''رد الدعم'')') = 'ok',
               '④ الدعم يرد افتراضيًا');

  -- المالك: الإعدادات تتطلب جلسة تحرير (افتراضي settings.manage)
  PERFORM t.call(t.u('OW'), 'public.owner_end_step_up()');
  e := t.errfull(t.u('OW'), 'public.staff_write_ok(''settings.manage'')');
  PERFORM t.ok(e LIKE '42501|%جلسة تحرير%', '④ المالك بلا جلسة: ' || e);
  PERFORM t.ok(t.exec(t.u('OW'), 'update public.advanced_settings set value = ''"o1"'' where key = ''sec_probe''') = '42501',
               '④ RLS ترفض تعديل المالك للإعدادات بلا جلسة');
  r := t.call(t.u('OW'), 'public.my_permission_status(''settings.manage'')');
  PERFORM t.ok((r ->> 'step_up_required')::boolean and not (r ->> 'step_up_fresh')::boolean, '④ الواجهة تعرف أن الإجراء يحتاج تحققًا');
  -- ما لا يحتاج تحققًا للمالك: يمر
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.knowledge_base (title, category, content, status) values (''ك'', ''general'', ''م'', ''draft'')') = 'ok',
               '④ قاعدة المعرفة للمالك بلا جلسة (افتراضيها)');
  PERFORM t.reset_counter();
  PERFORM t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.ok(t.affected(t.u('OW'), 'update public.advanced_settings set value = ''"o1"'' where key = ''sec_probe''') = 1, '④ وبجلسة تمر');

  -- المالك يقيّد الأدمن
  PERFORM t.ok(t.call(t.u('AD'), 'public.owner_set_role_permission(''admin'', ''settings.manage'', ''allowed'', false)') ->> 'error' = 'forbidden', '④ الأدمن لا يغيّر المصفوفة');
  PERFORM t.ok(t.call(t.u('EA'), 'public.owner_set_role_permission(''admin'', ''settings.manage'', ''allowed'', false)') ->> 'error' = 'forbidden', '④ ولا المرتفع');
  PERFORM t.ok(t.exec(t.u('EA'), 'insert into public.role_permission_rules (role, permission, allowed) values (''admin'', ''users.ban'', true)') = '42501', '④ لا كتابة مباشرة');
  r := t.call(t.u('OW'), 'public.owner_set_role_permission(''admin'', ''settings.manage'', ''allowed'', false)');
  PERFORM t.ok((r ->> 'ok')::boolean, '④ المالك يمنع الإعدادات عن الأدمن: ' || r::text);
  e := t.errfull(t.u('AD'), 'public.staff_write_ok(''settings.manage'')');
  PERFORM t.ok(e LIKE '42501|%معطّلة لدور admin%', '④ رسالة واضحة: ' || e);
  PERFORM t.ok(t.exec(t.u('AD'), 'update public.advanced_settings set value = ''"a2"'' where key = ''sec_probe''') = '42501', '④ RLS ترفض الأدمن');
  PERFORM t.ok(t.exec(t.u('EA'), 'update public.working_hours set auto_reply_text = ''x''') = '42501' OR (SELECT count(*) FROM public.working_hours) = 0,
               '④ والمرتفع (رتبته admin)');
  PERFORM t.ok(t.exec(t.u('AD'), 'insert into public.advanced_settings (key, value) values (''sec_new'', ''1'')') = '42501', '④ ولا إضافة');
  PERFORM t.ok(t.exec(t.u('AD'), 'insert into public.knowledge_base (title, category, content, status) values (''ك2'', ''general'', ''م'', ''draft'')') = 'ok',
               '④ صلاحية أخرى تبقى');
  PERFORM t.ok((t.call(t.u('AD'), 'public.my_permission_status(''settings.manage'')') ->> 'allowed')::boolean = false, '④ الأدمن يعرف حالته');
  PERFORM t.ok((SELECT value FROM public.advanced_settings WHERE key = 'sec_probe') = '"o1"'::jsonb, '④ لم يتغير شيء');

  -- الحظر والرتبة: محفّز profiles
  PERFORM t.call(t.u('OW'), 'public.owner_set_role_permission(''admin'', ''users.ban'', ''allowed'', false)');
  PERFORM t.ok(t.exec(t.u('AD'), format('update public.profiles set ban_status = ''permanent'' where id = %L', t.u('PU'))) = '42501', '④ الأدمن لا يحظر');
  PERFORM t.ok(t.exec(t.u('PU'), format('update public.profiles set full_name = ''حساب فرد'' where id = %L', t.u('PU'))) = 'ok', '④ تعديل الحساب لنفسه بلا تأثير');
  PERFORM t.call(t.u('OW'), 'public.owner_set_role_permission(''admin'', ''users.ban'', ''allowed'', true)');
  PERFORM t.ok(t.affected(t.u('AD'), format('update public.profiles set ban_status = ''permanent'', ban_reason = ''اختبار'' where id = %L', t.u('PU'))) = 1, '④ إعادة السماح');
  PERFORM t.ok(t.affected(t.u('AD'), format('update public.profiles set ban_status = ''none'', ban_reason = null where id = %L', t.u('PU'))) = 1, '④ رفع الحظر');

  -- الرد على التذاكر للدعم، والعميل بلا تأثير
  PERFORM t.call(t.u('OW'), 'public.owner_set_role_permission(''support'', ''tickets.reply'', ''allowed'', false)');
  PERFORM t.ok(t.exec(t.u('SUP'), 'insert into public.ticket_replies (ticket_id, user_id, message) values (''7c000000-0000-4000-8000-000000000001'', ''' || t.u('SUP') || ''', ''x'')') = '42501',
               '④ الدعم لا يرد');
  PERFORM t.ok(t.exec(t.u('PU'), 'insert into public.ticket_replies (ticket_id, user_id, message) values (''7c000000-0000-4000-8000-000000000001'', ''' || t.u('PU') || ''', ''رد العميل'')') = 'ok',
               '④ العميل يرد على تذكرته كما كان');
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.ticket_replies (ticket_id, user_id, message) values (''7c000000-0000-4000-8000-000000000001'', ''' || t.u('OW') || ''', ''رد المالك'')') = 'ok',
               '④ المالك يرد من سياقه');

  -- حماية من الإقفال: المالك لا يُقيَّد
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_role_permission(''platform_owner'', ''settings.manage'', ''allowed'', false)') ->> 'error' = 'invalid', '④ المالك لا يُمنع');
  BEGIN INSERT INTO public.role_permission_rules (role, permission, allowed) VALUES ('platform_owner', 'blog.manage', false);
        RAISE EXCEPTION 'FAIL ④ قيد المالك';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.role_permission_rules (role, permission, require_step_up) VALUES ('admin', 'blog.manage', true);
        RAISE EXCEPTION 'FAIL ④ قيد step-up';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- المالك يجعل المدوّنة تحتاج تحققًا لنفسه
  PERFORM t.ok((t.call(t.u('OW'), 'public.owner_set_role_permission(''platform_owner'', ''blog.manage'', ''require_step_up'', true)') ->> 'ok')::boolean, '④ تحقق للمدوّنة');
  r := t.call(t.u('OW'), 'public.owner_permission_matrix()');
  PERFORM t.ok(r -> 'permissions' @> '[{"key": "settings.manage", "admin": false, "support": true, "owner_step_up": true}]'
               and r -> 'permissions' @> '[{"key": "blog.manage", "owner_step_up": true}]', '④ المصفوفة تعكس القرارات');
  PERFORM t.ok(t.call(t.u('AD'), 'public.owner_permission_matrix()') ->> 'error' = 'forbidden', '④ المصفوفة للمالك');
  PERFORM t.ok(t.ev('permission.changed') = 5, '④ كل تغيير في سجل الأمان');
  -- بلا جلسة: تعديل المصفوفة مرفوض
  PERFORM t.call(t.u('OW'), 'public.owner_end_step_up()');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_role_permission(''admin'', ''settings.manage'', ''allowed'', true)') ->> 'error' = 'step_up_required', '④ المصفوفة تتطلب جلسة');
  RAISE NOTICE 'PASS ④ المصفوفة: الافتراضي كما كان، المالك يقيّد admin/support فتفرضها RLS والمحفّز، المالك لا يُقيَّد، وما يحتاج تحققًا يرفض بلا جلسة';
END $$;

-- ══ ⑤ سجل التغييرات والتراجع ═══════════════════════════════════════════
DO $$
DECLARE r jsonb; v_id bigint;
BEGIN
  PERFORM t.reset_counter();
  PERFORM t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.affected(t.u('OW'), 'update public.advanced_settings set value = ''"o2"'' where key = ''sec_probe''');
  SELECT id INTO v_id FROM public.settings_change_history WHERE table_name = 'advanced_settings' ORDER BY id DESC LIMIT 1;
  PERFORM t.ok((SELECT old_row ->> 'value' = 'o1' AND new_row ->> 'value' = 'o2' AND actor_id = t.u('OW') AND step_up_session IS NOT NULL
                  FROM public.settings_change_history WHERE id = v_id), '⑤ القديم والجديد والفاعل والجلسة');
  r := t.call(t.u('OW'), 'public.owner_change_history(''advanced_settings'', 5, 0)');
  PERFORM t.ok((r -> 'items' -> 0 ->> 'reversible')::boolean, '⑤ قابل للتراجع');
  PERFORM t.ok(t.call(t.u('AD'), format('public.owner_rollback_change(%s)', v_id)) ->> 'error' = 'forbidden', '⑤ الأدمن لا يتراجع');
  r := t.call(t.u('OW'), format('public.owner_rollback_change(%s)', v_id));
  PERFORM t.ok((r ->> 'ok')::boolean, '⑤ تراجع: ' || r::text);
  PERFORM t.ok((SELECT value FROM public.advanced_settings WHERE key = 'sec_probe') = '"o1"'::jsonb, '⑤ القيمة القديمة عادت');
  PERFORM t.ok(t.call(t.u('OW'), format('public.owner_rollback_change(%s)', v_id)) ->> 'error' = 'already_rolled_back', '⑤ مرة واحدة');
  PERFORM t.ok((SELECT rollback_of FROM public.settings_change_history ORDER BY id DESC LIMIT 1) = v_id, '⑤ التراجع نفسه مسجَّل');
  -- تراجع عن إضافة
  PERFORM t.exec(t.u('OW'), 'insert into public.advanced_settings (key, value) values (''sec_added'', ''1'')');
  SELECT id INTO v_id FROM public.settings_change_history WHERE op = 'INSERT' AND new_row ->> 'key' = 'sec_added';
  PERFORM t.call(t.u('OW'), format('public.owner_rollback_change(%s)', v_id));
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.advanced_settings WHERE key = 'sec_added'), '⑤ الإضافة أُزيلت');
  -- السجل لا يُعدَّل
  BEGIN UPDATE public.settings_change_history SET old_row = '{}'; RAISE EXCEPTION 'FAIL ⑤ عُدِّل';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.settings_change_history; RAISE EXCEPTION 'FAIL ⑤ حُذف';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM t.ok(t.rows(t.u('AD'), 'public.settings_change_history') = 0, '⑤ السجل للمالك');
  -- تغييرات المصفوفة والسياسة مسجّلة بالقديم/الجديد
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.settings_change_history WHERE table_name = 'role_permission_rules' AND op = 'UPDATE'
                        AND old_row ->> 'allowed' = 'false' AND new_row ->> 'allowed' = 'true'), '⑤ المصفوفة في السجل');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.settings_change_history WHERE table_name = 'owner_security_policy'), '⑤ والسياسة');
  RAISE NOTICE 'PASS ⑤ سجل التغييرات: القديم/الجديد/الفاعل/الجلسة، تراجع آمن للمالك بعد التحقق، والسجل لا يُعدَّل';
END $$;

-- ══ ⑥ مراقبة الدخول ═════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_calls int := t.calls('owner_new_login');
BEGIN
  INSERT INTO auth.sessions (id, user_id, ip, user_agent, aal) VALUES
    ('5e550000-0000-4000-8000-000000000001', t.u('PU'), '198.51.100.7', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', 'aal1');
  PERFORM t.ok((SELECT ip = '198.51.100.7'::inet AND target_email = 'pu@tenancy.test' AND (details ->> 'new_ip')::boolean
                  FROM public.security_events WHERE event_type = 'auth.login' ORDER BY id DESC LIMIT 1), '⑥ دخول ناجح بالـIP والبريد');
  PERFORM t.ok(t.ev('ip.shared') = 0, '⑥ لا مشاركة بعد');
  INSERT INTO auth.sessions (id, user_id, ip, user_agent) VALUES
    ('5e550000-0000-4000-8000-000000000002', t.u('A1'), '198.51.100.7', 'Mozilla/5.0 (iPhone) Safari/604.1');
  PERFORM t.ok(t.ev('ip.shared') = 1, '⑥ IP مشترك بين حسابين');
  PERFORM t.ok((SELECT details -> 'other_accounts' @> jsonb_build_array(jsonb_build_object('user_id', t.u('PU'), 'email', 'pu@tenancy.test'))
                  FROM public.security_events WHERE event_type = 'ip.shared'), '⑥ يسمّي الحساب الآخر');
  INSERT INTO auth.sessions (user_id, ip) VALUES (t.u('A1'), '198.51.100.7');
  PERFORM t.ok(t.ev('ip.shared') = 1, '⑥ بلا تكرار في 24 ساعة');

  r := t.call(t.u('OW'), 'public.owner_ip_correlation(null, 2, 10)');
  PERFORM t.ok(r -> 'items' -> 0 ->> 'ip' = '198.51.100.7' and (r -> 'items' -> 0 ->> 'accounts')::int = 2
               and (r -> 'items' -> 0 ->> 'logins')::int = 3 and jsonb_array_length(r -> 'items' -> 0 -> 'timeline') = 3, '⑥ الربط: ' || (r -> 'items' -> 0)::text);
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_ip_correlation(null, 2, 10)') = '42501', '⑥ للمالك وحده');

  -- البحث والتصفية
  r := t.call(t.u('OW'), 'public.owner_security_log(''A1@TENANCY'', null, ''auth'', null, null, null, 50, 0)');
  PERFORM t.ok((r ->> 'total')::int = 2, '⑥ بالبريد والنوع: ' || (r ->> 'total'));
  r := t.call(t.u('OW'), 'public.owner_security_log(null, ''198.51.100.7'', null, null, null, null, 50, 0)');
  PERFORM t.ok((r ->> 'total')::int = 4, '⑥ بالـIP (3 دخول + مشترك)');
  r := t.call(t.u('OW'), 'public.owner_security_log(null, null, null, now() + interval ''1 hour'', null, null, 50, 0)');
  PERFORM t.ok((r ->> 'total')::int = 0, '⑥ بالتاريخ');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_security_log(null, ''not-an-ip'', null, null, null, null, 50, 0)') ->> 'error' = 'invalid_ip', '⑥ IP غير صالح');

  -- دخول المالك من IP جديد: تحذير + تنبيه بالبريد، ومن نفس الـIP لاحقًا: لا
  INSERT INTO auth.sessions (id, user_id, ip, user_agent) VALUES
    ('5e550000-0000-4000-8000-0000000000a1', t.u('OW'), '192.0.2.10', 'Mozilla/5.0 (Macintosh) Firefox/131.0');
  PERFORM t.ok((SELECT severity FROM public.security_events WHERE event_type = 'auth.login' ORDER BY id DESC LIMIT 1) = 'warning', '⑥ دخول المالك من IP جديد تحذير');
  PERFORM t.ok(t.calls('owner_new_login') = v_calls + 1, '⑥ وتنبيه بالبريد');
  INSERT INTO auth.sessions (id, user_id, ip) VALUES ('5e550000-0000-4000-8000-0000000000a2', t.u('OW'), '192.0.2.10');
  PERFORM t.ok(t.calls('owner_new_login') = v_calls + 1, '⑥ نفس الـIP لا ينبّه');

  -- الخروج
  DELETE FROM auth.sessions WHERE id = '5e550000-0000-4000-8000-000000000002';
  PERFORM t.ok((SELECT target_user_id = t.u('A1') AND details ->> 'reason' = 'logout_or_expiry'
                  FROM public.security_events WHERE event_type = 'auth.session_ended' ORDER BY id DESC LIMIT 1), '⑥ الخروج مسجَّل');

  -- المراقبة لا تكسر الدخول: سجل معطّل ⇒ الجلسة تُنشأ رغم ذلك
  BEGIN
    ALTER TABLE public.security_events RENAME TO security_events_off;
    INSERT INTO auth.sessions (id, user_id, ip) VALUES ('5e550000-0000-4000-8000-0000000000ff', t.u('PU'), '198.51.100.99');
    PERFORM t.ok(EXISTS (SELECT 1 FROM auth.sessions WHERE id = '5e550000-0000-4000-8000-0000000000ff'), '⑥ الدخول نجح رغم تعطل السجل');
    RAISE EXCEPTION 'rollback-login';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-login' THEN RAISE; END IF;
  END;

  r := t.call(t.u('OW'), 'public.owner_security_overview(7)');
  PERFORM t.ok((r ->> 'logins')::int = 5 and (r ->> 'shared_ips')::int = 1 and (r ->> 'failed_logins')::int = 1
               and (r ->> 'owner_sessions')::int = 2, '⑥ الملخص: ' || r::text);
  RAISE NOTICE 'PASS ⑥ مراقبة الدخول: IP والبريد والمتصفح، IP مشترك بلا تكرار، الربط والبحث، تنبيه المالك، الخروج، والدخول لا يُكسر';
END $$;

-- ══ ⑦ الجلسات والأجهزة ══════════════════════════════════════════════════
INSERT INTO auth.sessions (id, user_id, ip, user_agent) VALUES
  ('5e550000-0000-4000-8000-0000000000ad', t.u('AD'), '203.0.113.20', 'Mozilla/5.0 Chrome'),
  ('5e550000-0000-4000-8000-0000000000ae', t.u('AD'), '203.0.113.21', 'Mozilla/5.0 Edge');
DO $$
DECLARE r jsonb; cur text := '5e550000-0000-4000-8000-0000000000a1';
BEGIN
  -- جلسة تحرير على جلسة الدخول الحالية (a1)
  PERFORM t.reset_counter();
  PERFORM t.callx(t.u('OW'), cur, format('public.owner_step_up(%L)', t.totp()));
  r := t.callx(t.u('OW'), cur, 'public.owner_list_sessions(null)');
  PERFORM t.ok(jsonb_array_length(r -> 'items') = 2 and r -> 'items' @> jsonb_build_array(jsonb_build_object('id', cur, 'current', true)), '⑦ جلساتي والحالية معلَّمة');
  PERFORM t.ok(jsonb_array_length(t.callx(t.u('OW'), cur, format('public.owner_list_sessions(%L::uuid)', t.u('AD'))) -> 'items') = 2, '⑦ جلسات فريق المنصة');
  PERFORM t.ok(t.callx(t.u('OW'), cur, format('public.owner_list_sessions(%L::uuid)', t.u('PU'))) ->> 'error' = 'not_staff_account', '⑦ لا أجهزة العملاء');
  PERFORM t.ok(t.callx(t.u('OW'), cur, format('public.owner_revoke_session(%L::uuid)', cur)) ->> 'error' = 'current_session', '⑦ لا إلغاء للجلسة الحالية');
  PERFORM t.ok(t.call(t.u('AD'), 'public.owner_revoke_session(''5e550000-0000-4000-8000-0000000000ae''::uuid)') ->> 'error' = 'forbidden', '⑦ الأدمن لا يلغي');
  PERFORM t.ok(t.callx(t.u('OW'), 'other', 'public.owner_revoke_session(''5e550000-0000-4000-8000-0000000000ae''::uuid)') ->> 'error' = 'step_up_required', '⑦ بلا جلسة تحرير مرفوض');
  r := t.callx(t.u('OW'), cur, 'public.owner_revoke_session(''5e550000-0000-4000-8000-0000000000ae''::uuid)');
  PERFORM t.ok((r ->> 'ok')::boolean and not exists (select 1 from auth.sessions where id = '5e550000-0000-4000-8000-0000000000ae'), '⑦ أُلغيت');
  PERFORM t.ok((SELECT details ->> 'reason' FROM public.security_events WHERE event_type = 'auth.session_ended' ORDER BY id DESC LIMIT 1) = 'revoked_by_owner', '⑦ السبب مسجَّل');
  -- خروج عام لعميل، وللمالك تبقى الحالية
  r := t.callx(t.u('OW'), cur, format('public.owner_global_logout(%L::uuid)', t.u('PU')));
  PERFORM t.ok((r ->> 'revoked')::int = 1 and not exists (select 1 from auth.sessions where user_id = t.u('PU')), '⑦ خروج عام: ' || r::text);
  r := t.callx(t.u('OW'), cur, format('public.owner_global_logout(%L::uuid)', t.u('OW')));
  PERFORM t.ok((r ->> 'revoked')::int = 1 and exists (select 1 from auth.sessions where id = cur::uuid), '⑦ المالك يبقى بجلسته الحالية');
  PERFORM t.ok(t.ev('session.global_logout') = 2, '⑦ مسجَّل');
  RAISE NOTICE 'PASS ⑦ الجلسات: قائمة للمالك وفريق المنصة، إلغاء وخروج عام بعد التحقق، والجلسة الحالية محمية';
END $$;

-- ══ ⑧ كلمة مرور المالك وبريده ═══════════════════════════════════════════
DO $$
DECLARE v_req uuid; r jsonb; cur text := '5e550000-0000-4000-8000-0000000000a1'; v_calls int := t.calls('owner_account_change');
BEGIN
  -- GoTrue (اتصاله بلا JWT) يحدّث كلمة مرور المالك
  INSERT INTO auth.sessions (id, user_id, ip) VALUES ('5e550000-0000-4000-8000-0000000000b1', t.u('OW'), '192.0.2.66');
  UPDATE auth.users SET encrypted_password = '$2a$10$attacker' WHERE id = t.u('OW');
  PERFORM t.ok((SELECT encrypted_password FROM auth.users WHERE id = t.u('OW')) = '$2a$10$old-' || t.u('OW'), '⑧ كلمة المرور لم تتغير');
  SELECT id INTO v_req FROM public.owner_account_change_requests WHERE kind = 'password' AND status = 'pending';
  PERFORM t.ok(v_req IS NOT NULL, '⑧ الطلب محجوز');
  PERFORM t.ok((SELECT ip = '192.0.2.66'::inet FROM public.owner_account_change_requests WHERE id = v_req), '⑧ IP آخر جلسة');
  PERFORM t.ok(t.ev('owner.password_change_blocked') = 1, '⑧ حدث حرج');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.security_events WHERE details::text LIKE '%attacker%' OR user_agent LIKE '%attacker%'), '⑧ لا بصمة كلمة مرور في السجل');
  PERFORM t.ok(t.calls('owner_account_change') = v_calls + 1
               AND (SELECT body ->> 'request' FROM net._calls WHERE body ->> 'kind' = 'owner_account_change' ORDER BY id DESC LIMIT 1) = v_req::text
               AND (SELECT body::text NOT LIKE '%attacker%' FROM net._calls ORDER BY id DESC LIMIT 1), '⑧ التنبيه بمعرّف الطلب وحده');
  -- حسابات أخرى بلا تغيير
  UPDATE auth.users SET encrypted_password = '$2a$10$pu-new' WHERE id = t.u('PU');
  PERFORM t.ok((SELECT encrypted_password FROM auth.users WHERE id = t.u('PU')) = '$2a$10$pu-new', '⑧ الحسابات الأخرى كما كانت');
  -- لا قراءة للطلبات من أي جلسة
  PERFORM t.ok(t.exec(t.u('OW'), 'select * from public.owner_account_change_requests') = '42501', '⑧ الجدول مغلق');
  PERFORM t.ok((t.call(t.u('OW'), 'public.owner_account_change_list(5)') -> 0 ->> 'status') = 'pending', '⑧ المالك يرى الملخص');
  PERFORM t.ok(NOT (t.call(t.u('OW'), 'public.owner_account_change_list(5)')::text LIKE '%attacker%'), '⑧ بلا البصمة');

  -- الطرف يحفظ بصمتي الرمزين مرة واحدة (service_role)
  SET LOCAL ROLE service_role;
  PERFORM t.ok(public._account_change_set_tokens(v_req, public._token_hash('approve-tok'), public._token_hash('reject-tok')), '⑧ بصمتا الرمزين');
  PERFORM t.ok(NOT public._account_change_set_tokens(v_req, public._token_hash('x'), public._token_hash('y')), '⑧ مرة واحدة');
  RESET ROLE;
  PERFORM t.ok(t.err(t.u('OW'), format('public._account_change_set_tokens(%L::uuid, ''a'', ''b'')', v_req)) = '42501', '⑧ ليست للجلسات');

  -- الموافقة: الأدمن لا، المالك بلا جلسة تحرير لا، برمز خاطئ لا
  PERFORM t.ok(t.call(t.u('AD'), format('public.owner_approve_account_change(%L::uuid, ''approve-tok'')', v_req)) ->> 'error' = 'forbidden', '⑧ الأدمن لا يوافق');
  PERFORM t.ok(t.callx(t.u('OW'), 'no-stepup', format('public.owner_approve_account_change(%L::uuid, ''approve-tok'')', v_req)) ->> 'error' = 'step_up_required', '⑧ يلزم تحقق');
  PERFORM t.ok(t.callx(t.u('OW'), cur, format('public.owner_approve_account_change(%L::uuid, ''reject-tok'')', v_req)) ->> 'error' = 'invalid_token', '⑧ رمز خاطئ');
  r := t.callx(t.u('OW'), cur, format('public.owner_approve_account_change(%L::uuid, ''approve-tok'')', v_req));
  PERFORM t.ok((r ->> 'ok')::boolean and (r ->> 'sessions_revoked')::int = 1, '⑧ وافق المالك: ' || r::text);
  PERFORM t.ok((SELECT encrypted_password FROM auth.users WHERE id = t.u('OW')) = '$2a$10$attacker', '⑧ طُبِّقت القيمة المحجوزة');
  PERFORM t.ok((SELECT status = 'approved' AND pending_value IS NULL FROM public.owner_account_change_requests WHERE id = v_req), '⑧ والبصمة مُسحت');
  PERFORM t.ok(exists (select 1 from auth.sessions where id = cur::uuid) and not exists (select 1 from auth.sessions where id = '5e550000-0000-4000-8000-0000000000b1'),
               '⑧ الجلسات الأخرى خرجت والحالية باقية');
  PERFORM t.ok(t.callx(t.u('OW'), cur, format('public.owner_approve_account_change(%L::uuid, ''approve-tok'')', v_req)) ->> 'error' = 'already_approved', '⑧ مرة واحدة');

  -- البريد
  UPDATE auth.users SET email_change = 'evil@attacker.test', email_change_token_new = 'tok' WHERE id = t.u('OW');
  PERFORM t.ok((SELECT email = 'ow@tenancy.test' AND email_change = '' AND email_change_token_new = '' FROM auth.users WHERE id = t.u('OW')), '⑧ تغيير البريد محجوز');
  SELECT id INTO v_req FROM public.owner_account_change_requests WHERE kind = 'email' AND status = 'pending';
  PERFORM t.ok((SELECT pending_value FROM public.owner_account_change_requests WHERE id = v_req) = 'evil@attacker.test', '⑧ البريد المطلوب محفوظ');
  UPDATE auth.users SET email_change = '' WHERE id = t.u('OW');
  PERFORM t.ok((SELECT count(*) FROM public.owner_account_change_requests WHERE kind = 'email') = 1, '⑧ مسح email_change ليس طلبًا');

  -- الرفض برمز الرابط (بلا تسجيل دخول) ⇒ كل جلسات المالك تخرج
  SET LOCAL ROLE service_role;
  PERFORM public._account_change_set_tokens(v_req, public._token_hash('a2'), public._token_hash('r2'));
  RESET ROLE;
  PERFORM t.ok((SELECT jsonb_build_object('e', public.owner_reject_account_change(v_req, 'wrong'))) #>> '{e,error}' = 'invalid_token', '⑧ رفض برمز خاطئ');
  SET LOCAL ROLE anon;
  r := public.owner_reject_account_change(v_req, 'r2');
  RESET ROLE;
  PERFORM t.ok((r ->> 'ok')::boolean and not exists (select 1 from auth.sessions where user_id = t.u('OW')), '⑧ رُفض وخرجت كل الجلسات: ' || r::text);
  PERFORM t.ok((SELECT email FROM auth.users WHERE id = t.u('OW')) = 'ow@tenancy.test', '⑧ البريد كما هو');
  PERFORM t.ok(t.ev('owner.account_change_bad_token') >= 2, '⑧ الرموز الخاطئة مسجّلة');

  -- طلب منتهٍ
  UPDATE auth.users SET encrypted_password = '$2a$10$late' WHERE id = t.u('OW');
  SELECT id INTO v_req FROM public.owner_account_change_requests WHERE kind = 'password' AND status = 'pending';
  UPDATE public.owner_account_change_requests SET expires_at = now() - interval '1 second', approve_token_hash = public._token_hash('a3') WHERE id = v_req;
  PERFORM t.reset_counter();
  PERFORM t.call(t.u('OW'), format('public.owner_step_up(%L)', t.totp()));
  PERFORM t.ok(t.call(t.u('OW'), format('public.owner_approve_account_change(%L::uuid, ''a3'')', v_req)) ->> 'error' = 'expired', '⑧ المنتهي لا يُطبَّق');

  -- السياسة تفك القفل ⇒ يمر
  PERFORM t.call(t.u('OW'), 'public.owner_set_security_policy(''{"password_change_locked": false}''::jsonb)');
  PERFORM t.ok((SELECT severity FROM public.security_events WHERE event_type = 'security_policy.changed' ORDER BY id DESC LIMIT 1) = 'warning', '⑧ فك القفل تحذير');
  UPDATE auth.users SET encrypted_password = '$2a$10$unlocked' WHERE id = t.u('OW');
  PERFORM t.ok((SELECT encrypted_password FROM auth.users WHERE id = t.u('OW')) = '$2a$10$unlocked', '⑧ بلا قفل يمر');
  PERFORM t.call(t.u('OW'), 'public.owner_set_security_policy(''{"password_change_locked": true}''::jsonb)');
  RAISE NOTICE 'PASS ⑧ كلمة المرور والبريد: محجوزان، تنبيه بلا أسرار، موافقة بتحقق ورمز، رفض يُخرج الجلسات، والحسابات الأخرى كما هي';
END $$;

-- ══ ⑨ التراجع ═══════════════════════════════════════════════════════════
-- بلا إذن صريح: يرفض (داخل معاملة تُلغى، فلا يسري شيء بعد الرفض)
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/121_owner_security_center.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.security_events') IS NOT NULL, '⑨ التراجع يرفض والسجل غير فارغ');
END $$;
BEGIN;
SET LOCAL mad3oom.rollback_discard_security_log = 'on';
\i migrations/_rollback/121_owner_security_center.down.sql
COMMIT;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.security_events') IS NULL AND to_regclass('public.role_permission_rules') IS NULL
               AND to_regprocedure('public.staff_write_ok(text)') IS NULL, '⑨ أُزيل كل شيء');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN ('auth.sessions'::regclass, 'auth.users'::regclass)
                            AND tgname LIKE 'trg_%security%' OR tgname = 'trg_guard_owner_account_change'), '⑨ محفّزات auth أُزيلت');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'perm\_%'), '⑨ سياسات الصلاحيات أُزيلت');
  PERFORM t.ok((SELECT count(*) FROM t.fp f JOIN pg_proc p ON p.proname = f.name AND p.pronamespace = 'public'::regnamespace
                 WHERE md5(pg_get_functiondef(p.oid)) = f.md5) = 3, '⑨ دوال 053 حرفيًا');
  PERFORM t.ok(t.affected(t.u('AD'), 'update public.advanced_settings set value = ''"after"'' where key = ''sec_probe''') = 1, '⑨ الأدمن كما قبل 121');
  RAISE NOTICE 'PASS ⑨ التراجع: يرفض بسجل غير فارغ، ثم يزيل كل شيء ويعيد 053 حرفيًا';
END $$;
\i migrations/121_owner_security_center.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.security_events') IS NOT NULL AND (SELECT step_up_minutes FROM public.owner_security_policy) = 10, '⑨ إعادة 121');
  RAISE NOTICE 'ALL owner-security-center tests passed';
END $$;
