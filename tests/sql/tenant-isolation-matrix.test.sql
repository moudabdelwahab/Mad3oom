-- ============================================================================
-- مصفوفة عزل الشركات قبل تفعيل company_isolation_enforced في الإنتاج
--   (docs/tenancy/ISOLATION_VERIFICATION_2026-10-21.md). قبل 111 تفشل 7 حالات (I1 و I2، التقرير §4).
--
-- البيئة: Postgres محلي مؤقت من لقطة مخطط الإنتاج (tests/fixtures/prod-shape) + 094→111 بترتيب الإنتاج
--   (109 قبل 108). بصمة الدوال والسياسات والمنح مطابقة للإنتاج (التقرير §2)، وتُضاف هنا سياسات storage.objects
--   الثماني الموجودة في الإنتاج والغائبة عن اللقطة. بيانات اصطناعية فقط: شركتان أ و ب (+ شركة المالك W)،
--   مالك ومشرف وموظف وعملاء لكل منهما، وطاقم منصة (أدمن مرتفع، أدمن، دعم)، وحساب فرد، ومجهول.
--
-- كل حالة تُسجَّل في t.m بالمتوقع والفعلي، ولكل رفض ضابط إيجابي: نفس الوصول ينجح من داخل الشركة، أو
--   ينجح والعزل مطفأ. فلا ينجح رفض لأن البيانات غائبة. في النهاية تُطبع المصفوفة ويفشل الملف إن اختلف شيء.
--
--   المرحلة OFF  : المفاتيح كلها مطفأة (السلوك قبل 097) — الضوابط الإيجابية لطاقم المنصة
--   المرحلة ON   : الصلاحيات ← الإيقاف ← العزل بمسار المالك الحقيقي (خطوة تحقق حديثة)؛ منح الوصول مطفأة
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

-- ── سياسات storage.objects الموجودة في الإنتاج والغائبة عن اللقطة (نص الإنتاج حرفيًا، 2026-10-21) ──
CREATE POLICY "Admin delete subdomain logos" ON storage.objects FOR DELETE
  USING ((bucket_id = 'subdomain-logos'::text) AND ((SELECT profiles.role FROM public.profiles WHERE (profiles.id = auth.uid())) = 'admin'::text));
CREATE POLICY "Admin update subdomain logos" ON storage.objects FOR UPDATE
  USING ((bucket_id = 'subdomain-logos'::text) AND ((SELECT profiles.role FROM public.profiles WHERE (profiles.id = auth.uid())) = 'admin'::text));
CREATE POLICY "Admin upload subdomain logos" ON storage.objects FOR INSERT
  WITH CHECK ((bucket_id = 'subdomain-logos'::text) AND ((SELECT profiles.role FROM public.profiles WHERE (profiles.id = auth.uid())) = 'admin'::text));
CREATE POLICY "Allow Authenticated Insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK ((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));
CREATE POLICY "Allow Owner Delete" ON storage.objects FOR DELETE TO authenticated
  USING ((bucket_id = 'avatars'::text) AND (owner = auth.uid()));
CREATE POLICY "Allow Owner Update" ON storage.objects FOR UPDATE TO authenticated
  USING ((bucket_id = 'avatars'::text) AND (owner = auth.uid()))
  WITH CHECK ((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));
CREATE POLICY chat_attachments_delete_own_unreferenced ON storage.objects FOR DELETE TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)
         AND (NOT (EXISTS (SELECT 1 FROM public.chat_messages m
                            WHERE ((m.image_url = objects.name) OR (m.audio_url = objects.name) OR ((m.attachment ->> 'path'::text) = objects.name))))));
CREATE POLICY chat_attachments_read_support_reply ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND (EXISTS (SELECT 1 FROM (public.chat_messages m JOIN public.chat_sessions s ON ((s.id = m.session_id)))
          WHERE ((s.user_id = auth.uid()) AND m.is_admin_reply AND (m.deleted_at IS NULL)
                 AND (((m.attachment ->> 'path'::text) = objects.name) OR (m.image_url = objects.name) OR (m.audio_url = objects.name))))));

-- ── أدوات المصفوفة ────────────────────────────────────────────────────────
CREATE TABLE t.m (n serial PRIMARY KEY, phase text, area text, path text, actor text, expected text, actual text);
CREATE FUNCTION t.rec(p_phase text, p_area text, p_path text, p_actor text, p_expected text, p_actual text) RETURNS void
LANGUAGE sql AS $$ insert into t.m (phase, area, path, actor, expected, actual) values (p_phase, p_area, p_path, p_actor, p_expected, coalesce(p_actual, '∅')) $$;
-- رفض: SQLSTATE من قائمة، أو 0 صف متأثر/مرئي
CREATE FUNCTION t.denied(p_actual text) RETURNS text LANGUAGE sql AS $$
  select case when p_actual in ('42501', 'P0002', '0A000', '22023', 'P0001', 'rows:0', 'rows:42501', 'null', 'false') then 'denied' else p_actual end $$;
CREATE FUNCTION t.owner_sw(p_key text, p_on boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_set_feature_switch(%L, %L, %L)', p_key, p_on, 'تحقق عزل الشركات بمعطيات اصطناعية'));
  PERFORM t.ctx(null);
  RETURN r;
END $$;
-- عدد صفوف يراها الفاعل، أو 'rows:0' إن كان الجدول مغلقًا أمامه
CREATE FUNCTION t.cnt(p text, p_from_where text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'rows:' || t.rows(t.u(p), p_from_where);
EXCEPTION WHEN insufficient_privilege THEN RETURN 'rows:0';
END $$;
-- جملة كتابة بهوية الفاعل: SQLSTATE أو rows:n
CREATE FUNCTION t.w(p text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  n := t.affected(t.u(p), p_sql);
  IF n >= 0 THEN RETURN 'rows:' || n; END IF;
  RETURN t.err(t.u(p), format('(with x as (%s returning 1) select count(*) from x)', p_sql));
END $$;
-- نداء RPC بهوية: 'ok' أو SQLSTATE
CREATE FUNCTION t.r(p text, p_sql text) RETURNS text LANGUAGE sql AS $$ select t.err(t.u(p), p_sql) $$;
-- نداء بمفتاح الخدمة (لا مستخدم في JWT، أو مستخدم محدد كما يفعل MCP)
CREATE FUNCTION t.svc(p_sub uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'service_role')::text, true);
  EXECUTE 'set local role service_role';
  EXECUTE 'select to_jsonb((' || p_sql || '))' INTO v;
  EXECUTE 'reset role';
  PERFORM t.act(null);
  RETURN coalesce(v::text, 'null');
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'reset role';
  PERFORM t.act(null);
  RETURN SQLSTATE;
END $$;
-- مجهول: دور anon بلا JWT
CREATE FUNCTION t.anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM t.act(null);
  EXECUTE 'set local role anon';
  EXECUTE p_sql INTO v;
  EXECUTE 'reset role';
  RETURN coalesce(v, 'null');
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'reset role';
  RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
GRANT ALL ON t.m TO authenticated, service_role, anon;
GRANT USAGE ON SEQUENCE t.m_n_seq TO authenticated, service_role, anon;

-- ── معطيات إضافية اصطناعية ────────────────────────────────────────────────
-- فاتورة محاسبية على تذكرة شركة أ (لا يُفترض وجودها؛ تختبر دوال الفواتير لطاقم المنصة إن وُجدت)
INSERT INTO public.accounting_invoices (external_invoice_id, invoice_number, ticket_id, user_id, total)
VALUES (gen_random_uuid(), 'FX-A1', t.k('TA1'), t.u('A1'), 10),
       (gen_random_uuid(), 'FX-A1S', t.k('TA1S'), t.u('A1'), 10);  -- ضابط: فاتورة على تذكرة الفوترة الشخصية (مدعوم)
-- محادثات الشركة (102): عميل أ وعميل ب
UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_inbox_enabled';
INSERT INTO t.saved (k, v) SELECT 'convA', (t.call(t.u('A1'), 'public.company_conversation_start(''طلب أ الاصطناعي'', ''نص اصطناعي أ'', gen_random_uuid())') ->> 'conversation_id');
INSERT INTO t.saved (k, v) SELECT 'convB', (t.call(t.u('B1'), 'public.company_conversation_start(''طلب ب الاصطناعي'', ''نص اصطناعي ب'', gen_random_uuid())') ->> 'conversation_id');
DO $$ BEGIN
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'convA') IS NOT NULL AND (SELECT v FROM t.saved WHERE k = 'convB') IS NOT NULL, 'FX conversations');
  PERFORM t.ok((SELECT count(*) FROM public.accounting_invoices WHERE ticket_id IN (t.k('TA1'), t.k('TA1S'))) = 2, 'FX invoices');
END $$;
CREATE FUNCTION t.conv(p text) RETURNS uuid LANGUAGE sql AS $$ select v::uuid from t.saved where k = p $$;
GRANT EXECUTE ON FUNCTION t.conv(text) TO authenticated, service_role, anon;

-- ══ المرحلة OFF: الضوابط الإيجابية (السلوك قبل 097) ══════════════════════════
DO $$
BEGIN
  PERFORM t.ok(NOT public._isolation_on(), 'OFF isolation off');
  PERFORM t.rec('OFF', 'tickets', 'direct lookup TA1 (company A)', 'AD', 'rows:1', t.cnt('AD', format('public.tickets where id = %L', t.k('TA1'))));
  PERFORM t.rec('OFF', 'tickets', 'direct lookup TB1 (company B)', 'SUP', 'rows:1', t.cnt('SUP', format('public.tickets where id = %L', t.k('TB1'))));
  PERFORM t.rec('OFF', 'replies', 'replies on TA1', 'AD', 'rows:2', t.cnt('AD', format('public.ticket_replies where ticket_id = %L', t.k('TA1'))));
  PERFORM t.rec('OFF', 'storage', 'ticket files of TA1', 'AD', 'rows:2', t.cnt('AD', format('storage.objects where bucket_id = ''tickets'' and name like %L', '%' || t.k('TA1')::text || '%')));
  PERFORM t.rec('OFF', 'mcp', 'mcp_admin_update_ticket TA1 (priority unchanged)', 'svc:AD', 'ok',
                CASE WHEN t.svc(t.u('AD'), format('public.mcp_admin_update_ticket(%L, %L, ''{"priority":"medium"}'')', t.k('TA1'), t.u('AD'))) ~ '^\{' THEN 'ok' ELSE 'refused' END);
  PERFORM t.rec('OFF', 'workflow', 'wf_update_ticket_status TA1', 'svc', 'ok',
                CASE WHEN t.svc(null, format('public.wf_update_ticket_status(%L, ''open'', null)', t.k('TA1'))) IN ('null', '""') OR t.svc(null, format('public.wf_update_ticket_status(%L, ''open'', null)', t.k('TA1'))) !~ '^[0-9A-Z]{5}$' THEN 'ok' ELSE 'refused' END);
END $$;

-- ══ التفعيل بمسار المالك: الصلاحيات ← الإيقاف ← العزل ══════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.owner_sw('company_permissions_enabled', true) ->> 'enabled' = 'true', 'SW permissions');
  PERFORM t.ok(t.owner_sw('company_suspension_enforced', true) ->> 'enabled' = 'true', 'SW suspension');
  PERFORM t.ok(t.owner_sw('company_isolation_enforced', true) ->> 'enabled' = 'true', 'SW isolation');
  PERFORM t.ok(public._isolation_on() AND NOT public._feature_on('data_access_grants_enabled'), 'SW state');
END $$;

-- ══ المرحلة ON ═══════════════════════════════════════════════════════════════
-- 1) التذاكر: قائمة، بحث مباشر، ردود، تعديل، حالة
DO $$
DECLARE
  ta1 text := t.k('TA1')::text; tb1 text := t.k('TB1')::text;
BEGIN
  -- قائمة: طاقم المنصة لا يرى أي تذكرة شركة؛ كل شركة تذاكرها فقط
  PERFORM t.rec('ON', 'tickets', 'list: company-scope tickets visible', 'AD', 'rows:0', t.cnt('AD', 'public.tickets where scope = ''company'''));
  PERFORM t.rec('ON', 'tickets', 'list: company-scope tickets visible', 'SUP', 'rows:0', t.cnt('SUP', 'public.tickets where scope = ''company'''));
  PERFORM t.rec('ON', 'tickets', 'list: company-scope tickets visible', 'EA', 'rows:0', t.cnt('EA', 'public.tickets where scope = ''company'''));
  PERFORM t.rec('ON', 'tickets', 'list: company A tickets (positive)', 'OA', 'rows:2', t.cnt('OA', format('public.tickets where company_id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'tickets', 'list: company A tickets', 'OB', 'rows:0', t.cnt('OB', format('public.tickets where company_id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'tickets', 'list: company A tickets', 'BS', 'rows:0', t.cnt('BS', format('public.tickets where company_id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'tickets', 'list: company B tickets', 'AS', 'rows:0', t.cnt('AS', format('public.tickets where company_id = %L', t.u('CB'))));
  PERFORM t.rec('ON', 'tickets', 'list: company A tickets (positive)', 'AS', 'rows:2', t.cnt('AS', format('public.tickets where company_id = %L', t.u('CA'))));
  -- بحث مباشر بالمعرّف (استبدال المعرّف)
  PERFORM t.rec('ON', 'tickets', 'direct lookup TA1', 'AD', 'rows:0', t.cnt('AD', format('public.tickets where id = %L', ta1)));
  PERFORM t.rec('ON', 'tickets', 'direct lookup TA1', 'OB', 'rows:0', t.cnt('OB', format('public.tickets where id = %L', ta1)));
  PERFORM t.rec('ON', 'tickets', 'direct lookup TA1', 'B1', 'rows:0', t.cnt('B1', format('public.tickets where id = %L', ta1)));
  PERFORM t.rec('ON', 'tickets', 'direct lookup TB1', 'A1', 'rows:0', t.cnt('A1', format('public.tickets where id = %L', tb1)));
  PERFORM t.rec('ON', 'tickets', 'direct lookup TA1 (own, positive)', 'A1', 'rows:1', t.cnt('A1', format('public.tickets where id = %L', ta1)));
  -- ردود
  PERFORM t.rec('ON', 'replies', 'read replies on TA1', 'AD', 'rows:0', t.cnt('AD', format('public.ticket_replies where ticket_id = %L', ta1)));
  PERFORM t.rec('ON', 'replies', 'read replies on TA1', 'OB', 'rows:0', t.cnt('OB', format('public.ticket_replies where ticket_id = %L', ta1)));
  PERFORM t.rec('ON', 'replies', 'read public reply on TA1 (positive)', 'OA', 'rows:1', t.cnt('OA', format('public.ticket_replies where ticket_id = %L and not coalesce(is_internal, false)', ta1)));
  PERFORM t.rec('ON', 'replies', 'insert reply into TA1', 'OB', 'denied', t.denied(t.w('OB',
    format('insert into public.ticket_replies (id, ticket_id, user_id, message) values (gen_random_uuid(), %L, %L, ''اصطناعي'')', ta1, t.u('OB')))));
  PERFORM t.rec('ON', 'replies', 'insert reply into TA1', 'AD', 'denied', t.denied(t.w('AD',
    format('insert into public.ticket_replies (id, ticket_id, user_id, message, is_internal) values (gen_random_uuid(), %L, %L, ''اصطناعي'', true)', ta1, t.u('AD')))));
  PERFORM t.rec('ON', 'replies', 'insert reply into TA1', 'B1', 'denied', t.denied(t.w('B1',
    format('insert into public.ticket_replies (id, ticket_id, user_id, message) values (gen_random_uuid(), %L, %L, ''اصطناعي'')', ta1, t.u('B1')))));
  -- تعديل وحالة
  PERFORM t.rec('ON', 'tickets', 'update TA1 priority', 'AD', 'denied', t.denied(t.w('AD', format('update public.tickets set priority = ''high'' where id = %L', ta1))));
  PERFORM t.rec('ON', 'tickets', 'update TA1 priority', 'BS', 'denied', t.denied(t.w('BS', format('update public.tickets set priority = ''high'' where id = %L', ta1))));
  PERFORM t.rec('ON', 'tickets', 'update TA1 company_id to B', 'OA', 'denied', t.denied(t.w('OA', format('update public.tickets set company_id = %L where id = %L', t.u('CB'), ta1))));
  PERFORM t.rec('ON', 'tickets', 'delete TA1', 'AD', 'denied', t.denied(t.w('AD', format('delete from public.tickets where id = %L', ta1))));
  PERFORM t.rec('ON', 'tickets', 'insert ticket scoped to company A', 'B1', 'denied', t.denied(t.w('B1',
    format('insert into public.tickets (title, description, user_id, scope, company_id) values (''اصطناعي'', ''اصطناعي'', %L, ''company'', %L)', t.u('B1'), t.u('CA')))));
  PERFORM t.rec('ON', 'tickets', 'company_ticket_set_status TA1', 'BS', 'denied', t.denied(t.r('BS', format('public.company_ticket_set_status(%L, ''in-progress'')', ta1))));
  PERFORM t.rec('ON', 'tickets', 'company_ticket_assign TA1 to BS', 'BS', 'denied', t.denied(t.r('BS', format('public.company_ticket_assign(%L, %L)', ta1, t.u('BS')))));
  PERFORM t.rec('ON', 'tickets', 'company_ticket_set_status TA1 (positive)', 'AS', 'ok', t.r('AS', format('public.company_ticket_set_status(%L, ''in-progress'')', ta1)));
  PERFORM t.rec('ON', 'tickets', 'company_tickets_list contains TA1', 'BS', 'false',
    (position(ta1 in coalesce(t.call(t.u('BS'), 'public.company_tickets_list()')::text, '')) > 0)::text);
  PERFORM t.rec('ON', 'tickets', 'company_tickets_list contains TA1 (positive)', 'AS', 'true',
    (position(ta1 in coalesce(t.call(t.u('AS'), 'public.company_tickets_list()')::text, '')) > 0)::text);
END $$;

-- 2) المحادثات (102): القراءة والكتابة عبر الشركات
DO $$
DECLARE ca uuid := t.conv('convA');
BEGIN
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation (positive)', 'OA', 'ok', t.r('OA', format('public.company_conversation_thread(%L)', ca)));
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation', 'OB', 'denied', t.denied(t.r('OB', format('public.company_conversation_thread(%L)', ca))));
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation', 'BS', 'denied', t.denied(t.r('BS', format('public.company_conversation_thread(%L)', ca))));
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation', 'B1', 'denied', t.denied(t.r('B1', format('public.company_conversation_thread(%L)', ca))));
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation', 'AD', 'denied', t.denied(t.r('AD', format('public.company_conversation_thread(%L)', ca))));
  PERFORM t.rec('ON', 'conversations', 'thread of A conversation', 'EA', 'denied', t.denied(t.r('EA', format('public.company_conversation_thread(%L)', ca))));
  PERFORM t.rec('ON', 'conversations', 'post into A conversation', 'OB', 'denied', t.denied(t.r('OB', format('public.company_conversation_post(%L, ''اصطناعي'', false)', ca))));
  PERFORM t.rec('ON', 'conversations', 'post into A conversation', 'AD', 'denied', t.denied(t.r('AD', format('public.company_conversation_post(%L, ''اصطناعي'', true)', ca))));
  PERFORM t.rec('ON', 'conversations', 'set status of A conversation', 'BS', 'denied', t.denied(t.r('BS', format('public.company_conversation_set_status(%L, ''closed'')', ca))));
  PERFORM t.rec('ON', 'conversations', 'assign A conversation to BS', 'OB', 'denied', t.denied(t.r('OB', format('public.company_conversation_assign(%L, %L)', ca, t.u('BS')))));
  PERFORM t.rec('ON', 'conversations', 'inbox list contains A conversation', 'OB', 'false',
    (position(ca::text in coalesce(t.call(t.u('OB'), 'public.company_inbox_list(''all'')')::text, '')) > 0)::text);
  PERFORM t.rec('ON', 'conversations', 'inbox list contains A conversation (positive)', 'OA', 'true',
    (position(ca::text in coalesce(t.call(t.u('OA'), 'public.company_inbox_list(''all'')')::text, '')) > 0)::text);
  PERFORM t.rec('ON', 'conversations', 'direct table read of conversations', 'OB', 'rows:0', t.cnt('OB', 'public.company_conversations'));
  PERFORM t.rec('ON', 'conversations', 'direct table read of conversations', 'AD', 'rows:0', t.cnt('AD', 'public.company_conversations'));
END $$;

-- 3) الملفات والتخزين
DO $$
DECLARE ta1 text := t.k('TA1')::text;
BEGIN
  PERFORM t.rec('ON', 'storage', 'ticket files of TA1', 'AD', 'rows:0', t.cnt('AD', format('storage.objects where bucket_id = ''tickets'' and name like %L', '%' || ta1 || '%')));
  PERFORM t.rec('ON', 'storage', 'ticket files of TA1', 'OB', 'rows:0', t.cnt('OB', format('storage.objects where bucket_id = ''tickets'' and name like %L', '%' || ta1 || '%')));
  PERFORM t.rec('ON', 'storage', 'public ticket file of TA1 (positive)', 'OA', 'rows:1', t.cnt('OA', format('storage.objects where bucket_id = ''tickets'' and name like %L', '%' || ta1 || '%')));
  PERFORM t.rec('ON', 'storage', 'upload into own folder naming TA1', 'OB', 'denied', t.denied(t.w('OB',
    format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)', t.u('OB')::text || '/' || ta1 || '/fx-planted.txt', t.u('OB')))));
  PERFORM t.rec('ON', 'storage', 'upload into own folder naming TA1', 'AD', 'denied', t.denied(t.w('AD',
    format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)', t.u('AD')::text || '/' || ta1 || '/fx-planted.txt', t.u('AD')))));
  PERFORM t.rec('ON', 'storage', 'ticket_attachments rows of TA1', 'AD', 'rows:0', t.cnt('AD', format('public.ticket_attachments where ticket_id = %L', ta1)));
  PERFORM t.rec('ON', 'storage', 'company-documents bucket read', 'OB', 'rows:0', t.cnt('OB', 'storage.objects where bucket_id = ''company-documents'''));
  PERFORM t.rec('ON', 'storage', 'company-documents bucket upload', 'OB', 'denied', t.denied(t.w('OB',
    format('insert into storage.objects (bucket_id, name, owner) values (''company-documents'', %L, %L)', t.u('CA')::text || '/fx.pdf', t.u('OB')))));
  PERFORM t.rec('ON', 'storage', 'company_documents table read', 'OB', 'rows:0', t.cnt('OB', format('public.company_documents where company_id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'storage', 'company_documents table read', 'AD', 'rows:0', t.cnt('AD', 'public.company_documents'));
END $$;

-- 4) الإشعارات: تذكرة شركة جديدة لا تُبلَّغ لطاقم المنصة، ولا يقرأ أحد إشعارات غيره
INSERT INTO t.saved (k, v) SELECT 'n0', (SELECT count(*) FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('SUP'), t.u('EA'), t.u('OW')))::text;
DO $$ BEGIN
  PERFORM t.ok(t.w('A1', format('insert into public.tickets (title, description, user_id) values (''تذكرة شركة اصطناعية جديدة'', ''اصطناعي'', %L)', t.u('A1'))) = 'rows:1', 'FX new A1 ticket');
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE title = 'تذكرة شركة اصطناعية جديدة') = 'company', 'FX new ticket company-scoped');
END $$;
DO $$
DECLARE n_staff int;
BEGIN
  SELECT count(*) INTO n_staff FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('SUP'), t.u('EA'), t.u('OW'));
  PERFORM t.rec('ON', 'notifications', 'staff notified of new company ticket', 'AD/SUP/EA/OW', 'rows:0',
                'rows:' || (n_staff - (SELECT v::int FROM t.saved WHERE k = 'n0')));
  PERFORM t.rec('ON', 'notifications', 'read notifications of company A owner', 'OB', 'rows:0', t.cnt('OB', format('public.notifications where user_id = %L', t.u('OA'))));
  PERFORM t.rec('ON', 'notifications', 'read notifications of company A owner', 'AS', 'rows:0', t.cnt('AS', format('public.notifications where user_id = %L', t.u('OA'))));
  PERFORM t.rec('ON', 'notifications', 'insert notification for company A owner', 'OB', 'denied', t.denied(t.w('OB',
    format('insert into public.notifications (user_id, title, message, type) values (%L, ''اصطناعي'', ''اصطناعي'', ''info'')', t.u('OA')))));
END $$;
-- ضابط إيجابي للإشعارات: نفس الإدراج والعزل مطفأ يبلّغ الطاقم
DO $$
DECLARE n0 int; n1 int;
BEGIN
  PERFORM t.sw('company_isolation_enforced', false);
  SELECT count(*) INTO n0 FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('SUP'), t.u('EA'), t.u('OW'));
  PERFORM t.ok(t.w('A1', format('insert into public.tickets (title, description, user_id) values (''تذكرة ضابطة اصطناعية'', ''اصطناعي'', %L)', t.u('A1'))) = 'rows:1', 'FX control ticket');
  SELECT count(*) INTO n1 FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('SUP'), t.u('EA'), t.u('OW'));
  PERFORM t.rec('OFF', 'notifications', 'staff notified of new company ticket (control)', 'AD/SUP/EA/OW', 'notified', CASE WHEN n1 > n0 THEN 'notified' ELSE 'rows:0' END);
  PERFORM t.sw('company_isolation_enforced', true);
END $$;

-- 5) لوحة الشركة ودوال الشركة
DO $$ BEGIN
  PERFORM t.rec('ON', 'dashboard', 'get_my_company_dashboard company id (positive)', 'OA', t.u('CA')::text, t.call(t.u('OA'), 'public.get_my_company_dashboard()') #>> '{company,id}');
  PERFORM t.rec('ON', 'dashboard', 'get_my_company_dashboard company id', 'OB', t.u('CB')::text, t.call(t.u('OB'), 'public.get_my_company_dashboard()') #>> '{company,id}');
  PERFORM t.rec('ON', 'dashboard', 'get_my_company_dashboard company id', 'BS', t.u('CB')::text, t.call(t.u('BS'), 'public.get_my_company_dashboard()') #>> '{company,id}');
  PERFORM t.rec('ON', 'dashboard', 'get_my_company_dashboard', 'AD', 'null', coalesce(t.call(t.u('AD'), 'public.get_my_company_dashboard()') #>> '{company,id}', 'null'));
  PERFORM t.rec('ON', 'dashboard', 'get_my_company_dashboard', 'B1', 'null', coalesce(t.call(t.u('B1'), 'public.get_my_company_dashboard()') #>> '{company,id}', 'null'));
  PERFORM t.rec('ON', 'dashboard', 'dashboard mentions company A', 'OB', 'false', (position(t.u('CA')::text in coalesce(t.call(t.u('OB'), 'public.get_my_company_dashboard()')::text, '')) > 0)::text);
  PERFORM t.rec('ON', 'dashboard', 'companies row of A', 'OB', 'rows:0', t.cnt('OB', format('public.companies where id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'dashboard', 'company_memberships of A', 'BS', 'rows:0', t.cnt('BS', format('public.company_memberships where company_id = %L', t.u('CA'))));
  PERFORM t.rec('ON', 'dashboard', 'company_access_log of A', 'OB', 'false', (position(t.u('CA')::text in coalesce(t.call(t.u('OB'), 'public.company_access_log()')::text, '')) > 0)::text);
END $$;

-- 6) الاستمرارية: لا مصدر من نوع تذكرة (غير مفعّل)
DO $$ BEGIN
  PERFORM t.rec('ON', 'continuity', 'attach mad3oom_ticket source (TA1)', 'AD', 'denied', t.denied(t.r('AD',
    format('public.continuity_attach_sources(gen_random_uuid(), %L::jsonb, 1, true)', jsonb_build_array(jsonb_build_object('type', 'mad3oom_ticket', 'ticket_id', t.k('TA1')))))));
  PERFORM t.rec('ON', 'continuity', 'rows referencing a ticket', 'superuser', 'rows:0', 'rows:' || (SELECT count(*) FROM public.continuity_sources WHERE ticket_id IS NOT NULL));
END $$;

-- 7) MCP والعمليات بمفتاح الخدمة
DO $$
DECLARE ta1 text := t.k('TA1')::text;
BEGIN
  PERFORM t.rec('ON', 'mcp', 'mcp_ticket_tenancy team companies', 'svc:AD', '[]', t.svc(null, format('public.mcp_ticket_tenancy(%L)', t.u('AD')))::jsonb ->> 'team_company_ids');
  PERFORM t.rec('ON', 'mcp', 'mcp_ticket_tenancy team companies (positive)', 'svc:AS', jsonb_build_array(t.u('CA'))::text, t.svc(null, format('public.mcp_ticket_tenancy(%L)', t.u('AS')))::jsonb ->> 'team_company_ids');
  PERFORM t.rec('ON', 'mcp', 'mcp_ticket_tenancy team companies', 'svc:BS', jsonb_build_array(t.u('CB'))::text, t.svc(null, format('public.mcp_ticket_tenancy(%L)', t.u('BS')))::jsonb ->> 'team_company_ids');
  PERFORM t.rec('ON', 'mcp', 'mcp_ticket_tenancy isolation flag', 'svc', 'true', t.svc(null, format('public.mcp_ticket_tenancy(%L)', t.u('AD')))::jsonb ->> 'isolation_on');
  PERFORM t.rec('ON', 'mcp', 'mcp_ticket_tenancy callable by user JWT', 'AD', 'denied', t.denied(t.r('AD', format('public.mcp_ticket_tenancy(%L)', t.u('AD')))));
  PERFORM t.rec('ON', 'mcp', 'mcp_admin_update_ticket TA1', 'svc:AD', 'denied', t.denied(t.svc(t.u('AD'), format('public.mcp_admin_update_ticket(%L, %L, ''{"priority":"medium"}'')', ta1, t.u('AD')))));
  PERFORM t.rec('ON', 'mcp', 'mcp_admin_update_ticket TA1S (support scope, positive)', 'svc:AD', 'ok',
    CASE WHEN t.svc(t.u('AD'), format('public.mcp_admin_update_ticket(%L, %L, ''{"priority":"medium"}'')', t.k('TA1S'), t.u('AD'))) ~ '^\{' THEN 'ok' ELSE 'refused' END);
  PERFORM t.rec('ON', 'workflow', 'wf_update_ticket_status TA1', 'svc', 'denied', t.denied(t.svc(null, format('public.wf_update_ticket_status(%L, ''open'', null)', ta1))));
  PERFORM t.rec('ON', 'workflow', 'wf_assign_ticket TA1 to AD', 'svc', 'denied', t.denied(t.svc(null, format('public.wf_assign_ticket(%L, %L, null)', ta1, t.u('AD')))));
  PERFORM t.rec('ON', 'workflow', 'wf_update_ticket_status callable by user JWT', 'AD', 'denied', t.denied(t.r('AD', format('public.wf_update_ticket_status(%L, ''open'', null)', ta1))));
END $$;

-- 8) دوال طاقم المنصة المرتبطة بتذكرة (فواتير محاسبية)، والتكاملات
DO $$
DECLARE ta1 text := t.k('TA1')::text;
BEGIN
  PERFORM t.rec('ON', 'staff-rpc', 'ticket_invoice_status TA1 (same as no invoice)', 'AD', 'none', t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', ta1)) ->> 'state');
  PERFORM t.rec('ON', 'staff-rpc', 'ticket_invoice_status TA1S support ticket (positive)', 'AD', 'ready', t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TA1S'))) ->> 'state');
  PERFORM t.rec('ON', 'staff-rpc', 'accounting_invoices row of TA1S (positive)', 'AD', 'rows:1', t.cnt('AD', format('public.accounting_invoices where ticket_id = %L', t.k('TA1S'))));
  PERFORM t.rec('ON', 'staff-rpc', 'own invoice row of TA1 (customer, positive)', 'A1', 'rows:1', t.cnt('A1', format('public.accounting_invoices where ticket_id = %L', ta1)));
  PERFORM t.rec('ON', 'staff-rpc', 'ticket_invoice_document TA1', 'AD', 'denied', t.denied(t.r('AD', format('public.ticket_invoice_document(%L)', ta1))));
  PERFORM t.rec('ON', 'staff-rpc', 'attach_accounting_invoice TA1', 'AD', 'denied', t.denied(t.r('AD', format('public.attach_accounting_invoice(%L)', ta1))));
  PERFORM t.rec('ON', 'staff-rpc', 'accounting_invoices row of TA1', 'AD', 'rows:0', t.cnt('AD', format('public.accounting_invoices where ticket_id = %L', ta1)));
  -- المسار الذي يضع فاتورة على تذكرة شركة: ربط طلب اشتراك بتذكرة غير تذكرة فوترة لمدعوم
  PERFORM t.rec('ON', 'billing', 'request_subscription_purchase linked to own company ticket TA1', 'A1', 'denied', t.denied(t.r('A1',
    format('public.request_subscription_purchase(''support'', ''monthly'', %L, false, null, null)', ta1))));
  PERFORM t.rec('ON', 'billing', 'request_subscription_upgrade linked to company A ticket TA1', 'OB', 'denied', t.denied(t.r('OB',
    format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', ta1))));
  PERFORM t.rec('ON', 'billing', 'subscriptions referencing TA1 after the attempts', 'superuser', 'rows:0',
    'rows:' || (SELECT count(*) FROM public.whatsapp_subscriptions WHERE ticket_id = t.k('TA1')));
  PERFORM t.rec('ON', 'integrations', 'ihub_ticket_context TA1', 'OB', 'denied', t.denied(t.r('OB', format('public.ihub_ticket_context(%L)', ta1))));
  PERFORM t.rec('ON', 'integrations', 'ihub_ticket_context TA1', 'AD', 'denied', t.denied(t.r('AD', format('public.ihub_ticket_context(%L)', ta1))));
  PERFORM t.rec('ON', 'integrations', 'ihub_authorize_ticket_link TA1', 'OB', 'denied', t.denied(t.r('OB', format('public.ihub_authorize_ticket_link(%L, gen_random_uuid())', ta1))));
END $$;

-- 9) استبدال المعرّفات في مسارات الوصول المؤقت والتاريخي (منح الوصول مطفأة)
DO $$
DECLARE ta1 text := t.k('TA1')::text;
BEGIN
  PERFORM t.rec('ON', 'grants', 'granted_ticket_view random grant + TA1', 'SUP', 'denied', t.denied(t.r('SUP', format('public.granted_ticket_view(gen_random_uuid(), %L)', ta1))));
  PERFORM t.rec('ON', 'grants', 'granted_company_tickets random grant', 'AD', 'denied', t.denied(t.r('AD', 'public.granted_company_tickets(gen_random_uuid())')));
  PERFORM t.rec('ON', 'grants', 'request_data_access while grants OFF', 'SUP', 'denied', t.denied(t.r('SUP', format('public.request_data_access(%L, %L, ''سبب اصطناعي للاختبار فقط'', 24)', t.u('CA'), ta1))));
  PERFORM t.rec('ON', 'grants', 'historical_ticket_view random request + TA1', 'OB', 'denied', t.denied(t.r('OB', format('public.historical_ticket_view(gen_random_uuid(), %L)', ta1))));
  PERFORM t.rec('ON', 'grants', 'data_access_grants table read', 'SUP', 'rows:0', t.cnt('SUP', 'public.data_access_grants'));
END $$;

-- 10) مفاتيح API (F7) والمجهول
DO $$ BEGIN
  INSERT INTO public.api_tokens (id, user_id, name, api_key, secret_hash, secret_last_four, is_active)
  VALUES ('a0000000-0000-4000-8000-0000000000e1', t.u('OA'), 'مفتاح اصطناعي OA', 'mk_fx_oa', 'fx-hash', 'fxfx', true);
  PERFORM t.rec('ON', 'api-tokens', 'rewrite secret_hash of company owner token', 'AD', 'denied', t.denied(t.w('AD',
    'update public.api_tokens set secret_hash = ''attacker'' where id = ''a0000000-0000-4000-8000-0000000000e1''')));
  PERFORM t.rec('ON', 'api-tokens', 'reassign company owner token to self', 'EA', 'denied', t.denied(t.w('EA',
    format('update public.api_tokens set user_id = %L where id = ''a0000000-0000-4000-8000-0000000000e1''', t.u('EA')))));
  PERFORM t.rec('ON', 'api-tokens', 'read company A owner token', 'OB', 'rows:0', t.cnt('OB', 'public.api_tokens where id = ''a0000000-0000-4000-8000-0000000000e1'''));
  -- مجهول
  PERFORM t.rec('ON', 'anonymous', 'tickets', 'anon', 'denied', t.denied('rows:' || t.anon('select count(*)::text from public.tickets')));
  PERFORM t.rec('ON', 'anonymous', 'ticket_replies', 'anon', 'denied', t.denied('rows:' || t.anon('select count(*)::text from public.ticket_replies')));
  PERFORM t.rec('ON', 'anonymous', 'notifications', 'anon', 'denied', t.denied('rows:' || t.anon('select count(*)::text from public.notifications')));
  PERFORM t.rec('ON', 'anonymous', 'ticket files', 'anon', 'denied', t.denied('rows:' || t.anon('select count(*)::text from storage.objects where bucket_id = ''tickets''')));
  PERFORM t.rec('ON', 'anonymous', 'get_my_company_dashboard', 'anon', 'denied', t.denied(t.anon('select public.get_my_company_dashboard()::text')));
  PERFORM t.rec('ON', 'anonymous', 'company_conversation_thread', 'anon', 'denied', t.denied(t.anon(format('select public.company_conversation_thread(%L)::text', t.conv('convA')))));
END $$;

-- ══ المصفوفة ═══════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_fail int := 0; v_n int := 0;
BEGIN
  FOR r IN SELECT * FROM t.m ORDER BY n LOOP
    v_n := v_n + 1;
    IF r.expected IS DISTINCT FROM r.actual THEN v_fail := v_fail + 1; END IF;
    RAISE NOTICE 'MATRIX|%|%|%|%|%|%|%', r.phase, r.area, r.path, r.actor, r.expected, r.actual,
      CASE WHEN r.expected IS NOT DISTINCT FROM r.actual THEN 'PASS' ELSE 'FAIL' END;
  END LOOP;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'FAIL tenant-isolation-matrix: % of % cases differ from expected', v_fail, v_n;
  END IF;
  RAISE NOTICE 'ALL tenant-isolation-matrix: PASS (% cases)', v_n;
END $$;
