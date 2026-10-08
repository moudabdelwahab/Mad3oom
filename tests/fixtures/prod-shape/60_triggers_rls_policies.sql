CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public._pre_038_rollback FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.accounting_invoices FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.admin_telegram_otps FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ads_settings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.advanced_settings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_agent_modes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_ai_agents_updated_at BEFORE UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION set_ai_agents_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_agents FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_provider_catalog FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_routing_rules FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_session_messages FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_sessions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_usage_events FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.api_keys FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.api_token_usage_logs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER guard_api_token_protected_columns BEFORE UPDATE ON public.api_tokens FOR EACH ROW EXECUTE FUNCTION guard_api_token_protected_columns();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.api_tokens FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.aqar_admin_audit_log FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.badge_definitions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_blog_touch_category BEFORE UPDATE ON public.blog_categories FOR EACH ROW EXECUTE FUNCTION blog_touch_category();
CREATE TRIGGER trg_blog_normalize_post BEFORE INSERT OR UPDATE ON public.blog_posts FOR EACH ROW EXECUTE FUNCTION blog_normalize_post();
CREATE TRIGGER trg_board_updated_at BEFORE UPDATE ON public.board FOR EACH ROW EXECUTE FUNCTION set_board_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.board FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.bot_api_keys FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.bot_settings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.bot_user_states FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trigger_bot_user_states_last_interaction BEFORE UPDATE ON public.bot_user_states FOR EACH ROW EXECUTE FUNCTION update_bot_user_states_last_interaction();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.canned_responses FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.central_wallet FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.central_wallet_transactions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.channel_identities FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.channel_link_codes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.channel_secrets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_ai_usage_counters FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_conversation_reviews FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_knowledge_entries FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_publish_overrides FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_scenarios FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_trace_events FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_engine_validation_runs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_message_revisions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER on_new_chat_message AFTER INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION handle_new_chat_message();
CREATE TRIGGER trg_guard_ai_reply_handoff BEFORE INSERT OR UPDATE OF is_bot_reply ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION guard_ai_reply_handoff();
CREATE TRIGGER trg_guard_chat_message_attachment BEFORE INSERT OR UPDATE ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION guard_chat_message_attachment();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_messages FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER tr_on_new_chat AFTER INSERT ON public.chat_sessions FOR EACH ROW EXECUTE FUNCTION notify_admin_on_new_chat();
CREATE TRIGGER trg_guard_bot_state BEFORE INSERT OR UPDATE OF bot_state ON public.chat_sessions FOR EACH ROW EXECUTE FUNCTION guard_bot_state();
CREATE TRIGGER trg_guard_handoff_state BEFORE INSERT OR UPDATE OF is_manual_mode ON public.chat_sessions FOR EACH ROW EXECUTE FUNCTION guard_handoff_state();
CREATE TRIGGER trg_log_handoff_change AFTER UPDATE OF is_manual_mode ON public.chat_sessions FOR EACH ROW EXECUTE FUNCTION log_handoff_change();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chat_sessions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chatbot_memory FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.community_comments FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.community_likes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.community_posts FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER guard_company_status BEFORE UPDATE OF status ON public.companies FOR EACH ROW EXECUTE FUNCTION guard_company_status();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.companies FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_sync_company_owner_role AFTER INSERT OR UPDATE OF user_id ON public.companies FOR EACH ROW EXECUTE FUNCTION sync_company_owner_role();
CREATE TRIGGER update_companies_timestamp_trigger BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION update_companies_timestamp();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.conversations FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.custom_roles FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_badges FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_notes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_notify_admins_of_service_report AFTER INSERT ON public.customer_service_reports FOR EACH ROW EXECUTE FUNCTION notify_admins_of_service_report();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_service_reports FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_set_service_report_episode BEFORE INSERT ON public.customer_service_reports FOR EACH ROW EXECUTE FUNCTION set_service_report_episode();
CREATE TRIGGER trg_guard_sie_edition_column BEFORE INSERT OR UPDATE ON public.customer_sie_access FOR EACH ROW EXECUTE FUNCTION guard_sie_edition_column();
CREATE TRIGGER trg_log_customer_sie_access AFTER INSERT OR UPDATE ON public.customer_sie_access FOR EACH ROW EXECUTE FUNCTION log_customer_sie_access_change();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_sie_access FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_touch_customer_sie_access BEFORE UPDATE ON public.customer_sie_access FOR EACH ROW EXECUTE FUNCTION touch_customer_sie_access_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_sie_access_audit FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_subscriptions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_customer_telegram_bots_updated_at BEFORE UPDATE ON public.customer_telegram_bots FOR EACH ROW EXECUTE FUNCTION customer_telegram_bots_set_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.customer_telegram_bots FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.email_lookup_rate_limits FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_external_integration_models_updated_at BEFORE UPDATE ON public.external_integration_models FOR EACH ROW EXECUTE FUNCTION set_external_integration_models_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.external_integration_models FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER set_external_integrations_updated_at BEFORE UPDATE ON public.external_integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.external_integrations FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.feature_flags FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.flow_analytics_events FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.flow_templates FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trigger_flow_templates_updated_at BEFORE UPDATE ON public.flow_templates FOR EACH ROW EXECUTE FUNCTION update_flow_templates_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_categories FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_likes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_mentions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_notifications FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_forum_reply_insert AFTER INSERT ON public.forum_replies FOR EACH ROW EXECUTE FUNCTION trg_badges_on_forum_reply();
CREATE TRIGGER tr_inc_reply_post_count AFTER INSERT ON public.forum_replies FOR EACH ROW EXECUTE FUNCTION increment_user_post_count();
CREATE TRIGGER tr_sanitize_reply BEFORE INSERT OR UPDATE ON public.forum_replies FOR EACH ROW EXECUTE FUNCTION forum_content_sanitization();
CREATE TRIGGER tr_update_reply_counts AFTER INSERT OR DELETE ON public.forum_replies FOR EACH ROW EXECUTE FUNCTION update_forum_counts();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_replies FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_reports FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_subforums FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_forum_thread_insert AFTER INSERT ON public.forum_threads FOR EACH ROW EXECUTE FUNCTION trg_badges_on_forum_thread();
CREATE TRIGGER tr_inc_post_count AFTER INSERT ON public.forum_threads FOR EACH ROW EXECUTE FUNCTION increment_user_post_count();
CREATE TRIGGER tr_sanitize_thread BEFORE INSERT OR UPDATE ON public.forum_threads FOR EACH ROW EXECUTE FUNCTION forum_content_sanitization();
CREATE TRIGGER tr_update_thread_counts AFTER INSERT OR DELETE ON public.forum_threads FOR EACH ROW EXECUTE FUNCTION update_forum_counts();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.forum_threads FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_conversation_tags FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_conversations FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_inbox_events_immutable BEFORE UPDATE ON public.inbox_events FOR EACH ROW EXECUTE FUNCTION guard_inbox_events_immutable();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_events FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_notes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_reactions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_scheduled_replies FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_team_members FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inbox_teams FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.individuals FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER update_individuals_timestamp_trigger BEFORE UPDATE ON public.individuals FOR EACH ROW EXECUTE FUNCTION update_individuals_timestamp();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_api_keys FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_clients FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_message_requests FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_request_logs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_settings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_templates FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER tr_assign_channel_id BEFORE INSERT ON public.integrations FOR EACH ROW EXECUTE FUNCTION trigger_assign_channel_id();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integrations FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.internal_service_secrets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.kb_article_feedback FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_kb_published_at BEFORE INSERT OR UPDATE ON public.knowledge_base FOR EACH ROW EXECUTE FUNCTION set_kb_published_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.knowledge_base FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER landing_config_touch BEFORE UPDATE ON public.landing_config FOR EACH ROW EXECUTE FUNCTION landing_touch_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.landing_config FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.landing_leads FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER landing_services_touch BEFORE UPDATE ON public.landing_services FOR EACH ROW EXECUTE FUNCTION landing_touch_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.landing_services FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.mailbox_emails FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_mcp_server_connections_updated_at BEFORE UPDATE ON public.mcp_server_connections FOR EACH ROW EXECUTE FUNCTION set_mcp_servers_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.mcp_server_connections FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_mcp_servers_updated_at BEFORE UPDATE ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION set_mcp_servers_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.mcp_servers FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.mcp_tools_catalog FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.memory_firewall_rules FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.messages FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_notifications_set_action BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION set_notification_action();
CREATE TRIGGER trg_notifications_set_category BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION set_notification_category();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.notifications FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_authorization_codes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_client_registrations_log FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_clients FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_rate_limit_hits FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_refresh_tokens FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.oauth_scopes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_owner_context_audit_immutable BEFORE DELETE OR UPDATE ON public.owner_context_audit FOR EACH ROW EXECUTE FUNCTION guard_owner_context_audit_immutable();
CREATE TRIGGER trg_guard_owner_context_state BEFORE INSERT OR DELETE OR UPDATE ON public.owner_context_state FOR EACH ROW EXECUTE FUNCTION guard_owner_context_state_write();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.plan_features FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_audit_platform_authority AFTER INSERT OR DELETE OR UPDATE ON public.platform_authority FOR EACH ROW EXECUTE FUNCTION audit_authority_tables();
CREATE TRIGGER trg_guard_platform_authority BEFORE INSERT OR DELETE OR UPDATE ON public.platform_authority FOR EACH ROW EXECUTE FUNCTION guard_platform_authority_write();
CREATE TRIGGER trg_audit_capability_grants AFTER INSERT OR DELETE OR UPDATE ON public.platform_capability_grants FOR EACH ROW EXECUTE FUNCTION audit_authority_tables();
CREATE TRIGGER trg_guard_capability_grants BEFORE INSERT OR DELETE OR UPDATE ON public.platform_capability_grants FOR EACH ROW EXECUTE FUNCTION guard_capability_grants_write();
CREATE TRIGGER trg_privileged_audit_immutable BEFORE DELETE OR UPDATE ON public.privileged_audit FOR EACH ROW EXECUTE FUNCTION guard_privileged_audit_immutable();
CREATE TRIGGER enforce_2fa_change_requires_challenge BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION enforce_2fa_change_requires_challenge();
CREATE TRIGGER evaluate_badges_after_points_update AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION trg_badges_on_points();
CREATE TRIGGER guard_privileged_accounts BEFORE DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_privileged_accounts();
CREATE TRIGGER guard_profile_phone_format BEFORE INSERT OR UPDATE OF phone, whatsapp_phone ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_phone_format();
CREATE TRIGGER guard_profile_points_change BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_points_change();
CREATE TRIGGER guard_profile_protected_columns BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_protected_columns();
CREATE TRIGGER guard_profile_role_change BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_role_change();
CREATE TRIGGER guard_profile_security_columns BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_security_columns();
CREATE TRIGGER guard_profile_super_user_id_insert BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_super_user_id_insert();
CREATE TRIGGER profiles_guard_aqar_enabled BEFORE UPDATE OF aqar_enabled ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_aqar_enabled();
CREATE TRIGGER tr_check_super_user_creation BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION check_super_user_creation();
CREATE TRIGGER trg_audit_profile_privileged AFTER DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION audit_profile_privileged_change();
CREATE TRIGGER trg_divert_mfa_secrets BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION divert_mfa_secrets();
CREATE TRIGGER trg_guard_chatbot_mode_value BEFORE INSERT OR UPDATE OF chatbot_mode ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_chatbot_mode_value();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_sie_provision_free_access AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION sie_provision_free_access();
CREATE TRIGGER trg_sync_company_role BEFORE INSERT OR UPDATE OF super_user_id, role ON public.profiles FOR EACH ROW EXECUTE FUNCTION sync_company_role();
CREATE TRIGGER trg_waitlist_drop_auto_entry_on_role AFTER UPDATE OF role ON public.profiles FOR EACH ROW EXECUTE FUNCTION waitlist_drop_auto_entry_on_role();
CREATE TRIGGER trg_waitlist_enqueue_new_account AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION waitlist_enqueue_new_account();
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ratings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.reward_activity_logs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.rules_engine FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.saved_ticket_filters FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.scheduled_messages FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trigger_scheduled_messages_updated_at BEFORE UPDATE ON public.scheduled_messages FOR EACH ROW EXECUTE FUNCTION update_scheduled_messages_updated_at();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.service_status_history FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.services FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_track_service_status_change BEFORE INSERT OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION track_service_status_change();
CREATE TRIGGER trg_audit_sie_admin_grants AFTER INSERT OR DELETE OR UPDATE ON public.sie_admin_grants FOR EACH ROW EXECUTE FUNCTION audit_authority_tables();
CREATE TRIGGER trg_guard_sie_admin_grants BEFORE INSERT OR DELETE OR UPDATE ON public.sie_admin_grants FOR EACH ROW EXECUTE FUNCTION guard_sie_admin_grants_write();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_api_keys FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_api_requests FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_sie_authority_audit_immutable BEFORE DELETE OR UPDATE ON public.sie_authority_audit FOR EACH ROW EXECUTE FUNCTION guard_sie_authority_audit_immutable();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_customer_memory FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_rate_limit_buckets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_rate_limit_overrides FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER sie_settings_touch BEFORE INSERT OR UPDATE ON public.sie_settings FOR EACH ROW EXECUTE FUNCTION touch_sie_settings_updated_at();
CREATE TRIGGER trg_audit_sie_settings AFTER INSERT OR DELETE OR UPDATE ON public.sie_settings FOR EACH ROW EXECUTE FUNCTION audit_authority_tables();
CREATE TRIGGER trg_guard_sie_edition_settings BEFORE INSERT OR DELETE OR UPDATE ON public.sie_settings FOR EACH ROW EXECUTE FUNCTION guard_sie_edition_settings();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.sie_settings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.site_errors FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.subdomain_activity_log FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.subdomain_request_queue FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_subdomain_change AFTER INSERT OR UPDATE ON public.subdomain_requests FOR EACH ROW EXECUTE FUNCTION trg_badges_on_subdomain();
CREATE TRIGGER trg_enforce_subdomain_entitlement BEFORE INSERT ON public.subdomain_requests FOR EACH ROW EXECUTE FUNCTION enforce_subdomain_entitlement();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.subdomain_requests FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.subscription_audit_log FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.subscription_plans FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.suggested_questions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.telegram_auth_logs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_activity FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_attachments FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_distribution_config FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_rating_insert AFTER INSERT ON public.ticket_ratings FOR EACH ROW EXECUTE FUNCTION trg_badges_on_rating();
CREATE TRIGGER trg_log_ticket_rating_activity AFTER INSERT ON public.ticket_ratings FOR EACH ROW EXECUTE FUNCTION log_ticket_rating_activity();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_ratings FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_reply_insert AFTER INSERT ON public.ticket_replies FOR EACH ROW EXECUTE FUNCTION trg_badges_on_reply();
CREATE TRIGGER on_ticket_reply_created AFTER INSERT ON public.ticket_replies FOR EACH ROW EXECUTE FUNCTION notify_ticket_reply();
CREATE TRIGGER trg_log_ticket_reply_activity AFTER INSERT ON public.ticket_replies FOR EACH ROW EXECUTE FUNCTION log_ticket_reply_activity();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_replies FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_track_first_response AFTER INSERT ON public.ticket_replies FOR EACH ROW EXECUTE FUNCTION track_first_response();
CREATE TRIGGER trg_unarchive_ticket_on_external_reply AFTER INSERT ON public.ticket_replies FOR EACH ROW EXECUTE FUNCTION unarchive_ticket_on_external_reply();
CREATE TRIGGER trg_log_ticket_tag_activity AFTER INSERT OR DELETE ON public.ticket_tag_links FOR EACH ROW EXECUTE FUNCTION log_ticket_tag_activity();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_tag_links FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ticket_tags FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_ticket_insert AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION trg_badges_on_ticket();
CREATE TRIGGER on_ticket_created AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_ticket_event();
CREATE TRIGGER on_ticket_updated AFTER UPDATE OF status ON public.tickets FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION notify_ticket_event();
CREATE TRIGGER ticket_notification_trigger AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_all_admins_on_ticket();
CREATE TRIGGER tickets_enforce_quota BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION enforce_ticket_quota();
CREATE TRIGGER tr_on_new_ticket AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_admin_on_new_ticket();
CREATE TRIGGER tr_set_ticket_number BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION set_ticket_number();
CREATE TRIGGER trg_assign_ticket_round_robin BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION assign_ticket_round_robin();
CREATE TRIGGER trg_dispatch_ticket_webhooks AFTER INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION dispatch_ticket_webhooks();
CREATE TRIGGER trg_dispatch_workflow_on_ticket_created AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION dispatch_workflow_on_ticket_created();
CREATE TRIGGER trg_enforce_customer_ticket_update BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION enforce_customer_ticket_update_restrictions();
CREATE TRIGGER trg_log_ticket_changes_after AFTER INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION log_ticket_changes_after();
CREATE TRIGGER trg_log_ticket_changes_before BEFORE INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION log_ticket_changes_before();
CREATE TRIGGER trg_notify_subdomain_owner_on_ticket AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_subdomain_owner_on_ticket();
CREATE TRIGGER trg_notify_support_on_ticket_rejected AFTER UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_support_on_ticket_rejected();
CREATE TRIGGER trg_notify_urgent_ticket AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION notify_admins_on_urgent_ticket();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.tickets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_recalc_ticket_sla BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION recalc_ticket_sla();
CREATE TRIGGER trg_restrict_customer_ticket_update BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION restrict_customer_ticket_update();
CREATE TRIGGER trg_set_ticket_sla BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION set_ticket_sla();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.trusted_devices FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.twofa_rate_limits FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_handle_new_reward_report AFTER INSERT ON public.user_reports FOR EACH ROW EXECUTE FUNCTION handle_new_reward_report();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.user_reports FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.user_wallets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.webhook_deliveries FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.webhooks FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_leads FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_node_types FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_run_steps FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_runs FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_scheduled_resumes FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_variables FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_webhook_endpoints FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_workflow_versions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.wf_workflows FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_billing_admins FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_campaign_reports FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_campaigns FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER evaluate_badges_after_whatsapp_change AFTER INSERT OR UPDATE ON public.whatsapp_subscriptions FOR EACH ROW EXECUTE FUNCTION trg_badges_on_whatsapp();
CREATE TRIGGER trg_enforce_subscription_company_owner BEFORE INSERT OR UPDATE OF company_id ON public.whatsapp_subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_subscription_company_owner();
CREATE TRIGGER trg_enforce_subscription_purchase_rules BEFORE INSERT ON public.whatsapp_subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_subscription_purchase_rules();
CREATE TRIGGER trg_notify_admin_on_new_subscription AFTER INSERT ON public.whatsapp_subscriptions FOR EACH ROW EXECUTE FUNCTION notify_admin_on_new_subscription();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_subscriptions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER update_whatsapp_subscriptions_updated_at BEFORE UPDATE ON public.whatsapp_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_wallet_topup_requests FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_wallet_transactions FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_wallets FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_whatsapp_wallets_updated_at BEFORE UPDATE ON public.whatsapp_wallets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.work_hours FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.working_hours FOR EACH STATEMENT EXECUTE FUNCTION guard_preview_read_only();
ALTER TABLE public.suggested_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_distribution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_ai_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_tools_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.individuals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_mfa_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_firewall_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advanced_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules_engine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_telegram_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_auth_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privileged_step_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_billing_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subdomain_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mailbox_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_campaign_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_customer_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privileged_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_subforums ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_lookup_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_message_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aqar_admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_service_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subdomain_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_telegram_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subdomain_request_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_token_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_server_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_sie_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_wallet_topup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_rate_limit_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_client_registrations_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canned_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_ticket_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_scheduled_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_trace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_conversation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_engine_publish_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badge_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_sie_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_scheduled_resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_node_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_admin_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_integration_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_rate_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_api_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sie_authority_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_passcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passcode_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._pre_038_rollback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_context_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_context_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_article_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_service_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_ticket_quotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_passcodes_owner_all ON public.access_passcodes AS PERMISSIVE FOR ALL TO authenticated USING (is_platform_owner()) WITH CHECK (is_platform_owner());
CREATE POLICY own_invoices_select ON public.accounting_invoices AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR is_admin()));
CREATE POLICY activity_logs_select_policy ON public.activity_logs AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'admin'::text) OR supervises(user_id)));
CREATE POLICY allow_insert_logs ON public.activity_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY gate_account_active ON public.activity_logs AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can manage advanced_settings" ON public.advanced_settings AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY advanced_settings_public_read_registration_mode ON public.advanced_settings AS PERMISSIVE FOR SELECT TO authenticated, anon USING ((key = 'registration_mode'::text));
CREATE POLICY "Admins manage agent modes" ON public.ai_agent_modes AS PERMISSIVE FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Read agent modes" ON public.ai_agent_modes AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage ai_agents" ON public.ai_agents AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins manage provider catalog" ON public.ai_provider_catalog AS PERMISSIVE FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Read provider catalog" ON public.ai_provider_catalog AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage routing rules" ON public.ai_routing_rules AS PERMISSIVE FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Manage own ai session messages" ON public.ai_session_messages AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM ai_sessions s
  WHERE ((s.id = ai_session_messages.session_id) AND ((s.owner_id = auth.uid()) OR is_admin()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ai_sessions s
  WHERE ((s.id = ai_session_messages.session_id) AND ((s.owner_id = auth.uid()) OR is_admin())))));
CREATE POLICY "Manage own ai sessions" ON public.ai_sessions AS PERMISSIVE FOR ALL TO authenticated USING (((owner_id = auth.uid()) OR is_admin())) WITH CHECK (((owner_id = auth.uid()) OR is_admin()));
CREATE POLICY "Admins read ai usage" ON public.ai_usage_events AS PERMISSIVE FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "Admins can view all api_keys" ON public.api_keys AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'admin'::text) OR (profiles.email = 'support@mad3oom.online'::text))))));
CREATE POLICY "Users can insert own api_keys" ON public.api_keys AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = id));
CREATE POLICY "Users can select own api_keys" ON public.api_keys AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = id));
CREATE POLICY "Users can update own api_keys" ON public.api_keys AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));
CREATE POLICY "Owner/SuperUser/Admin can view usage logs" ON public.api_token_usage_logs AS PERMISSIVE FOR SELECT TO public USING ((is_admin() OR is_owner_or_super_of(user_id)));
CREATE POLICY "Service role can insert usage logs" ON public.api_token_usage_logs AS PERMISSIVE FOR INSERT TO public WITH CHECK (false);
CREATE POLICY "Admin can delete any api token" ON public.api_tokens AS PERMISSIVE FOR DELETE TO public USING ((is_admin() OR is_owner_or_super_of(user_id)));
CREATE POLICY "Admin can update any api token" ON public.api_tokens AS PERMISSIVE FOR UPDATE TO public USING ((is_admin() OR is_owner_or_super_of(user_id))) WITH CHECK ((is_admin() OR is_owner_or_super_of(user_id)));
CREATE POLICY "Admin can view all api tokens" ON public.api_tokens AS PERMISSIVE FOR SELECT TO public USING ((is_admin() OR is_owner_or_super_of(user_id)));
CREATE POLICY "Users can delete their own api tokens" ON public.api_tokens AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can toggle active state of their own tokens" ON public.api_tokens AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own api tokens" ON public.api_tokens AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY badge_definitions_admin_write ON public.badge_definitions AS PERMISSIVE FOR ALL TO public USING (is_platform_staff()) WITH CHECK (is_platform_staff());
CREATE POLICY badge_definitions_select_active ON public.badge_definitions AS PERMISSIVE FOR SELECT TO public USING (((is_active = true) OR is_platform_staff()));
CREATE POLICY blog_categories_public_read ON public.blog_categories AS PERMISSIVE FOR SELECT TO authenticated, anon USING ((is_active IS TRUE));
CREATE POLICY blog_categories_staff_read ON public.blog_categories AS PERMISSIVE FOR SELECT TO authenticated USING (is_platform_staff());
CREATE POLICY blog_categories_staff_write ON public.blog_categories AS PERMISSIVE FOR ALL TO authenticated USING (is_platform_staff()) WITH CHECK (is_platform_staff());
CREATE POLICY blog_posts_public_read ON public.blog_posts AS PERMISSIVE FOR SELECT TO authenticated, anon USING (((status = 'published'::text) AND (published_at IS NOT NULL) AND (published_at <= now())));
CREATE POLICY blog_posts_staff_read ON public.blog_posts AS PERMISSIVE FOR SELECT TO authenticated USING (is_platform_staff());
CREATE POLICY blog_posts_staff_write ON public.blog_posts AS PERMISSIVE FOR ALL TO authenticated USING (is_platform_staff()) WITH CHECK (is_platform_staff());
CREATE POLICY board_staff_insert ON public.board AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((is_admin() OR is_support_user()));
CREATE POLICY board_staff_read ON public.board AS PERMISSIVE FOR SELECT TO authenticated USING ((is_admin() OR is_support_user()));
CREATE POLICY board_staff_update ON public.board AS PERMISSIVE FOR UPDATE TO authenticated USING ((is_admin() OR is_support_user())) WITH CHECK ((is_admin() OR is_support_user()));
CREATE POLICY "Admins can view all bot_api_keys" ON public.bot_api_keys AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'admin'::text) OR (profiles.email = 'support@mad3oom.online'::text))))));
CREATE POLICY "Users can manage own bot_api_keys" ON public.bot_api_keys AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = created_by)) WITH CHECK ((auth.uid() = created_by));
CREATE POLICY "Admins can view all bot_settings" ON public.bot_settings AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'admin'::text) OR (profiles.email = 'support@mad3oom.online'::text))))));
CREATE POLICY "Authenticated users can read the global site-chat bot settings" ON public.bot_settings AS PERMISSIVE FOR SELECT TO authenticated USING ((phone_number_id IS NULL));
CREATE POLICY "Users can manage own bot settings" ON public.bot_settings AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can select own bot_settings" ON public.bot_settings AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own bot states" ON public.bot_user_states AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own bot states" ON public.bot_user_states AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own bot states" ON public.bot_user_states AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can view their own bot states" ON public.bot_user_states AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Admin can manage canned responses" ON public.canned_responses AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Staff can view canned responses" ON public.canned_responses AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY "Only support email can update central wallet" ON public.central_wallet AS PERMISSIVE FOR UPDATE TO public USING (((auth.jwt() ->> 'email'::text) = 'support@mad3oom.online'::text));
CREATE POLICY "Only support email can view central wallet" ON public.central_wallet AS PERMISSIVE FOR SELECT TO public USING (((auth.jwt() ->> 'email'::text) = 'support@mad3oom.online'::text));
CREATE POLICY "Only support email can insert transactions" ON public.central_wallet_transactions AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.jwt() ->> 'email'::text) = 'support@mad3oom.online'::text));
CREATE POLICY "Only support email can view transactions" ON public.central_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING (((auth.jwt() ->> 'email'::text) = 'support@mad3oom.online'::text));
CREATE POLICY channel_identities_delete ON public.channel_identities AS PERMISSIVE FOR DELETE TO authenticated USING (((user_id = auth.uid()) OR is_sie_admin()));
CREATE POLICY channel_identities_select ON public.channel_identities AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_chat_engine_staff()));
CREATE POLICY channel_link_codes_select ON public.channel_link_codes AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "Staff can manage conversation reviews" ON public.chat_engine_conversation_reviews AS PERMISSIVE FOR ALL TO public USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY "Authenticated customers can read published knowledge entries" ON public.chat_engine_knowledge_entries AS PERMISSIVE FOR SELECT TO authenticated USING ((status = 'published'::text));
CREATE POLICY "Staff can manage knowledge entries" ON public.chat_engine_knowledge_entries AS PERMISSIVE FOR ALL TO public USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY "Staff can manage publish overrides" ON public.chat_engine_publish_overrides AS PERMISSIVE FOR ALL TO public USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY "Authenticated customers can read published scenarios" ON public.chat_engine_scenarios AS PERMISSIVE FOR SELECT TO authenticated USING ((status = 'published'::text));
CREATE POLICY "Staff can manage scenarios" ON public.chat_engine_scenarios AS PERMISSIVE FOR ALL TO public USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY "Staff can insert trace events" ON public.chat_engine_trace_events AS PERMISSIVE FOR INSERT TO public WITH CHECK ((is_chat_engine_staff() OR (session_id IN ( SELECT chat_sessions.id
   FROM chat_sessions
  WHERE (chat_sessions.user_id = auth.uid())))));
CREATE POLICY "Staff can read trace events" ON public.chat_engine_trace_events AS PERMISSIVE FOR SELECT TO public USING (is_chat_engine_staff());
CREATE POLICY "Staff can manage validation runs" ON public.chat_engine_validation_runs AS PERMISSIVE FOR ALL TO public USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY chat_message_revisions_select ON public.chat_message_revisions AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.chat_message_revisions AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY chat_messages_insert_own_or_admin ON public.chat_messages AS PERMISSIVE FOR INSERT TO public WITH CHECK ((has_elevated_authority() OR ((session_id IN ( SELECT s.id
   FROM chat_sessions s
  WHERE (s.user_id = auth.uid()))) AND (sender_id = auth.uid()) AND (COALESCE(is_admin_reply, false) = false) AND (COALESCE(is_bot_reply, false) = false))));
CREATE POLICY chat_messages_select_own_or_admin ON public.chat_messages AS PERMISSIVE FOR SELECT TO public USING ((has_elevated_authority() OR (sender_id = auth.uid()) OR (session_id IN ( SELECT s.id
   FROM chat_sessions s
  WHERE (s.user_id = auth.uid())))));
CREATE POLICY gate_account_active ON public.chat_messages AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_assigned_select ON public.chat_messages AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT is_platform_staff() AS is_platform_staff) AND inbox_can_access(session_id)));
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = auth.uid()) OR has_elevated_authority()));
CREATE POLICY chat_sessions_select_own_or_admin ON public.chat_sessions AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR has_elevated_authority()));
CREATE POLICY chat_sessions_update_own_or_admin ON public.chat_sessions AS PERMISSIVE FOR UPDATE TO public USING (((user_id = auth.uid()) OR has_elevated_authority()));
CREATE POLICY gate_account_active ON public.chat_sessions AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_assigned_select ON public.chat_sessions AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT is_platform_staff() AS is_platform_staff) AND inbox_can_access(id)));
CREATE POLICY "Admins have full access to chatbot_memory" ON public.chatbot_memory AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Chatbot can read chatbot_memory" ON public.chatbot_memory AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can view comments" ON public.community_comments AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated users can create comments" ON public.community_comments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Anyone can view posts" ON public.community_posts AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated users can create posts" ON public.community_posts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Company members can view their company" ON public.companies AS PERMISSIVE FOR SELECT TO public USING ((id = current_company_id()));
CREATE POLICY "Users can insert their own company" ON public.companies AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can update their own company" ON public.companies AS PERMISSIVE FOR UPDATE TO public USING ((user_id = auth.uid()));
CREATE POLICY "Users can view their own company" ON public.companies AS PERMISSIVE FOR SELECT TO public USING ((user_id = auth.uid()));
CREATE POLICY "Admins can manage custom_roles" ON public.custom_roles AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY customer_badges_select_own ON public.customer_badges AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR is_platform_staff()));
CREATE POLICY gate_account_active ON public.customer_badges AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can delete customer notes" ON public.customer_notes AS PERMISSIVE FOR DELETE TO public USING (is_platform_staff());
CREATE POLICY "Admins can insert customer notes" ON public.customer_notes AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_platform_staff());
CREATE POLICY "Admins can update their own notes" ON public.customer_notes AS PERMISSIVE FOR UPDATE TO public USING (is_platform_staff());
CREATE POLICY "Admins can view customer notes" ON public.customer_notes AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY "Staff manage service reports" ON public.customer_service_reports AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Users create their own service reports" ON public.customer_service_reports AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users read their own service reports" ON public.customer_service_reports AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY sie_access_select ON public.customer_sie_access AS PERMISSIVE FOR SELECT TO public USING ((is_sie_admin() OR (user_id = auth.uid())));
CREATE POLICY sie_access_write ON public.customer_sie_access AS PERMISSIVE FOR ALL TO public USING (is_sie_admin()) WITH CHECK (is_sie_admin());
CREATE POLICY sie_audit_select ON public.customer_sie_access_audit AS PERMISSIVE FOR SELECT TO public USING (is_sie_admin());
CREATE POLICY "Admins manage customer_subscriptions" ON public.customer_subscriptions AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Users read own subscriptions" ON public.customer_subscriptions AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR is_admin()));
CREATE POLICY "customer can delete own telegram bot" ON public.customer_telegram_bots AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "customer can insert own telegram bot" ON public.customer_telegram_bots AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "customer can update own telegram bot" ON public.customer_telegram_bots AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "customer can view own telegram bot" ON public.customer_telegram_bots AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Manage models of writable integrations" ON public.external_integration_models AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM external_integrations ei
  WHERE ((ei.id = external_integration_models.integration_id) AND (is_admin() OR ((ei.owner_scope <> 'platform'::text) AND is_owner_or_super_of(ei.owner_id))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM external_integrations ei
  WHERE ((ei.id = external_integration_models.integration_id) AND (is_admin() OR ((ei.owner_scope <> 'platform'::text) AND is_owner_or_super_of(ei.owner_id)))))));
CREATE POLICY "View models of accessible integrations" ON public.external_integration_models AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM external_integrations ei
  WHERE (ei.id = external_integration_models.integration_id))));
CREATE POLICY "Delete own/managed/platform integrations" ON public.external_integrations AS PERMISSIVE FOR DELETE TO public USING ((is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id))));
CREATE POLICY "Insert own/managed integrations" ON public.external_integrations AS PERMISSIVE FOR INSERT TO public WITH CHECK ((is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id))));
CREATE POLICY "Update own/managed/platform integrations" ON public.external_integrations AS PERMISSIVE FOR UPDATE TO public USING ((is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id)))) WITH CHECK ((is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id))));
CREATE POLICY "View own/managed/platform integrations" ON public.external_integrations AS PERMISSIVE FOR SELECT TO public USING ((is_admin() OR (owner_scope = 'platform'::text) OR is_owner_or_super_of(owner_id)));
CREATE POLICY "Admins manage feature_flags" ON public.feature_flags AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Anyone authenticated can read feature_flags" ON public.feature_flags AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() IS NOT NULL));
CREATE POLICY "Prevent deletes of analytics events" ON public.flow_analytics_events AS PERMISSIVE FOR DELETE TO public USING (false);
CREATE POLICY "Prevent updates to analytics events" ON public.flow_analytics_events AS PERMISSIVE FOR UPDATE TO public USING (false);
CREATE POLICY "Users can insert their own analytics events" ON public.flow_analytics_events AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own analytics events" ON public.flow_analytics_events AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Anyone can view public templates" ON public.flow_templates AS PERMISSIVE FOR SELECT TO public USING (((is_public = true) OR (auth.uid() = created_by)));
CREATE POLICY "Users can create their own templates" ON public.flow_templates AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = created_by));
CREATE POLICY "Users can delete their own templates" ON public.flow_templates AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = created_by));
CREATE POLICY "Users can update their own templates" ON public.flow_templates AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = created_by));
CREATE POLICY "Admins can manage categories" ON public.forum_categories AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Everyone can view categories" ON public.forum_categories AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated users can manage likes" ON public.forum_likes AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id));
CREATE POLICY "Everyone can view likes" ON public.forum_likes AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Users can manage own notifications" ON public.forum_notifications AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id));
CREATE POLICY "Authenticated users can create replies" ON public.forum_replies AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((author_id = auth.uid()));
CREATE POLICY "Authors/Admins can update replies" ON public.forum_replies AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid() = author_id) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
CREATE POLICY "Everyone can view replies" ON public.forum_replies AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Admins can view reports" ON public.forum_reports AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Authenticated users can report" ON public.forum_reports AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((reporter_id = auth.uid()));
CREATE POLICY "Admins can manage subforums" ON public.forum_subforums AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Everyone can view subforums" ON public.forum_subforums AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated users can create threads" ON public.forum_threads AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((author_id = auth.uid()));
CREATE POLICY "Authors/Admins can update threads" ON public.forum_threads AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid() = author_id) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
CREATE POLICY "Everyone can view threads" ON public.forum_threads AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY gate_account_active ON public.inbox_conversation_tags AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_conversation_tags_select ON public.inbox_conversation_tags AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_conversations AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_conversations_select ON public.inbox_conversations AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_events AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_events_select ON public.inbox_events AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_notes AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_notes_select ON public.inbox_notes AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_reactions AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_reactions_select ON public.inbox_reactions AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_scheduled_replies AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_scheduled_replies_select ON public.inbox_scheduled_replies AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT inbox_is_agent() AS inbox_is_agent) AND inbox_can_access(session_id)));
CREATE POLICY gate_account_active ON public.inbox_team_members AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_team_members_select ON public.inbox_team_members AS PERMISSIVE FOR SELECT TO authenticated USING (( SELECT inbox_is_agent() AS inbox_is_agent));
CREATE POLICY gate_account_active ON public.inbox_teams AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY inbox_teams_select ON public.inbox_teams AS PERMISSIVE FOR SELECT TO authenticated USING (( SELECT inbox_is_agent() AS inbox_is_agent));
CREATE POLICY "Allow public read access to incidents" ON public.incidents AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Staff can write incidents" ON public.incidents AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Users can insert their own individual profile" ON public.individuals AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can update their own individual profile" ON public.individuals AS PERMISSIVE FOR UPDATE TO public USING ((user_id = auth.uid()));
CREATE POLICY "Users can view their own individual profile" ON public.individuals AS PERMISSIVE FOR SELECT TO public USING ((user_id = auth.uid()));
CREATE POLICY integration_api_keys_read ON public.integration_api_keys AS PERMISSIVE FOR SELECT TO authenticated USING ((is_admin() OR (EXISTS ( SELECT 1
   FROM integration_clients c
  WHERE ((c.id = integration_api_keys.client_id) AND (c.owner_user_id = auth.uid()))))));
CREATE POLICY integration_clients_read ON public.integration_clients AS PERMISSIVE FOR SELECT TO authenticated USING (((owner_user_id = auth.uid()) OR is_admin()));
CREATE POLICY integration_message_requests_read ON public.integration_message_requests AS PERMISSIVE FOR SELECT TO authenticated USING ((is_admin() OR (EXISTS ( SELECT 1
   FROM integration_clients c
  WHERE ((c.id = integration_message_requests.client_id) AND (c.owner_user_id = auth.uid()))))));
CREATE POLICY integration_request_logs_read ON public.integration_request_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((is_admin() OR (EXISTS ( SELECT 1
   FROM integration_clients c
  WHERE ((c.id = integration_request_logs.client_id) AND (c.owner_user_id = auth.uid()))))));
CREATE POLICY integration_settings_read ON public.integration_settings AS PERMISSIVE FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY integration_templates_read ON public.integration_templates AS PERMISSIVE FOR SELECT TO authenticated USING (((owner_user_id IS NULL) OR (owner_user_id = auth.uid()) OR is_admin()));
CREATE POLICY "Admins can view all integrations" ON public.integrations AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'admin'::text) OR (profiles.email = 'support@mad3oom.online'::text))))));
CREATE POLICY "Support can view all integrations" ON public.integrations AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.email = 'support@mad3oom.online'::text) OR (profiles.role = 'admin'::text))))));
CREATE POLICY "Users can delete own integrations" ON public.integrations AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own integrations" ON public.integrations AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can select own integrations" ON public.integrations AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own integrations" ON public.integrations AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Staff can read article feedback" ON public.kb_article_feedback AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Users manage their own article feedback" ON public.kb_article_feedback AS PERMISSIVE FOR ALL TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Anyone signed in can read published articles" ON public.knowledge_base AS PERMISSIVE FOR SELECT TO authenticated USING (((status = 'published'::text) AND (is_internal = false)));
CREATE POLICY "Staff can read all articles" ON public.knowledge_base AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Staff can write articles" ON public.knowledge_base AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY landing_config_admin_all ON public.landing_config AS PERMISSIVE FOR ALL TO authenticated USING (is_landing_admin()) WITH CHECK (is_landing_admin());
CREATE POLICY landing_config_public_read ON public.landing_config AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY landing_leads_admin_all ON public.landing_leads AS PERMISSIVE FOR ALL TO authenticated USING (is_landing_admin()) WITH CHECK (is_landing_admin());
CREATE POLICY landing_services_admin_all ON public.landing_services AS PERMISSIVE FOR ALL TO authenticated USING (is_landing_admin()) WITH CHECK (is_landing_admin());
CREATE POLICY landing_services_public_read ON public.landing_services AS PERMISSIVE FOR SELECT TO authenticated, anon USING ((status = 'active'::text));
CREATE POLICY "Admin can delete mailbox emails" ON public.mailbox_emails AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Admin can select mailbox emails" ON public.mailbox_emails AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Admin can update mailbox emails" ON public.mailbox_emails AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Owner can delete own mcp connections" ON public.mcp_server_connections AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = owner_id));
CREATE POLICY "Owner can insert own mcp connections" ON public.mcp_server_connections AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = owner_id));
CREATE POLICY "Owner can update own mcp connections" ON public.mcp_server_connections AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = owner_id)) WITH CHECK ((auth.uid() = owner_id));
CREATE POLICY "Owner can view own mcp connections" ON public.mcp_server_connections AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = owner_id));
CREATE POLICY "Owner can delete own mcp servers" ON public.mcp_servers AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = owner_id));
CREATE POLICY "Owner can insert own mcp servers" ON public.mcp_servers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = owner_id));
CREATE POLICY "Owner can update own mcp servers" ON public.mcp_servers AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = owner_id)) WITH CHECK ((auth.uid() = owner_id));
CREATE POLICY "Owner can view own mcp servers" ON public.mcp_servers AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = owner_id));
CREATE POLICY "Admins can manage mcp_tools_catalog" ON public.mcp_tools_catalog AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can manage firewall rules" ON public.memory_firewall_rules AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Users can insert own messages" ON public.messages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own messages" ON public.messages AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own messages" ON public.messages AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.messages AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can read notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO public USING (has_elevated_authority());
CREATE POLICY "Staff can create notifications for any user" ON public.notifications AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_platform_staff());
CREATE POLICY "Users can create their own notifications" ON public.notifications AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own notifications" ON public.notifications AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can view their own notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.notifications AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY oauth_scopes_public_read ON public.oauth_scopes AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY owner_context_audit_select ON public.owner_context_audit AS PERMISSIVE FOR SELECT TO public USING (has_elevated_authority());
CREATE POLICY owner_context_state_select_self ON public.owner_context_state AS PERMISSIVE FOR SELECT TO public USING ((user_id = auth.uid()));
CREATE POLICY passcode_redemptions_select ON public.passcode_redemptions AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_platform_owner()));
CREATE POLICY "Admins manage plan_features" ON public.plan_features AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Anyone authenticated can read plan_features" ON public.plan_features AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() IS NOT NULL));
CREATE POLICY "Admins manage ticket quotas" ON public.plan_ticket_quotas AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Anyone can read ticket quotas" ON public.plan_ticket_quotas AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY platform_authority_select_owner ON public.platform_authority AS PERMISSIVE FOR SELECT TO authenticated USING (owner_capability('owner_only'::text));
CREATE POLICY platform_authority_select_self ON public.platform_authority AS PERMISSIVE FOR SELECT TO public USING ((user_id = auth.uid()));
CREATE POLICY platform_capability_grants_select ON public.platform_capability_grants AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR owner_capability('owner_only'::text)));
CREATE POLICY privileged_audit_select_owner ON public.privileged_audit AS PERMISSIVE FOR SELECT TO authenticated USING (owner_capability('owner_only'::text));
CREATE POLICY privileged_step_ups_select_self ON public.privileged_step_ups AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "Support can update whatsapp_enabled" ON public.profiles AS PERMISSIVE FOR UPDATE TO public USING (is_support_user()) WITH CHECK (is_support_user());
CREATE POLICY "Support can view all profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO public USING ((is_support_user() OR (auth.uid() = id)));
CREATE POLICY profiles_delete_policy ON public.profiles AS PERMISSIVE FOR DELETE TO public USING (has_elevated_authority());
CREATE POLICY profiles_select_policy ON public.profiles AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = id) OR has_elevated_authority() OR supervises(id)));
CREATE POLICY profiles_update_policy ON public.profiles AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid() = id) OR has_elevated_authority() OR supervises(id)));
CREATE POLICY user_insert_self ON public.profiles AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = id));
CREATE POLICY "Admins can view all reward logs" ON public.reward_activity_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Users can view their own reward logs" ON public.reward_activity_logs AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.reward_activity_logs AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can manage rules_engine" ON public.rules_engine AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Users manage own saved filters" ON public.saved_ticket_filters AS PERMISSIVE FOR ALL TO public USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY gate_account_active ON public.saved_ticket_filters AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Users can delete their own scheduled messages" ON public.scheduled_messages AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own scheduled messages" ON public.scheduled_messages AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own scheduled messages" ON public.scheduled_messages AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can view their own scheduled messages" ON public.scheduled_messages AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Allow public read access to service history" ON public.service_status_history AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Staff can write service history" ON public.service_status_history AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Allow public read access to services" ON public.services AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Staff can write services" ON public.services AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY sie_admin_grants_select ON public.sie_admin_grants AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR sie_owner_authority()));
CREATE POLICY sie_api_keys_read ON public.sie_api_keys AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_sie_admin() OR is_chat_engine_staff()));
CREATE POLICY sie_api_requests_read ON public.sie_api_requests AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_sie_admin() OR is_chat_engine_staff()));
CREATE POLICY sie_authority_audit_select ON public.sie_authority_audit AS PERMISSIVE FOR SELECT TO authenticated USING (sie_owner_authority());
CREATE POLICY sie_customer_memory_delete ON public.sie_customer_memory AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY sie_customer_memory_select ON public.sie_customer_memory AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_chat_engine_staff()));
CREATE POLICY "Staff can read rate limit buckets" ON public.sie_rate_limit_buckets AS PERMISSIVE FOR SELECT TO public USING ((is_sie_admin() OR is_chat_engine_staff()));
CREATE POLICY "Customers can read their own rate limit" ON public.sie_rate_limit_overrides AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR is_sie_admin() OR is_chat_engine_staff()));
CREATE POLICY "Only the SIE admin can write rate limits" ON public.sie_rate_limit_overrides AS PERMISSIVE FOR ALL TO public USING (is_sie_admin()) WITH CHECK (is_sie_admin());
CREATE POLICY sie_settings_read ON public.sie_settings AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY sie_settings_write ON public.sie_settings AS PERMISSIVE FOR ALL TO authenticated USING (is_chat_engine_staff()) WITH CHECK (is_chat_engine_staff());
CREATE POLICY "Allow admins to update errors" ON public.site_errors AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Allow admins to view errors" ON public.site_errors AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Allow public insert for errors" ON public.site_errors AS PERMISSIVE FOR INSERT TO public WITH CHECK (((char_length(message) <= 2000) AND ((stack_trace IS NULL) OR (char_length(stack_trace) <= 8000)) AND ((type IS NULL) OR (type = ANY (ARRAY['js'::text, 'network'::text, 'promise'::text, 'resource'::text, 'console'::text, 'unhandled'::text]))) AND (status = 'new'::text)));
CREATE POLICY "Admins view activity log" ON public.subdomain_activity_log AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));
CREATE POLICY "Admins view all requests" ON public.subdomain_request_queue AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));
CREATE POLICY "Clients create own requests" ON public.subdomain_request_queue AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Clients view own requests" ON public.subdomain_request_queue AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "Admins view all subdomains" ON public.subdomain_requests AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));
CREATE POLICY "Clients view own subdomains" ON public.subdomain_requests AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND (deleted_at IS NULL)));
CREATE POLICY "Admins read subscription audit" ON public.subscription_audit_log AS PERMISSIVE FOR SELECT TO public USING (is_admin());
CREATE POLICY "Admins manage subscription_plans" ON public.subscription_plans AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Anyone authenticated can read subscription_plans" ON public.subscription_plans AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() IS NOT NULL));
CREATE POLICY board_anon_read_subscription_plans ON public.subscription_plans AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "Signed in users can read active questions" ON public.suggested_questions AS PERMISSIVE FOR SELECT TO authenticated USING ((is_active IS TRUE));
CREATE POLICY "Staff can manage suggested questions" ON public.suggested_questions AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'support'::text]))))));
CREATE POLICY "Admins can view their own auth logs" ON public.telegram_auth_logs AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Company scope can view ticket activity" ON public.ticket_activity AS PERMISSIVE FOR SELECT TO public USING (((action_type <> ALL (ARRAY['assignee_change'::text, 'assigned'::text, 'internal_note'::text])) AND ticket_in_my_scope(ticket_id)));
CREATE POLICY "Owner can view own ticket activity" ON public.ticket_activity AS PERMISSIVE FOR SELECT TO public USING (((action_type <> ALL (ARRAY['assignee_change'::text, 'assigned'::text, 'internal_note'::text])) AND (EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_activity.ticket_id) AND (t.user_id = auth.uid()))))));
CREATE POLICY "Staff can insert activity" ON public.ticket_activity AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_platform_staff());
CREATE POLICY "Staff can view activity" ON public.ticket_activity AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY gate_account_active ON public.ticket_activity AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Company scope can attach to scoped tickets" ON public.ticket_attachments AS PERMISSIVE FOR INSERT TO public WITH CHECK (ticket_in_my_scope(ticket_id));
CREATE POLICY "Company scope can view ticket attachments" ON public.ticket_attachments AS PERMISSIVE FOR SELECT TO public USING (ticket_in_my_scope(ticket_id));
CREATE POLICY "Owner can upload attachments to own ticket" ON public.ticket_attachments AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_access_ticket(ticket_id));
CREATE POLICY "Owner can view own ticket attachments" ON public.ticket_attachments AS PERMISSIVE FOR SELECT TO public USING (can_access_ticket(ticket_id));
CREATE POLICY "Staff can delete attachments" ON public.ticket_attachments AS PERMISSIVE FOR DELETE TO public USING (is_platform_staff());
CREATE POLICY "Staff can upload attachments" ON public.ticket_attachments AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_platform_staff());
CREATE POLICY "Staff can view all attachments" ON public.ticket_attachments AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY gate_account_active ON public.ticket_attachments AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can manage ticket_distribution_config" ON public.ticket_distribution_config AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Company scope can view ticket ratings" ON public.ticket_ratings AS PERMISSIVE FOR SELECT TO public USING (ticket_in_my_scope(ticket_id));
CREATE POLICY "Owner can rate own ticket" ON public.ticket_ratings AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_ratings.ticket_id) AND (t.user_id = auth.uid())))));
CREATE POLICY "Owner can view own rating" ON public.ticket_ratings AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_ratings.ticket_id) AND (t.user_id = auth.uid())))));
CREATE POLICY "Staff can view all ratings" ON public.ticket_ratings AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY gate_account_active ON public.ticket_ratings AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Support can add replies" ON public.ticket_replies AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = auth.uid()) AND (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'support'::text)));
CREATE POLICY "Support can view all replies" ON public.ticket_replies AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text)))));
CREATE POLICY "Users can add replies to their tickets" ON public.ticket_replies AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = auth.uid()) AND (has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'admin'::text) OR ticket_in_my_scope(ticket_id))));
CREATE POLICY gate_account_active ON public.ticket_replies AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY ticket_replies_select_policy ON public.ticket_replies AS PERMISSIVE FOR SELECT TO public USING ((has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = ANY (ARRAY['admin'::text, 'support'::text])) OR ((COALESCE(is_internal, false) = false) AND ticket_in_my_scope(ticket_id))));
CREATE POLICY "Staff can manage tag links" ON public.ticket_tag_links AS PERMISSIVE FOR ALL TO public USING (is_platform_staff()) WITH CHECK (is_platform_staff());
CREATE POLICY "Staff can view tag links" ON public.ticket_tag_links AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY "Admin can manage tags" ON public.ticket_tags AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Staff can view tags" ON public.ticket_tags AS PERMISSIVE FOR SELECT TO public USING (is_platform_staff());
CREATE POLICY "Admin can delete tickets" ON public.tickets AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Admin can update tickets" ON public.tickets AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Customer can archive own ticket" ON public.tickets AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Customer can create ticket" ON public.tickets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Support can update tickets" ON public.tickets AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text)))));
CREATE POLICY "Support can view all tickets" ON public.tickets AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text)))));
CREATE POLICY "Users can create tickets" ON public.tickets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.tickets AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY tickets_select_policy ON public.tickets AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'admin'::text) OR supervises(user_id)));
CREATE POLICY "Users can delete own trusted devices" ON public.trusted_devices AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own trusted devices" ON public.trusted_devices AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own trusted devices" ON public.trusted_devices AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own trusted devices" ON public.trusted_devices AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.user_reports AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY report_insert_self ON public.user_reports AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY report_select_all ON public.user_reports AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
CREATE POLICY report_update_all ON public.user_reports AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Admins can insert wallets" ON public.user_wallets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Admins can update wallets" ON public.user_wallets AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY gate_account_active ON public.user_wallets AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY wallet_insert_self ON public.user_wallets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY wallet_select_all ON public.user_wallets AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
CREATE POLICY waitlist_entries_admin_all ON public.waitlist_entries AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY waitlist_entries_anon_insert ON public.waitlist_entries AS PERMISSIVE FOR INSERT TO anon WITH CHECK (((status = 'pending'::text) AND (reviewed_at IS NULL) AND (reviewed_by IS NULL)));
CREATE POLICY waitlist_entries_platform_admin_all ON public.waitlist_entries AS PERMISSIVE FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can view webhook deliveries" ON public.webhook_deliveries AS PERMISSIVE FOR SELECT TO public USING (is_admin());
CREATE POLICY "Admins can manage webhooks" ON public.webhooks AS PERMISSIVE FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY wf_leads_delete ON public.wf_leads AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_leads_insert ON public.wf_leads AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_leads_select ON public.wf_leads AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_leads_update ON public.wf_leads AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_node_types_delete ON public.wf_node_types AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_node_types_insert ON public.wf_node_types AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_node_types_select ON public.wf_node_types AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_node_types_update ON public.wf_node_types AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_run_steps_delete ON public.wf_run_steps AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_run_steps_insert ON public.wf_run_steps AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_run_steps_select ON public.wf_run_steps AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_run_steps_update ON public.wf_run_steps AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_runs_delete ON public.wf_runs AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_runs_insert ON public.wf_runs AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_runs_select ON public.wf_runs AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_runs_update ON public.wf_runs AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_scheduled_resumes_all ON public.wf_scheduled_resumes AS PERMISSIVE FOR ALL TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_variables_all ON public.wf_variables AS PERMISSIVE FOR ALL TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_webhook_endpoints_all ON public.wf_webhook_endpoints AS PERMISSIVE FOR ALL TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_workflow_versions_delete ON public.wf_workflow_versions AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_workflow_versions_insert ON public.wf_workflow_versions AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_workflow_versions_select ON public.wf_workflow_versions AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_workflow_versions_update ON public.wf_workflow_versions AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY wf_workflows_delete ON public.wf_workflows AS PERMISSIVE FOR DELETE TO public USING (wf_is_admin());
CREATE POLICY wf_workflows_insert ON public.wf_workflows AS PERMISSIVE FOR INSERT TO public WITH CHECK (wf_is_admin());
CREATE POLICY wf_workflows_select ON public.wf_workflows AS PERMISSIVE FOR SELECT TO public USING (wf_is_staff());
CREATE POLICY wf_workflows_update ON public.wf_workflows AS PERMISSIVE FOR UPDATE TO public USING (wf_is_admin()) WITH CHECK (wf_is_admin());
CREATE POLICY "Users can insert their own campaign reports" ON public.whatsapp_campaign_reports AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM whatsapp_campaigns
  WHERE ((whatsapp_campaigns.id = whatsapp_campaign_reports.campaign_id) AND (whatsapp_campaigns.user_id = auth.uid())))));
CREATE POLICY "Users can view their own campaign reports" ON public.whatsapp_campaign_reports AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM whatsapp_campaigns
  WHERE ((whatsapp_campaigns.id = whatsapp_campaign_reports.campaign_id) AND (whatsapp_campaigns.user_id = auth.uid())))));
CREATE POLICY "Users can insert their own campaigns" ON public.whatsapp_campaigns AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own campaigns" ON public.whatsapp_campaigns AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Admins can manage all subscriptions" ON public.whatsapp_subscriptions AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Users can view their own subscriptions" ON public.whatsapp_subscriptions AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.whatsapp_subscriptions AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY "Admins can manage all wallet topup requests" ON public.whatsapp_wallet_topup_requests AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "Users can create their own wallet topup requests" ON public.whatsapp_wallet_topup_requests AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid() = user_id) AND ((ticket_id IS NULL) OR (EXISTS ( SELECT 1
   FROM tickets
  WHERE ((tickets.id = whatsapp_wallet_topup_requests.ticket_id) AND (tickets.user_id = auth.uid())))))));
CREATE POLICY "Users can view their own wallet topup requests" ON public.whatsapp_wallet_topup_requests AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY gate_account_active ON public.whatsapp_wallet_topup_requests AS RESTRICTIVE FOR ALL TO authenticated USING (account_is_active()) WITH CHECK (account_is_active());
CREATE POLICY wa_wallet_tx_select ON public.whatsapp_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text))))));
CREATE POLICY wa_wallets_select ON public.whatsapp_wallets AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'support'::text))))));
CREATE POLICY "Admins can manage working_hours" ON public.working_hours AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));
