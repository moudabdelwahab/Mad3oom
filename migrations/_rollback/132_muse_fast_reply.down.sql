-- ============================================================================
-- Rollback 132 — المسار السريع لردود Muse.
--
-- يحذف الـ trigger والدالة وجدول الحجز والسر وإدخال Realtime.
-- لا يحذف agent_activity_log ولا muse_account_activations — سابقان حيًا
-- قبل 132، وتعريفهما فيه توثيقي فقط. ولا يحذف أي رد أُدخل عبر المسار السريع.
-- ============================================================================

DROP TRIGGER IF EXISTS muse_chat_reply_trigger ON public.ai_session_messages;
DROP FUNCTION IF EXISTS public._muse_chat_reply_call();
DROP TABLE IF EXISTS public.muse_reply_claims;

DELETE FROM public.internal_service_secrets WHERE key = 'muse_chat_reply';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                AND tablename = 'ai_session_messages') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.ai_session_messages';
  END IF;
END $$;
