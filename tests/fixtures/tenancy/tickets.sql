-- ============================================================================
-- عُدّة تذاكر تعدد الشركات (097 وما بعده) — تُحمَّل بعد harness.sql و095 و096، وقبل 097
-- (التذاكر تُدرج بلا محفّزات ثم يختمها الملء الأولي في 097).
--
--  TA1 تذكرة أ1 (شركة أ) · TA1S فوترة أ1 الشخصية (مدعوم) · TA2 تذكرة أ2 (شركة أ) · TB1 تذكرة ب1 (شركة ب)
--  TOA مالك أ لمدعوم · TAS مشرف أ لمدعوم · TPU حساب فرد لمدعوم
--  RPUB رد علني من مالك أ على TA1 · RINT ملاحظة داخلية من طاقم المنصة على TA1 (بمرفق)
--  RB1 متابعة ب1 · RPU رد مدعوم على TPU
-- ============================================================================
-- ── معرّفات التذاكر الثابتة ───────────────────────────────────────────────
CREATE FUNCTION t.k(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'TA1'  then '7a000000-0000-4000-8000-000000000a11' when 'TA1S' then '7a000000-0000-4000-8000-000000000a15'
    when 'TA2'  then '7a000000-0000-4000-8000-000000000a12' when 'TB1'  then '7b000000-0000-4000-8000-000000000b11'
    when 'TOA'  then '7a000000-0000-4000-8000-000000000a00' when 'TAS'  then '7a000000-0000-4000-8000-000000000a21'
    when 'TPU'  then '7e000000-0000-4000-8000-000000000005'
    when 'RPUB' then '7c000000-0000-4000-8000-000000000001' when 'RINT' then '7c000000-0000-4000-8000-000000000002'
    when 'RB1'  then '7c000000-0000-4000-8000-000000000003' when 'RPU'  then '7c000000-0000-4000-8000-000000000004'
    when 'TAG'  then '7d000000-0000-4000-8000-000000000001'
  end)::uuid $$;
CREATE FUNCTION t.fxt() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  select array[t.k('TA1'), t.k('TA1S'), t.k('TA2'), t.k('TB1'), t.k('TOA'), t.k('TAS'), t.k('TPU')] $$;
CREATE FUNCTION t.path(p_user text, p_ticket text, p_file text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  select t.u(p_user)::text || '/' || t.k(p_ticket)::text || '/fx-' || p_file $$;

-- رؤية فاعل: t تذاكر، r ردود، a مرفقات، v نشاط، g تقييمات، l وسوم، o ملفات
CREATE FUNCTION t.vis(p text) RETURNS text LANGUAGE sql AS $$
  select concat_ws(',',
    't' || t.rows(t.u(p), 'public.tickets where id = any(t.fxt())'),
    'r' || t.rows(t.u(p), 'public.ticket_replies where ticket_id = any(t.fxt())'),
    'a' || t.rows(t.u(p), 'public.ticket_attachments where ticket_id = any(t.fxt())'),
    'v' || t.rows(t.u(p), 'public.ticket_activity where ticket_id = any(t.fxt())'),
    'g' || t.rows(t.u(p), 'public.ticket_ratings where ticket_id = any(t.fxt())'),
    'l' || t.rows(t.u(p), 'public.ticket_tag_links where ticket_id = any(t.fxt())'),
    'o' || t.rows(t.u(p), 'storage.objects where bucket_id = ''tickets'' and name like ''%/fx-%''')) $$;
CREATE FUNCTION t.sees(p text, p_ticket text) RETURNS boolean LANGUAGE sql AS $$
  select t.rows(t.u(p), format('public.tickets where id = %L', t.k(p_ticket))) = 1 $$;
CREATE FUNCTION t.allvis() RETURNS text LANGUAGE sql AS $$
  select string_agg(n || '=' || t.vis(n), ';' order by n)
    from unnest(array['EA','AD','SUP','PU','OA','A1','A2','AS','AG','OB','B1','BS']) n $$;
CREATE FUNCTION t.sw(p_key text, p_on boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  update public.platform_feature_switches set enabled = p_on where key = p_key; END $$;
CREATE FUNCTION t.err_super_ok(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
CREATE FUNCTION t.schema_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(x, '#' order by x)) from (
    select 'f:' || p.oid::regprocedure || ':' || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, '') x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'storage') and p.prokind = 'f'
    union all select 'p:' || schemaname || tablename || policyname || permissive || cmd || coalesce(qual, '') || coalesce(with_check, '')
      from pg_policies
    union all select 'tg:' || tgrelid::regclass || pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
    union all select 'ck:' || conrelid::regclass || conname || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'c:' || table_schema || table_name || column_name || data_type || is_nullable
      from information_schema.columns where table_schema in ('public', 'storage')
    union all select 'g:' || grantee || table_name || privilege_type
      from information_schema.role_table_grants where table_schema = 'public'
    union all select 'k:' || key || enabled from public.platform_feature_switches) s $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── التذاكر قبل 097 (بلا محفّزات: لا إشعارات ولا حصص في التهيئة) ────────────
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.tickets (id, user_id, title, description, status, priority, category, created_at) VALUES
  (t.k('TA1'),  t.u('A1'), 'طلبي لم يصل',     'تفاصيل أ1', 'open', 'medium', 'other',        now() - interval '3 days'),
  (t.k('TA1S'), t.u('A1'), 'تجديد اشتراكي',    'فوترة شخصية', 'open', 'high',   'subscription', now() - interval '3 days'),
  (t.k('TA2'),  t.u('A2'), 'استفسار أ2',      'تفاصيل أ2', 'open', 'low',    'other',        now() - interval '3 days'),
  (t.k('TB1'),  t.u('B1'), 'شكوى ب1',         'تفاصيل ب1', 'open', 'medium', 'other',        now() - interval '3 days'),
  (t.k('TOA'),  t.u('OA'), 'مالك أ يسأل مدعوم', 'تفاصيل',    'open', 'medium', 'other',        now() - interval '3 days'),
  (t.k('TAS'),  t.u('AS'), 'مشرف أ يسأل مدعوم', 'تفاصيل',    'open', 'medium', 'other',        now() - interval '3 days'),
  (t.k('TPU'),  t.u('PU'), 'حساب فرد',         'تفاصيل',    'open', 'medium', 'other',        now() - interval '3 days');
INSERT INTO public.ticket_replies (id, ticket_id, user_id, message, is_internal) VALUES
  (t.k('RPUB'), t.k('TA1'), t.u('OA'),  'رد الشركة', false),
  (t.k('RINT'), t.k('TA1'), t.u('SUP'), 'ملاحظة داخلية', true),
  (t.k('RB1'),  t.k('TB1'), t.u('B1'),  'متابعة', false),
  (t.k('RPU'),  t.k('TPU'), t.u('SUP'), 'رد مدعوم', false);
INSERT INTO public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path) VALUES
  (t.k('TA1'), t.k('RINT'), 'x', 'internal.png', 10, 'image/png', t.u('SUP'), t.path('A1', 'TA1', 'internal.png')),
  (t.k('TA1'), t.k('RPUB'), 'x', 'public.png',   10, 'image/png', t.u('OA'),  t.path('A1', 'TA1', 'public.png')),
  (t.k('TB1'), null,        'x', 'b.png',        10, 'image/png', t.u('B1'),  t.path('B1', 'TB1', 'b.png')),
  (t.k('TPU'), null,        'x', 'pu.png',       10, 'image/png', t.u('PU'),  t.path('PU', 'TPU', 'pu.png'));
INSERT INTO storage.objects (bucket_id, name, owner) VALUES
  ('tickets', t.path('A1', 'TA1', 'internal.png'), t.u('SUP')),
  ('tickets', t.path('A1', 'TA1', 'public.png'),   t.u('OA')),
  ('tickets', t.path('B1', 'TB1', 'b.png'),        t.u('B1')),
  ('tickets', t.path('PU', 'TPU', 'pu.png'),       t.u('PU'));
INSERT INTO public.ticket_activity (ticket_id, actor_id, action_type, to_value)
SELECT id, user_id, 'create', 'open' FROM public.tickets WHERE id = any(t.fxt());
INSERT INTO public.ticket_ratings (ticket_id, user_id, rating) VALUES
  (t.k('TA1'), t.u('A1'), 5), (t.k('TPU'), t.u('PU'), 4);
INSERT INTO public.ticket_tags (id, name) VALUES (t.k('TAG'), 'وسم');
INSERT INTO public.ticket_tag_links (ticket_id, tag_id) VALUES (t.k('TA1'), t.k('TAG')), (t.k('TPU'), t.k('TAG'));
COMMIT;
