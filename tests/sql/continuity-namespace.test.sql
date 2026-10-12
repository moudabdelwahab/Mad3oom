-- ============================================================================
-- مدعوم — الاستمرارية: نقل المساحة الداخلية relay → continuity (077) على نسخة
-- مطابقة لشكل الإنتاج (073 + 074 + 076 مطبقة ومفعّل، ببيانات في كل جدول)
--
--   ⓪ 073 + 074 + 076 + بيانات (سجلات، مصادر، لقطات، حجب، محذوفات، ممسوح، منح)،
--      ولقطة: كل الصفوف، نصوص الدوال، الصلاحيات، القيود، الفهارس، المحفزات، السياسات
--   ① 077: البيانات حرفيًا، كل دالة = نظيرتها القديمة بعد عكس الأسماء، الصلاحيات
--      والمالك و SECURITY DEFINER و search_path، القيود والفهارس والمحفزات والسياسات،
--      لا اسم relay متبقٍ، الأغلفة (INVOKER، نفس النتائج، authenticated فقط)،
--      السلوك عبر الأسماء الجديدة (C3، T1/T2، P3، الثبات، التسلسل)
--   ② إعادة التشغيل، التراجع (كل شيء يرجع حرفيًا)، إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

-- ── أدوات ─────────────────────────────────────────────────────────────────
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         -- شكل الإنتاج: PostgREST يضبط claims كاملة (بلا relay_client للمسار الأصلي)
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
-- نداء عبر relay-api (المرحلة G): claim relay_client
CREATE FUNCTION t.act_api(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated',
                                                             'continuity_client', 'extension')::text, false); $$;
-- ينفّذ تعبيرًا كدور authenticated للمستخدم p ويرجع النتيجة jsonb
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  if p is not null then perform t.act(p); end if;
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
end $$;
CREATE FUNCTION t.call_api(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act_api(p);
  v := t.call(null, p_sql);
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- الخطأ كاملًا (للبحث عن تسرب في نص الخطأ وتفاصيله)
CREATE FUNCTION t.errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare m text; d text; h text;
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
  return sqlstate || '|' || m || '|' || coalesce(d, '') || '|' || coalesce(h, '');
end $$;
-- جملة كاملة كدور authenticated (للـ INSERT/UPDATE/DELETE المباشر)
CREATE FUNCTION t.err_stmt(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- كدور anon (بلا مستخدم)
CREATE FUNCTION t.err_anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(null);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
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
-- طلب إنشاء متابعة: موعد بكرة 12:00 بتوقيت القاهرة
CREATE FUNCTION t.req(p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object(
    'contract_version', 1,
    'idempotency_key', md5(p_key)::uuid,
    'kind', 'follow_up',
    'title', 'TITLEMARK ' || p_key,
    'summary', 'SUMMARYMARK ' || p_key,
    'next_action', 'اتصل بالعميل',
    'due', jsonb_build_object('at', to_char((now() at time zone 'Africa/Cairo')::date + 1, 'YYYY-MM-DD') || 'T12:00:00',
                              'tz', 'Africa/Cairo'),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('type', 'mad3oom_message', 'provider', 'mad3oom',
                                   'internal', jsonb_build_object('chat_message_id', m)))
                           from unnest(p_msgs) m), '[]'::jsonb)) || p_extra $$;
CREATE FUNCTION t.mk(p uuid, p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS uuid LANGUAGE sql AS $$
  select (t.call(p, format('public.relay_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra))) -> 'record' ->> 'id')::uuid $$;
CREATE FUNCTION t.get(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.relay_get(%L::uuid)', p_rec)) $$;
CREATE FUNCTION t.ver(p_rec uuid) RETURNS int LANGUAGE plpgsql AS $$
begin return (select version from public.relay_records where id = p_rec); end $$;
-- بصمة جداول الشات والصندوق (لإثبات عدم المساس)
CREATE FUNCTION t.chat_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_sessions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_messages x),
    (select string_agg(md5(x::text), ',' order by x.session_id) from public.inbox_conversations x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.inbox_teams x),
    (select string_agg(md5(x::text), ',' order by x.team_id, x.user_id) from public.inbox_team_members x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.notifications x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_message_revisions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.inbox_events x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.tickets x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.profiles x))) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;


-- مختصرات الفاعلين (نفس معرّفات relay-core.test.sql + GR)
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'C1' then '00000000-0000-4000-8000-0000000000c1' when 'C2' then '00000000-0000-4000-8000-0000000000c2'
                 when 'S1' then '00000000-0000-4000-8000-0000000000a5' when 'S2' then '00000000-0000-4000-8000-0000000000a6'
                 when 'S3' then '00000000-0000-4000-8000-0000000000a7' when 'GR' then '00000000-0000-4000-8000-0000000000a8'
                 when 'AD' then '00000000-0000-4000-8000-0000000000ad' when 'EA' then '00000000-0000-4000-8000-0000000000ea'
                 when 'OW' then '00000000-0000-4000-8000-0000000000f0' when 'BN' then '00000000-0000-4000-8000-0000000000b0'
                 when 'T1' then '7ea70000-0000-4000-8000-000000000001' end)::uuid $$;
CREATE FUNCTION t.create_sql(p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $$
  select format('public.relay_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra)) $$;
CREATE FUNCTION t.assign_sql(p_rec uuid, p_owner uuid, p_team uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.relay_assign(%L::uuid, %L::uuid, %L::uuid, %s)', p_rec, p_owner, p_team, t.ver(p_rec)) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  C1/C2 عملاء · S1/S2/S3 دعم · GR دعم سيُمنح صلاحية الإسناد · AD أدمن عادي
--  EA أدمن مرتفع (مشرف) · OW المالك (سياق admin) · BN دعم محظور
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io'), ('00000000-0000-4000-8000-0000000000a6', 's2@t.io'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io'), ('00000000-0000-4000-8000-0000000000a8', 'gr@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'), ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io'), ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000041', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'عميل اتنين', 'user', '01000000042', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io', 'دعم 1', 'support', '01000000043', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a6', 's2@t.io', 'دعم 2', 'support', '01000000044', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io', 'دعم 3', 'support', '01000000045', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a8', 'gr@t.io', 'دعم مُسند', 'support', '01000000050', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000046', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io', 'أدمن مرتفع', 'admin', '01000000047', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000048', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io', 'دعم محظور', 'support', '01000000049', '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = '00000000-0000-4000-8000-0000000000b0';
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-0000000000f0', 'owner'), ('00000000-0000-4000-8000-0000000000ea', 'elevated_admin');

-- SA (C1، مسندة S1)، SB (C2، مسندة S2)، SC (C1، فريق T1 فيه S3)
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2'),
  ('5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1');
INSERT INTO public.inbox_teams (id, name) VALUES ('7ea70000-0000-4000-8000-000000000001', 'فريق المتابعة');
INSERT INTO public.inbox_team_members (team_id, user_id) VALUES
  ('7ea70000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a7');
INSERT INTO public.inbox_conversations (session_id, assignee_id, team_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', NULL),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a6', NULL),
  ('5e550000-0000-4000-8000-0000000000c1', NULL, '7ea70000-0000-4000-8000-000000000001');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_admin_reply, created_at) VALUES
  ('3e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA1 مرحبًا، أريد الاستفسار عن حالة طلبي', false, '2026-10-07 07:24+00'),
  ('3e550000-0000-4000-8000-0000000000a2', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5',
   'MARKERA2 أهلًا بك، من فضلك أرسل رقم الطلب', true, '2026-10-07 07:25+00'),
  ('3e550000-0000-4000-8000-0000000000a3', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA3 رقم الطلب هو 45879', false, '2026-10-07 07:27+00'),
  ('3e550000-0000-4000-8000-0000000000b1', '5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2',
   'MARKERB1 عميل تاني', false, '2026-10-07 10:00+00'),
  ('3e550000-0000-4000-8000-0000000000c1', '5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERC1 محادثة الفريق', false, '2026-10-07 11:00+00'),
  ('3e550000-0000-4000-8000-0000000000c2', '5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERC2 متابعة في محادثة الفريق', false, '2026-10-07 11:05+00');

CREATE TABLE t.actors (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO t.actors SELECT n, t.u(n) FROM unnest(array['S1', 'S2', 'S3', 'GR', 'AD', 'EA', 'OW', 'BN', 'C1']) n;
CREATE FUNCTION t.matrix() RETURNS text LANGUAGE plpgsql AS $$
declare a record; s uuid; o text := '';
begin
  perform t.ctx('admin');
  for a in select * from t.actors order by name loop
    perform t.act(a.id);
    foreach s in array array['5e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000b1',
                             '5e550000-0000-4000-8000-0000000000c1']::uuid[] loop
      o := o || a.name || ':' || public.inbox_can_access(s)::text || ' ';
    end loop;
  end loop;
  perform t.act(null);
  return o;
end $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
-- عكس التسمية: نص 077 → نص 073/074/076 (لإثبات أن المنطق لم يتغير)
CREATE FUNCTION t.unrename(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  select replace(replace(replace(replace(p,
           'الاستمرارية غير مفعّلة لهذه المساحة', 'Relay غير مفعّل لهذه المساحة'),
           'continuity-api', 'relay-api'),
           'continuity', 'relay'),
           'الاستمرارية', 'Relay') $$;
-- كل ما يخص الكائنات بصيغة مقارنة (الأسماء الجديدة تُعكس قبل المقارنة)
CREATE FUNCTION t.catalog(p_ns text) RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object(
    'functions', (select jsonb_object_agg(t.unrename(p.oid::regprocedure::text),
                     jsonb_build_object('def', t.unrename(pg_get_functiondef(p.oid)), 'acl', p.proacl::text,
                                        'owner', p.proowner::regrole::text, 'secdef', p.prosecdef,
                                        'config', p.proconfig::text, 'volatile', p.provolatile))
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname like '%' || p_ns || '%'),
    'tables', (select jsonb_object_agg(t.unrename(c.relname),
                  jsonb_build_object('acl', c.relacl::text, 'rls', c.relrowsecurity, 'owner', c.relowner::regrole::text,
                                     'comment', t.unrename(coalesce(obj_description(c.oid, 'pg_class'), ''))))
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'S') and c.relname like p_ns || '%'),
    'constraints', (select jsonb_object_agg(t.unrename(c.conrelid::regclass::text || '.' || c.conname),
                                            t.unrename(pg_get_constraintdef(c.oid)))
                      from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace
                     where n.nspname = 'public' and r.relname like p_ns || '%'),
    'indexes', (select jsonb_object_agg(t.unrename(i.relname), t.unrename(pg_get_indexdef(i.oid)))
                  from pg_class i join pg_namespace n on n.oid = i.relnamespace
                 where n.nspname = 'public' and i.relkind = 'i' and i.relname like p_ns || '%'),
    'triggers', (select jsonb_object_agg(t.unrename(g.tgrelid::regclass::text || '.' || g.tgname),
                                         t.unrename(pg_get_triggerdef(g.oid)))
                   from pg_trigger g join pg_class r on r.oid = g.tgrelid join pg_namespace n on n.oid = r.relnamespace
                  where n.nspname = 'public' and not g.tgisinternal and r.relname like p_ns || '%'),
    'policies', (select jsonb_object_agg(t.unrename(tablename) || '.' || policyname,
                                         jsonb_build_object('roles', roles::text, 'cmd', cmd, 'permissive', permissive,
                                                            'qual', qual, 'check', with_check))
                   from pg_policies where schemaname = 'public' and tablename like p_ns || '%'),
    'comments', (select jsonb_object_agg(t.unrename(c.relname) || '.' || a.attname, t.unrename(col_description(c.oid, a.attnum)))
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
                  where n.nspname = 'public' and c.relname like p_ns || '%' and col_description(c.oid, a.attnum) is not null)) $$;
-- كل الصفوف في الجداول الستة (بالأسماء الحالية)
CREATE FUNCTION t.rows(p_ns text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare tb text; o jsonb := '{}'; o_tmp jsonb;
begin
  foreach tb in array array['workspaces', 'records', 'sources', 'source_snapshots', 'events', 'assigners'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x) order by x.id), ''[]'') from public.%I x', p_ns || '_' || tb)
      into strict o_tmp;
    o := o || jsonb_build_object(tb, o_tmp);
  end loop;
  return o;
end $$;
-- نتيجة القراءة أو كود الخطأ (لمقارنة الفاعلين غير الأعضاء أيضًا)
CREATE FUNCTION t.safe(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare c text := t.err(p, p_sql);
begin
  if c <> 'ok' then return jsonb_build_object('error', c); end if;
  return t.call(p, p_sql);
end $$;
-- استدعاء الأغلفة والأسماء الجديدة (الجداول تنشأ لاحقًا)
SET check_function_bodies = off;
CREATE FUNCTION t.ver2(p_rec uuid) RETURNS int LANGUAGE plpgsql AS $$
begin return (select version from public.continuity_records where id = p_rec); end $$;
CREATE FUNCTION t.src2(p_rec uuid, p_msg text) RETURNS uuid LANGUAGE sql AS $$
  select id from public.continuity_sources where record_id = p_rec and chat_message_id = ('3e550000-0000-4000-8000-0000000000' || p_msg)::uuid $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act(t.u('S1'));
  PERFORM t.ok(public.is_platform_staff() AND NOT public._inbox_is_supervisor(), 'SETUP S1');
  PERFORM t.act(t.u('EA'));
  PERFORM t.ok(public._inbox_is_supervisor(), 'SETUP EA');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS SETUP';
END $$;

-- ============================================================================
-- ⓪ 073 + 074 + 076 كما في الإنتاج، وبيانات في كل جدول
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;

-- REC (S1، 3 رسائل من SA) · OWN2 (EA، مالكه S2) · CLOSED (مقفول) · مصدر في المحذوفات،
-- ومصدر ممسوح نهائيًا، وحجب لطلب حذف بيانات، ومنح إسناد
DO $$
DECLARE rid uuid; sid uuid;
BEGIN
  PERFORM t.ctx('admin');
  rid := t.mk(t.u('S1'), 'REC', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2',
                                      '3e550000-0000-4000-8000-0000000000a3']::uuid[], jsonb_build_object('owner_id', t.u('S1')));
  INSERT INTO t.saved VALUES ('REC', rid::text);
  rid := t.mk(t.u('EA'), 'OWN2', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2']::uuid[],
              jsonb_build_object('owner_id', t.u('S2')));
  INSERT INTO t.saved VALUES ('OWN2', rid::text);
  rid := t.mk(t.u('S1'), 'CLOSED', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], '{}');
  PERFORM t.call(t.u('S1'), format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
  INSERT INTO t.saved VALUES ('CLOSED', rid::text);
  -- محذوفات وممسوح وحجب طلب حذف
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'REC');
  sid := (SELECT id FROM public.relay_sources WHERE record_id = rid AND chat_message_id = '3e550000-0000-4000-8000-0000000000a3');
  PERFORM t.call(t.u('S1'), format('public.relay_remove_source(%L::uuid, %s)', sid, t.ver(rid)));
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'OWN2');
  sid := (SELECT id FROM public.relay_sources WHERE record_id = rid AND chat_message_id = '3e550000-0000-4000-8000-0000000000a2');
  PERFORM t.call(t.u('EA'), format('public.relay_remove_source(%L::uuid, %s)', sid, t.ver(rid)));
  PERFORM t.call(t.u('OW'), format('public.relay_purge_removed(%L::uuid)', rid));
  PERFORM t.call(t.u('EA'), format('public.relay_redact_for_subject(%L::uuid)', t.u('C2')));
  PERFORM t.call(t.u('OW'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok((SELECT count(*) FROM public.relay_sources) = 6 AND (SELECT count(*) FROM public.relay_assigners) = 1
               AND (SELECT count(*) FROM public.relay_sources WHERE purged_at IS NOT NULL) = 1
               AND (SELECT count(*) FROM public.relay_sources WHERE removed_at IS NOT NULL AND purged_at IS NULL) = 1, 'SETUP data');
  PERFORM t.act(NULL);
END $$;

INSERT INTO t.saved SELECT 'catalog', t.catalog('relay')::text;
INSERT INTO t.saved SELECT 'rows', t.rows('relay')::text;
INSERT INTO t.saved SELECT 'chat', t.chat_digest();
INSERT INTO t.saved SELECT 'events_max', (SELECT max(id) FROM public.relay_events)::text;
-- نتائج القراءة لكل فاعل قبل 077 (المقارنة بعدها عبر الأسماء الجديدة والأغلفة)
INSERT INTO t.saved SELECT 'reads', (SELECT jsonb_object_agg(a.name, jsonb_build_object(
    'access', t.safe(a.id, 'public.relay_my_access()'),
    'list', t.safe(a.id, 'public.relay_list(''{"status":["open","resolved"]}''::jsonb)'),
    'rec', (SELECT t.safe(a.id, format('public.relay_get(%L::uuid)', v)) FROM t.saved WHERE k = 'REC'),
    'removed', t.safe(a.id, 'public.relay_list_removed(100)')))
  FROM t.actors a)::text;

-- ============================================================================
-- ① تطبيق 077
-- ============================================================================
\i migrations/077_continuity_namespace.sql
SET search_path = public, extensions;

DO $$
DECLARE before jsonb := (SELECT v::jsonb FROM t.saved WHERE k = 'catalog'); after jsonb := t.catalog('continuity'); kk text;
BEGIN
  -- N1: كل الصفوف حرفيًا
  PERFORM t.ok(t.rows('continuity') = (SELECT v::jsonb FROM t.saved WHERE k = 'rows'), 'N1 rows identical');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat'), 'N1 chat untouched');
  -- N2: الدوال الـ57 بعد عكس الأسماء = نصوصها قبل 077، بنفس الصلاحيات والمالك وDEFINER وsearch_path
  PERFORM t.ok((SELECT count(*) FROM jsonb_object_keys(before -> 'functions')) = 57, 'N2 57 before');
  FOR kk IN SELECT jsonb_object_keys(before -> 'functions') LOOP
    PERFORM t.ok(after -> 'functions' -> kk = before -> 'functions' -> kk, 'N2 function equivalent: ' || kk);
  END LOOP;
  PERFORM t.ok((SELECT count(*) FROM jsonb_object_keys(after -> 'functions')) = 57, 'N2 57 after');
  -- N3: الجداول (صلاحيات، RLS، المالك، التعليقات) والقيود والفهارس والمحفزات والسياسات وتعليقات الأعمدة
  FOREACH kk IN ARRAY array['tables', 'constraints', 'indexes', 'triggers', 'policies', 'comments'] LOOP
    PERFORM t.ok(after -> kk = before -> kk, 'N3 ' || kk || ' identical');
  END LOOP;
  PERFORM t.ok((SELECT count(*) FROM jsonb_object_keys(before -> 'constraints')) = 83
               AND (SELECT count(*) FROM jsonb_object_keys(before -> 'triggers')) = 17, 'N3 counts');
  RAISE NOTICE 'PASS N1-N3: كل الصفوف حرفيًا، والدوال الـ57 مطابقة لنصها قبل 077 بعد عكس الأسماء (صلاحيات ومالك وDEFINER وsearch_path)، والجداول والقيود الـ83 والفهارس والمحفزات الـ17 والسياسات والتعليقات كما هي';
END $$;

-- N4: لا اسم relay متبقٍ في public إلا الأغلفة الـ19
DO $$
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname LIKE '%relay%'), 'N4 relations');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%relay%'), 'N4 triggers');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
                            WHERE n.nspname = 'public' AND ty.typname LIKE '%relay%'), 'N4 types');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname LIKE '%relay%') = 19, 'N4 only 19 wrappers');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND p.proname LIKE '%relay%' AND (p.prosecdef OR p.prosrc !~ 'public\.continuity_')),
               'N4 wrappers are INVOKER and delegate');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND p.proname LIKE '%continuity%' AND p.prosrc ~* 'relay'), 'N4 bodies clean');
  RAISE NOTICE 'PASS N4: لا جدول ولا تسلسل ولا فهرس ولا قيد ولا محفز ولا نوع باسم relay؛ الدوال باسم relay هي الأغلفة الـ19 فقط (INVOKER تنادي continuity_*)، ولا جسم continuity يذكر relay';
END $$;

-- N5: القراءات بالأسماء الجديدة وبالأغلفة = القراءات قبل 077
DO $$
DECLARE b jsonb := (SELECT v::jsonb FROM t.saved WHERE k = 'reads'); a record; rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'REC');
  vnew jsonb; vwrap jsonb;
BEGIN
  PERFORM t.ctx('admin');
  FOR a IN SELECT * FROM t.actors LOOP
    vnew := jsonb_build_object(
      'access', t.safe(a.id, 'public.continuity_my_access()'),
      'list', t.safe(a.id, 'public.continuity_list(''{"status":["open","resolved"]}''::jsonb)'),
      'rec', t.safe(a.id, format('public.continuity_get(%L::uuid)', rid)),
      'removed', t.safe(a.id, 'public.continuity_list_removed(100)'));
    vwrap := jsonb_build_object(
      'access', t.safe(a.id, 'public.relay_my_access()'),
      'list', t.safe(a.id, 'public.relay_list(''{"status":["open","resolved"]}''::jsonb)'),
      'rec', t.safe(a.id, format('public.relay_get(%L::uuid)', rid)),
      'removed', t.safe(a.id, 'public.relay_list_removed(100)'));
    PERFORM t.ok(vnew = b -> a.name, 'N5 continuity_* = before for ' || a.name);
    PERFORM t.ok(vwrap = b -> a.name, 'N5 relay_* wrappers = before for ' || a.name);
  END LOOP;
  -- أخطاء الأغلفة نفس أكواد الأسماء الجديدة
  PERFORM t.ok(t.err(t.u('C1'), format('public.relay_get(%L::uuid)', rid)) = '42501'
               AND t.err(t.u('S2'), format('public.relay_get(%L::uuid)', rid)) = 'P0002'
               AND t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', rid)) = 'P0002', 'N5 error codes');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS N5: لكل فاعل (عملاء، دعم، أدمن، مشرف، المالك، محظور): my_access وlist وget وlist_removed بالأسماء الجديدة وبالأغلفة = نتيجتها قبل 077 حرفيًا، بما فيها إخفاء المقتطف (C3)';
END $$;

-- N6: الكتابة والقواعد عبر الأسماء الجديدة والأغلفة، والثبات، والتسلسل
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'REC'); r jsonb; nid uuid; c text;
BEGIN
  PERFORM t.ctx('admin');
  -- إنشاء عبر الاسم الجديد وتكرار آمن عبر الغلاف (نفس السجل)
  r := t.call(t.u('S1'), format('public.continuity_create(%L::jsonb)', t.req('NEW', array['3e550000-0000-4000-8000-0000000000a1']::uuid[])));
  nid := (r -> 'record' ->> 'id')::uuid;
  r := t.call(t.u('S1'), format('public.relay_create(%L::jsonb)', t.req('NEW', array['3e550000-0000-4000-8000-0000000000a1']::uuid[])));
  PERFORM t.ok((r -> 'record' ->> 'id')::uuid = nid AND (r ->> 'replayed')::boolean, 'N6 idempotent across wrapper');
  PERFORM t.ok((SELECT min(id) FROM public.continuity_events WHERE record_id = nid) > (SELECT v::bigint FROM t.saved WHERE k = 'events_max'),
               'N6 sequence continues');
  -- P3 كما هو
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_create(%L::jsonb)', t.req('P3', '{}', jsonb_build_object('owner_id', t.u('S2'))))) = '42501'
               AND t.err(t.u('S1'), format('public.relay_create(%L::jsonb)', t.req('P3w', '{}', jsonb_build_object('owner_id', t.u('S2'))))) = '42501', 'N6 P3');
  -- تحديث بنسخة قديمة عبر الغلاف
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, ''{"title":"x"}''::jsonb, 1)', rid)) = '40001', 'N6 version');
  r := t.call(t.u('S1'), format('public.continuity_update(%L::uuid, ''{"title":"عنوان جديد"}''::jsonb, %s)', rid, t.ver2(rid)));
  PERFORM t.ok(r -> 'record' ->> 'title' = 'عنوان جديد', 'N6 update');
  -- T2: المسح للمالك فقط عبر الاسم الجديد
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_redact_source(%L::uuid, ''manual'')', t.src2(rid, 'a1'))) = '42501', 'N6 T2');
  -- الثبات بالأسماء الجديدة (حتى للمالك الخارق)
  BEGIN UPDATE public.continuity_events SET kind = 'x'; RAISE EXCEPTION 'FAIL N6 events update';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_records; RAISE EXCEPTION 'FAIL N6 record delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_source_snapshots; RAISE EXCEPTION 'FAIL N6 snapshot delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_sources SET purged_at = NULL WHERE purged_at IS NOT NULL; RAISE EXCEPTION 'FAIL N6 purge guard';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- لا صلاحية مباشرة
  PERFORM t.ok(t.err_stmt(t.u('OW'), 'select * from public.continuity_records') = '42501', 'N6 no table read');
  -- الأغلفة: authenticated فقط
  FOR c IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'relay\_%' LOOP
    PERFORM t.ok(has_function_privilege('authenticated', c, 'EXECUTE') AND NOT has_function_privilege('anon', c, 'EXECUTE')
                 AND NOT has_function_privilege('service_role', c, 'EXECUTE'), 'N6 wrapper grants ' || c);
  END LOOP;
  PERFORM t.ok(t.err_anon('select public.relay_my_access()') = '42501', 'N6 anon wrapper');
  -- claim الـAPI بالاسم الجديد: المالك عبر الـAPI ليس مشرفًا ولا مالكًا
  r := t.call_api(t.u('OW'), 'public.continuity_my_access()');
  PERFORM t.ok(NOT (r ->> 'supervisor')::boolean AND NOT (r ->> 'owner')::boolean, 'N6 api claim (relay_client in t.act_api)');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS N6: الإنشاء والتكرار الآمن عبر الاسمين، التسلسل يكمل، P3 والنسخة وT2 كما هي، الثبات حتى للمالك الخارق، لا قراءة مباشرة، والأغلفة لـ authenticated فقط';
END $$;

-- N7: claim الـAPI القديم relay_client لم يعد يُقرأ (لا مستخدم له في الإنتاج: relay-api لم يُبنَ)
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM set_config('request.jwt.claim.sub', t.u('EA')::text, false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', t.u('EA'), 'role', 'authenticated',
                                                              'continuity_client', 'extension')::text, false);
  PERFORM t.ok(public._continuity_via_api() AND NOT public._continuity_is_supervisor(), 'N7 new claim = api path');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', t.u('EA'), 'role', 'authenticated',
                                                              'relay_client', 'extension')::text, false);
  PERFORM t.ok(NOT public._continuity_via_api(), 'N7 old claim name ignored');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS N7: مفتاح claim الجديد continuity_client يحدد مسار الـAPI؛ القديم relay_client لم يعد يُقرأ (موثق كاستثناء)';
END $$;

-- ============================================================================
-- ② إعادة التشغيل والتراجع وإعادة التطبيق
-- ============================================================================
INSERT INTO t.saved SELECT 'counts_after', (SELECT count(*) FROM public.continuity_records)::text || '/' ||
  (SELECT count(*) FROM public.continuity_sources)::text || '/' || (SELECT count(*) FROM public.continuity_events)::text;
INSERT INTO t.saved SELECT 'catalog_after', t.catalog('continuity')::text;
\i migrations/077_continuity_namespace.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.catalog('continuity') = (SELECT v::jsonb FROM t.saved WHERE k = 'catalog_after'), 'RERUN catalog unchanged');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_records)::text || '/' || (SELECT count(*) FROM public.continuity_sources)::text
               || '/' || (SELECT count(*) FROM public.continuity_events)::text = (SELECT v FROM t.saved WHERE k = 'counts_after'), 'RERUN data');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 077 لا تغيّر شيئًا';
END $$;

\i migrations/_rollback/077_continuity_namespace.down.sql
SET search_path = public, extensions;
DO $$
DECLARE before jsonb := (SELECT v::jsonb FROM t.saved WHERE k = 'catalog'); after jsonb := t.catalog('relay'); kk text;
BEGIN
  FOREACH kk IN ARRAY array['functions', 'tables', 'constraints', 'indexes', 'triggers', 'policies', 'comments'] LOOP
    PERFORM t.ok(after -> kk = before -> kk, 'RB ' || kk || ' identical to before 077');
  END LOOP;
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname LIKE '%continuity%')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public' AND p.proname LIKE '%continuity%'), 'RB no continuity objects');
  PERFORM t.ok((SELECT count(*) FROM public.relay_records)::text || '/' || (SELECT count(*) FROM public.relay_sources)::text
               || '/' || (SELECT count(*) FROM public.relay_events)::text = (SELECT v FROM t.saved WHERE k = 'counts_after'), 'RB data kept');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat'), 'RB chat untouched');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), 'public.relay_list(''{}''::jsonb)') = 'ok', 'RB relay_* works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB: التراجع يعيد كل الأسماء والدوال والصلاحيات والقيود والفهارس والمحفزات والسياسات حرفيًا كما قبل 077، بلا فقد بيانات';
END $$;

\i migrations/077_continuity_namespace.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.catalog('continuity') = (SELECT v::jsonb FROM t.saved WHERE k = 'catalog_after'), 'RB-c catalog');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_list(''{}''::jsonb)') = 'ok'
               AND t.err(t.u('S1'), 'public.relay_list(''{}''::jsonb)') = 'ok', 'RB-c works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 077 بعد التراجع تعطي نفس الحالة';
END $$;

\echo 'ALL continuity-namespace tests passed'
