-- ============================================================================
-- اختبار تنفيذي لـ 057: المالك في سياق «الإدارة» مشرف على الصندوق.
--
-- بلاغ الإنتاج: المالك في لوحة الإدارة (سياق admin) أخد 403 على كل رد وملاحظة.
-- اختبارات 055/056 ما مسكتش ده لأن بديل owner_capability فيها كان بيتجاهل
-- السياق («المالك» = كل القدرات). هنا دوال السياق **منسوخة من الإنتاج حرفيًا**
-- (context_allows و owner_capability و active_context و is_platform_owner)
-- وحالة السياق صف حقيقي في owner_context_state.
--
-- يثبّت:
--   ① المالك في admin: وكيل ومشرف — يرى كل المحادثات ويرد ويدير الفرق ويسحب لزملائه
--   ② المالك في owner: نفس الإشراف (سلوك 055 كما هو)
--   ③ المالك في customer / company_admin / معاينة العضو / سياق منتهٍ / بلا سياق:
--      مش مشرف، ومفيش كتابة في الصندوق
--   ④ لا انتشار: الأدمن العادي والدعم كما هم، والمرتفع كما هو، والعميل لا شيء
--   ⑤ inbox_my_access يقول للواجهة نفس قرار القاعدة
--
-- التمهيد منسوخ من inbox-phase2.test.sql (حالة الإنتاج بعد 054/055/056).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- ── الجداول بشكل الإنتاج ─────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, role text DEFAULT 'user',
  phone text, ban_status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY, level text NOT NULL, granted_at timestamptz DEFAULT now(), note text);
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), guest_id text,
  is_manual_mode boolean DEFAULT false, bot_state jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid REFERENCES public.chat_sessions(id),
  sender_id uuid, message_text text NOT NULL, is_bot_reply boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), is_admin_reply boolean DEFAULT false,
  image_url text, audio_url text, attachment jsonb);

-- 054_chat_composer_attachments (مطبَّق على الإنتاج قبل 055): حارس المرفقات
-- على chat_messages منسوخ حرفيًا، حتى يمرّ رد الدعم عبر inbox_send_reply من
-- نفس المحفّز الذي يمرّ منه في الإنتاج.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
-- storage.foldername كما في Supabase: أجزاء المسار ما عدا اسم الملف.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]; $$;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT ON storage.objects TO authenticated;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.chat_attachment_path_ok(p_path text, p_sender uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_sender IS NOT NULL
     AND p_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*:'
     AND p_path !~ '(^|/)\.\.?(/|$)'
     AND left(p_path, 1) <> '/'
     AND split_part(p_path, '/', 1) = p_sender::text
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'chat-attachments' AND o.name = p_path); $$;
CREATE OR REPLACE FUNCTION public.guard_chat_message_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_path text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.audio_url IS NOT DISTINCT FROM OLD.audio_url
     AND NEW.attachment IS NOT DISTINCT FROM OLD.attachment THEN
    RETURN NEW;
  END IF;
  FOREACH v_path IN ARRAY ARRAY[NEW.image_url, NEW.audio_url, NEW.attachment->>'path'] LOOP
    IF v_path IS NOT NULL AND NOT public.chat_attachment_path_ok(v_path, NEW.sender_id) THEN
      RAISE EXCEPTION 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلد المرسل نفسه' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_guard_chat_message_attachment
  BEFORE INSERT OR UPDATE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_attachment();
CREATE TABLE public.ticket_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  color text NOT NULL DEFAULT '#4DA3FF', created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text NOT NULL, message text NOT NULL,
  type text DEFAULT 'info', is_read boolean DEFAULT false, link text, created_at timestamptz DEFAULT now());
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions, public.chat_messages;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- ── بدائل يتحكم فيها الاختبار ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(current_setting('test.owner_context', true), '') = 'on'
     and exists (select 1 from public.platform_authority a where a.user_id = auth.uid() and a.level = 'owner'); $$;
CREATE OR REPLACE FUNCTION public.preview_mode() RETURNS boolean
LANGUAGE sql STABLE AS $$ select coalesce(current_setting('test.preview', true), '') = 'on'; $$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = p_user_id and p.ban_status = 'permanent'); $$;
CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is null or not public.is_banned(auth.uid()); $$;

-- ── منسوخة من الإنتاج حرفيًا ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_elevated_authority() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1
             from public.platform_authority a
             join public.profiles p on p.id = a.user_id
            where a.user_id = auth.uid()
              and a.level   = 'elevated_admin'
              and p.role    = 'admin'
         )
      or public.owner_capability('owner_only'); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'support')
         )
      or public.owner_capability('staff'); $$;
CREATE OR REPLACE FUNCTION public.guard_preview_read_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة'
      using errcode = '42501';
  end if;
  return null;
end; $$;

-- ── سياسات الشات القائمة في الإنتاج ──────────────────────────────────────
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_sessions_select_own_or_admin ON public.chat_sessions
  FOR SELECT USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_update_own_or_admin ON public.chat_sessions
  FOR UPDATE USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_messages_select_own_or_admin ON public.chat_messages
  FOR SELECT USING (public.has_elevated_authority() OR sender_id = auth.uid()
    OR session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid()));
CREATE POLICY chat_messages_insert_own_or_admin ON public.chat_messages
  FOR INSERT WITH CHECK (public.has_elevated_authority() OR (
    session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid())
    AND (sender_id = auth.uid() OR sender_id IS NULL)));
CREATE POLICY gate_account_active ON public.chat_sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());
CREATE POLICY gate_account_active ON public.chat_messages AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());

-- ── الفاعلون والبيانات ────────────────────────────────────────────────────
--   O  مالك المنصة        E  أدمن مرتفع          A1/A2 أدمن عادي
--   S1 دعم                B  أدمن محظور          C1/C2 عملاء
INSERT INTO public.profiles (id, email, full_name, role, ban_status) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner@t', 'المالك', 'platform_owner', null),
  ('00000000-0000-4000-8000-0000000000e1', 'e@t', 'أدمن مرتفع', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a1', 'a1@t', 'أدمن واحد', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a2', 'a2@t', 'أدمن اتنين', 'admin', null),
  ('00000000-0000-4000-8000-0000000000b1', 'b@t', 'أدمن محظور', 'admin', 'permanent'),
  ('00000000-0000-4000-8000-00000000005a', 's1@t', 'دعم واحد', 'support', null),
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t', 'عميل واحد', 'user', null),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t', 'عميل اتنين', 'user', null);
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner'),
  ('00000000-0000-4000-8000-0000000000e1', 'elevated_admin');
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_bot_reply) VALUES
  ('3e550000-0000-4000-8000-000000000001', '5e550000-0000-4000-8000-000000000001', null, 'أهلاً', true),
  ('3e550000-0000-4000-8000-000000000002', '5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'عندي مشكلة', false),
  ('3e550000-0000-4000-8000-000000000003', '5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2', 'سؤال من عميل تاني', false);
INSERT INTO public.ticket_tags (id, name) VALUES ('7a900000-0000-4000-8000-000000000001', 'فوترة');

-- سياسة القراءة القائمة في الإنتاج على المستودع (منسوخة حرفيًا)
CREATE POLICY chat_attachments_read_own_or_staff ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND (public.is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)));

-- ── دوال السياق كما في الإنتاج (تحل محل بديل التمهيد) ────────────────────
CREATE TABLE public.owner_context_state (
  user_id uuid PRIMARY KEY, context text NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE OR REPLACE FUNCTION public.owns_a_company(p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id); $$;
CREATE OR REPLACE FUNCTION public.is_platform_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1
      from public.platform_authority a
      join public.profiles p on p.id = a.user_id
     where a.user_id = auth.uid()
       and a.level   = 'owner'
       and p.role    = 'platform_owner'
  ); $$;
CREATE OR REPLACE FUNCTION public.active_context() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select s.context
    from public.owner_context_state s
   where s.user_id = auth.uid()
     and s.expires_at > now()
     and public.is_platform_owner(); $$;
CREATE OR REPLACE FUNCTION public.context_allows(p_context text, p_capability text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  select coalesce(case p_capability
    when 'owner_only'     then p_context = 'owner'
    when 'admin'          then p_context in ('owner', 'admin')
    when 'staff'          then p_context in ('owner', 'admin')
    when 'company_admin'  then p_context in ('owner', 'company_admin')
    when 'company_member' then p_context = 'company_user_preview'
    when 'customer'       then p_context in ('owner', 'customer')
    else false
  end, false); $$;
CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(
    public.is_platform_owner()
      and public.context_allows(public.active_context(), p_capability)
      and case p_capability
            when 'company_admin'  then public.owns_a_company(auth.uid())
            when 'company_member' then public.owns_a_company(auth.uid())
            else true
          end,
    false); $$;
-- in_context في الإنتاج = active_context() = p و context_grants(p)؛ المنح مفترض هنا.
CREATE OR REPLACE FUNCTION public.preview_mode() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(public.active_context() = 'company_user_preview', false); $$;

-- المالك عنده محادثة من حسابه هو كعميل (زي الإنتاج: 4 محادثات)
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-0000000000f0', '00000000-0000-4000-8000-00000000000f');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text) VALUES
  ('3e550000-0000-4000-8000-0000000000f0', '5e550000-0000-4000-8000-0000000000f0', '00000000-0000-4000-8000-00000000000f', 'تجربة من حسابي');

\i migrations/055_inbox_helpdesk_core.sql
\i migrations/056_inbox_attachments_reactions_edits.sql
\i migrations/057_inbox_owner_admin_context.sql

-- ── مساعدات الاختبار ─────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated;
CREATE OR REPLACE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false); $$;
-- السياق صف في القاعدة، يكتبه enter_context في الإنتاج — هنا مباشرة.
CREATE OR REPLACE FUNCTION t.ctx(p_context text, p_ttl interval DEFAULT interval '1 hour') RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  delete from public.owner_context_state where user_id = '00000000-0000-4000-8000-00000000000f';
  insert into public.owner_context_state (user_id, context, expires_at)
  select '00000000-0000-4000-8000-00000000000f', p_context, now() + p_ttl where p_context is not null; $$;
CREATE OR REPLACE FUNCTION t.fails(p_sql text, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return false;
exception when others then
  if p_code is not null and sqlstate <> p_code then
    raise notice '   (رمز غير متوقع % : %)', sqlstate, sqlerrm;
    return false;
  end if;
  return true;
end $$;
CREATE OR REPLACE FUNCTION t.visible_sessions() RETURNS bigint LANGUAGE sql AS $$
  select count(*) from public.chat_sessions; $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated;

-- ── تجهيز: فريق فيه A1، ومحادثة S1 مسندة لـ A1 وفيها ملاحظة ورد منه ───────
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1');
SELECT t.act('00000000-0000-4000-8000-0000000000a1');
SELECT public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'ملاحظة من A1', '{}');
SELECT public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'رد من A1');

-- ① المالك في سياق admin — البلاغ نفسه ─────────────────────────────────────
DO $$
DECLARE v jsonb; n bigint; note uuid; reply uuid; team uuid;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-00000000000f');
  PERFORM t.ctx('admin');
  IF public.has_elevated_authority() THEN RAISE EXCEPTION 'FAIL 1-pre: التمهيد غلط — admin مش owner_only'; END IF;

  v := public.inbox_my_access();
  IF v <> '{"agent": true, "supervisor": true}'::jsonb THEN RAISE EXCEPTION 'FAIL 1a: my_access %', v; END IF;
  n := t.visible_sessions();
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 1b: المالك في admin يرى % محادثة بدل 3', n; END IF;

  -- نفس النداءين اللي رجعوا 403 في الإنتاج — على محادثة عميل مش مسندة له
  PERFORM public.inbox_add_note('5e550000-0000-4000-8000-000000000002', 'ملاحظة من المالك', '{}');
  PERFORM public.inbox_send_reply('5e550000-0000-4000-8000-000000000002', 'رد من المالك');
  -- ومحادثته هو كعميل (اللي كانت ظاهرة في القايمة)
  PERFORM public.inbox_add_note('5e550000-0000-4000-8000-0000000000f0', 'ملاحظة على محادثتي', '{}');

  -- إشراف: سحب ملاحظة زميل، حذف رد زميل، إدارة فرق
  SELECT id INTO note FROM public.inbox_notes WHERE body = 'ملاحظة من A1';
  PERFORM public.inbox_delete_note(note);
  SELECT id INTO reply FROM public.chat_messages WHERE message_text = 'رد من A1';
  PERFORM public.inbox_delete_message(reply);
  -- التعديل لصاحب الرد وحده حتى للمشرف
  IF NOT t.fails(format('select public.inbox_edit_message(%L, %L)',
      (SELECT id FROM public.chat_messages WHERE message_text = 'أهلاً'), 'x'), '42501') THEN
    RAISE EXCEPTION 'FAIL 1c: المشرف عدّل رسالة مش رد دعم';
  END IF;
  team := (public.inbox_save_team(null, 'فريق المالك', null)).id;
  IF team IS NULL THEN RAISE EXCEPTION 'FAIL 1d: إدارة الفرق'; END IF;
  RAISE NOTICE 'PASS 1: المالك في سياق الإدارة يرد ويكتب ملاحظات على كل المحادثات، ويشرف (سحب/حذف/فرق)';
END $$;

-- ② المالك في owner — كما كان ─────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-00000000000f');
  PERFORM t.ctx('owner');
  v := public.inbox_my_access();
  IF v <> '{"agent": true, "supervisor": true}'::jsonb OR t.visible_sessions() <> 3 THEN
    RAISE EXCEPTION 'FAIL 2: المالك في owner %', v;
  END IF;
  PERFORM public.inbox_add_note('5e550000-0000-4000-8000-000000000002', 'من سياق المالك', '{}');
  RAISE NOTICE 'PASS 2: المالك في سياق المالك مشرف كما في 055';
END $$;

-- ③ سياقات مش إدارية: لا إشراف ولا كتابة ───────────────────────────────────
DO $$
DECLARE c text; v jsonb; n bigint;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-00000000000f');
  FOREACH c IN ARRAY ARRAY['customer', 'company_admin', 'company_user_preview', 'expired', 'none'] LOOP
    IF c = 'expired' THEN PERFORM t.ctx('admin', interval '-1 minute');
    ELSIF c = 'none' THEN PERFORM t.ctx(null);
    ELSE PERFORM t.ctx(c); END IF;

    v := public.inbox_my_access();
    IF (v->>'supervisor')::boolean THEN RAISE EXCEPTION 'FAIL 3a: مشرف في سياق % (%)', c, v; END IF;
    IF NOT t.fails($q$select public.inbox_add_note('5e550000-0000-4000-8000-000000000002', 'x', '{}')$q$, '42501') THEN
      RAISE EXCEPTION 'FAIL 3b: ملاحظة على محادثة عميل في سياق %', c;
    END IF;
    IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-0000000000f0', 'x')$q$, '42501') THEN
      RAISE EXCEPTION 'FAIL 3c: رد على محادثته في سياق %', c;
    END IF;
    n := t.visible_sessions();
    -- في أي سياق غير إداري: محادثاته هو بس (سياسة «جلساتي» القائمة)
    IF n <> 1 THEN RAISE EXCEPTION 'FAIL 3d: يرى % محادثة في سياق %', n, c; END IF;
  END LOOP;
  RAISE NOTICE 'PASS 3: customer / company_admin / معاينة العضو / منتهٍ / بلا سياق — لا إشراف ولا كتابة';
END $$;

-- ④ لا انتشار لغير المالك ───────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  -- سياق المالك مفتوح admin — لازم مايأثرش على غيره
  PERFORM t.act('00000000-0000-4000-8000-00000000000f');
  PERFORM t.ctx('admin');

  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');   -- أدمن عادي مش مسند له
  v := public.inbox_my_access();
  IF v <> '{"agent": true, "supervisor": false}'::jsonb OR t.visible_sessions() <> 0 THEN
    RAISE EXCEPTION 'FAIL 4a: الأدمن العادي % يرى %', v, t.visible_sessions();
  END IF;
  IF NOT t.fails($q$select public._inbox_is_supervisor()$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4b: الدالة الداخلية مكشوفة';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');   -- مسند له S1 بس
  IF (public.inbox_my_access()->>'supervisor')::boolean OR t.visible_sessions() <> 1 THEN
    RAISE EXCEPTION 'FAIL 4c: الأدمن المسند له';
  END IF;
  IF NOT t.fails($q$select public.inbox_save_team(null, 'x', null)$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4d: أدمن عادي أدار الفرق';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');   -- مرتفع بلا أي سياق
  IF public.inbox_my_access() <> '{"agent": true, "supervisor": true}'::jsonb OR t.visible_sessions() <> 3 THEN
    RAISE EXCEPTION 'FAIL 4e: المرتفع اتغيّر';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');   -- عميل
  IF public.inbox_my_access() <> '{"agent": false, "supervisor": false}'::jsonb OR t.visible_sessions() <> 1 THEN
    RAISE EXCEPTION 'FAIL 4f: العميل %', public.inbox_my_access();
  END IF;
  RAISE NOTICE 'PASS 4: الأدمن العادي والمسند له والمرتفع والعميل كما كانوا';
END $$;

-- ⑤ مفيش قرار إشراف لسه بيسأل has_elevated_authority مباشرة ────────────────
RESET ROLE;
DO $$
BEGIN
  IF exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname like '%inbox%' and p.proname <> '_inbox_is_supervisor'
               and pg_get_functiondef(p.oid) like '%has_elevated_authority%') THEN
    RAISE EXCEPTION 'FAIL 5: دالة صندوق لسه بتسأل has_elevated_authority: %',
      (select string_agg(proname, ', ') from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.proname like '%inbox%' and p.proname <> '_inbox_is_supervisor'
         and pg_get_functiondef(p.oid) like '%has_elevated_authority%');
  END IF;
  RAISE NOTICE 'PASS 5: الإشراف له مصدر واحد (_inbox_is_supervisor)';
END $$;

\echo 'ALL inbox-owner-context tests passed'
