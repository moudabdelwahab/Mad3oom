-- ============================================================================
-- 132 — المسار السريع لردود Muse داخل المنصة (owner/muse-chat.html).
--
-- المشكلة (مقاسة 2026-11-24): الرد كان يصل بعد ~165 ثانية. الجسر الحالي
-- كرون كل دقيقة + hook كل 15 ثانية + وكيل Muse كامل يُشغَّل من الصفر لكل
-- رسالة؛ الـ runs نفسها كانت تتكدّس (run يأخذ 133-300 ثانية فيتجاوز فترته
-- وتلغى الـ runs التالية). الصفحة بريئة (تستطلع كل 5 ثواني).
--
-- الإصلاح — Edge Function ‏supabase/functions/muse-chat-reply‏ تُستدعى فور
-- وصول رسالة user في جلسة muse%، في عملية واحدة: حجز ذري للرسالة، ثم رد
-- مباشر عبر ai-gateway (Cerebras أولًا، max_attempts=2، ميزانية 25 ثانية)،
-- أو إقرار فوري `⏳ جارٍ التنفيذ — …` للمهمة الثقيلة ويكملها الجسر.
--
-- ما يضيفه هذا الترحيل:
--   • public.muse_reply_claims — صف واحد لكل رسالة محجوزة (message_id PK).
--     RLS مفعّلة بلا سياسات (service-role فقط؛ الـ Edge Function بمفتاح
--     الخدمة تتجاوز RLS).
--   • سرّ webhook عشوائي (32 بايت) في internal_service_secrets
--     ('muse_chat_reply') — لا يمر بأي ملف أو سجل؛ يُضبط كمتغير بيئة
--     MUSE_REPLY_WEBHOOK_SECRET على الـ Edge Function وقت التطبيق الحي.
--     لا يغيّر سرًا موجودًا (ON CONFLICT DO NOTHING).
--   • _muse_chat_reply_call() + trigger على INSERT في ai_session_messages
--     (WHEN role='user') — نفس نمط المشروع في 089/090 (pg_net، غير متزامن).
--     الدالة تتحقق أولًا أن الجلسة نشطة وmodel_id يبدأ بـ muse ومالكها
--     مفعّل في muse_account_activations، فلا يخرج أي نداء HTTP لغير جلسات
--     Muse المفعّلة. ملاحظة صلاحيات: الدالة SECURITY DEFINER، وEXECUTE
--     ممنوح لـ authenticated وservice_role صراحةً لأن الـ trigger يجب أن
--     يعمل على إدخالاتهم (إدخال الصفحة كـ authenticated) — الدالة لا ترجع
--     السر أبدًا (ترجع معرّف طلب pg_net فقط)، والـ Edge Function تعيد
--     التحقق من كل شيء قبل أي رد.
--   • إضافة public.ai_session_messages إلى publication ‏supabase_realtime‏
--     (نمط 055: فحص الوجود أولًا) ليشترك فيها شات المالك بدل الاستطلاع وحده.
--   • تعريف توثيقي (CREATE TABLE IF NOT EXISTS) لجدولين موجودين حيًا بلا
--     أي تعريف ترحيل — اكتُشف أثناء البناء: agent_activity_log
--     (أعمدته من assets/js/owner/muse-agent-activity-state.js) و
--     muse_account_activations (أعمدته من muse-activations.js). لا يغيّر
--     أي جدول حي؛ للقواعد الجديدة فقط.
--
-- ما لا يفعله: لا يغيّر الجسر الحالي ولا الكرون ولا الـ hook (تبقى كما هي
-- حتى يُتحقق من المسار السريع حيًا)، ولا يمس SIE، ولا يفعّل أي حساب.
-- التراجع: migrations/_rollback/132_muse_fast_reply.down.sql
-- (لا يحذف agent_activity_log ولا muse_account_activations — سابقان حيًا).
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.internal_service_secrets') IS NULL THEN
    RAISE EXCEPTION '132: جدول internal_service_secrets غير موجود (089)';
  END IF;
  IF to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') IS NULL THEN
    RAISE EXCEPTION '132: يتطلب pg_net (net.http_post)';
  END IF;
  IF to_regclass('public.ai_session_messages') IS NULL THEN
    RAISE EXCEPTION '132: جدول ai_session_messages غير موجود (002)';
  END IF;
  IF to_regclass('public.muse_account_activations') IS NULL THEN
    RAISE EXCEPTION '132: جدول muse_account_activations غير موجود';
  END IF;
END $$;

-- سر الـ webhook: يُولَّد داخل القاعدة، ولا يغيّر سرًا موجودًا.
INSERT INTO public.internal_service_secrets (key, value)
VALUES ('muse_chat_reply', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- حجز الردود: صف واحد لكل رسالة، يمنع الرد المكرر من أي مصدر.
CREATE TABLE IF NOT EXISTS public.muse_reply_claims (
  message_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'failed')),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_reply_claims_session_claimed_idx
  ON public.muse_reply_claims (session_id, claimed_at DESC);

ALTER TABLE public.muse_reply_claims ENABLE ROW LEVEL SECURITY;
-- بلا سياسات عمدًا: service-role فقط (الـ Edge Function بمفتاح الخدمة).

-- تعريف توثيقي لجدولين موجودين حيًا بلا ترحيل (انظر رأس الملف) — لا يغيّر حيًا.
CREATE TABLE IF NOT EXISTS public.agent_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_id uuid,
  model_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.muse_account_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE,
  email text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  activated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_account_activations ENABLE ROW LEVEL SECURITY;
-- بلا سياسات جديدة: الجدولان موجودان حيًا بسياساتهما؛ هذا التعريف للقواعد
-- الجديدة فقط، ولا يمس أي سياسة قائمة.

-- دالة النداء: تحقق ثم POST غير متزامن لـ muse-chat-reply.
CREATE OR REPLACE FUNCTION public._muse_chat_reply_call()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_secret text;
BEGIN
  PERFORM 1
    FROM public.ai_sessions s
   WHERE s.id = NEW.session_id
     AND s.status = 'active'
     AND s.model_id LIKE 'muse%'
     AND EXISTS (
       SELECT 1 FROM public.muse_account_activations a
        WHERE a.owner_id = s.owner_id AND a.active = true
     );
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_secret
    FROM public.internal_service_secrets
   WHERE key = 'muse_chat_reply';
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  -- طلب غير متزامن (pg_net). الرد في net._http_response؛ الـ Edge Function
  -- تعيد التحقق من الرسالة والجلسة والتفعيل والحجز قبل أي رد.
  RETURN net.http_post(
    url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/muse-chat-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Muse-Reply-Secret', v_secret),
    body := jsonb_build_object('message_id', NEW.id::text, 'session_id', NEW.session_id::text),
    timeout_milliseconds := 30000);
END $$;

REVOKE ALL ON FUNCTION public._muse_chat_reply_call() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._muse_chat_reply_call() TO authenticated, service_role;

COMMENT ON FUNCTION public._muse_chat_reply_call() IS
  '132: تنادي muse-chat-reply عند رسالة user في جلسة muse% نشطة لمالك مفعّل (pg_net، غير متزامن).';

DROP TRIGGER IF EXISTS muse_chat_reply_trigger ON public.ai_session_messages;
CREATE TRIGGER muse_chat_reply_trigger
  AFTER INSERT ON public.ai_session_messages
  FOR EACH ROW WHEN (NEW.role = 'user')
  EXECUTE FUNCTION public._muse_chat_reply_call();

-- Realtime لجدول الرسائل (نمط 055: فحص الوجود أولًا).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE '132: لا يوجد supabase_realtime — تخطّي Realtime';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'ai_session_messages') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_session_messages';
  END IF;
END $$;

-- فحص ذاتي.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'muse_reply_claims') THEN
    RAISE EXCEPTION '132: muse_reply_claims table was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'muse_reply_claims') THEN
    RAISE EXCEPTION '132: muse_reply_claims RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'muse_reply_claims') <> 0 THEN
    RAISE EXCEPTION '132: muse_reply_claims must have exactly 0 policies';
  END IF;
  IF to_regprocedure('public._muse_chat_reply_call()') IS NULL THEN
    RAISE EXCEPTION '132: _muse_chat_reply_call() was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'muse_chat_reply_trigger') THEN
    RAISE EXCEPTION '132: muse_chat_reply_trigger was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.internal_service_secrets WHERE key = 'muse_chat_reply') THEN
    RAISE EXCEPTION '132: muse_chat_reply secret was not created';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'ai_session_messages') THEN
    RAISE EXCEPTION '132: ai_session_messages was not added to supabase_realtime';
  END IF;
END $$;
