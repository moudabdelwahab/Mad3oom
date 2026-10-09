-- ============================================================================
-- مساحة العمل — 074_workspace_layouts على نسخة مطابقة لشكل الإنتاج
--
--   ① قبل 074: لا شيء موجود (الواجهة تحفظ محليًا)
--   ② بعد 074: الحفظ والقراءة، النسخ والتعارض، العزل بين الموظفين، الأدوار
--      المرفوضة، لا وصول مباشر للجدول، رفض الحمولات غير الصالحة، الحذف المتتالي
--   ③ التراجع وإعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

-- ── أدوات (نفس relay-core.test.sql) ─────────────────────────────────────────
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
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
-- حفظ كموظف: يرجع {revision, updated_at, conflict}
CREATE FUNCTION t.save(p uuid, p_layout jsonb, p_base bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('(select to_jsonb(x) from public.workspace_save_layout(%L::jsonb, %s) x)',
                          p_layout, coalesce(p_base::text, 'null'))) $$;
CREATE FUNCTION t.load(p uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, '(select to_jsonb(x) from public.workspace_get_layout() x)') $$;
-- ترتيب حقيقي بالشكل الذي يرسله serializeLayout()
CREATE FUNCTION t.layout(p_marker text) RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object(
    'version', 1, 'seq', 4, 'activeGroup', 'g2', 'savedAt', 1760000000000,
    'panels', jsonb_build_object('p1', jsonb_build_object('id', 'p1', 'type', 'inbox', 'params', '{}'::jsonb),
                                 'p3', jsonb_build_object('id', 'p3', 'type', 'ticket',
                                         'params', jsonb_build_object('ticketId', p_marker))),
    'root', jsonb_build_object('kind', 'group', 'id', 'g2', 'tabs', jsonb_build_array('p1', 'p3'), 'active', 'p1')) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  S1/S2 دعم · AD أدمن · C1 عميل · BN دعم محظور
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io'), ('00000000-0000-4000-8000-0000000000a6', 's2@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'), ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io', 'دعم 1', 'support', '01000000061', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a6', 's2@t.io', 'دعم 2', 'support', '01000000062', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000063', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل', 'user', '01000000064', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io', 'دعم محظور', 'support', '01000000065', '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = '00000000-0000-4000-8000-0000000000b0';

-- ── ① قبل 074 ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.workspace_layouts') IS NULL
               AND to_regprocedure('public.workspace_get_layout()') IS NULL, '0: موجود قبل الترحيلة');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_get_layout())') = '42883',
               '0: النداء قبل 074 يجب أن يكون «دالة غير موجودة» (الواجهة تتحول للحفظ المحلي)');
  RAISE NOTICE 'PASS 0: قبل 074 الدالة غير موجودة (42883) — الواجهة تعرف ذلك وتحفظ محليًا';
END $$;

\i migrations/074_workspace_layouts.sql
SET search_path = public, extensions;

-- ── ② الحفظ والقراءة ────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.load('00000000-0000-4000-8000-0000000000a5') IS NULL, '1a: لا ترتيب قبل الحفظ');
  r := t.save('00000000-0000-4000-8000-0000000000a5', t.layout('bbbbbbbb-0000-4000-8000-000000000001'));
  PERFORM t.ok((r ->> 'revision')::int = 1 AND NOT (r ->> 'conflict')::boolean, '1b: أول حفظ ' || r::text);
  r := t.load('00000000-0000-4000-8000-0000000000a5');
  PERFORM t.ok(r -> 'layout' = t.layout('bbbbbbbb-0000-4000-8000-000000000001') AND (r ->> 'revision')::int = 1, '1c: القراءة');
  RAISE NOTICE 'PASS 1: الموظف يحفظ ترتيبه ويقرؤه كما هو (revision = 1)';
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  r := t.save('00000000-0000-4000-8000-0000000000a5', t.layout('bbbbbbbb-0000-4000-8000-000000000002'), 1);
  PERFORM t.ok((r ->> 'revision')::int = 2 AND NOT (r ->> 'conflict')::boolean, '2a: حفظ على النسخة الحالية');
  -- نافذة ثانية ما زالت تبني على النسخة 1: الكتابة تنجح (آخر من يكتب يكسب) مع إشارة تعارض
  r := t.save('00000000-0000-4000-8000-0000000000a5', t.layout('bbbbbbbb-0000-4000-8000-000000000003'), 1);
  PERFORM t.ok((r ->> 'revision')::int = 3 AND (r ->> 'conflict')::boolean, '2b: نسخة مرجعية قديمة ' || r::text);
  PERFORM t.ok(t.load('00000000-0000-4000-8000-0000000000a5') -> 'layout' -> 'panels' -> 'p3' -> 'params' ->> 'ticketId'
               = 'bbbbbbbb-0000-4000-8000-000000000003', '2c: الأحدث هو المحفوظ');
  r := t.save('00000000-0000-4000-8000-0000000000a5', t.layout('bbbbbbbb-0000-4000-8000-000000000004'));
  PERFORM t.ok((r ->> 'revision')::int = 4 AND NOT (r ->> 'conflict')::boolean, '2d: بلا نسخة مرجعية لا تعارض');
  RAISE NOTICE 'PASS 2: النسخ تزيد مع كل حفظ؛ النسخة المرجعية القديمة تُكتب (آخر من يكتب يكسب) وترجع conflict = true';
END $$;

DO $$
BEGIN
  PERFORM t.save('00000000-0000-4000-8000-0000000000ad', t.layout('bbbbbbbb-0000-4000-8000-0000000000ad'));
  PERFORM t.ok(t.load('00000000-0000-4000-8000-0000000000ad') -> 'layout' -> 'panels' -> 'p3' -> 'params' ->> 'ticketId'
               = 'bbbbbbbb-0000-4000-8000-0000000000ad', '3a: الأدمن يرى ترتيبه');
  PERFORM t.ok(t.load('00000000-0000-4000-8000-0000000000a5') -> 'layout' -> 'panels' -> 'p3' -> 'params' ->> 'ticketId'
               = 'bbbbbbbb-0000-4000-8000-000000000004', '3b: الدعم يرى ترتيبه هو لا ترتيب الأدمن');
  PERFORM t.ok(t.load('00000000-0000-4000-8000-0000000000a6') IS NULL, '3c: موظف بلا حفظ لا يرى شيئًا');
  PERFORM t.ok((SELECT count(*) FROM public.workspace_layouts) = 2, '3d: صف لكل موظف');
  RAISE NOTICE 'PASS 3: كل موظف يحفظ ويقرأ صفه هو فقط (لا معامل يسمّي مستخدمًا آخر)';
END $$;

-- ── الأدوار المرفوضة ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000c1', '(select 1 from public.workspace_get_layout())') = '42501', '4a عميل get');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000c1',
               format('(select 1 from public.workspace_save_layout(%L::jsonb))', t.layout('x'))) = '42501', '4a عميل save');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000b0', '(select 1 from public.workspace_get_layout())') = '42501', '4b محظور get');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000b0',
               format('(select 1 from public.workspace_save_layout(%L::jsonb))', t.layout('x'))) = '42501', '4b محظور save');
  PERFORM t.ok(t.err(NULL, '(select 1 from public.workspace_get_layout())') = '42501', '4c بلا مستخدم');
  PERFORM t.ok(t.err_anon('select 1 from public.workspace_get_layout()') = '42501', '4d anon get');
  PERFORM t.ok(t.err_anon(format('select 1 from public.workspace_save_layout(%L::jsonb)', t.layout('x'))) = '42501', '4d anon save');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.workspace_layouts WHERE user_id IN
                 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b0')), '4e لم يُكتب شيء');
  RAISE NOTICE 'PASS 4: العميل والمحظور وبلا مستخدم وanon ⇒ 42501، ولم يُكتب لهم أي صف';
END $$;

-- ── لا وصول مباشر للجدول ──────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000a5', 'select 1 from public.workspace_layouts') = '42501', '5a select');
  PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000a6',
               format('insert into public.workspace_layouts (user_id, layout) values (%L, %L::jsonb)',
                      '00000000-0000-4000-8000-0000000000a6', t.layout('x'))) = '42501', '5b insert');
  PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000a6',
               'update public.workspace_layouts set layout = ''{"version":1}''::jsonb') = '42501', '5c update غير صاحب');
  PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000a5', 'delete from public.workspace_layouts') = '42501', '5d delete');
  PERFORM t.ok(t.err_anon('select 1 from public.workspace_layouts') = '42501', '5e anon select');
  PERFORM t.ok((SELECT count(*) FROM public.workspace_layouts) = 2, '5f لا تغيير');
  RAISE NOTICE 'PASS 5: لا SELECT/INSERT/UPDATE/DELETE مباشر على الجدول لأي دور — الدالتان فقط';
END $$;

-- ── رفض الحمولات غير الصالحة ──────────────────────────────────────────────
DO $$
DECLARE big jsonb;
BEGIN
  big := t.layout('x') || jsonb_build_object('pad', repeat('x', 70000));
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_save_layout(''[1,2]''::jsonb))') = '22023', '6a مصفوفة');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_save_layout(''{"root":null}''::jsonb))') = '22023', '6b بلا version');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_save_layout(''{"version":"1"}''::jsonb))') = '22023', '6c version نص');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_save_layout(''{"version":1.5}''::jsonb))') = '22023', '6d version كسر');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_save_layout(null))') = '22023', '6e null');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('(select 1 from public.workspace_save_layout(%L::jsonb))', big)) = '22023', '6f أكبر من 64KB');
  PERFORM t.ok((t.load('00000000-0000-4000-8000-0000000000a5') ->> 'revision')::int = 4, '6g المحفوظ لم يتغير');
  RAISE NOTICE 'PASS 6: الحمولة غير الكائن، أو بلا version رقمي صحيح، أو فوق 64KB ⇒ 22023 ولا يتغير المحفوظ';
END $$;

-- ── حذف الموظف يحذف ترتيبه ────────────────────────────────────────────────
-- حذف ملف موظف فعليًا محروس في الإنتاج (المالك وحده بخطوتين)، فنتحقق من القيد نفسه.
DO $$
BEGIN
  PERFORM t.ok(EXISTS (SELECT 1 FROM pg_constraint c
                        WHERE c.conrelid = 'public.workspace_layouts'::regclass AND c.contype = 'f'
                          AND c.confrelid = 'public.profiles'::regclass AND c.confdeltype = 'c'), '7');
  RAISE NOTICE 'PASS 7: الترتيب مربوط بالملف الشخصي بـ on delete cascade — حذف الحساب يحذف ترتيبه';
END $$;

-- ── إعادة التشغيل ─────────────────────────────────────────────────────────
\i migrations/074_workspace_layouts.sql
DO $$
BEGIN
  PERFORM t.ok((t.load('00000000-0000-4000-8000-0000000000a5') ->> 'revision')::int = 4
               AND (SELECT count(*) FROM public.workspace_layouts) = 2, '8: البيانات بعد إعادة التشغيل');
  RAISE NOTICE 'PASS 8: 074 قابلة لإعادة التشغيل بلا فقد';
END $$;

-- ── ③ التراجع وإعادة التطبيق ──────────────────────────────────────────────
\i migrations/_rollback/074_workspace_layouts.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.workspace_layouts') IS NULL
               AND to_regprocedure('public.workspace_save_layout(jsonb,bigint)') IS NULL, '9a');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', '(select 1 from public.workspace_get_layout())') = '42883', '9b');
  RAISE NOTICE 'PASS 9: التراجع يحذف الجدول والدالتين، والنداء يرجع 42883 فتعود الواجهة للحفظ المحلي';
END $$;
\i migrations/074_workspace_layouts.sql
DO $$
DECLARE r jsonb;
BEGIN
  r := t.save('00000000-0000-4000-8000-0000000000a6', t.layout('bbbbbbbb-0000-4000-8000-0000000000a6'));
  PERFORM t.ok((r ->> 'revision')::int = 1, '10');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 10: إعادة التطبيق بعد التراجع تنجح (كتلة التحقق) والحفظ يعمل';
END $$;

\echo 'ALL workspace-layouts tests passed'
