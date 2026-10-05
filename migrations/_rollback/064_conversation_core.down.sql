-- ============================================================================
-- تراجع 064_conversation_core
--
-- ⚠️ قبله: أي كود بينادي conv_* لازم يكون اتقفل (الأعلام core_ingest_* و
-- agent_runtime_enabled = false — وده الوضع الافتراضي).
--
-- بيشيل: الدوال، المحفّزات، الفهارس الفريدة، والأعلام.
-- بيسيب (عن قصد — مفيش حذف بيانات):
--   • الأعمدة الجديدة وقيمها (channel, external_thread_id, state_version,
--     channel_identity_id, seq, external_id, metadata, delivery_*): nullable أو
--     بقيمة افتراضية، ومفيش كود قديم بيقراها.
--   • أنواع inbox_events الموسّعة: فيه أحداث اتكتبت بالأنواع دي، وتضييق القيد
--     هيفشل أو يحتاج حذفها.
--   • قيود CHECK على الأعمدة الجديدة و FK channel_identity_id.
-- بعد التراجع: الرسايل الجديدة مابتاخدش seq، ومفيش أحداث رسايل/إنشاء/إقفال
-- جديدة، والتسليم مابيزوّدش state_version — يعني رجوع للسلوك قبل 064 بالظبط.
-- ============================================================================

drop function if exists public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval);
drop function if exists public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text);
drop function if exists public.conv_claim_delivery(uuid, interval);
drop function if exists public.conv_record_delivery(uuid, text, text, text);
drop function if exists public._conv_json(public.chat_sessions);

drop trigger if exists trg_seq_assign on public.chat_messages;
drop trigger if exists trg_conv_message_event on public.chat_messages;
drop trigger if exists trg_guard_core_columns on public.chat_messages;
drop trigger if exists trg_guard_core_columns on public.chat_sessions;
drop trigger if exists trg_conv_session_created on public.chat_sessions;
drop trigger if exists trg_conv_session_closed on public.chat_sessions;
drop trigger if exists trg_conv_handoff_version on public.chat_sessions;

drop function if exists public.conv_assign_seq();
drop function if exists public.conv_log_message_event();
drop function if exists public.conv_log_session_created();
drop function if exists public.conv_log_session_closed();
drop function if exists public.conv_bump_version_on_handoff();
drop function if exists public.guard_conversation_core_columns();

drop index if exists public.chat_messages_session_seq_key;
drop index if exists public.chat_messages_session_external_id_key;
drop index if exists public.chat_sessions_active_thread_key;

delete from public.sie_settings
 where key in ('core_ingest_website', 'core_ingest_telegram', 'agent_runtime_enabled');
