-- ============================================================================
-- بوابة ما قبل الإنتاج لـ Conversation Core — على نسخة مطابقة لشكل الإنتاج
--
-- الفرق عن conversation-core.test.sql: هناك الجداول والسياسات مكتوبة باليد
-- (tickets من غير ولا محفّز). هنا قاعدة الإنتاج كاملة (tests/fixtures/prod-shape):
-- 20 محفّز على tickets منهم حصة 065، بوابة الحساب 042/066، كل سياسات RLS،
-- كل الصلاحيات — ثم 064 كما هو، ثم 067.
--
-- الجزء ① (064 كما هو): كل فجوة مثبتة بسلوكها الفعلي. لو حد صلّحها في 064
--   نفسه الاختبار هيقول.
-- الجزء ② (بعد 067): الإصلاحات + نموذج التهديد كامل + التزامن A–E باتصالات
--   حقيقية (dblink) + توافق المسارات القديمة + التراجع وإعادة التطبيق.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

-- ── مساعدات ────────────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
CREATE FUNCTION t.as_service() RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.role', 'service_role', false); $$;
-- يرجّع sqlstate لو فشل، أو 'ok' (والأثر بيترجع في الحالتين).
CREATE FUNCTION t.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  raise exception using errcode = 'TT000';
exception when others then
  return case when sqlstate = 'TT000' then 'ok' else sqlstate end;
end $$;
CREATE FUNCTION t.conn(p_name text) RETURNS text LANGUAGE sql AS $$
  select t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1))); $$;
CREATE FUNCTION t.svc_conn(p_name text) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.conn(p_name);
  perform t.dblink_exec(p_name, s) from (values
    ('set search_path = public, extensions'), ($s$set deadlock_timeout = '200ms'$s$),
    ($s$set request.jwt.claim.sub = ''$s$), ($s$set request.jwt.claim.role = 'service_role'$s$),
    ('set role service_role'), ($s$set lock_timeout = '10s'$s$)) q(s);
end $$;
CREATE FUNCTION t.user_conn(p_name text, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.conn(p_name);
  perform t.dblink_exec(p_name, s) from (values
    ('set search_path = public, extensions'),
    (format('set request.jwt.claim.sub = %L', p_user)), ($s$set request.jwt.claim.role = 'authenticated'$s$),
    ('set role authenticated'), ($s$set lock_timeout = '10s'$s$)) q(s);
end $$;
-- نتيجة استعلام في اتصال (نص واحد)
CREATE FUNCTION t.q(p_conn text, p_sql text) RETURNS text LANGUAGE sql AS $$
  select x from t.dblink(p_conn, p_sql) as r(x text); $$;
-- استنى لحد ما الاتصال يقف على قفل (أو ينتهي)
CREATE FUNCTION t.wait_blocked(p_conn text) RETURNS boolean LANGUAGE plpgsql AS $$
declare i int := 0;
begin
  loop
    -- pg_stat_activity بيتصوّر مرة لكل معاملة؛ من غير المسح الاستدعاء التاني بيشوف صورة قديمة.
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity a where a.wait_event_type = 'Lock'
                and a.pid <> pg_backend_pid() and a.backend_type = 'client backend'
                and a.state = 'active') then
      return true;
    end if;
    if t.dblink_is_busy(p_conn) = 0 then return false; end if;
    i := i + 1;
    if i > 200 then return false; end if;
    perform pg_sleep(0.02);
  end loop;
end $$;
-- plpgsql عن قصد: العمود بييجي مع 064 (دالة sql بتتفحص وقت الإنشاء).
CREATE FUNCTION t.version(p uuid) RETURNS int LANGUAGE plpgsql AS $$
begin
  return (select state_version from public.chat_sessions where id = p);
end $$;
CREATE FUNCTION t.bot_msgs(p uuid) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.chat_messages where session_id = p and is_bot_reply; $$;
CREATE FUNCTION t.events(p uuid, k text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.inbox_events where session_id = p and kind = k; $$;
CREATE FUNCTION t.tickets(p uuid) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.tickets where user_id = p; $$;
CREATE FUNCTION t.b(j jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  select coalesce((j->>k)::boolean, false); $$;
CREATE FUNCTION t.flag(p_channel text, v jsonb) RETURNS void LANGUAGE sql AS $$
  update public.sie_settings set value = v where key = 'core_ingest_' || p_channel; $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون (حسابات حقيقية بمحفّزات الإنتاج: بوابة، قائمة انتظار، هاتف) ──
--   C1..C4 عملاء معتمدون (أنشئوا قبل البوابة + هاتف)   CB محظور   CW قائمة انتظار
--   E1 أدمن مرتفع (مشرف الصندوق)
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000c3', 'c3@t.io'), ('00000000-0000-4000-8000-0000000000c4', 'c4@t.io'),
  ('00000000-0000-4000-8000-0000000000cb', 'cb@t.io'), ('00000000-0000-4000-8000-0000000000cd', 'cw@t.io'),
  ('00000000-0000-4000-8000-0000000000e1', 'e1@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000001', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'عميل اتنين', 'user', '01000000002', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c3', 'c3@t.io', 'عميل تلاتة', 'user', '01000000003', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c4', 'c4@t.io', 'عميل أربعة', 'user', '01000000004', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000cb', 'cb@t.io', 'محظور', 'user', '01000000005', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000cd', 'cw@t.io', 'منتظر', 'user', '01000000006', now()),
  ('00000000-0000-4000-8000-0000000000e1', 'e1@t.io', 'أدمن مرتفع', 'admin', '01000000007', '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = '00000000-0000-4000-8000-0000000000cb';
INSERT INTO public.platform_authority (user_id, level) VALUES ('00000000-0000-4000-8000-0000000000e1', 'elevated_admin');
-- C3 قرب الحد: الخطة المجانية 20 تذكرة شهريًا (065) — 19 مستخدمة.
INSERT INTO public.tickets (user_id, title, description, status)
SELECT '00000000-0000-4000-8000-0000000000c3', 'قديمة ' || g, 'x', 'open' FROM generate_series(1, 19) g;

DO $$
BEGIN
  -- الإعداد اتأكد بدوال بوابة الإنتاج نفسها (042/066)، مش بافتراض
  IF NOT (public.account_is_whitelisted('00000000-0000-4000-8000-0000000000c1')
          AND public.account_verification_ok('00000000-0000-4000-8000-0000000000c1')) THEN
    RAISE EXCEPTION 'SETUP: C1 مش معتمد في بوابة الإنتاج';
  END IF;
  IF public.account_is_whitelisted('00000000-0000-4000-8000-0000000000cd') THEN
    RAISE EXCEPTION 'SETUP: CW المفروض في قائمة الانتظار';
  END IF;
  IF NOT public.is_banned('00000000-0000-4000-8000-0000000000cb') THEN
    RAISE EXCEPTION 'SETUP: CB المفروض محظور';
  END IF;
  IF (public.ticket_quota_status('00000000-0000-4000-8000-0000000000c3')->>'remaining')::int <> 1 THEN
    RAISE EXCEPTION 'SETUP: C3 المفروض فاضله تذكرة واحدة (%)', public.ticket_quota_status('00000000-0000-4000-8000-0000000000c3');
  END IF;
  RAISE NOTICE 'PASS SETUP: نسخة الإنتاج + الفاعلون (معتمد/محظور/منتظر/قرب الحد) ببوابة الإنتاج نفسها';
END $$;

-- ============================================================================
-- ① 064 كما هو
-- ============================================================================
\i migrations/064_conversation_core.sql
SET search_path = public, extensions;

-- محادثة تيليجرام لـ C3 على Core
CREATE TABLE t.ids (k text PRIMARY KEY, id uuid, v int);
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c3', '301', 'tg:301:1', 'محتاج أفتح تذكرة');
  INSERT INTO t.ids VALUES ('c3', (r->'conversation'->>'id')::uuid, (r->>'stateVersion')::int);
END $$;

-- ①-D1 الحصة: التذكرة رقم 20 مسموحة، والـ 21 بترمي استثناء جوه commit ⇒ مفيش رد
DO $$
DECLARE sid uuid; v int; r jsonb; st text;
BEGIN
  SELECT id, t.version(id) INTO sid, v FROM t.ids WHERE k = 'c3';
  PERFORM t.as_service();
  r := public.conv_commit_turn(sid, v, 'q-ok', 'تمام', '[]', null, 'sie', false, '{"category":"دعم"}');
  IF NOT t.b(r, 'committed') OR r->>'ticketNumber' IS NULL THEN RAISE EXCEPTION 'FAIL P1a: %', r; END IF;
  -- الحساب وصل 20/20
  v := t.version(sid);
  st := t.try(format($s$select public.conv_commit_turn(%L, %s, 'q-over', 'هفتحلك تذكرة', '[]', null, 'sie', false, '{"category":"دعم"}')$s$, sid, v));
  IF st <> 'P0001' THEN RAISE EXCEPTION 'FAIL P1b: توقعنا P0001 من حصة 065، جالنا %', st; END IF;
  IF EXISTS (SELECT 1 FROM public.chat_messages WHERE session_id = sid AND external_id = 'turn:q-over') THEN
    RAISE EXCEPTION 'FAIL P1c';
  END IF;
  RAISE NOTICE 'PROVEN GAP D1 (064): الحصة خلصت ⇒ conv_commit_turn بيرمي P0001 ⇒ الدور كله اترجع ⇒ العميل مالوش رد';
END $$;

-- ①-N1 مساحة الأسماء: رسالة عميل بمعرّف 'turn:k' بتسكت رد الوكيل بنفس المفتاح
DO $$
DECLARE r jsonb; sid uuid; v int;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c1', '101', 'turn:hijack', 'أي حاجة');
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  r := public.conv_commit_turn(sid, v, 'hijack', 'رد البوت');
  IF NOT (t.b(r, 'committed') AND t.b(r, 'duplicate')) OR t.bot_msgs(sid) <> 0 THEN
    RAISE EXCEPTION 'FAIL N1-064: %', r;
  END IF;
  INSERT INTO t.ids VALUES ('c1tg', sid, null);
  RAISE NOTICE 'PROVEN GAP N1 (064): رسالة عميل external_id=turn:hijack ⇒ commit بنفس المفتاح رجع duplicate ومفيش رد اتكتب';
END $$;

-- ①-G1 بوابة الحساب: المحظور والمنتظر بيتقبلوا عبر Core (service_role بيعدّي RLS)
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000cb', '501', 'tg:501:1', 'محظور بيكتب');
  IF NOT t.b(r, 'created') THEN RAISE EXCEPTION 'FAIL G1-064a'; END IF;
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000cd', '502', 'tg:502:1', 'منتظر بيكتب');
  IF NOT t.b(r, 'created') THEN RAISE EXCEPTION 'FAIL G1-064b'; END IF;
  -- نفس الحساب من المتصفح مرفوض (بوابة الإنتاج):
  PERFORM t.act('00000000-0000-4000-8000-0000000000cb');
  SET LOCAL ROLE authenticated;
  IF t.try($s$insert into public.chat_sessions (user_id) values ('00000000-0000-4000-8000-0000000000cb')$s$) = 'ok' THEN
    RAISE EXCEPTION 'FAIL G1-064c: البوابة نفسها مش شغالة في النسخة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PROVEN GAP G1 (064): المحظور والمنتظر اتقبلوا عبر Core، والبوابة بترفضهم من المتصفح';
END $$;

-- ①-D3 الخمول يقفل محادثة ماسكها إنسان ويرجّع العميل للبوت
DO $$
DECLARE r jsonb; sid uuid; sid2 uuid;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '201', 'tg:201:1', 'عايز حد من الدعم');
  sid := (r->'conversation'->>'id')::uuid;
  PERFORM public.sie_request_human(sid, 'test');
  UPDATE public.chat_sessions SET updated_at = now() - interval '2 days' WHERE id = sid;
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '201', 'tg:201:2', 'لسه مستني',
         '[]', '{}', null, interval '24 hours');
  sid2 := (r->'conversation'->>'id')::uuid;
  IF sid2 = sid OR r->>'owner' <> 'agent' OR (SELECT status FROM public.chat_sessions WHERE id = sid) <> 'closed' THEN
    RAISE EXCEPTION 'FAIL D3-064: %', r;
  END IF;
  RAISE NOTICE 'PROVEN GAP D3 (064): محادثة ماسكها إنسان + خمول 48 ساعة ⇒ اتقفلت والعميل رجع للبوت (owner=agent)';
END $$;

-- ①-D4 العميل بيكتب في محادثة Core مباشرة والعلم مفتوح، ويرجّع جلسة مقفولة
DO $$
DECLARE r jsonb; sid uuid; v int; st text;
BEGIN
  PERFORM t.flag('website', 'true');
  PERFORM t.as_service();
  r := public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c4', '', 'web:1', 'أهلا');
  sid := (r->'conversation'->>'id')::uuid; v := t.version(sid);
  PERFORM t.act('00000000-0000-4000-8000-0000000000c4');
  SET LOCAL ROLE authenticated;
  st := t.try(format($s$insert into public.chat_messages (session_id, sender_id, message_text) values (%L, '00000000-0000-4000-8000-0000000000c4', 'من المتصفح')$s$, sid));
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4-064a: %', st; END IF;
  RESET ROLE;
  PERFORM t.as_service();
  PERFORM public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c4', '', 'web:x', 'لإقفال');
  UPDATE public.chat_sessions SET status = 'closed' WHERE id = sid;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c4');
  SET LOCAL ROLE authenticated;
  st := t.try(format($s$update public.chat_sessions set status = 'active' where id = %L$s$, sid));
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4-064b: %', st; END IF;
  RESET ROLE;
  PERFORM t.flag('website', 'false');
  RAISE NOTICE 'PROVEN GAP D4 (064): العلم مفتوح والعميل لسه بيكتب مباشرة في محادثة Core (من غير external_id ولا نسخة)، وبيرجّع جلسة مقفولة';
END $$;

-- ①-D2 ingest مالوش مكان للمرفق خالص
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'conv_ingest_message'
              AND pg_get_function_identity_arguments(oid) LIKE '%attachment%') THEN
    RAISE EXCEPTION 'FAIL D2-064';
  END IF;
  RAISE NOTICE 'PROVEN GAP D2 (064): conv_ingest_message مابياخدش مرفق ⇒ صورة/صوت/ملف عبر Core مايوصلوش للصندوق';
END $$;

-- ①-L1 ترتيب الأقفال: المسار القديم (حصة ← جلسة) ضد commit 064 (جلسة ← حصة) ⇒ deadlock
DELETE FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000c1';
SELECT t.svc_conn('w1'), t.svc_conn('w2');
DO $$
DECLARE sid uuid; v int; st1 text; st2 text; r text;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'c1tg';
  v := t.version(sid);
  PERFORM t.dblink_exec('w1', 'begin');
  -- المسار القديم: التذكرة الأول (محفّز 065 بياخد قفل الحصة)…
  PERFORM t.dblink_exec('w1', $s$insert into public.tickets (user_id, title, description) values ('00000000-0000-4000-8000-0000000000c1', 'قديم', 'x')$s$);
  -- …و Core (064): الجلسة الأول ثم التذكرة ⇒ بيستنى قفل الحصة وهو ماسك الجلسة
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'dl', 'رد', '[]', null, 'sie', false, '{"category":"دعم"}')::text$s$, sid, v));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL L1-064a: Core ماوقفش على قفل الحصة'; END IF;
  -- …والمسار القديم يكمل: رسالة البوت (محتاج قفل الجلسة) ⇒ حلقة
  BEGIN
    PERFORM t.dblink_exec('w1', format($s$insert into public.chat_messages (session_id, message_text, is_bot_reply) values (%L, 'رد قديم', true)$s$, sid));
    st1 := 'ok';
  EXCEPTION WHEN others THEN st1 := CASE WHEN SQLERRM LIKE '%deadlock%' THEN 'deadlock' ELSE SQLERRM END;
  END;
  BEGIN
    SELECT x INTO r FROM t.dblink_get_result('w2') AS q(x text);
    st2 := 'ok';
  EXCEPTION WHEN others THEN st2 := CASE WHEN SQLERRM LIKE '%deadlock%' THEN 'deadlock' ELSE SQLERRM END;
  END;
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  PERFORM t.dblink_exec('w1', 'rollback');
  IF 'deadlock' NOT IN (st1, st2) THEN
    RAISE EXCEPTION 'FAIL L1-064: توقعنا deadlock (قديم=%، Core=%)', st1, st2;
  END IF;
  RAISE NOTICE 'PROVEN GAP L1 (064): المسار القديم + commit بتذكرة على نفس الجلسة ⇒ deadlock (قديم=%، Core=%)', st1, st2;
END $$;
SELECT t.dblink_disconnect('w1'), t.dblink_disconnect('w2');
-- ⇒ الجلسة اللي اتقفلت بالخطأ ترجع للحالة الطبيعية للجزء التاني
DELETE FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000c1';

-- ============================================================================
-- ② بعد 067
-- ============================================================================
\i migrations/067_conversation_core_gate.sql
SET search_path = public, extensions;

-- ── G1 + N1 ────────────────────────────────────────────────────────────────
DO $$
DECLARE before_msgs int := (SELECT count(*) FROM public.chat_messages);
        before_sess int := (SELECT count(*) FROM public.chat_sessions);
BEGIN
  PERFORM t.as_service();
  IF t.try($s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000cb', '601', 'tg:601:1', 'x')$s$) <> '42501'
     OR t.try($s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000cd', '602', 'tg:602:1', 'x')$s$) <> '42501' THEN
    RAISE EXCEPTION 'FAIL G1: المحظور/المنتظر لسه بيعدّوا';
  END IF;
  IF t.try($s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c1', '101', 'turn:x2', 'x')$s$) <> '22023' THEN
    RAISE EXCEPTION 'FAIL N1: turn: لسه مقبول من العميل';
  END IF;
  IF (SELECT count(*) FROM public.chat_messages) <> before_msgs OR (SELECT count(*) FROM public.chat_sessions) <> before_sess THEN
    RAISE EXCEPTION 'FAIL G1/N1: الرفض ساب أثر';
  END IF;
  RAISE NOTICE 'PASS G1: المحظور والمنتظر مرفوضين عبر Core (42501) من غير أي أثر';
  RAISE NOTICE 'PASS N1: external_id يبدأ بـ turn: مرفوض من الوارد (22023)';
END $$;

-- N1 الجزء التاني: الصف القديم اللي فيه turn:hijack (رسالة عميل) مابقاش بيسكت البوت
DO $$
DECLARE sid uuid; r jsonb;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'c1tg';
  PERFORM t.as_service();
  r := public.conv_commit_turn(sid, t.version(sid), 'hijack', 'رد البوت');
  -- الفهرس الفريد (session_id, external_id) لسه بيمنع صف تاني بنفس المفتاح ⇒ خطأ صريح بدل رد صامت
  RAISE EXCEPTION 'FAIL N1b: %', r;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS N1b: مفتاح دور اتاخد قبل 067 بصف عميل ⇒ commit بيفشل صراحةً (23505) بدل duplicate صامت';
END $$;

-- ── D1 الحصة ───────────────────────────────────────────────────────────────
DO $$
DECLARE sid uuid; v int; r jsonb; n_before int; ev int;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'c3';
  v := t.version(sid); n_before := t.tickets('00000000-0000-4000-8000-0000000000c3');
  IF (public.ticket_quota_status('00000000-0000-4000-8000-0000000000c3')->>'remaining')::int <> 0 THEN
    RAISE EXCEPTION 'SETUP D1: C3 المفروض خلّص حصته';
  END IF;
  PERFORM t.as_service();
  r := public.conv_commit_turn(sid, v, 'd1-quota', 'تمام، هسجّل مشكلتك', '[]', '{"step":"ticket"}', 'sie', false,
         '{"category":"دعم","description":"مشكلة","confirmation":"رقم تذكرتك #{ticket_number}"}');
  IF NOT t.b(r, 'committed') OR t.b(r, 'duplicate') OR r->>'ticketError' <> 'ticket_quota_exceeded'
     OR r->>'ticketNumber' IS NOT NULL OR r->>'owner' <> 'agent' OR (r->>'stateVersion')::int <> v + 1 THEN
    RAISE EXCEPTION 'FAIL D1a: %', r;
  END IF;
  IF t.tickets('00000000-0000-4000-8000-0000000000c3') <> n_before THEN RAISE EXCEPTION 'FAIL D1b: اتعملت تذكرة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE id = (r->>'messageId')::uuid AND is_bot_reply
                   AND message_text LIKE 'تمام، هسجّل مشكلتك%' AND message_text LIKE '%الأقصى من التذاكر%'
                   AND message_text NOT LIKE '%رقم تذكرتك%' AND metadata->>'ticketError' = 'ticket_quota_exceeded') THEN
    RAISE EXCEPTION 'FAIL D1c: الرد مش فيه نص الحصة أو فيه تأكيد كاذب: %',
      (SELECT to_jsonb(m) - 'id' FROM public.chat_messages m WHERE id = (r->>'messageId')::uuid);
  END IF;
  SELECT count(*) INTO ev FROM public.inbox_events WHERE session_id = sid AND kind = 'ticket_failed'
     AND payload->>'reason' = 'ticket_quota_exceeded' AND payload->>'sqlstate' = 'P0001';
  IF ev <> 1 OR (SELECT bot_state->>'step' FROM public.chat_sessions WHERE id = sid) <> 'ticket' THEN
    RAISE EXCEPTION 'FAIL D1d: الحدث أو الحالة';
  END IF;
  -- إعادة نفس الدور ⇒ نفس النتيجة ومفيش رسالة تانية
  r := public.conv_commit_turn(sid, v, 'd1-quota', 'تمام، هسجّل مشكلتك', '[]', null, 'sie', false, '{"category":"دعم"}');
  IF NOT t.b(r, 'duplicate') OR r->>'ticketError' <> 'ticket_quota_exceeded' THEN RAISE EXCEPTION 'FAIL D1e: %', r; END IF;
  RAISE NOTICE 'PASS D1: الحصة خلصت ⇒ الرد اتسجّل + نص الحصة من 065، من غير تذكرة ولا تأكيد كاذب، حدث ticket_failed، والإعادة duplicate';
END $$;

-- D1 فشل تاني (غير الحصة) ⇒ الرد اتسجّل + تسليم لإنسان + الحدث بالـ sqlstate
DO $$
DECLARE r jsonb; sid uuid;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '202', 'tg:202:1', 'مشكلة');
  sid := (r->'conversation'->>'id')::uuid;
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'd1-bad', 'هفتحلك تذكرة', '[]', null, 'sie', false,
         '{"category":"دعم","priority":"urgent"}');
  IF NOT t.b(r, 'committed') OR r->>'ticketError' <> 'ticket_failed' OR NOT t.b(r, 'handoff') OR r->>'owner' <> 'human' THEN
    RAISE EXCEPTION 'FAIL D1f: %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inbox_events WHERE session_id = sid AND kind = 'ticket_failed' AND payload->>'sqlstate' = '23514')
     OR NOT EXISTS (SELECT 1 FROM public.inbox_events WHERE session_id = sid AND kind = 'handoff_to_human') THEN
    RAISE EXCEPTION 'FAIL D1g: الحدث أو التسليم';
  END IF;
  RAISE NOTICE 'PASS D1b: فشل تذكرة غير متوقع (23514) ⇒ الرد اتسجّل + نص ثابت + تسليم لإنسان + حدث بالـ sqlstate';
END $$;

-- D1 تذكرة سليمة ⇒ رقمها في التأكيد + نوعها وأولويتها
DO $$
DECLARE r jsonb; sid uuid; n bigint;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '401', 'tg:401:1', 'استفسار');
  sid := (r->'conversation'->>'id')::uuid;
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'd1-ok', 'سجلت استفسارك', '[]', null, 'sie', false,
         '{"category":"استفسار","type":"inquiry","priority":"low","confirmation":"رقمها #{ticket_number}"}');
  n := (r->>'ticketNumber')::bigint;
  IF n IS NULL OR r->>'ticketError' IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.tickets WHERE ticket_number = n AND ticket_type = 'inquiry' AND priority = 'low'
                      AND user_id = '00000000-0000-4000-8000-0000000000c4')
     OR NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE id = (r->>'messageId')::uuid AND message_text LIKE '%رقمها #' || n || '%') THEN
    RAISE EXCEPTION 'FAIL D1h: %', r;
  END IF;
  -- محفّزات الإنتاج على التذكرة اشتغلت (إيميل + workflows عبر pg_net) جوه نفس المعاملة
  IF NOT EXISTS (SELECT 1 FROM net._calls WHERE url LIKE '%send-ticket-email%' AND body->>'ticket_number' = n::text) THEN
    RAISE EXCEPTION 'FAIL D1i: محفّز إيميل التذكرة ماشتغلش';
  END IF;
  RAISE NOTICE 'PASS D1c: تذكرة سليمة ⇒ رقمها في التأكيد، inquiry/low، ومحفّزات الإنتاج (إيميل 065) اشتغلت';
END $$;

-- ── T11 فشل جزئي: الرسالة نفسها بتفشل ⇒ ولا تذكرة ولا حالة ولا نسخة ──────────
CREATE FUNCTION t.boom() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if new.is_bot_reply and new.message_text like '%BOOM%' then
    raise exception 'injected failure' using errcode = 'XX999';
  end if;
  return new;
end $$;
CREATE TRIGGER t_boom BEFORE INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION t.boom();
DO $$
DECLARE r jsonb; sid uuid; v int; st text; n int;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '402', 'tg:402:1', 'x');
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  n := t.tickets('00000000-0000-4000-8000-0000000000c4');
  st := t.try(format($s$select public.conv_commit_turn(%L, %s, 't11', 'BOOM', '[]', '{"x":1}', 'sie', true, '{"category":"دعم"}', 'fail')$s$, sid, v));
  IF st <> 'XX999' OR t.tickets('00000000-0000-4000-8000-0000000000c4') <> n OR t.version(sid) <> v
     OR t.bot_msgs(sid) <> 0 OR (SELECT is_manual_mode FROM public.chat_sessions WHERE id = sid)
     OR (SELECT bot_state FROM public.chat_sessions WHERE id = sid) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'FAIL T11: st=% أثر باقي', st;
  END IF;
  RAISE NOTICE 'PASS T11: فشل إدراج الرد بعد التذكرة ⇒ المعاملة كلها اترجعت (لا تذكرة ولا حالة ولا نسخة ولا تسليم)';
END $$;
DROP TRIGGER t_boom ON public.chat_messages;

-- ── T10 مدخلات غلط ⇒ مفيش أثر ──────────────────────────────────────────────
DO $$
DECLARE sid uuid; v int; codes text[];
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'c3'; v := t.version(sid);
  PERFORM t.as_service();
  codes := array[
    t.try(format($s$select public.conv_commit_turn(%L, %s, '', 'x')$s$, sid, v)),
    t.try(format($s$select public.conv_commit_turn(%L, %s, 'k', '  ')$s$, sid, v)),
    t.try(format($s$select public.conv_commit_turn(%L, %s, 'k', repeat('x', 4001))$s$, sid, v)),
    t.try(format($s$select public.conv_commit_turn(%L, %s, 'k', 'x', '{}')$s$, sid, v)),
    t.try(format($s$select public.conv_commit_turn(%L, %s, 'k', 'x', '[]', '[]')$s$, sid, v)),
    t.try($s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c3', '301', 'e1', '  ')$s$),
    t.try($s$select public.conv_ingest_message('sms', '00000000-0000-4000-8000-0000000000c3', '301', 'e1', 'x')$s$)];
  IF codes <> array['22023','22023','22023','22023','22023','22023','22023'] OR t.version(sid) <> v THEN
    RAISE EXCEPTION 'FAIL T10: %', codes;
  END IF;
  RAISE NOTICE 'PASS T10: مدخلات غلط (مفتاح/رد فاضي، رد طويل، أشكال غلط، رسالة فاضية، قناة مجهولة) ⇒ 22023 ومفيش أثر';
END $$;

-- ── D2 المرفقات ────────────────────────────────────────────────────────────
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c1/s-1-a.png'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c1/s-1-b.webm'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c1/s-1-c.pdf'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c2/s-2-z.png');
DO $$
DECLARE r jsonb; m record; sid uuid; before_msgs int; staff_sees int; st text;
BEGIN
  PERFORM t.as_service();
  -- صورة بتعليق
  r := public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:img', 'شوف الصورة', '[]', '{}', null, null,
         '{"kind":"image","path":"00000000-0000-4000-8000-0000000000c1/s-1-a.png","name":"a.png","mime":"image/png","size":1200}');
  sid := (r->'conversation'->>'id')::uuid;
  SELECT * INTO m FROM public.chat_messages WHERE id = (r->'message'->>'id')::uuid;
  IF m.message_text <> 'شوف الصورة' OR m.attachment->>'kind' <> 'image' OR m.image_url <> '00000000-0000-4000-8000-0000000000c1/s-1-a.png'
     OR m.audio_url IS NOT NULL OR m.sender_id <> '00000000-0000-4000-8000-0000000000c1' THEN
    RAISE EXCEPTION 'FAIL D2a: %', to_jsonb(m);
  END IF;
  -- صوت من غير نص ⇒ نص تلقائي زي الويدجت
  r := public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:aud', '', '[]', '{}', null, null,
         '{"kind":"audio","path":"00000000-0000-4000-8000-0000000000c1/s-1-b.webm","mime":"audio/webm","size":800,"duration_ms":3200}');
  SELECT * INTO m FROM public.chat_messages WHERE id = (r->'message'->>'id')::uuid;
  IF m.message_text <> 'رسالة صوتية' OR m.audio_url <> '00000000-0000-4000-8000-0000000000c1/s-1-b.webm' OR m.image_url IS NOT NULL
     OR (m.attachment->>'duration_ms')::int <> 3200 THEN
    RAISE EXCEPTION 'FAIL D2b: %', to_jsonb(m);
  END IF;
  -- ملف
  r := public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:pdf', null, '[]', '{}', null, null,
         '{"kind":"file","path":"00000000-0000-4000-8000-0000000000c1/s-1-c.pdf","name":"فاتورة.pdf","mime":"application/pdf","size":5000}');
  SELECT * INTO m FROM public.chat_messages WHERE id = (r->'message'->>'id')::uuid;
  IF m.message_text <> 'ملف مرفق: فاتورة.pdf' OR m.image_url IS NOT NULL OR m.audio_url IS NOT NULL OR m.attachment->>'kind' <> 'file' THEN
    RAISE EXCEPTION 'FAIL D2c: %', to_jsonb(m);
  END IF;
  -- الصندوق: المشرف شايف التلاتة بالمرفق عبر RLS بتاعته (نفس الاستعلام اللي inbox-data.js بيعمله)
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO staff_sees FROM public.chat_messages WHERE session_id = sid AND attachment IS NOT NULL;
  RESET ROLE;
  IF staff_sees <> 3 THEN RAISE EXCEPTION 'FAIL D2d: المشرف شايف % من 3', staff_sees; END IF;
  -- مسار في مجلد عميل تاني ⇒ حارس 054 يرفض، ولا رسالة ولا محادثة جديدة
  PERFORM t.as_service();
  before_msgs := (SELECT count(*) FROM public.chat_messages);
  st := t.try($s$select public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c3', '', 'w:steal', 'x', '[]', '{}', null, null,
         '{"kind":"image","path":"00000000-0000-4000-8000-0000000000c2/s-2-z.png"}')$s$);
  IF st <> '42501' OR (SELECT count(*) FROM public.chat_messages) <> before_msgs
     OR EXISTS (SELECT 1 FROM public.chat_sessions WHERE user_id = '00000000-0000-4000-8000-0000000000c3' AND channel = 'website') THEN
    RAISE EXCEPTION 'FAIL D2e: %', st;
  END IF;
  -- فيديو (مش مدعوم في المنتج — 054 بيسمح image/audio/file) ⇒ رفض قبل أي كتابة
  st := t.try($s$select public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:vid', 'x', '[]', '{}', null, null,
         '{"kind":"video","path":"00000000-0000-4000-8000-0000000000c1/v.mp4"}')$s$);
  IF st <> '22023' THEN RAISE EXCEPTION 'FAIL D2f: %', st; END IF;
  -- ملف مش مرفوع فعلًا ⇒ رفض
  st := t.try($s$select public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:ghost', 'x', '[]', '{}', null, null,
         '{"kind":"file","path":"00000000-0000-4000-8000-0000000000c1/ghost.pdf"}')$s$);
  IF st <> '42501' THEN RAISE EXCEPTION 'FAIL D2g: %', st; END IF;
  INSERT INTO t.ids VALUES ('c1web', sid, null);
  RAISE NOTICE 'PASS D2: صورة/صوت/ملف ⇒ attachment + image_url/audio_url + نص تلقائي، المشرف شايفهم؛ مجلد غيره/ملف وهمي ⇒ 42501، فيديو ⇒ 22023 — بلا أثر';
END $$;

-- ── D3 ملكية الإنسان ───────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; sid uuid; v int;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '203', 'tg:203:1', 'عايز الدعم');
  sid := (r->'conversation'->>'id')::uuid;
  PERFORM public.sie_request_human(sid, 'test');
  UPDATE public.chat_sessions SET updated_at = now() - interval '3 days' WHERE id = sid;
  v := t.version(sid);
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '203', 'tg:203:2', 'لسه مستني',
         '[]', '{}', null, interval '24 hours');
  IF (r->'conversation'->>'id')::uuid <> sid OR r->>'owner' <> 'human' OR (r->>'stateVersion')::int <> v + 1
     OR (SELECT status FROM public.chat_sessions WHERE id = sid) <> 'active' THEN
    RAISE EXCEPTION 'FAIL D3a: %', r;
  END IF;
  -- البوت لسه مايقدرش يرد
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'd3', 'رد بوت');
  IF r->>'reason' <> 'human_owner' THEN RAISE EXCEPTION 'FAIL D3b: %', r; END IF;
  -- محادثة بوت خاملة لسه بتتقفل عادي (السلوك المقصود ما اتكسرش)
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '204', 'tg:204:1', 'x');
  UPDATE public.chat_sessions SET updated_at = now() - interval '3 days' WHERE id = (r->'conversation'->>'id')::uuid;
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '204', 'tg:204:2', 'y', '[]', '{}', null, interval '24 hours');
  IF r->'conversation'->>'resolution' <> 'created' THEN RAISE EXCEPTION 'FAIL D3c: %', r; END IF;
  RAISE NOTICE 'PASS D3: إنسان ماسك + خمول 3 أيام ⇒ نفس المحادثة ونفس المالك (human) والبوت مرفوض؛ محادثة البوت الخاملة بتتقفل عادي';
END $$;

-- D3 جلسة قديمة (قبل Core) ماسكها إنسان وخاملة ⇒ بتتبنّى ومابتتسابش
DO $$
DECLARE legacy uuid; r jsonb;
BEGIN
  INSERT INTO public.chat_sessions (user_id, guest_id) VALUES ('00000000-0000-4000-8000-0000000000c2', 'channel:telegram:205')
  RETURNING id INTO legacy;
  PERFORM t.as_service();
  PERFORM public.sie_request_human(legacy, 'قديم');
  UPDATE public.chat_sessions SET updated_at = now() - interval '5 days' WHERE id = legacy;
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '205', 'tg:205:1', 'رجعت', '[]', '{}', null, interval '24 hours');
  IF (r->'conversation'->>'id')::uuid <> legacy OR r->'conversation'->>'resolution' <> 'adopted' OR r->>'owner' <> 'human' THEN
    RAISE EXCEPTION 'FAIL D3d: %', r;
  END IF;
  RAISE NOTICE 'PASS D3b: جلسة قديمة ماسكها إنسان وخاملة 5 أيام ⇒ اتبنّت بمالكها (human)، مش محادثة بوت جديدة جنبها';
END $$;

-- D3 تزامن: استلام إنسان ↔ وارد خامل
-- (كل تجهيز في بلوك لوحده عشان يتثبّت: اتصالات dblink مابتشوفش معاملة مفتوحة)
SELECT t.svc_conn('w1'), t.svc_conn('w2');
SELECT t.conn('admin1');
SELECT t.dblink_exec('admin1', s) FROM (VALUES
  ('set search_path = public, extensions'),
  ($s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000e1'$s$),
  ($s$set request.jwt.claim.role = 'authenticated'$s$), ('set role authenticated'), ($s$set lock_timeout = '10s'$s$)) q(s);
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '206', 'tg:206:1', 'x');
  INSERT INTO t.ids VALUES ('d3a', (r->'conversation'->>'id')::uuid, null);
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '207', 'tg:207:1', 'x');
  INSERT INTO t.ids VALUES ('d3b', (r->'conversation'->>'id')::uuid, null);
  UPDATE public.chat_sessions SET updated_at = now() - interval '2 days' WHERE id IN (SELECT id FROM t.ids WHERE k IN ('d3a', 'd3b'));
END $$;
DO $$
DECLARE sid uuid; got jsonb;
BEGIN
  -- (أ) الاستلام ماسك القفل والوارد الخامل بيستنى ⇒ بيشوف human ومابيقفلش
  SELECT id INTO sid FROM t.ids WHERE k = 'd3a';
  PERFORM t.dblink_exec('admin1', 'begin');
  PERFORM t.q('admin1', format('select public.inbox_take_over(%L, %L)::text', sid, 'live'));
  PERFORM t.dblink_send_query('w1', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '206', 'tg:206:2', 'y', '[]', '{}', null, interval '24 hours')::text$s$);
  IF NOT t.wait_blocked('w1') THEN RAISE EXCEPTION 'FAIL D3e: الوارد ماستناش الاستلام'; END IF;
  PERFORM t.dblink_exec('admin1', 'commit');
  SELECT x::jsonb INTO got FROM t.dblink_get_result('w1') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w1', false) AS q(x text);
  IF (got->'conversation'->>'id')::uuid <> sid OR got->>'owner' <> 'human' THEN RAISE EXCEPTION 'FAIL D3f: %', got; END IF;
  -- (ب) الوارد الخامل الأول (محادثة بوت) ⇒ اتقفلت، والاستلام بعده بيفشل صريح على المقفولة
  SELECT id INTO sid FROM t.ids WHERE k = 'd3b';
  PERFORM t.dblink_exec('w1', 'begin');
  PERFORM t.q('w1', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '207', 'tg:207:2', 'y', '[]', '{}', null, interval '24 hours')::text$s$);
  PERFORM t.dblink_send_query('admin1', format('select public.inbox_take_over(%L, %L)::text', sid, 'late'));
  IF NOT t.wait_blocked('admin1') THEN RAISE EXCEPTION 'FAIL D3g: الاستلام ماستناش'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  BEGIN
    PERFORM * FROM t.dblink_get_result('admin1') AS q(x text);
    RAISE EXCEPTION 'FAIL D3h: الاستلام نجح على محادثة اتقفلت';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  PERFORM * FROM t.dblink_get_result('admin1', false) AS q(x text);
  IF (SELECT status FROM public.chat_sessions WHERE id = sid) <> 'closed' OR (SELECT is_manual_mode FROM public.chat_sessions WHERE id = sid) THEN
    RAISE EXCEPTION 'FAIL D3i';
  END IF;
  RAISE NOTICE 'PASS D3c: تزامن الاستلام والخمول — الاستلام الأول ⇒ الوارد يستنى ويكمّل مع الإنسان؛ الخمول الأول ⇒ الاستلام يفشل صريح (مفيش حالة نص-نص)';
END $$;

-- ── D4 الكاتب الواحد ───────────────────────────────────────────────────────
DO $$
DECLARE sid1 uuid; sid2 uuid; r jsonb; st text; legacy uuid;
BEGIN
  -- الطرح التدريجي: C1 بس
  PERFORM t.flag('website', '{"enabled":true,"users":["00000000-0000-4000-8000-0000000000c1"],"percent":0}');
  SELECT id INTO sid1 FROM t.ids WHERE k = 'c1web';
  PERFORM t.as_service();
  r := public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c2', '', 'w2:1', 'أهلا');
  sid2 := (r->'conversation'->>'id')::uuid;
  IF NOT public.conv_channel_enabled('website', '00000000-0000-4000-8000-0000000000c1')
     OR public.conv_channel_enabled('website', '00000000-0000-4000-8000-0000000000c2') THEN
    RAISE EXCEPTION 'FAIL D4a: الطرح التدريجي';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  st := t.try(format($s$insert into public.chat_messages (session_id, sender_id, message_text) values (%L, '00000000-0000-4000-8000-0000000000c1', 'تجاوز')$s$, sid1));
  -- حارس كاتب الخادم (محفّز BEFORE) بيرفض قبل ما RLS تتفحص: 55000 core_owns_session
  IF st <> '55000' THEN RAISE EXCEPTION 'FAIL D4b: C1 كتب مباشرة في محادثة Core (%)', st; END IF;
  st := t.try($s$insert into public.chat_sessions (user_id) values ('00000000-0000-4000-8000-0000000000c1')$s$);
  IF st <> '42501' THEN RAISE EXCEPTION 'FAIL D4c: C1 أنشأ جلسة بنفسه (%)', st; END IF;
  IF t.try($s$select public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'w:self', 'x')$s$) <> '42501'
     OR t.try(format($s$select public.conv_commit_turn(%L, 1, 'k', 'x')$s$, sid1)) <> '42501'
     OR t.try(format($s$select public.conv_claim_delivery(%L)$s$, sid1)) <> '42501' THEN
    RAISE EXCEPTION 'FAIL D4d: العميل وصل لـ conv_*';
  END IF;
  IF t.try(format($s$update public.chat_messages set external_id = 'zz' where session_id = %L$s$, sid1)) = 'ok'
     AND EXISTS (SELECT 1 FROM public.chat_messages WHERE external_id = 'zz') THEN
    RAISE EXCEPTION 'FAIL D4e';
  END IF;
  RESET ROLE;

  -- C2 برا الطرح ⇒ السلوك القديم بالظبط (حتى في جلسة Core بتاعته)
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  SET LOCAL ROLE authenticated;
  st := t.try(format($s$insert into public.chat_messages (session_id, sender_id, message_text) values (%L, '00000000-0000-4000-8000-0000000000c2', 'قديم')$s$, sid2));
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4f: C2 برا الطرح اترفض (%)', st; END IF;
  st := t.try($s$insert into public.chat_sessions (user_id) values ('00000000-0000-4000-8000-0000000000c2')$s$);
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4g: (%)', st; END IF;
  RESET ROLE;

  -- تعديل الجلسة من العميل: الإقفال بس
  INSERT INTO public.chat_sessions (user_id) VALUES ('00000000-0000-4000-8000-0000000000c2') RETURNING id INTO legacy;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  SET LOCAL ROLE authenticated;
  IF t.try(format($s$update public.chat_sessions set guest_id = 'channel:telegram:999' where id = %L$s$, legacy)) <> '42501'
     OR t.try(format($s$update public.chat_sessions set created_at = now() - interval '1 year' where id = %L$s$, legacy)) <> '42501' THEN
    RAISE EXCEPTION 'FAIL D4h: العميل غيّر أصل الجلسة';
  END IF;
  UPDATE public.chat_sessions SET status = 'closed' WHERE id = legacy;
  IF t.try(format($s$update public.chat_sessions set status = 'active' where id = %L$s$, legacy)) <> '42501' THEN
    RAISE EXCEPTION 'FAIL D4i: العميل رجّع جلسة مقفولة';
  END IF;
  RESET ROLE;
  IF (SELECT status FROM public.chat_sessions WHERE id = legacy) <> 'closed' THEN RAISE EXCEPTION 'FAIL D4j: الإقفال من العميل اتمنع'; END IF;

  -- 100% ⇒ الكل؛ مقفول ⇒ الرجوع للسلوك القديم (حتى في جلسة اتبنّت)
  PERFORM t.flag('website', '{"enabled":true,"percent":100}');
  IF NOT public.conv_channel_enabled('website', '00000000-0000-4000-8000-0000000000c2') THEN RAISE EXCEPTION 'FAIL D4k'; END IF;
  PERFORM t.flag('website', 'false');
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  st := t.try(format($s$insert into public.chat_messages (session_id, sender_id, message_text) values (%L, '00000000-0000-4000-8000-0000000000c1', 'بعد الرجوع')$s$, sid1));
  RESET ROLE;
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4l: الرجوع (العلم مقفول) ماسمحش للمتصفح (%)', st; END IF;
  RAISE NOTICE 'PASS D4: العلم مفتوح لـ C1 ⇒ كتابة مباشرة (55000) وجلسة جديدة و conv_* (42501) مرفوضين؛ C2 برا الطرح ⇒ قديم؛ الإقفال بس مسموح للعميل؛ قفل العلم ⇒ رجوع كامل';
END $$;

-- D4 كتّاب الخادم القدام: sie-api / Android / تيليجرام القديم / الإشعارات
DO $$
DECLARE r jsonb; sid uuid; n int; st text;
BEGIN
  PERFORM t.flag('telegram', '{"enabled":true,"users":["00000000-0000-4000-8000-0000000000c4"]}');
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '750', 'tg:750:1', 'أهلا');
  sid := (r->'conversation'->>'id')::uuid;
  n := t.tickets('00000000-0000-4000-8000-0000000000c4');
  SET LOCAL ROLE service_role;
  IF t.try(format($s$select public.persist_bot_turn(%L, 1, 'رد SIE قديم', '{}')$s$, sid)) <> '55000'
     OR t.try(format($s$select public.create_ticket_with_message_and_session_update(%L, 1, 'فتحت تذكرة', '{}', 's', 'دعم', 'x')$s$, sid)) <> '55000'
     OR t.try(format($s$insert into public.chat_messages (session_id, sender_id, message_text) values (%L, '00000000-0000-4000-8000-0000000000c4', 'مسار تيليجرام القديم')$s$, sid)) <> '55000' THEN
    RAISE EXCEPTION 'FAIL D4w1: كاتب خادم قديم عدّى على محادثة Core';
  END IF;
  RESET ROLE;
  IF t.tickets('00000000-0000-4000-8000-0000000000c4') <> n THEN RAISE EXCEPTION 'FAIL D4w2: تذكرة من غير رد'; END IF;
  -- الموظف هو الكاتب البشري: رده بيعدّي وبيسلّم، والبوت عبر Core بيترفض human_owner
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_send_reply(sid, 'معاك من الدعم', null);
  PERFORM t.as_service();
  IF public.conv_commit_turn(sid, t.version(sid), 'w-1', 'رد')->>'reason' <> 'human_owner' THEN RAISE EXCEPTION 'FAIL D4w3'; END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_return_to_ai(sid, 'رجوع');
  PERFORM t.as_service();
  IF NOT t.b(public.conv_commit_turn(sid, t.version(sid), 'w-2', 'رد عبر Core'), 'committed') THEN RAISE EXCEPTION 'FAIL D4w4'; END IF;
  -- العلم اتقفل ⇒ نفس الكتّاب القدام شغالين تاني (الرجوع)
  PERFORM t.flag('telegram', 'false');
  SET LOCAL ROLE service_role;
  st := t.try(format($s$select public.persist_bot_turn(%L, 2, 'رد بعد الرجوع', '{}')$s$, sid));
  RESET ROLE;
  IF st <> 'ok' THEN RAISE EXCEPTION 'FAIL D4w5: %', st; END IF;
  RAISE NOTICE 'PASS D4-writers: العلم مفتوح ⇒ persist_bot_turn و create_ticket_… ومسار تيليجرام القديم مرفوضين (55000، ولا تذكرة يتيمة)؛ رد الموظف بيعدّي؛ Core بس بيكتب رد البوت؛ قفل العلم ⇒ القدام يرجعوا';
END $$;

-- ============================================================================
-- نموذج التهديد + التزامن (A–E)
-- ============================================================================
-- محادثة جديدة نظيفة لكل مجموعة
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:0', 'بداية');
  INSERT INTO t.ids VALUES ('tm', (r->'conversation'->>'id')::uuid, null);
END $$;

-- T1 وارد مكرر متسلسل
DO $$
DECLARE r jsonb; a jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:1', 'مرة');
  a := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:1', 'مرة (معادة)');
  IF NOT t.b(a, 'duplicate') OR a->'message'->>'id' <> r->'message'->>'id' OR a->>'stateVersion' <> r->>'stateVersion' THEN
    RAISE EXCEPTION 'FAIL T1: %', a;
  END IF;
  RAISE NOTICE 'PASS T1: نفس الرسالة مرتين ⇒ صف واحد، التانية duplicate بنفس الـ id، والنسخة ماتحركتش';
END $$;

-- T12 webhook اتعاد في نفس اللحظة (اتصالين)
DO $$
DECLARE a jsonb; b jsonb; sid uuid; n int;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm';
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:2', 'متزامن')::text$s$)::jsonb;
  PERFORM t.dblink_send_query('w2', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:2', 'متزامن')::text$s$);
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL T12a: التاني ماستناش'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  SELECT count(*) INTO n FROM public.chat_messages WHERE session_id = sid AND external_id = 'tg:700:2';
  IF n <> 1 OR NOT t.b(a, 'created') OR NOT t.b(b, 'duplicate') THEN RAISE EXCEPTION 'FAIL T12b: n=% a=% b=%', n, a, b; END IF;
  RAISE NOTICE 'PASS T12: نفس الـ webhook من اتصالين في نفس اللحظة ⇒ التاني استنى القفل وطلع duplicate، صف واحد';
END $$;

-- A + T3 رسالتين مختلفتين في نفس اللحظة ⇒ متسلسلين
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:3', 'أ')::text$s$)::jsonb;
  PERFORM t.dblink_send_query('w2', $s$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:4', 'ب')::text$s$);
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL A1'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF (b->'message'->>'seq')::int <> (a->'message'->>'seq')::int + 1
     OR (b->>'stateVersion')::int <> (a->>'stateVersion')::int + 1
     OR a->'conversation'->>'id' <> b->'conversation'->>'id' THEN
    RAISE EXCEPTION 'FAIL A2: a=% b=%', a, b;
  END IF;
  INSERT INTO t.ids VALUES ('A-old-v', null, (a->>'stateVersion')::int);
  RAISE NOTICE 'PASS A/T3: رسالتين متزامنتين ⇒ نفس المحادثة، seq و stateVersion متتاليين';
END $$;
DO $$
DECLARE sid uuid;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm';
  PERFORM t.as_service();
  IF public.conv_commit_turn(sid, (SELECT v FROM t.ids WHERE k = 'A-old-v'), 'stale-a', 'رد على أ')->>'reason' <> 'version_conflict' THEN
    RAISE EXCEPTION 'FAIL A3';
  END IF;
  RAISE NOTICE 'PASS A2: الدور اللي اتحسب على الرسالة الأولى بس اترفض (version_conflict) — فيه رسالة أحدث ماشافهاش';
END $$;

-- C + T2 نفس turn_key من اتصالين ⇒ رد واحد
DO $$
DECLARE a jsonb; b jsonb; sid uuid; v int; n int;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm'; v := t.version(sid);
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', format($s$select public.conv_commit_turn(%L, %s, 'same', 'رد', '[]', '{"n":1}', 'sie', true)::text$s$, sid, v))::jsonb;
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'same', 'رد', '[]', '{"n":1}', 'sie', true)::text$s$, sid, v));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL C1'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  SELECT count(*) INTO n FROM public.chat_messages WHERE session_id = sid AND external_id = 'turn:same';
  IF n <> 1 OR NOT t.b(a, 'committed') OR NOT t.b(b, 'duplicate') OR a->>'messageId' <> b->>'messageId' THEN
    RAISE EXCEPTION 'FAIL C2: n=% a=% b=%', n, a, b;
  END IF;
  INSERT INTO t.ids VALUES ('C-msg', (a->>'messageId')::uuid, v);
  RAISE NOTICE 'PASS C/T2: نفس turn_key من اتصالين في نفس اللحظة ⇒ رسالة واحدة، والتاني duplicate بنفس messageId';
END $$;

-- T14 العامل وقع بعد ما الـ commit نجح وعاد المحاولة
DO $$
DECLARE b jsonb; sid uuid;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm';
  PERFORM t.as_service();
  b := public.conv_commit_turn(sid, (SELECT v FROM t.ids WHERE k = 'C-msg'), 'same', 'رد', '[]', '{"n":1}', 'sie', true);
  IF NOT t.b(b, 'duplicate') OR (b->>'messageId')::uuid <> (SELECT id FROM t.ids WHERE k = 'C-msg') THEN RAISE EXCEPTION 'FAIL T14: %', b; END IF;
  RAISE NOTICE 'PASS T14: إعادة العامل بعد نجاح الـ commit (بنفس النسخة القديمة) ⇒ duplicate ونفس الرسالة، مش version_conflict ولا رد تاني';
END $$;

-- T4 وكيلين بمفتاحين مختلفين ونفس النسخة
DO $$
DECLARE a jsonb; b jsonb; sid uuid; v int;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm'; v := t.version(sid);
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', format($s$select public.conv_commit_turn(%L, %s, 'agent-1', 'رد 1')::text$s$, sid, v))::jsonb;
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'agent-2', 'رد 2')::text$s$, sid, v));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL T4a'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF NOT t.b(a, 'committed') OR b->>'reason' <> 'version_conflict' THEN RAISE EXCEPTION 'FAIL T4b: a=% b=%', a, b; END IF;
  RAISE NOTICE 'PASS T4: وكيلين بنفس النسخة في نفس اللحظة ⇒ واحد اتثبّت والتاني version_conflict';
END $$;

-- T5 + T7 البوت بيفكر ثم إنسان استلم ⇒ human_owner؛ إعادة قديمة بعد تغيّر النسخة ⇒ version_conflict
DO $$
DECLARE r jsonb; sid uuid; v int;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '701', 'tg:701:1', 'سؤال');
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_take_over(sid, 'شوفته');
  PERFORM t.as_service();
  IF public.conv_commit_turn(sid, v, 't5', 'رد متأخر')->>'reason' <> 'human_owner' THEN RAISE EXCEPTION 'FAIL T5'; END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_return_to_ai(sid, 'خلصت');
  PERFORM t.as_service();
  IF public.conv_commit_turn(sid, v, 't7', 'رد متأخر')->>'reason' <> 'version_conflict' OR t.bot_msgs(sid) <> 0 THEN
    RAISE EXCEPTION 'FAIL T7';
  END IF;
  RAISE NOTICE 'PASS T5/T7: البوت بيفكر والإنسان استلم ⇒ human_owner؛ وبعد ما رجّعه ⇒ النسخة اتغيرت ⇒ version_conflict، ولا رد اتكتب';
END $$;

-- B + T6 commit البوت والاستلام في نفس اللحظة (الترتيبين)
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '702', 'tg:702:1', 'سؤال');
  INSERT INTO t.ids VALUES ('B', (r->'conversation'->>'id')::uuid, (r->>'stateVersion')::int);
END $$;
DO $$
DECLARE sid uuid; v int; c jsonb; n int;
BEGIN
  SELECT id, t.ids.v INTO sid, v FROM t.ids WHERE k = 'B';
  n := t.tickets('00000000-0000-4000-8000-0000000000c4');
  PERFORM t.dblink_exec('admin1', 'begin');
  PERFORM t.q('admin1', format('select public.inbox_take_over(%L, %L)::text', sid, 'B1'));
  PERFORM t.dblink_send_query('w1', format($s$select public.conv_commit_turn(%L, %s, 'b1', 'رد', '[]', null, 'sie', false, '{"category":"دعم"}')::text$s$, sid, v));
  IF NOT t.wait_blocked('w1') THEN RAISE EXCEPTION 'FAIL B1a'; END IF;
  PERFORM t.dblink_exec('admin1', 'commit');
  SELECT x::jsonb INTO c FROM t.dblink_get_result('w1') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w1', false) AS q(x text);
  IF c->>'reason' <> 'human_owner' OR t.bot_msgs(sid) <> 0 OR t.tickets('00000000-0000-4000-8000-0000000000c4') <> n THEN
    RAISE EXCEPTION 'FAIL B1b: %', c;
  END IF;
  RAISE NOTICE 'PASS B1/T6: الاستلام ماسك القفل ⇒ commit البوت (بتذكرة) استنى وطلع human_owner — ولا رد ولا تذكرة';
END $$;
DO $$
DECLARE sid uuid;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'B';
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_return_to_ai(sid, 'رجوع');
END $$;
DO $$
DECLARE sid uuid; v int; c jsonb;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'B'; v := t.version(sid);
  PERFORM t.dblink_exec('w1', 'begin');
  c := t.q('w1', format($s$select public.conv_commit_turn(%L, %s, 'b2', 'رد قبل الاستلام')::text$s$, sid, v))::jsonb;
  PERFORM t.dblink_send_query('admin1', format('select public.inbox_take_over(%L, %L)::text', sid, 'B2'));
  IF NOT t.wait_blocked('admin1') THEN RAISE EXCEPTION 'FAIL B2a'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  PERFORM * FROM t.dblink_get_result('admin1') AS q(x text);
  PERFORM * FROM t.dblink_get_result('admin1', false) AS q(x text);
  IF NOT t.b(c, 'committed')
     OR (SELECT max(id) FROM public.inbox_events WHERE session_id = sid AND kind = 'handoff_to_human' AND payload->>'reason' = 'B2')
        < (SELECT max(id) FROM public.inbox_events WHERE session_id = sid AND kind = 'agent_replied') THEN
    RAISE EXCEPTION 'FAIL B2b: %', c;
  END IF;
  IF EXISTS (SELECT 1 FROM public.inbox_events a WHERE a.session_id = sid AND a.kind = 'agent_replied'
              AND a.id > (SELECT max(id) FROM public.inbox_events WHERE session_id = sid AND kind = 'handoff_to_human')) THEN
    RAISE EXCEPTION 'FAIL B2c: رد بوت بعد التسليم';
  END IF;
  RAISE NOTICE 'PASS B2/T6: البوت ماسك القفل ⇒ الاستلام استنى، وحدث التسليم بعد الرد؛ مفيش رد بوت بعد آخر تسليم';
END $$;

-- T13 خارج الترتيب: رسالة أقدم عند المزوّد توصل بعد الأحدث
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
  PERFORM t.as_service();
  a := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '703', 'tg:703:9', 'الأحدث', '[]',
         '{"providerTs":"2026-10-07T10:00:05Z"}');
  b := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '703', 'tg:703:8', 'الأقدم', '[]',
         '{"providerTs":"2026-10-07T10:00:01Z"}');
  IF NOT (t.b(a, 'created') AND t.b(b, 'created')) OR (b->'message'->>'seq')::int <> (a->'message'->>'seq')::int + 1
     OR public.conv_commit_turn((a->'conversation'->>'id')::uuid, (a->>'stateVersion')::int, 't13', 'رد')->>'reason' <> 'version_conflict' THEN
    RAISE EXCEPTION 'FAIL T13: a=% b=%', a, b;
  END IF;
  RAISE NOTICE 'PASS T13: خارج الترتيب ⇒ الاتنين اتخزنوا (seq = ترتيب الوصول، وقت المزوّد في metadata)، والدور اللي ماشافش المتأخرة اترفض';
END $$;

-- D + T8 + T9 + R1 الإرسال
DO $$
DECLARE sid uuid; r jsonb;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm';
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:9', 'محتاج رد');
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'deliv', 'رد يتبعت', '[]', null, 'sie', true);
  INSERT INTO t.ids VALUES ('mid', (r->>'messageId')::uuid, null);
END $$;
DO $$
DECLARE mid uuid; a jsonb; b jsonb;
BEGIN
  SELECT id INTO mid FROM t.ids WHERE k = 'mid';
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', format('select public.conv_claim_delivery(%L)::text', mid))::jsonb;
  PERFORM t.dblink_send_query('w2', format('select public.conv_claim_delivery(%L)::text', mid));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL D-a'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF NOT t.b(a, 'claimed') OR t.b(b, 'claimed') OR (a->>'attempt')::int <> 1 THEN RAISE EXCEPTION 'FAIL D-b: a=% b=%', a, b; END IF;
  RAISE NOTICE 'PASS D: مُرسِلين في نفس اللحظة ⇒ مطالبة واحدة (attempt 1)، التاني claimed=false';
END $$;
DO $$
DECLARE sid uuid; mid uuid; r jsonb; i int;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'tm';
  SELECT id INTO mid FROM t.ids WHERE k = 'mid';
  PERFORM t.as_service();
  -- T8: فشل ⇒ إعادة على نفس الصف بمحاولة 2
  PERFORM public.conv_record_delivery(mid, 'failed', null, 'timeout', 1);
  r := public.conv_claim_delivery(mid);
  IF NOT t.b(r, 'claimed') OR (r->>'attempt')::int <> 2 THEN RAISE EXCEPTION 'FAIL T8: %', r; END IF;
  -- T9: العامل وقع (lease انتهى) ⇒ محاولة 3، وتقرير المحاولة 2 المتأخر مالوش أثر
  UPDATE public.chat_messages SET delivery_updated_at = now() - interval '5 minutes' WHERE id = mid;
  r := public.conv_claim_delivery(mid);
  IF (r->>'attempt')::int <> 3 THEN RAISE EXCEPTION 'FAIL T9a: %', r; END IF;
  IF t.b(public.conv_record_delivery(mid, 'sent', 'p-old', null, 2), 'updated') THEN RAISE EXCEPTION 'FAIL T9b'; END IF;
  r := public.conv_record_delivery(mid, 'sent', 'p-3', null, 3);
  IF NOT t.b(r, 'updated') OR (SELECT provider_message_id FROM public.chat_messages WHERE id = mid) <> 'p-3' THEN
    RAISE EXCEPTION 'FAIL T9c: %', r;
  END IF;
  IF t.b(public.conv_claim_delivery(mid), 'claimed') THEN RAISE EXCEPTION 'FAIL T9d'; END IF;
  -- R1: حد أقصى ⇒ dead letter
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:10', 'تاني');
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'deliv2', 'رد هيفشل', '[]', null, 'sie', true);
  mid := (r->>'messageId')::uuid;
  FOR i IN 1..3 LOOP
    r := public.conv_claim_delivery(mid, interval '2 minutes', 3);
    PERFORM public.conv_record_delivery(mid, 'failed', null, 'boom', (r->>'attempt')::int);
  END LOOP;
  r := public.conv_claim_delivery(mid, interval '2 minutes', 3);
  IF t.b(r, 'claimed') OR NOT t.b(r, 'exhausted') OR r->>'deliveryState' <> 'failed' THEN RAISE EXCEPTION 'FAIL R1a: %', r; END IF;
  -- آخر محاولة مسموحة والعامل وقع ⇒ failed نهائي مش sending للأبد
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '700', 'tg:700:11', 'تالت');
  r := public.conv_commit_turn(sid, (r->>'stateVersion')::int, 'deliv3', 'رد', '[]', null, 'sie', true);
  mid := (r->>'messageId')::uuid;
  r := public.conv_claim_delivery(mid, interval '2 minutes', 1);
  UPDATE public.chat_messages SET delivery_updated_at = now() - interval '5 minutes' WHERE id = mid;
  r := public.conv_claim_delivery(mid, interval '2 minutes', 1);
  IF t.b(r, 'claimed') OR r->>'deliveryState' <> 'failed' THEN RAISE EXCEPTION 'FAIL R1b: %', r; END IF;
  RAISE NOTICE 'PASS T8/T9/R1: فشل ⇒ نفس الصف محاولة 2؛ lease انتهى ⇒ محاولة 3 وتقرير المحاولة 2 اتجاهل؛ بعد sent مفيش مطالبة؛ الحد الأقصى ⇒ failed نهائي (dead letter)';
END $$;

-- E الحصة تحت التزامن: محادثتين لنفس الحساب، تذكرة واحدة فاضلة
DELETE FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000c1';
INSERT INTO public.tickets (user_id, title, description, status)
SELECT '00000000-0000-4000-8000-0000000000c1', 'قديمة ' || g, 'x', 'open' FROM generate_series(1, 19) g;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c1', '801', 'tg:801:1', 'أ');
  INSERT INTO t.ids VALUES ('E1', (r->'conversation'->>'id')::uuid, (r->>'stateVersion')::int);
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c1', '802', 'tg:802:1', 'ب');
  INSERT INTO t.ids VALUES ('E2', (r->'conversation'->>'id')::uuid, (r->>'stateVersion')::int);
END $$;
DO $$
DECLARE s1 uuid; s2 uuid; v1 int; v2 int; a jsonb; b jsonb; made int;
BEGIN
  SELECT id, v INTO s1, v1 FROM t.ids WHERE k = 'E1';
  SELECT id, v INTO s2, v2 FROM t.ids WHERE k = 'E2';
  PERFORM t.dblink_exec('w1', 'begin');
  a := t.q('w1', format($s$select public.conv_commit_turn(%L, %s, 'e1', 'رد أ', '[]', null, 'sie', false, '{"category":"دعم"}')::text$s$, s1, v1))::jsonb;
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'e2', 'رد ب', '[]', null, 'sie', false, '{"category":"دعم"}')::text$s$, s2, v2));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL E1: التاني ماستناش قفل الحصة'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  SELECT count(*) INTO made FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND title NOT LIKE 'قديمة%';
  IF made <> 1 OR NOT t.b(a, 'committed') OR NOT t.b(b, 'committed') OR a->>'ticketNumber' IS NULL
     OR b->>'ticketError' <> 'ticket_quota_exceeded' OR t.bot_msgs(s2) <> 1 THEN
    RAISE EXCEPTION 'FAIL E2: made=% a=% b=%', made, a, b;
  END IF;
  RAISE NOTICE 'PASS E: تذكرة واحدة فاضلة ومحادثتين في نفس اللحظة ⇒ تذكرة واحدة بس، والتاني ردّه اتسجّل بسبب الحصة (لا رد ضايع ولا تجاوز للحد)';
END $$;

-- L1 بعد 067: نفس التداخل اللي عمل deadlock ⇒ بيتسلسل
DELETE FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000c2';
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c2', '210', 'tg:210:1', 'x');
  INSERT INTO t.ids VALUES ('L1', (r->'conversation'->>'id')::uuid, (r->>'stateVersion')::int);
END $$;
DO $$
DECLARE sid uuid; v int; c jsonb;
BEGIN
  SELECT id, t.ids.v INTO sid, v FROM t.ids WHERE k = 'L1';
  PERFORM t.dblink_exec('w1', 'begin');
  PERFORM t.dblink_exec('w1', $s$insert into public.tickets (user_id, title, description) values ('00000000-0000-4000-8000-0000000000c2', 'قديم', 'x')$s$);
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'l1', 'رد', '[]', null, 'sie', false, '{"category":"دعم"}')::text$s$, sid, v));
  IF NOT t.wait_blocked('w2') THEN RAISE EXCEPTION 'FAIL L1a'; END IF;
  -- المسار القديم يكمّل على نفس الجلسة: Core واقف قبل قفل الجلسة، فمفيش حلقة
  PERFORM t.dblink_exec('w1', format($s$insert into public.chat_messages (session_id, message_text, is_bot_reply) values (%L, 'رد قديم', true)$s$, sid));
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO c FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF NOT t.b(c, 'committed') OR c->>'ticketNumber' IS NULL THEN RAISE EXCEPTION 'FAIL L1b: %', c; END IF;
  RAISE NOTICE 'PASS L1: نفس التداخل اللي عمل deadlock مع 064 ⇒ Core بياخد قفل الحصة قبل الجلسة ⇒ الاتنين نجحوا';
END $$;

SELECT t.dblink_disconnect('w1'), t.dblink_disconnect('w2'), t.dblink_disconnect('admin1');

-- ============================================================================
-- توافق المسارات القديمة (الأعلام مقفولة — ده اللي شغال في الإنتاج النهارده)
-- ============================================================================
DO $$
DECLARE sid uuid; v int; r jsonb; nid uuid; tn bigint; msg uuid;
BEGIN
  PERFORM t.flag('website', 'false');
  -- المتصفح: جلسة + رسالة + إقفال (chat-logic.js / chat-widget.js)
  PERFORM t.act('00000000-0000-4000-8000-0000000000c4');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.chat_sessions (user_id, status) VALUES ('00000000-0000-4000-8000-0000000000c4', 'active') RETURNING id INTO sid;
  INSERT INTO public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
  VALUES (sid, '00000000-0000-4000-8000-0000000000c4', 'من المتصفح', false) RETURNING id INTO msg;
  -- إشعار الخادم (061) بيرد على آخر رسالة عميل
  nid := public.chat_post_notice(sid, 'error');
  RESET ROLE;
  IF nid IS NULL OR (SELECT seq FROM public.chat_messages WHERE id = msg) <> 1 OR t.version(sid) <> 0 THEN
    RAISE EXCEPTION 'FAIL L-web: notice=% seq/version', nid;
  END IF;
  -- sie-api / Android: persist_bot_turn و create_ticket_with_message_… بـ service_role
  PERFORM t.as_service();
  SET LOCAL ROLE service_role;
  r := public.persist_bot_turn(sid, 1, 'رد SIE قديم', '{"s":1}');
  SELECT ticket_number INTO tn FROM public.create_ticket_with_message_and_session_update(sid, 2, 'فتحت تذكرة', '{"s":2}', 'sc', 'دعم', 'وصف');
  RESET ROLE;
  IF r->>'message_id' IS NULL OR tn IS NULL OR (SELECT bot_state->>'s' FROM public.chat_sessions WHERE id = sid) <> '2' THEN
    RAISE EXCEPTION 'FAIL L-sie: % %', r, tn;
  END IF;
  -- الصندوق: رد موظف ⇒ تسليم + نسخة، ثم البوت القديم مرفوض (059)
  v := t.version(sid);
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_send_reply(sid, 'معاك من الدعم', null);
  PERFORM t.as_service();
  IF t.version(sid) <> v + 1 OR NOT (SELECT is_manual_mode FROM public.chat_sessions WHERE id = sid)
     OR t.try(format($s$select public.persist_bot_turn(%L, 3, 'بوت بعد الموظف', '{}')$s$, sid)) <> '55000' THEN
    RAISE EXCEPTION 'FAIL L-inbox';
  END IF;
  -- العميل يقفل
  PERFORM t.act('00000000-0000-4000-8000-0000000000c4');
  SET LOCAL ROLE authenticated;
  UPDATE public.chat_sessions SET status = 'closed' WHERE id = sid;
  RESET ROLE;
  INSERT INTO t.ids VALUES ('legacy', sid, null);
  RAISE NOTICE 'PASS LEGACY: المتصفح (جلسة/رسالة/إشعار/إقفال)، persist_bot_turn و create_ticket_… (Android/sie-api)، رد الصندوق والتسليم وحارس 059 — كلهم شغالين مع 064+067 والأعلام مقفولة';
END $$;

-- حدث الإقفال محفّز مؤجَّل (064) ⇒ بيتكتب عند الـ commit، فالفحص في بلوك بعده.
DO $$
DECLARE sid uuid;
BEGIN
  SELECT id INTO sid FROM t.ids WHERE k = 'legacy';
  IF t.events(sid, 'closed') <> 1 OR t.events(sid, 'message_received') <> 1 OR t.events(sid, 'human_reply') <> 1
     OR t.events(sid, 'handoff_to_human') <> 1 THEN
    RAISE EXCEPTION 'FAIL L-events: closed=% received=% human=% handoff=%', t.events(sid, 'closed'),
      t.events(sid, 'message_received'), t.events(sid, 'human_reply'), t.events(sid, 'handoff_to_human');
  END IF;
  RAISE NOTICE 'PASS LEGACY-EVENTS: المسارات القديمة بتكتب أحداث Core (رسالة، رد موظف، تسليم، إقفال واحد)';
END $$;

-- ============================================================================
-- التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/067_conversation_core_gate.sql
SET search_path = public, extensions;
\i migrations/_rollback/067_conversation_core_gate.down.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb;
BEGIN
  IF to_regprocedure('public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)') IS NULL
     OR to_regprocedure('public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval, jsonb)') IS NOT NULL
     OR to_regprocedure('public.conv_claim_delivery(uuid, interval)') IS NULL
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'core_single_writer')
     OR has_function_privilege('authenticated', 'public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL RB1: التراجع مارجّعش نسخة 064';
  END IF;
  -- بيانات 067 (أحداث ticket_failed ومرفقات) فضلت
  IF NOT EXISTS (SELECT 1 FROM public.inbox_events WHERE kind = 'ticket_failed')
     OR NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE channel = 'website' AND attachment IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL RB2: التراجع مسح بيانات';
  END IF;
  -- نسخة 064 شغالة بعد التراجع
  PERFORM t.as_service();
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '900', 'tg:900:1', 'بعد التراجع');
  IF NOT t.b(r, 'created') THEN RAISE EXCEPTION 'FAIL RB3'; END IF;
  RAISE NOTICE 'PASS RB: إعادة 067 idempotent؛ التراجع رجّع دوال 064 حرفيًا وشال السياسات والحارس، والبيانات فضلت، و 064 شغال';
END $$;
\i migrations/067_conversation_core_gate.sql
SET search_path = public, extensions;
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policy WHERE polname = 'core_single_writer') <> 2 THEN RAISE EXCEPTION 'FAIL RB4'; END IF;
  RAISE NOTICE 'PASS RB5: إعادة تطبيق 067 بعد التراجع';
END $$;

DROP SCHEMA IF EXISTS t CASCADE;
DROP SCHEMA IF EXISTS net, extensions, vault, emp_ops CASCADE;
SELECT 'ALL CONVERSATION CORE GATE TESTS PASSED';
