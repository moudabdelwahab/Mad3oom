-- ============================================================================
-- 134_admin_fix_suggestions_wallet_workflows.sql
--   إصلاحات لوحة الإدارة (2026-11-25) — «صلح كل دول»:
--
--   • تثبيت انجراف الترحيلات: إعادة فحص 2026-11-25 أظهرت أن 134 جدولًا من
--     الشكل الحي (tests/fixtures/prod-shape/10_tables.sql) بلا CREATE TABLE
--     في migrations/ — لا 37 كما قدّر تدقيق اللوحات (الـ 37 كانت عدّ جداول
--     اللوحات الخمس فقط تقريبًا). هذا الترحيل يثبّت 125 منها بـ
--     CREATE TABLE IF NOT EXISTS حرفيًا من prod-shape، فلا يغيّر مخططًا حيًا
--     ولا يحذف بيانات، ولا يعيد إنشاء ما هو موجود أصلًا.
--
--   • المستثناة (9): جداول SIE الثمانية (sie_* و customer_sie_access*) —
--     ممنوع المساس بـ SIE إطلاقًا — و _pre_038_rollback (أثر تراجع قديم،
--     ليس جدولًا حيًا). و sie_admin_grants و sie_authority_audit لهما
--     CREATE TABLE أصلًا في 052 فلا حاجة لتثبيتهما.
--
--   • ما لم يُثبَّت عمدًا (انظر التقرير): القيود (FK/PK/CHECK) والفهارس
--     والمحفّزات وسياسات RLS لبقية الجداول — تطبيقها على قاعدة حية قد
--     يفشل على بيانات قائمة، وبعضها يشير لدوال/جداول منجرفة هي نفسها؛
--     الشكل الكامل المرجعي يبقى في tests/fixtures/prod-shape/. الاستثناء:
--     سياسات جداول سير العمل و rules_engine (قسم 6) لأن زر «حفظ ونشر»
--     يعتمد عليها، وسياسات suggestions (قسم 3).
--
--   • جدول suggestions جديد (قسم 3) من حقول suggestions-service.js و
--     admin/suggestions.html الفعلية، مع RLS: إدخال للمستخدمين أنفسهم،
--     وقراءة/تعديل/حذف للأدمن فقط (is_admin() من 027/040).
--
--   • دوال المحفظة المركزية واختبار تيليجرام (قسم 4) ودوال سير العمل
--     (قسم 5) منسوخة حرفيًا من prod-shape — نفس التوقيع والسلوك الذي
--     تستدعيه الواجهة، بلا أي تغيير سلوكي، باستثناء إصلاح واحد موثّق
--     في create_workflow_draft_version (انظر القسم 5): السجل v_source
--     بلا تعيين عند p_from_version_id ‏NULL كان يُسقط الدالة، وهو مسار
--     النشر الأول لأي تدفق جديد.
--
-- يعتمد على: is_admin() من 027/040، و wf_is_admin()/wf_is_staff() من
-- 117 و 027/035، و auth.users. قابل لإعادة التشغيل (IF NOT EXISTS +
-- CREATE OR REPLACE + DROP POLICY IF EXISTS). لا يمسّ مسارات الدفع ولا SIE.
-- التراجع: migrations/_rollback/134_admin_fix_suggestions_wallet_workflows.down.sql
--   (يحذف الدوال الجديدة وجدول suggestions فقط؛ الجداول المثبّتة لا تُحذف).
-- ============================================================================


-- ============================================================================
-- 1) التسلسلات التي تعتمد عليها الجداول المثبّتة (من 05_sequences.sql حرفيًا)
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS public.ticket_number_seq AS bigint START 1001 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.conversations_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.suggested_questions_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.work_hours_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.ratings_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.oauth_rate_limit_hits_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.integration_request_logs_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.subscription_audit_log_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.owner_context_audit_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.privileged_audit_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE IF NOT EXISTS public.inbox_events_id_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;

-- ============================================================================
-- 2) تثبيت الجداول المفقودة من الترحيلات (125 جدولًا، من 10_tables.sql حرفيًا
--    مع IF NOT EXISTS فقط — لا يغيّر مخططًا حيًا ولا يحذف بيانات)
-- ============================================================================
create table if not exists public.activity_logs (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, action text NOT NULL, details jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), ip_address text, user_agent text, device_info text, location_info jsonb, session_duration integer, user_role text);
create table if not exists public.admin_telegram_otps (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, otp_hash text NOT NULL, attempts integer DEFAULT 0, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), ip_address text, user_agent text, is_used boolean DEFAULT false);
create table if not exists public.ads_settings (id uuid DEFAULT gen_random_uuid() NOT NULL, enabled boolean DEFAULT false, content text, link text, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.advanced_settings (id uuid DEFAULT gen_random_uuid() NOT NULL, key text NOT NULL, value jsonb NOT NULL, description text, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.ai_agents (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, slug text NOT NULL, description text, type text DEFAULT 'custom'::text NOT NULL, version text, status text DEFAULT 'stopped'::text NOT NULL, enabled boolean DEFAULT true NOT NULL, auto_start boolean DEFAULT false NOT NULL, auto_restart boolean DEFAULT false NOT NULL, connection_type text DEFAULT 'http'::text NOT NULL, protocol text, host text, port integer, endpoint text, health_endpoint text, api_key_encrypted text, api_key_last4 text, timeout_ms integer DEFAULT 10000 NOT NULL, retry_count integer DEFAULT 3 NOT NULL, retry_delay_ms integer DEFAULT 2000 NOT NULL, executable text, working_directory text, command_start text, command_stop text, command_restart text, health_check_interval integer DEFAULT 30 NOT NULL, last_heartbeat timestamp with time zone, last_error text, resources jsonb DEFAULT '[]'::jsonb NOT NULL, permissions jsonb DEFAULT '[]'::jsonb NOT NULL, environment_variables jsonb DEFAULT '[]'::jsonb NOT NULL, settings jsonb DEFAULT '{}'::jsonb NOT NULL, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.api_keys (id uuid DEFAULT gen_random_uuid() NOT NULL, openai_key text, telegram_token text, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.api_token_usage_logs (id uuid DEFAULT gen_random_uuid() NOT NULL, token_id uuid NOT NULL, user_id uuid NOT NULL, endpoint text, method text, status_code integer, ip_address text, user_agent text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.api_tokens (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, name text NOT NULL, description text, api_key text NOT NULL, secret_hash text NOT NULL, secret_last_four text NOT NULL, is_active boolean DEFAULT true NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, last_used_at timestamp with time zone, revoked_at timestamp with time zone, scopes jsonb DEFAULT '["tickets:read", "tickets:write", "whatsapp:send", "whatsapp:read", "chatbot:read"]'::jsonb NOT NULL, usage_count integer DEFAULT 0 NOT NULL, last_used_ip text, created_by_role text, expires_at timestamp with time zone, credential_type text DEFAULT 'api_key_secret'::text NOT NULL, bearer_token_hash text, bearer_last_four text, credential_group_id uuid);
create table if not exists public.aqar_admin_audit_log (id uuid DEFAULT gen_random_uuid() NOT NULL, actor_user_id uuid, actor_email text, target_user_id uuid, action text NOT NULL, phone_number_id text, previous_state jsonb, new_state jsonb, reason text, outcome text DEFAULT 'success'::text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.badge_definitions (id uuid DEFAULT gen_random_uuid() NOT NULL, key text NOT NULL, name text NOT NULL, description text NOT NULL, icon text DEFAULT '🏆'::text NOT NULL, criteria_type text NOT NULL, criteria_value jsonb DEFAULT '{}'::jsonb NOT NULL, sort_order integer DEFAULT 100 NOT NULL, is_active boolean DEFAULT true NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.board (id text DEFAULT 'main'::text NOT NULL, data jsonb DEFAULT '{}'::jsonb NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.bot_api_keys (id uuid DEFAULT gen_random_uuid() NOT NULL, key_value text NOT NULL, name text NOT NULL, website_url text, status text DEFAULT 'active'::text, permissions jsonb DEFAULT '["chat:send", "memory:read"]'::jsonb, created_at timestamp with time zone DEFAULT now(), last_used_at timestamp with time zone, created_by uuid, allowed_domains text[] DEFAULT '{}'::text[], platform_binding text, hmac_enabled boolean DEFAULT false, description text);
create table if not exists public.bot_settings (id uuid DEFAULT gen_random_uuid() NOT NULL, is_enabled boolean DEFAULT true, welcome_message text DEFAULT 'أهلاً بك! كيف يمكننا مساعدتك اليوم؟'::text, ticket_confirmation_message text DEFAULT 'تم فتح تذكرة دعم وسيتم التواصل معك قريبًا.'::text, trigger_keywords text[] DEFAULT ARRAY['مشكلة'::text, 'عطل'::text, 'مش شغال'::text, 'problem'::text, 'issue'::text, 'help'::text], response_delay_seconds integer DEFAULT 2, response_frequency text DEFAULT 'once'::text, advanced_first_chat_only boolean DEFAULT true, advanced_ignore_if_support_online boolean DEFAULT false, advanced_prevent_duplicate_tickets boolean DEFAULT true, updated_at timestamp with time zone DEFAULT now(), custom_replies jsonb DEFAULT '[]'::jsonb, auto_manual_on_admin_reply boolean DEFAULT true, smart_memory_enabled boolean DEFAULT false, system_prompt text, bot_enabled boolean DEFAULT true, ticket_message text DEFAULT 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.'::text, keywords text[] DEFAULT '{}'::text[], user_id uuid, ai_enabled boolean DEFAULT false, ai_model character varying(50) DEFAULT 'gpt-3.5-turbo'::character varying, ai_temperature double precision DEFAULT 0.7, flow_settings jsonb DEFAULT '{}'::jsonb, ai_config jsonb DEFAULT '{"model": "gpt-3.5-turbo", "enabled": false, "max_tokens": 500, "temperature": 0.7}'::jsonb, automation_enabled boolean DEFAULT true, phone_number_id text, ai_integration_id uuid);
create table if not exists public.bot_user_states (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, phone_number character varying(20) NOT NULL, current_node_id character varying(50), context jsonb DEFAULT '{}'::jsonb, last_interaction timestamp with time zone DEFAULT now(), expires_at timestamp with time zone, last_inbound_message_at timestamp with time zone, flow_id character varying(100) DEFAULT 'default'::character varying);
create table if not exists public.canned_responses (id uuid DEFAULT gen_random_uuid() NOT NULL, title text NOT NULL, content text NOT NULL, category text, shortcut text, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.central_wallet (id uuid DEFAULT gen_random_uuid() NOT NULL, balance bigint DEFAULT 10000000, total_transferred bigint DEFAULT 0, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.central_wallet_transactions (id uuid DEFAULT gen_random_uuid() NOT NULL, admin_id uuid, target_user_id uuid, amount bigint NOT NULL, transaction_type text NOT NULL, previous_balance bigint, new_balance bigint, created_at timestamp with time zone DEFAULT now());
create table if not exists public.channel_identities (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, channel text NOT NULL, channel_user_id text NOT NULL, channel_chat_id text, display_name text, is_active boolean DEFAULT true NOT NULL, linked_at timestamp with time zone DEFAULT now() NOT NULL, last_seen_at timestamp with time zone);
create table if not exists public.channel_link_codes (code text NOT NULL, user_id uuid NOT NULL, channel text NOT NULL, expires_at timestamp with time zone NOT NULL, redeemed_at timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.channel_secrets (key text NOT NULL, value text NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.chat_ai_usage_counters (user_id uuid NOT NULL, window_start timestamp with time zone NOT NULL, ai_message_count integer DEFAULT 0 NOT NULL);
create table if not exists public.chat_engine_conversation_reviews (id uuid DEFAULT gen_random_uuid() NOT NULL, session_id uuid NOT NULL, status text DEFAULT 'unresolved'::text NOT NULL, corrected_scenario_id text, reviewed_by uuid, reviewed_at timestamp with time zone, notes text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.chat_engine_knowledge_entries (id uuid DEFAULT gen_random_uuid() NOT NULL, knowledge_key text NOT NULL, version integer DEFAULT 1 NOT NULL, status text DEFAULT 'draft'::text NOT NULL, content jsonb NOT NULL, notes text, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, published_at timestamp with time zone);
create table if not exists public.chat_engine_publish_overrides (id uuid DEFAULT gen_random_uuid() NOT NULL, validation_run_id uuid, target_type text NOT NULL, target_key text NOT NULL, overridden_by uuid, reason text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.chat_engine_scenarios (id uuid DEFAULT gen_random_uuid() NOT NULL, scenario_key text NOT NULL, version integer DEFAULT 1 NOT NULL, status text DEFAULT 'draft'::text NOT NULL, definition jsonb NOT NULL, notes text, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, published_at timestamp with time zone);
create table if not exists public.chat_engine_trace_events (id uuid DEFAULT gen_random_uuid() NOT NULL, session_id uuid, turn integer NOT NULL, response_language text, normalized_tokens jsonb, hypotheses jsonb, ranking jsonb, decision jsonb, knowledge_data jsonb, rendered jsonb, action_result jsonb, processing_time_ms integer, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.chat_engine_validation_runs (id uuid DEFAULT gen_random_uuid() NOT NULL, run_type text NOT NULL, target_type text NOT NULL, target_key text NOT NULL, before_version integer, after_version integer, conversation_count integer DEFAULT 0 NOT NULL, summary jsonb NOT NULL, details jsonb, pass_fail text NOT NULL, publish_recommendation text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.chat_messages (id uuid DEFAULT gen_random_uuid() NOT NULL, session_id uuid, sender_id uuid, message_text text NOT NULL, is_bot_reply boolean DEFAULT false, created_at timestamp with time zone DEFAULT now(), is_admin_reply boolean DEFAULT false, image_url text, audio_url text, attachment jsonb, edited_at timestamp with time zone, deleted_at timestamp with time zone);
create table if not exists public.chat_sessions (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, status text DEFAULT 'active'::text, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), guest_id text, is_manual_mode boolean DEFAULT false, bot_state jsonb DEFAULT '{}'::jsonb NOT NULL);
create table if not exists public.chatbot_memory (id uuid DEFAULT gen_random_uuid() NOT NULL, conversation_id uuid, user_message text NOT NULL, admin_reply text NOT NULL, created_at timestamp with time zone DEFAULT now());
create table if not exists public.community_comments (id uuid DEFAULT gen_random_uuid() NOT NULL, post_id uuid, user_id uuid, content text NOT NULL, created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL);
create table if not exists public.community_likes (id uuid DEFAULT gen_random_uuid() NOT NULL, post_id uuid, user_id uuid, created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL);
create table if not exists public.community_posts (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, content text NOT NULL, image_url text, created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL, updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL);
create table if not exists public.companies (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, company_name character varying(255) NOT NULL, commercial_registration_number character varying(100) NOT NULL, company_email character varying(320), company_phone character varying(20), address text, city character varying(100), country character varying(100), website character varying(255), industry character varying(100), employee_count character varying(50), tax_id character varying(100), created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), commercial_registration_expiry date, status text DEFAULT 'active'::text NOT NULL);
create table if not exists public.conversations (id bigint DEFAULT nextval('conversations_id_seq'::regclass) NOT NULL, user_id uuid NOT NULL, admin_id uuid, status text DEFAULT 'active'::text NOT NULL, subject text, is_outside_work_hours boolean DEFAULT false NOT NULL, customer_name character varying(255), customer_phone character varying(20), customer_email character varying(320), created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL, closed_at timestamp with time zone);
create table if not exists public.custom_roles (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, description text, permissions jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.customer_badges (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, badge_id uuid NOT NULL, earned_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.customer_notes (id uuid DEFAULT gen_random_uuid() NOT NULL, customer_id uuid NOT NULL, admin_id uuid, note text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.customer_subscriptions (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, plan_id uuid NOT NULL, status text DEFAULT 'active'::text NOT NULL, start_date timestamp with time zone DEFAULT now() NOT NULL, end_date timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.customer_telegram_bots (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, bot_token text NOT NULL, bot_username text NOT NULL, chat_id text, webhook_secret text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL, is_active boolean DEFAULT true NOT NULL, connected_at timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.email_lookup_rate_limits (bucket_key text NOT NULL, count integer DEFAULT 0 NOT NULL, window_start timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.external_integration_models (id uuid DEFAULT gen_random_uuid() NOT NULL, integration_id uuid NOT NULL, model_id text NOT NULL, display_name text, supports_chat boolean DEFAULT true NOT NULL, supports_vision boolean DEFAULT false NOT NULL, supports_tools boolean DEFAULT false NOT NULL, supports_streaming boolean DEFAULT false NOT NULL, context_window integer, max_output_tokens integer, input_price numeric, output_price numeric, is_default boolean DEFAULT false NOT NULL, is_enabled boolean DEFAULT true NOT NULL, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, discovered_at timestamp with time zone DEFAULT now() NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, supports_reasoning boolean DEFAULT false NOT NULL, supports_coding boolean DEFAULT false NOT NULL, supports_agent boolean DEFAULT false NOT NULL, supports_long_context boolean DEFAULT false NOT NULL, supports_audio boolean DEFAULT false NOT NULL, category text DEFAULT 'general'::text NOT NULL, capabilities jsonb DEFAULT '{}'::jsonb NOT NULL, capabilities_source text DEFAULT 'heuristic'::text NOT NULL, notes text);
create table if not exists public.external_integrations (id uuid DEFAULT gen_random_uuid() NOT NULL, owner_id uuid, owner_scope text DEFAULT 'platform'::text NOT NULL, provider text NOT NULL, display_name text NOT NULL, credentials_encrypted text, credentials_meta jsonb DEFAULT '{}'::jsonb NOT NULL, is_active boolean DEFAULT true NOT NULL, last_tested_at timestamp with time zone, last_test_status text, last_test_message text, last_used_at timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, priority integer DEFAULT 100 NOT NULL, protocol text, base_url text, capabilities_override jsonb DEFAULT '{}'::jsonb NOT NULL, tags text[] DEFAULT '{}'::text[] NOT NULL, base_urls jsonb DEFAULT '{}'::jsonb NOT NULL);
create table if not exists public.feature_flags (key text NOT NULL, name text NOT NULL, name_ar text, description text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.flow_analytics_events (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, phone_number character varying(20) NOT NULL, flow_id character varying(100) NOT NULL, node_id character varying(100), node_type character varying(50), event_type character varying(50) NOT NULL, duration_ms integer, success boolean, error_message text, total_duration_ms integer, nodes_visited integer, condition character varying(255), result boolean, button_text character varying(255), metadata jsonb DEFAULT '{}'::jsonb, "timestamp" timestamp with time zone DEFAULT now());
create table if not exists public.flow_templates (id uuid DEFAULT gen_random_uuid() NOT NULL, name character varying(100) NOT NULL, name_ar character varying(100) NOT NULL, description text, description_ar text, category character varying(50) NOT NULL, flow_data jsonb NOT NULL, preview_image_url text, is_public boolean DEFAULT true, is_featured boolean DEFAULT false, usage_count integer DEFAULT 0, rating numeric(3,2) DEFAULT 0.00, created_by uuid, tags text[] DEFAULT '{}'::text[], created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_categories (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, description text, icon text, slug text NOT NULL, display_order integer DEFAULT 0, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_likes (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, thread_id uuid, reply_id uuid, created_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_mentions (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, thread_id uuid, reply_id uuid, created_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_notifications (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, type text NOT NULL, thread_id uuid, reply_id uuid, actor_id uuid, is_read boolean DEFAULT false, created_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_replies (id uuid DEFAULT gen_random_uuid() NOT NULL, thread_id uuid, author_id uuid, content text NOT NULL, parent_id uuid, is_edited boolean DEFAULT false, edit_history jsonb DEFAULT '[]'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_reports (id uuid DEFAULT gen_random_uuid() NOT NULL, reporter_id uuid, thread_id uuid, reply_id uuid, reason text NOT NULL, status text DEFAULT 'pending'::text, created_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_subforums (id uuid DEFAULT gen_random_uuid() NOT NULL, category_id uuid, name text NOT NULL, description text, slug text NOT NULL, display_order integer DEFAULT 0, threads_count integer DEFAULT 0, posts_count integer DEFAULT 0, last_activity_at timestamp with time zone DEFAULT now(), created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.forum_threads (id uuid DEFAULT gen_random_uuid() NOT NULL, subforum_id uuid, author_id uuid, title text NOT NULL, content text NOT NULL, slug text NOT NULL, is_pinned boolean DEFAULT false, is_locked boolean DEFAULT false, views_count integer DEFAULT 0, replies_count integer DEFAULT 0, tags text[], last_post_at timestamp with time zone DEFAULT now(), created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.individuals (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, first_name character varying(100) NOT NULL, last_name character varying(100) NOT NULL, date_of_birth date, national_id character varying(50), address text, city character varying(100), country character varying(100), gender text, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.integration_api_keys (id uuid DEFAULT gen_random_uuid() NOT NULL, client_id uuid NOT NULL, name text NOT NULL, environment text DEFAULT 'live'::text NOT NULL, key_prefix text NOT NULL, key_last4 text NOT NULL, key_hash text NOT NULL, scopes jsonb DEFAULT '["messages:send"]'::jsonb NOT NULL, status text DEFAULT 'active'::text NOT NULL, expires_at timestamp with time zone, last_used_at timestamp with time zone, revoked_at timestamp with time zone, rotated_from uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid);
create table if not exists public.integration_clients (id uuid DEFAULT gen_random_uuid() NOT NULL, slug text NOT NULL, name text NOT NULL, owner_user_id uuid NOT NULL, status text DEFAULT 'active'::text NOT NULL, channel_phone_number_id text, allowed_templates jsonb, rate_limit_per_minute integer, rate_limit_burst integer, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid);
create table if not exists public.integration_message_requests (id uuid DEFAULT gen_random_uuid() NOT NULL, client_id uuid NOT NULL, api_key_id uuid, idempotency_key text NOT NULL, request_hash text NOT NULL, environment text DEFAULT 'live'::text NOT NULL, template_key text, recipient_masked text, status text DEFAULT 'processing'::text NOT NULL, message_id text, provider_message_id text, error_code text, response_snapshot jsonb, created_at timestamp with time zone DEFAULT now() NOT NULL, completed_at timestamp with time zone);
create table if not exists public.integration_request_logs (id bigint DEFAULT nextval('integration_request_logs_id_seq'::regclass) NOT NULL, request_id text NOT NULL, client_id uuid, api_key_id uuid, environment text, method text NOT NULL, path text NOT NULL, stage text, template_key text, idempotency_key text, recipient_masked text, status_code integer NOT NULL, error_code text, duration_ms integer, details jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.integration_settings (key text NOT NULL, value jsonb NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid);
create table if not exists public.integration_templates (id uuid DEFAULT gen_random_uuid() NOT NULL, template_key text NOT NULL, owner_user_id uuid, channel text DEFAULT 'whatsapp'::text NOT NULL, language text DEFAULT 'ar'::text NOT NULL, category text DEFAULT 'utility'::text NOT NULL, required_variables text[] DEFAULT '{}'::text[] NOT NULL, optional_variables text[] DEFAULT '{}'::text[] NOT NULL, provider text DEFAULT 'meta_cloud'::text NOT NULL, provider_template_name text, provider_language_code text, body_variable_order text[] DEFAULT '{}'::text[] NOT NULL, status text DEFAULT 'draft'::text NOT NULL, description text, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.integrations (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, provider text, access_token text, token_type text, expires_in bigint, metadata jsonb, created_at timestamp with time zone DEFAULT now(), phone text, channel_id text, encrypted_access_token text, encrypted_verification_pin text);
create table if not exists public.internal_service_secrets (key text NOT NULL, value text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.landing_config (key text NOT NULL, value text DEFAULT ''::text NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.landing_leads (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, phone text NOT NULL, email text NOT NULL, service text DEFAULT ''::text NOT NULL, message text DEFAULT ''::text NOT NULL, status text DEFAULT 'new'::text NOT NULL, source text DEFAULT 'landing'::text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.landing_services (id uuid DEFAULT gen_random_uuid() NOT NULL, title text NOT NULL, description text NOT NULL, long_description text DEFAULT ''::text NOT NULL, link text DEFAULT ''::text NOT NULL, features jsonb DEFAULT '[]'::jsonb NOT NULL, icon text DEFAULT 'i-box'::text NOT NULL, color text DEFAULT 'violet'::text NOT NULL, status text DEFAULT 'active'::text NOT NULL, sort_order integer DEFAULT 0 NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.mailbox_emails (id uuid DEFAULT gen_random_uuid() NOT NULL, direction text NOT NULL, from_email text NOT NULL, to_email text NOT NULL, subject text, html_body text, text_body text, status text DEFAULT 'sent'::text NOT NULL, provider_message_id text, attachments jsonb DEFAULT '[]'::jsonb NOT NULL, related_user_id uuid, is_read boolean DEFAULT false NOT NULL, error_message text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.mcp_server_connections (id uuid DEFAULT gen_random_uuid() NOT NULL, server_id uuid NOT NULL, owner_id uuid NOT NULL, auth_type text DEFAULT 'none'::text NOT NULL, api_key_encrypted text, api_secret_encrypted text, bearer_token_encrypted text, custom_config_encrypted text, oauth_client_id text, oauth_client_secret_encrypted text, oauth_authorize_url text, oauth_token_url text, oauth_scope text, oauth_access_token_encrypted text, oauth_refresh_token_encrypted text, oauth_token_expires_at timestamp with time zone, oauth_state text, status text DEFAULT 'pending'::text NOT NULL, tools jsonb DEFAULT '[]'::jsonb NOT NULL, last_checked_at timestamp with time zone, last_error text, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.mcp_servers (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, transport text DEFAULT 'streamable_http'::text NOT NULL, url text, command text, args jsonb DEFAULT '[]'::jsonb NOT NULL, env jsonb DEFAULT '{}'::jsonb NOT NULL, headers jsonb DEFAULT '{}'::jsonb NOT NULL, description text DEFAULT ''::text NOT NULL, category text DEFAULT 'general'::text NOT NULL, enabled boolean DEFAULT true NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, connector_type text DEFAULT 'mcp_server'::text NOT NULL, owner_id uuid NOT NULL);
create table if not exists public.mcp_tools_catalog (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, scope text NOT NULL, description text NOT NULL, input_schema jsonb DEFAULT '{}'::jsonb NOT NULL, sort_order integer DEFAULT 0 NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.memory_firewall_rules (id uuid DEFAULT gen_random_uuid() NOT NULL, rule_type text NOT NULL, rule_value text, description text, is_active boolean DEFAULT true, created_at timestamp with time zone DEFAULT now());
create table if not exists public.messages (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, from_number text, to_number text, message_text text, message_type text DEFAULT 'text'::text, direction text DEFAULT 'inbound'::text, status text DEFAULT 'received'::text, waba_id text, "timestamp" timestamp with time zone DEFAULT now(), raw_data jsonb, created_at timestamp with time zone DEFAULT now(), read_at timestamp with time zone, client_id uuid, delivery_status text DEFAULT 'sent'::text, is_read boolean DEFAULT false, sender_type text DEFAULT 'user'::text, updated_at timestamp with time zone DEFAULT now(), file_name text, file_url text, file_size bigint, mime_type text, attachment_type text, wa_message_id text, uuid_id uuid DEFAULT gen_random_uuid(), contact_bsuid text, duplicate_of_id uuid);
create table if not exists public.notifications (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, title text NOT NULL, message text NOT NULL, type text DEFAULT 'info'::text, is_read boolean DEFAULT false, link text, created_at timestamp with time zone DEFAULT now(), reference_id uuid, category text, action text, action_target text, action_label text);
create table if not exists public.oauth_authorization_codes (id uuid DEFAULT gen_random_uuid() NOT NULL, code_hash text NOT NULL, client_id text NOT NULL, user_id uuid NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL, code_challenge_method text DEFAULT 'S256'::text NOT NULL, scope jsonb DEFAULT '[]'::jsonb NOT NULL, resource text, expires_at timestamp with time zone NOT NULL, used_at timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.oauth_client_registrations_log (id uuid DEFAULT gen_random_uuid() NOT NULL, client_id text, client_name text, redirect_uris jsonb, ip_address text, user_agent text, success boolean NOT NULL, error text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.oauth_clients (id uuid DEFAULT gen_random_uuid() NOT NULL, client_id text NOT NULL, client_secret_hash text, client_name text NOT NULL, redirect_uris jsonb DEFAULT '[]'::jsonb NOT NULL, grant_types jsonb DEFAULT '["authorization_code", "refresh_token"]'::jsonb NOT NULL, response_types jsonb DEFAULT '["code"]'::jsonb NOT NULL, token_endpoint_auth_method text DEFAULT 'none'::text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, created_via text DEFAULT 'dynamic_registration'::text NOT NULL, is_active boolean DEFAULT true NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.oauth_rate_limit_hits (id bigint DEFAULT nextval('oauth_rate_limit_hits_id_seq'::regclass) NOT NULL, endpoint text NOT NULL, identifier text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.oauth_refresh_tokens (id uuid DEFAULT gen_random_uuid() NOT NULL, token_hash text NOT NULL, client_id text NOT NULL, api_token_id uuid NOT NULL, user_id uuid NOT NULL, scope jsonb DEFAULT '[]'::jsonb NOT NULL, expires_at timestamp with time zone NOT NULL, revoked_at timestamp with time zone, rotated_from uuid, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.oauth_scopes (scope text NOT NULL, description_ar text NOT NULL, is_default boolean DEFAULT false NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.plan_features (plan_id uuid NOT NULL, feature_key text NOT NULL, enabled boolean DEFAULT true NOT NULL, limits jsonb DEFAULT '{}'::jsonb NOT NULL);
create table if not exists public.profiles (id uuid NOT NULL, email text, role text DEFAULT 'user'::text, created_at timestamp with time zone DEFAULT now(), full_name text, phone text, ban_status text DEFAULT 'none'::text, ban_until timestamp with time zone, ban_reason text, points integer DEFAULT 0, bio text, website text, two_factor_enabled boolean DEFAULT false, two_factor_secret text, recovery_codes text[], telegram_chat_id text, telegram_username text, telegram_otp_enabled boolean DEFAULT false, first_name text, last_name text, username text, last_password_change timestamp with time zone DEFAULT now(), failed_login_attempts integer DEFAULT 0, is_locked boolean DEFAULT false, mfa_enabled boolean DEFAULT false, custom_role_id uuid, user_type text DEFAULT 'individual'::text, date_of_birth date, gender text, address text, city character varying(100), country character varying(100), is_verified boolean DEFAULT false, updated_at timestamp with time zone DEFAULT now(), forum_posts_count integer DEFAULT 0, super_user_id uuid, whatsapp_enabled boolean DEFAULT false, pi_uid text, avatar_url text, telegram_alert_events text[] DEFAULT '{}'::text[], chatbot_mode text DEFAULT 'sie'::text NOT NULL, chatbot_selected_integration_id uuid, chatbot_selected_model_id text, aqar_enabled boolean DEFAULT false NOT NULL, whatsapp_phone text);
create table if not exists public.ratings (id bigint DEFAULT nextval('ratings_id_seq'::regclass) NOT NULL, conversation_id bigint NOT NULL, rating text NOT NULL, feedback text, created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL);
create table if not exists public.reward_activity_logs (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, activity_type text NOT NULL, details jsonb, created_at timestamp with time zone DEFAULT now());
create table if not exists public.rules_engine (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, trigger_event text NOT NULL, conditions jsonb DEFAULT '[]'::jsonb, actions jsonb DEFAULT '[]'::jsonb, is_active boolean DEFAULT true, priority integer DEFAULT 0, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.saved_ticket_filters (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, name text NOT NULL, filters jsonb NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.scheduled_messages (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, phone_number character varying(20) NOT NULL, message text NOT NULL, scheduled_at timestamp with time zone NOT NULL, status character varying(20) DEFAULT 'pending'::character varying, sent_at timestamp with time zone, whatsapp_message_id character varying(100), error_message text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.site_errors (id uuid DEFAULT gen_random_uuid() NOT NULL, type text NOT NULL, message text NOT NULL, stack_trace text, page_url text, file_name text, line_number integer, column_number integer, user_id uuid, user_agent text, status text DEFAULT 'new'::text, created_at timestamp with time zone DEFAULT now());
create table if not exists public.subdomain_activity_log (id uuid DEFAULT gen_random_uuid() NOT NULL, subdomain_id uuid, subdomain_name text NOT NULL, action text NOT NULL, performed_by uuid, performed_by_email text, target_client_id uuid, details jsonb, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.subdomain_request_queue (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, requested_name text NOT NULL, status text DEFAULT 'pending'::text NOT NULL, note text, reviewed_by uuid, reviewed_at timestamp with time zone, resulting_subdomain_id uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.subdomain_requests (id uuid DEFAULT gen_random_uuid() NOT NULL, subdomain text NOT NULL, full_domain text NOT NULL, status text DEFAULT 'pending'::text NOT NULL, cloudflare_record_id text, vercel_added boolean DEFAULT false, error_message text, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, user_id uuid, created_ip text, activated_at timestamp with time zone, deleted_at timestamp with time zone, last_action text, suspended_at timestamp with time zone, logo_url text);
create table if not exists public.subscription_plans (id uuid DEFAULT gen_random_uuid() NOT NULL, key text NOT NULL, name text NOT NULL, name_ar text, is_active boolean DEFAULT true NOT NULL, sort_order integer DEFAULT 100 NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL, requires_company boolean DEFAULT false NOT NULL, price_monthly numeric(14,2), price_yearly numeric(14,2), currency text DEFAULT 'USD'::text NOT NULL);
create table if not exists public.suggested_questions (id bigint DEFAULT nextval('suggested_questions_id_seq'::regclass) NOT NULL, question text NOT NULL, answer text NOT NULL, category character varying(100), is_active boolean DEFAULT true NOT NULL, created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL);
create table if not exists public.telegram_auth_logs (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, action text NOT NULL, ip_address text, user_agent text, details jsonb, created_at timestamp with time zone DEFAULT now());
create table if not exists public.ticket_activity (id uuid DEFAULT gen_random_uuid() NOT NULL, ticket_id uuid NOT NULL, actor_id uuid, action_type text NOT NULL, from_value text, to_value text, meta jsonb, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.ticket_attachments (id uuid DEFAULT gen_random_uuid() NOT NULL, ticket_id uuid NOT NULL, reply_id uuid, file_url text NOT NULL, file_name text, file_size bigint, mime_type text, uploaded_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, file_path text);
create table if not exists public.ticket_distribution_config (id uuid DEFAULT gen_random_uuid() NOT NULL, method text DEFAULT 'round_robin'::text, is_active boolean DEFAULT true, settings jsonb DEFAULT '{}'::jsonb, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.ticket_ratings (id uuid DEFAULT gen_random_uuid() NOT NULL, ticket_id uuid NOT NULL, user_id uuid, rating smallint NOT NULL, comment text, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.ticket_replies (id uuid DEFAULT gen_random_uuid() NOT NULL, ticket_id uuid NOT NULL, user_id uuid NOT NULL, message text NOT NULL, created_at timestamp with time zone DEFAULT now(), is_internal boolean DEFAULT false);
create table if not exists public.ticket_tag_links (ticket_id uuid NOT NULL, tag_id uuid NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.ticket_tags (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, color text DEFAULT '#4DA3FF'::text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.tickets (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, title text NOT NULL, description text NOT NULL, status text DEFAULT 'open'::text, priority text DEFAULT 'medium'::text, created_at timestamp with time zone DEFAULT now(), image_url text, ticket_number bigint DEFAULT nextval('ticket_number_seq'::regclass), archived_by_customer boolean DEFAULT false NOT NULL, archived_at timestamp with time zone, ticket_type text DEFAULT 'problem'::text NOT NULL, contact_info text, category text, assigned_to uuid, first_response_at timestamp with time zone, sla_alert_sent boolean DEFAULT false, subdomain_id uuid, last_updated_by uuid, last_updated_at timestamp with time zone, reopen_count integer DEFAULT 0 NOT NULL, last_reopened_at timestamp with time zone, resolved_at timestamp with time zone, sla_response_due_at timestamp with time zone, sla_resolution_due_at timestamp with time zone);
create table if not exists public.trusted_devices (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, device_name text NOT NULL, device_fingerprint text, last_login timestamp with time zone DEFAULT now(), created_at timestamp with time zone DEFAULT now(), trusted_until timestamp with time zone);
create table if not exists public.twofa_rate_limits (user_id uuid NOT NULL, failed_attempts integer DEFAULT 0 NOT NULL, window_start timestamp with time zone DEFAULT now() NOT NULL, locked_until timestamp with time zone);
create table if not exists public.user_reports (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, problem_type text NOT NULL, severity text NOT NULL, title text NOT NULL, description text NOT NULL, estimated_points integer DEFAULT 0, actual_points integer, status text DEFAULT 'pending'::text, rejection_reason text, approved_at timestamp with time zone, created_at timestamp with time zone DEFAULT now());
create table if not exists public.user_wallets (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, total_points integer DEFAULT 0, available_points integer DEFAULT 0, pending_points integer DEFAULT 0, membership_level text DEFAULT 'عضو جديد'::text, is_pro boolean DEFAULT false, pro_badge_earned_at timestamp with time zone, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), is_frozen boolean DEFAULT false);
create table if not exists public.webhook_deliveries (id uuid DEFAULT gen_random_uuid() NOT NULL, webhook_id uuid, event text NOT NULL, payload jsonb, status_code integer, success boolean, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.webhooks (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, url text NOT NULL, events text[] DEFAULT '{}'::text[] NOT NULL, secret text NOT NULL, is_active boolean DEFAULT true NOT NULL, last_triggered_at timestamp with time zone, last_status text, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.wf_leads (id uuid DEFAULT gen_random_uuid() NOT NULL, name text, phone text, email text, source text DEFAULT 'workflow'::text, status text DEFAULT 'new'::text NOT NULL, tags text[] DEFAULT '{}'::text[], notes text, workflow_run_id uuid, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
create table if not exists public.wf_node_types (id uuid DEFAULT gen_random_uuid() NOT NULL, key text NOT NULL, category text NOT NULL, name_en text NOT NULL, name_ar text NOT NULL, description text, icon text DEFAULT '⚙️'::text, color text DEFAULT '#4DA3FF'::text, config_schema jsonb DEFAULT '{}'::jsonb NOT NULL, output_vars jsonb DEFAULT '[]'::jsonb NOT NULL, is_active boolean DEFAULT true, sort_order integer DEFAULT 0, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), source text DEFAULT 'core'::text NOT NULL, owner_id uuid, handler_type text, handler_ref text);
create table if not exists public.wf_run_steps (id uuid DEFAULT gen_random_uuid() NOT NULL, run_id uuid NOT NULL, node_id text NOT NULL, node_key text NOT NULL, status text DEFAULT 'running'::text NOT NULL, input jsonb DEFAULT '{}'::jsonb, output jsonb DEFAULT '{}'::jsonb, error text, started_at timestamp with time zone DEFAULT now(), finished_at timestamp with time zone, duration_ms integer, attempt integer DEFAULT 1 NOT NULL, max_attempts integer DEFAULT 1 NOT NULL);
create table if not exists public.wf_runs (id uuid DEFAULT gen_random_uuid() NOT NULL, workflow_id uuid NOT NULL, trigger_event_key text, trigger_payload jsonb DEFAULT '{}'::jsonb, status text DEFAULT 'pending'::text NOT NULL, context jsonb DEFAULT '{}'::jsonb NOT NULL, current_node_id text, error text, started_at timestamp with time zone DEFAULT now(), finished_at timestamp with time zone, created_at timestamp with time zone DEFAULT now(), correlation_id text, idempotency_key text, workflow_version_id uuid, workflow_version_number integer);
create table if not exists public.wf_scheduled_resumes (id uuid DEFAULT gen_random_uuid() NOT NULL, run_id uuid NOT NULL, resume_node_id text NOT NULL, resume_at timestamp with time zone NOT NULL, status text DEFAULT 'pending'::text NOT NULL, created_at timestamp with time zone DEFAULT now());
create table if not exists public.wf_variables (key text NOT NULL, value jsonb DEFAULT '{}'::jsonb NOT NULL, description text, updated_at timestamp with time zone DEFAULT now());
create table if not exists public.wf_webhook_endpoints (id uuid DEFAULT gen_random_uuid() NOT NULL, workflow_id uuid NOT NULL, slug text NOT NULL, secret text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL, is_active boolean DEFAULT true, created_at timestamp with time zone DEFAULT now());
create table if not exists public.wf_workflow_versions (id uuid DEFAULT gen_random_uuid() NOT NULL, workflow_id uuid NOT NULL, version_number integer NOT NULL, status text DEFAULT 'draft'::text NOT NULL, definition jsonb DEFAULT '{"edges": [], "nodes": []}'::jsonb NOT NULL, trigger_event_key text, trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL, variables jsonb DEFAULT '{}'::jsonb NOT NULL, change_note text, created_by uuid, created_at timestamp with time zone DEFAULT now(), published_at timestamp with time zone);
create table if not exists public.wf_workflows (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, description text, status text DEFAULT 'draft'::text NOT NULL, trigger_event_key text, trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL, is_active boolean DEFAULT true NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), published_version_id uuid, current_draft_version_id uuid, max_runs_per_hour integer);
create table if not exists public.whatsapp_billing_admins (email text NOT NULL, added_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, user_id uuid);
create table if not exists public.whatsapp_campaign_reports (id uuid DEFAULT gen_random_uuid() NOT NULL, campaign_id uuid, recipient text NOT NULL, status text NOT NULL, error_message text, sent_at timestamp with time zone DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb);
create table if not exists public.whatsapp_campaigns (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid, name text NOT NULL, template_name text, language_code text, total_recipients integer DEFAULT 0, success_count integer DEFAULT 0, fail_count integer DEFAULT 0, status text DEFAULT 'completed'::text, created_at timestamp with time zone DEFAULT now());
create table if not exists public.whatsapp_subscriptions (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, ticket_id uuid, status text DEFAULT 'active'::text, billing_cycle text, start_date timestamp with time zone DEFAULT now(), end_date timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), plan text DEFAULT 'whatsapp'::text NOT NULL, rejection_reason text, is_renewal boolean DEFAULT false NOT NULL, duration_days integer, previous_end_date timestamp with time zone, reviewed_by uuid, reviewed_at timestamp with time zone, payment_method text, payment_reference text, company_id uuid, upgraded_from_subscription_id uuid, upgrade_amount numeric(14,2), price_snapshot jsonb);
create table if not exists public.whatsapp_wallet_topup_requests (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, ticket_id uuid, amount numeric(12,2) NOT NULL, currency text DEFAULT 'EGP'::text NOT NULL, payment_method text, payment_reference text, status text DEFAULT 'pending'::text NOT NULL, rejection_reason text, reviewed_by uuid, reviewed_at timestamp with time zone, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.whatsapp_wallet_transactions (id uuid DEFAULT gen_random_uuid() NOT NULL, wallet_id uuid NOT NULL, user_id uuid NOT NULL, amount numeric(12,2) NOT NULL, balance_before numeric(12,2) NOT NULL, balance_after numeric(12,2) NOT NULL, transaction_type text NOT NULL, description text, ticket_id uuid, performed_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.whatsapp_wallets (id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, balance numeric(12,2) DEFAULT 0 NOT NULL, currency text DEFAULT 'EGP'::text NOT NULL, low_balance_threshold numeric(12,2) DEFAULT 20 NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
create table if not exists public.work_hours (id bigint DEFAULT nextval('work_hours_id_seq'::regclass) NOT NULL, day_of_week integer NOT NULL, start_time character varying(5) NOT NULL, end_time character varying(5) NOT NULL, is_work_day boolean DEFAULT true NOT NULL, created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL);
create table if not exists public.working_hours (id uuid DEFAULT gen_random_uuid() NOT NULL, day_of_week integer NOT NULL, is_working_day boolean DEFAULT true, start_time time without time zone, end_time time without time zone, auto_reply_text text, transfer_to_bot boolean DEFAULT false, updated_at timestamp with time zone DEFAULT now());

-- ============================================================================
-- 3) جدول suggestions — من حقول suggestions-service.js و admin/suggestions.html:
--    submitSuggestion تُدخل (user_id, title, description, category, status)
--    و fetchSuggestions تقرأ (*, profiles(full_name, email)) مرتبة بالأحدث،
--    والصفحة تعرض حالات pending/reviewed/implemented وتصنيفات
--    feature/improvement/design/other (والافتراضي 'general' في الخدمة).
--    ملحوظة: الربط profiles(full_name, email) في PostgREST يتطلب مفتاحًا
--    أجنبيًا، والمفتاح الأجنبي يتطلب قيدًا فريدًا على profiles(id) —
--    والمفتاح الأساسي لـ profiles معرّف في 20_constraints.sql لا في
--    الترحيلات، فيُنشأ هنا إن كان غائبًا فقط (حيًا هو موجود أصلًا).
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_pkey') then
    alter table public.profiles add constraint profiles_pkey primary key (id);
  end if;
end $$;

create table if not exists public.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  title text not null,
  description text,
  category text not null default 'general'
    check (category in ('general', 'feature', 'improvement', 'design', 'other')),
  status text not null default 'pending'
    check (status in ('pending', 'reviewed', 'implemented')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists suggestions_user_id_idx on public.suggestions (user_id);
create index if not exists suggestions_status_created_idx on public.suggestions (status, created_at desc);

alter table public.suggestions enable row level security;
-- الإدخال: المستخدم لنفسه فقط (submitSuggestion)؛ القراءة/التعديل/الحذف: أدمن فقط.
drop policy if exists "suggestions_insert_own" on public.suggestions;
create policy "suggestions_insert_own" on public.suggestions as permissive
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "suggestions_select_admin" on public.suggestions;
create policy "suggestions_select_admin" on public.suggestions as permissive
  for select to authenticated using (public.is_admin());
drop policy if exists "suggestions_update_admin" on public.suggestions;
create policy "suggestions_update_admin" on public.suggestions as permissive
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "suggestions_delete_admin" on public.suggestions;
create policy "suggestions_delete_admin" on public.suggestions as permissive
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- 3.5) قيد تعتمد عليه دوال المحفظة: transfer_points_from_central تستخدم
--    ON CONFLICT (user_id) على user_wallets، والقيد الفريد حيًا موجود
--    (user_wallets_user_id_key في 20_constraints.sql) لكنه بلا أي تعريف
--    في migrations/. يُنشأ هنا إن كان غائبًا فقط — حيًا لا يفعل شيئًا.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_wallets_user_id_key') then
    alter table public.user_wallets add constraint user_wallets_user_id_key unique (user_id);
  end if;
end $$;

-- ============================================================================
-- 4) دوال المحفظة المركزية واختبار تيليجرام (من 50/51/52_functions حرفيًا —
--    نفس التوقيع والسلوك الذي تستدعيه central-wallet*.js و users.js و settings.js)
--    ملحوظة: النسخة الحية تقيّد manage/transfer ببريد JWT = support@mad3oom.online
--    حرفيًا (لا can_manage_central_wallet) — أُبقيت كما هي لأن الواجهة تعتمد عليها.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.send_telegram_message(p_chat_id text, p_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token text;
BEGIN
  SELECT telegram_token INTO v_token FROM public.api_keys LIMIT 1;
  IF v_token IS NULL OR v_token = '' OR p_chat_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat_id, 'text', p_message, 'parse_mode', 'HTML')
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    admin_uid UUID;
    current_balance BIGINT;
    new_balance BIGINT;
    transaction_id UUID;
BEGIN
    admin_uid := auth.uid();

    IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF action_type NOT IN ('add', 'deduct', 'freeze', 'unfreeze') THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'نوع العملية غير صحيح',
            'error_code', 'INVALID_ACTION'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT available_points INTO current_balance
    FROM user_wallets
    WHERE user_id = target_uid;

    IF current_balance IS NULL THEN
        current_balance := 0;
    END IF;

    IF action_type = 'add' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        UPDATE user_wallets
        SET available_points = available_points + amount_change,
            total_points = total_points + amount_change,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance + amount_change;

    ELSIF action_type = 'deduct' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        IF current_balance < amount_change THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'رصيد العميل غير كافٍ. الرصيد الحالي: ' || current_balance,
                'error_code', 'INSUFFICIENT_BALANCE',
                'current_balance', current_balance
            );
        END IF;

        UPDATE user_wallets
        SET available_points = GREATEST(0, available_points - amount_change),
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := GREATEST(0, current_balance - amount_change);

    ELSIF action_type = 'freeze' THEN
        UPDATE user_wallets
        SET is_frozen = TRUE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;

    ELSIF action_type = 'unfreeze' THEN
        UPDATE user_wallets
        SET is_frozen = FALSE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_change,
        action_type,
        current_balance,
        new_balance,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تمت العملية بنجاح',
        'transaction_id', transaction_id,
        'action_type', action_type,
        'amount', amount_change,
        'user_email', target_user_email,
        'previous_balance', current_balance,
        'new_balance', new_balance
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_points_from_central(target_user_email text, amount_to_transfer bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    current_central_balance BIGINT;
    admin_uid UUID;
    transaction_id UUID;
    user_wallet_before BIGINT;
    user_wallet_after BIGINT;
BEGIN
    admin_uid := auth.uid();

    IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF amount_to_transfer IS NULL OR amount_to_transfer <= 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'يجب أن يكون عدد النقاط أكبر من صفر',
            'error_code', 'INVALID_AMOUNT'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT balance INTO current_central_balance FROM central_wallet LIMIT 1;

    IF current_central_balance IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المحفظة المركزية غير موجودة',
            'error_code', 'WALLET_NOT_FOUND'
        );
    END IF;

    IF current_central_balance < amount_to_transfer THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'رصيد المحفظة المركزية غير كافٍ. الرصيد الحالي: ' || current_central_balance,
            'error_code', 'INSUFFICIENT_BALANCE',
            'current_balance', current_central_balance
        );
    END IF;

    SELECT available_points INTO user_wallet_before
    FROM user_wallets
    WHERE user_id = target_uid;

    IF user_wallet_before IS NULL THEN
        user_wallet_before := 0;
    END IF;

    UPDATE central_wallet
    SET balance = balance - amount_to_transfer,
        total_transferred = total_transferred + amount_to_transfer,
        updated_at = NOW()
    WHERE id = (SELECT id FROM central_wallet LIMIT 1);

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'فشل تحديث المحفظة المركزية',
            'error_code', 'UPDATE_FAILED'
        );
    END IF;

    INSERT INTO user_wallets (user_id, available_points, total_points, created_at, updated_at)
    VALUES (target_uid, amount_to_transfer, amount_to_transfer, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET available_points = user_wallets.available_points + amount_to_transfer,
        total_points = user_wallets.total_points + amount_to_transfer,
        updated_at = NOW();

    SELECT available_points INTO user_wallet_after
    FROM user_wallets
    WHERE user_id = target_uid;

    IF user_wallet_after != (user_wallet_before + amount_to_transfer) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'فشل التحقق من تحديث محفظة العميل',
            'error_code', 'VERIFICATION_FAILED',
            'expected', user_wallet_before + amount_to_transfer,
            'actual', user_wallet_after
        );
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_to_transfer,
        'transfer',
        current_central_balance,
        current_central_balance - amount_to_transfer,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تم تحويل النقاط بنجاح',
        'transaction_id', transaction_id,
        'amount_transferred', amount_to_transfer,
        'user_email', target_user_email,
        'user_new_balance', user_wallet_after,
        'central_wallet_new_balance', current_central_balance - amount_to_transfer
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_test_telegram_alert()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chat_id text;
BEGIN
  SELECT telegram_chat_id INTO v_chat_id FROM public.profiles WHERE id = auth.uid();
  IF v_chat_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_telegram_linked');
  END IF;
  PERFORM public.send_telegram_message(v_chat_id, '✅ تم تفعيل تنبيهات تيليجرام بنجاح من لوحة إعدادات مدعوم.');
  RETURN jsonb_build_object('success', true);
END;
$function$
;

-- منح التنفيذ كما في 70_grants.sql حرفيًا:
REVOKE ALL ON FUNCTION public.send_telegram_message(p_chat_id text, p_message text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_telegram_message(p_chat_id text, p_message text) TO service_role;
REVOKE ALL ON FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text) TO service_role;
REVOKE ALL ON FUNCTION public.transfer_points_from_central(target_user_email text, amount_to_transfer bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transfer_points_from_central(target_user_email text, amount_to_transfer bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_points_from_central(target_user_email text, amount_to_transfer bigint) TO service_role;
REVOKE ALL ON FUNCTION public.send_test_telegram_alert() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_test_telegram_alert() TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_test_telegram_alert() TO service_role;

-- ============================================================================
-- 5) دوال سير العمل (من 50/51_functions حرفيًا — يعتمد عليها زر «حفظ ونشر»
--    في admin/automation.html، ولم يكن لها أي تعريف في migrations/)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid DEFAULT NULL::uuid, p_change_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_next_number INTEGER;
    v_new_id UUID;
    v_source RECORD;
BEGIN
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_number
    FROM wf_workflow_versions WHERE workflow_id = p_workflow_id;

    IF p_from_version_id IS NOT NULL THEN
        SELECT * INTO v_source FROM wf_workflow_versions WHERE id = p_from_version_id;
    ELSE
        -- إصلاح 134: السجل v_source بلا تعيين عند NULL كان يُسقط الدالة
        -- بخطأ «record is not assigned yet» — وهو مسار النشر الأول لأي
        -- تدفق جديد (publish_workflow يناديها بـ published_version_id
        -- ‏NULL). الصف الفارغ يجعل COALESCE يسلك مسار الافتراضيات كما قُصد.
        SELECT NULL::jsonb AS definition, NULL::text AS trigger_event_key,
               NULL::jsonb AS trigger_config, NULL::jsonb AS variables
          INTO v_source;
    END IF;

    INSERT INTO wf_workflow_versions (workflow_id, version_number, status, definition, trigger_event_key, trigger_config, variables, change_note, created_by)
    VALUES (
        p_workflow_id,
        v_next_number,
        'draft',
        COALESCE(v_source.definition, '{"nodes":[],"edges":[]}'::jsonb),
        v_source.trigger_event_key,
        COALESCE(v_source.trigger_config, '{}'::jsonb),
        COALESCE(v_source.variables, '{}'::jsonb),
        p_change_note,
        auth.uid()
    )
    RETURNING id INTO v_new_id;

    UPDATE wf_workflows SET current_draft_version_id = v_new_id, updated_at = now() WHERE id = p_workflow_id;

    RETURN v_new_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_draft_id UUID;
    v_published_id UUID;
BEGIN
    -- 1. Reuse an existing draft if one exists (never create a second draft)
    SELECT id INTO v_draft_id
    FROM wf_workflow_versions
    WHERE workflow_id = p_workflow_id AND status = 'draft'
    ORDER BY version_number DESC
    LIMIT 1;

    -- 2. No draft exists: create one. create_workflow_draft_version() computes
    --    version_number = MAX(version_number) + 1 over ALL versions (draft/published/
    --    archived), not "latest published + 1" -- so it can never collide with an
    --    existing row and never needs to guess based on status.
    IF v_draft_id IS NULL THEN
        SELECT published_version_id INTO v_published_id
        FROM wf_workflows WHERE id = p_workflow_id;

        v_draft_id := create_workflow_draft_version(p_workflow_id, v_published_id, p_change_note);
    END IF;

    -- 3. Publish it. This only UPDATEs the existing row's status -- it never inserts,
    --    so there is no version_number to collide with.
    PERFORM publish_workflow_version(v_draft_id);

    RETURN v_draft_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_workflow_version(p_version_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_workflow_id UUID;
    v_trigger_key TEXT;
    v_trigger_cfg JSONB;
BEGIN
    SELECT workflow_id, trigger_event_key, trigger_config
        INTO v_workflow_id, v_trigger_key, v_trigger_cfg
        FROM wf_workflow_versions WHERE id = p_version_id;

    IF v_workflow_id IS NULL THEN
        RAISE EXCEPTION 'Workflow version % not found', p_version_id;
    END IF;

    UPDATE wf_workflow_versions SET status = 'published', published_at = now()
        WHERE id = p_version_id;

    UPDATE wf_workflow_versions SET status = 'archived'
        WHERE workflow_id = v_workflow_id AND id <> p_version_id AND status = 'published';

    UPDATE wf_workflows
        SET published_version_id = p_version_id,
            trigger_event_key = v_trigger_key,
            trigger_config = v_trigger_cfg,
            status = 'active',
            updated_at = now()
        WHERE id = v_workflow_id;
END;
$function$
;

-- منح التنفيذ كما في 70_grants.sql حرفيًا:
REVOKE ALL ON FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid, p_change_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid, p_change_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid, p_change_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid, p_change_note text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid, p_change_note text) TO PUBLIC;

-- منح التنفيذ كما في 70_grants.sql حرفيًا:
REVOKE ALL ON FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text) TO PUBLIC;

-- منح التنفيذ كما في 70_grants.sql حرفيًا:
REVOKE ALL ON FUNCTION public.publish_workflow_version(p_version_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_workflow_version(p_version_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_workflow_version(p_version_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.publish_workflow_version(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_workflow_version(p_version_id uuid) TO PUBLIC;

-- ============================================================================
-- 6) RLS وسياسات جداول سير العمل وقواعد الأتمتة (من 60_triggers_rls_policies.sql
--    حرفيًا — wf_is_admin()/wf_is_staff() معرّفان أصلًا في 117 و 027/035)
-- ============================================================================
ALTER TABLE public.wf_workflows ENABLE ROW LEVEL SECURITY;
drop policy if exists "wf_workflows_delete" on public.wf_workflows;
CREATE POLICY wf_workflows_delete ON public.wf_workflows AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
drop policy if exists "wf_workflows_insert" on public.wf_workflows;
CREATE POLICY wf_workflows_insert ON public.wf_workflows AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
drop policy if exists "wf_workflows_select" on public.wf_workflows;
CREATE POLICY wf_workflows_select ON public.wf_workflows AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
drop policy if exists "wf_workflows_update" on public.wf_workflows;
CREATE POLICY wf_workflows_update ON public.wf_workflows AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
ALTER TABLE public.wf_workflow_versions ENABLE ROW LEVEL SECURITY;
drop policy if exists "wf_workflow_versions_delete" on public.wf_workflow_versions;
CREATE POLICY wf_workflow_versions_delete ON public.wf_workflow_versions AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
drop policy if exists "wf_workflow_versions_insert" on public.wf_workflow_versions;
CREATE POLICY wf_workflow_versions_insert ON public.wf_workflow_versions AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
drop policy if exists "wf_workflow_versions_select" on public.wf_workflow_versions;
CREATE POLICY wf_workflow_versions_select ON public.wf_workflow_versions AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
drop policy if exists "wf_workflow_versions_update" on public.wf_workflow_versions;
CREATE POLICY wf_workflow_versions_update ON public.wf_workflow_versions AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
ALTER TABLE public.wf_runs ENABLE ROW LEVEL SECURITY;
drop policy if exists "wf_runs_delete" on public.wf_runs;
CREATE POLICY wf_runs_delete ON public.wf_runs AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
drop policy if exists "wf_runs_insert" on public.wf_runs;
CREATE POLICY wf_runs_insert ON public.wf_runs AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
drop policy if exists "wf_runs_select" on public.wf_runs;
CREATE POLICY wf_runs_select ON public.wf_runs AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
drop policy if exists "wf_runs_update" on public.wf_runs;
CREATE POLICY wf_runs_update ON public.wf_runs AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
ALTER TABLE public.wf_run_steps ENABLE ROW LEVEL SECURITY;
drop policy if exists "wf_run_steps_delete" on public.wf_run_steps;
CREATE POLICY wf_run_steps_delete ON public.wf_run_steps AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
drop policy if exists "wf_run_steps_insert" on public.wf_run_steps;
CREATE POLICY wf_run_steps_insert ON public.wf_run_steps AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
drop policy if exists "wf_run_steps_select" on public.wf_run_steps;
CREATE POLICY wf_run_steps_select ON public.wf_run_steps AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
drop policy if exists "wf_run_steps_update" on public.wf_run_steps;
CREATE POLICY wf_run_steps_update ON public.wf_run_steps AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
ALTER TABLE public.wf_webhook_endpoints ENABLE ROW LEVEL SECURITY;
drop policy if exists "wf_webhook_endpoints_all" on public.wf_webhook_endpoints;
CREATE POLICY wf_webhook_endpoints_all ON public.wf_webhook_endpoints AS PERMISSIVE FOR ALL TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
ALTER TABLE public.rules_engine ENABLE ROW LEVEL SECURITY;
drop policy if exists "Admins can manage rules_engine" on public.rules_engine;
CREATE POLICY "Admins can manage rules_engine" ON public.rules_engine AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

-- ============================================================================
-- 7) فحوص ذاتية — تفشل الترحيل بصوت عالٍ بدل أن يمرّ ناقصًا
-- ============================================================================
do $$
declare
  missing text[];
  f text;
begin
  -- الجداول الحرجة لهذا الإصلاح
  select array_agg(t)
    into missing
    from unnest(array['suggestions', 'wf_workflows', 'wf_workflow_versions', 'wf_runs',
                      'wf_run_steps', 'rules_engine', 'central_wallet',
                      'central_wallet_transactions', 'user_wallets', 'api_keys']) t
   where to_regclass('public.' || t) is null;
  if missing is not null then
    raise exception '134: جداول مفقودة بعد التثبيت: %', array_to_string(missing, ', ');
  end if;

  -- الدوال الحرجة (التوقيع الكامل)
  foreach f in array array[
    'public.manage_user_points(text,bigint,text)',
    'public.transfer_points_from_central(text,bigint)',
    'public.send_test_telegram_alert()',
    'public.send_telegram_message(text,text)',
    'public.create_workflow_draft_version(uuid,uuid,text)',
    'public.publish_workflow(uuid,text)',
    'public.publish_workflow_version(uuid)'
  ] loop
    if to_regprocedure(f) is null then
      raise exception '134: دالة مفقودة بعد التثبيت: %', f;
    end if;
  end loop;

  -- سياسات suggestions الأربع
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'suggestions') <> 4 then
    raise exception '134: سياسات suggestions ليست 4 كما هو متوقع';
  end if;
end $$;
