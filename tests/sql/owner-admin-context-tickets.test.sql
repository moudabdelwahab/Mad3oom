-- ============================================================================
-- المالك في سياق الإدارة وتذاكر العملاء (070) — على نسخة مطابقة لشكل الإنتاج
--
-- ⓪ (قبل 070): المالك في سياق admin يملك is_admin() لكنه لا يرى تذكرة عميل
--    واحدة ولا يرد عليها — بلاغ الإنتاج نفسه.
-- ① (بعد 070): في سياق admin يرى ويرد ويحدّث كالأدمن؛ في سياق customer أو بعد
--    انتهاء السياق لا يرى شيئًا (الاحتواء من 040 كما هو)؛ الأدمن والدعم والعميل
--    كما كانوا.
-- ② التراجع وإعادة التطبيق.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
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
  -- نفس العلم اللي enter_context بتفتحه للكتابة؛ هنا بيسمح كمان بسياق منتهي
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values ('00000000-0000-4000-8000-0000000000f0', p_context, now(),
          case when p_live then now() + interval '12 hours' else now() - interval '1 minute' end)
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون: C1/C2 عملاء، AD أدمن، SP دعم، OW مالك المنصة ─────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'), ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000031', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'عميل اتنين', 'user', '01000000032', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000033', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io', 'دعم', 'support', '01000000034', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000035', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES ('00000000-0000-4000-8000-0000000000f0', 'owner');
INSERT INTO public.tickets (id, user_id, title, description, status, priority, category) VALUES
  ('11111111-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1', 'مشكلة دخول', 'وصف', 'open', 'medium', 'login'),
  ('11111111-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000c1', 'سؤال', 'وصف', 'open', 'low', 'other'),
  ('11111111-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000c2', 'تذكرة تانية', 'وصف', 'open', 'low', 'other');
INSERT INTO public.ticket_replies (ticket_id, user_id, message, is_internal) VALUES
  ('11111111-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1', 'رد العميل', false),
  ('11111111-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000ad', 'ملاحظة داخلية', true);

-- ما يراه حساب من تذاكر العملاء وردودها
CREATE FUNCTION t.seen() RETURNS text LANGUAGE sql AS $$
  select (select count(*) from public.tickets where user_id in ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000c2'))
         || '/' || (select count(*) from public.ticket_replies where ticket_id = '11111111-0000-4000-8000-0000000000c1') $$;
GRANT EXECUTE ON FUNCTION t.seen() TO authenticated;

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  IF NOT public.is_platform_owner() OR public.active_context() <> 'admin' OR NOT public.is_admin()
     OR NOT public.is_platform_staff() OR public.has_elevated_authority() THEN
    RAISE EXCEPTION 'SETUP: المالك مش في سياق admin بصلاحيات الإنتاج';
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS SETUP: المالك في سياق admin (is_admin=true، has_elevated=false) + عميلين وأدمن ودعم';
END $$;

-- ============================================================================
-- ⓪ قبل 070
-- ============================================================================
DO $$
DECLARE seen text; st text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  seen := t.seen();
  st := t.try($s$insert into public.ticket_replies (ticket_id, user_id, message)
                values ('11111111-0000-4000-8000-0000000000c1', auth.uid(), 'رد المالك')$s$);
  RESET ROLE;
  IF seen <> '0/0' OR st <> '42501' THEN RAISE EXCEPTION 'FAIL ⓪: السلوك قبل 070 مش زي الإنتاج (% / %)', seen, st; END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PROVEN GAP ⓪ (قبل 070): المالك في سياق admin بيشوف 0 من 3 تذاكر عملاء و0 ردود، والرد مرفوض (%)', st;
END $$;

-- ============================================================================
-- ① بعد 070
-- ============================================================================
\i migrations/070_owner_admin_context_tickets.sql
SET search_path = public, extensions;

-- ── O1: المالك في سياق admin = أدمن على التذاكر ────────────────────────────
DO $$
DECLARE seen text; upd int; del int;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  seen := t.seen();
  INSERT INTO public.ticket_replies (ticket_id, user_id, message)
  VALUES ('11111111-0000-4000-8000-0000000000c1', auth.uid(), 'رد المالك من الإدارة');
  upd := t.rows($s$update public.tickets set priority = 'high' where id = '11111111-0000-4000-8000-0000000000c2'$s$);
  del := t.rows($s$delete from public.tickets where id = '11111111-0000-4000-8000-0000000000c3'$s$);
  RESET ROLE;
  IF seen <> '3/2' OR upd <> 1 OR del <> 1 THEN
    RAISE EXCEPTION 'FAIL O1: المالك في سياق admin (شاف %، عدّل %، حذف %)', seen, upd, del;
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS O1: المالك في سياق admin شاف 3/3 تذاكر و2 رد (منها الداخلي)، رد، وعدّل وحذف زي الأدمن';
END $$;

-- ── O2: الاحتواء — سياق customer أو سياق منتهي ⇒ ولا تذكرة عميل ──────────
DO $$
DECLARE s_cust text; s_exp text; st text; upd int;
BEGIN
  PERFORM t.ctx('customer');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated;
  s_cust := t.seen();
  st := t.try($s$insert into public.ticket_replies (ticket_id, user_id, message)
                values ('11111111-0000-4000-8000-0000000000c1', auth.uid(), 'رد')$s$);
  upd := t.rows($s$update public.tickets set priority = 'low' where id = '11111111-0000-4000-8000-0000000000c1'$s$);
  RESET ROLE;
  PERFORM t.ctx('company_admin');
  SET LOCAL ROLE authenticated;
  IF t.seen() <> '0/0' THEN RESET ROLE; RAISE EXCEPTION 'FAIL O2: سياق company_admin شاف تذاكر العملاء'; END IF;
  RESET ROLE;
  PERFORM t.ctx('admin', false);
  SET LOCAL ROLE authenticated;
  s_exp := t.seen();
  RESET ROLE;
  IF s_cust <> '0/0' OR st <> '42501' OR upd <> 0 OR s_exp <> '0/0' THEN
    RAISE EXCEPTION 'FAIL O2: الاحتواء انكسر (customer=% رد=% تعديل=% منتهي=%)', s_cust, st, upd, s_exp;
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS O2: المالك في سياق customer/company_admin أو بعد انتهاء السياق ⇒ 0 تذاكر عملاء، الرد 42501، التعديل 0 صفوف';
END $$;

-- ── O3: الباقي كما كان ─────────────────────────────────────────────────────
DO $$
DECLARE s_owner text; s_ad text; s_sp text; s_c1 text; s_c2 text;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');  SET LOCAL ROLE authenticated; s_owner := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');  SET LOCAL ROLE authenticated; s_ad := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');  SET LOCAL ROLE authenticated; s_sp := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');  SET LOCAL ROLE authenticated; s_c1 := t.seen(); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');  SET LOCAL ROLE authenticated; s_c2 := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  -- العميل يشوف تذاكره وردوده غير الداخلية بس
  IF s_owner <> '3/3' OR s_ad <> '3/3' OR s_sp <> '3/3' OR s_c1 <> '2/2' OR s_c2 <> '1/0' THEN
    RAISE EXCEPTION 'FAIL O3: owner=% admin=% support=% c1=% c2=%', s_owner, s_ad, s_sp, s_c1, s_c2;
  END IF;
  -- قيود العميل على تذكرته كما هي بعد تعديل المحفّزين
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  IF t.try($s$update public.tickets set status = 'resolved' where id = '11111111-0000-4000-8000-0000000000c2'$s$) <> 'P0001'
     OR t.try($s$update public.tickets set archived_by_customer = true where id = '11111111-0000-4000-8000-0000000000c2'$s$) <> 'ok' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL O3: قيود العميل اتغيّرت';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS O3: المالك في سياق owner والأدمن والدعم 3/3؛ العميل تذاكره وردوده غير الداخلية بس (2/2 و1/0)، ولسه مايقدرش يغيّر الحالة (الأرشفة بس)';
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/_rollback/070_owner_admin_context_tickets.down.sql
DO $$
DECLARE seen text;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated; seen := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  IF seen <> '0/0' THEN RAISE EXCEPTION 'FAIL RB1: التراجع مارجّعش سلوك الإنتاج (%)', seen; END IF;
  RAISE NOTICE 'PASS RB1: التراجع بيرجّع نص الإنتاج (المالك في admin ⇒ 0/0)';
END $$;
\i migrations/070_owner_admin_context_tickets.sql
DO $$
DECLARE seen text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated; seen := t.seen(); RESET ROLE;
  PERFORM t.act(NULL);
  IF seen <> '3/3' THEN RAISE EXCEPTION 'FAIL RB2 (%)', seen; END IF;
  RAISE NOTICE 'PASS RB2: إعادة التطبيق idempotent';
END $$;

SELECT 'ALL OWNER ADMIN CONTEXT TICKET TESTS PASSED';
