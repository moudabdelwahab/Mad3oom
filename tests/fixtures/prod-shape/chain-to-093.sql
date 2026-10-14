-- ============================================================================
-- يكمل النسخة المطابقة لشكل الإنتاج (load.sql، مستخرجة 2026-10-07) حتى آخر
-- ترحيل مطبّق على الإنتاج: 093_continuity_collab_actions.
--
-- الترتيب = ترتيب أرقام الملفات للترحيلات المطبّقة على الإنتاج بعد الاستخراج.
-- 075_workspace_layouts غير مطبّق على الإنتاج فلا يُحمَّل هنا. 082–084 محجوزة
-- وغير مستعملة. 094 (PR #133) غير مدمج وغير مطبّق.
--
-- الاستعمال (من جذر المستودع، بعد \i tests/fixtures/prod-shape/load.sql):
--   \i tests/fixtures/prod-shape/chain-to-093.sql
--
-- الصلاحيات الافتراضية تحاكي Supabase: كل دالة وجدول جديد يُمنح لـ anon و
-- authenticated و service_role ما لم يسحبه الترحيل صراحةً — نفس سلوك الإنتاج،
-- فاختبارات ما بعد هذا الملف ترى نفس الصلاحيات التي يراها الإنتاج.
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
SET client_min_messages = warning;

-- Storage كما في الإنتاج (قراءة pg_policies و storage.buckets على srnelrdpqkcntbgudyto،
-- 2026-10-13). الملف 00_supabase_stubs.sql لا يحمل أعمدة الحدود ولا سياسات Storage،
-- و080 يُدرج مستودعه بهذه الأعمدة. سياسة continuity_attachments_read يُنشئها 080 نفسه.
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint,
                            ADD COLUMN IF NOT EXISTS allowed_mime_types text[];
INSERT INTO storage.buckets (id, name, public) VALUES
  ('avatars', 'avatars', true), ('subdomain-logos', 'subdomain-logos', true),
  ('platform-assets', 'platform-assets', true), ('tickets', 'tickets', false),
  ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
CREATE POLICY "Allow authenticated uploads" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK ((bucket_id = 'tickets'::text) AND (is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)
              OR can_access_ticket(storage_ticket_id(name))));
CREATE POLICY tickets_read_own_or_staff ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'tickets'::text) AND (is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)
         OR can_access_ticket(storage_ticket_id(name))));
CREATE POLICY "Allow authenticated users to upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK ((bucket_id = 'chat-attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));
CREATE POLICY chat_attachments_read_own_or_staff ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND (is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY public_assets_read ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = ANY (ARRAY['avatars'::text, 'platform-assets'::text, 'subdomain-logos'::text]));

\ir ../../../migrations/064_conversation_core.sql
SET search_path = public, extensions;
\ir ../../../migrations/067_conversation_core_gate.sql
SET search_path = public, extensions;
\ir ../../../migrations/068_company_account_requests.sql
SET search_path = public, extensions;
\ir ../../../migrations/069_billing_ticket_quota.sql
SET search_path = public, extensions;
\ir ../../../migrations/070_owner_admin_context_tickets.sql
SET search_path = public, extensions;
\ir ../../../migrations/071_owner_admin_context_billing_requests.sql
SET search_path = public, extensions;
\ir ../../../migrations/072_invoice_pdf_attachment.sql
SET search_path = public, extensions;
\ir ../../../migrations/073_relay_core.sql
SET search_path = public, extensions;
-- الإنتاج: مساحة المنصة مفعّلة (continuity_workspaces.enabled = true)
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
\ir ../../../migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
\ir ../../../migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;
\ir ../../../migrations/077_continuity_namespace.sql
SET search_path = public, extensions;
\ir ../../../migrations/078_continuity_policies.sql
SET search_path = public, extensions;
\ir ../../../migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;
\ir ../../../migrations/080_continuity_attachments.sql
SET search_path = public, extensions;
\ir ../../../migrations/081_continuity_handovers.sql
SET search_path = public, extensions;
\ir ../../../migrations/085_company_members_privacy.sql
SET search_path = public, extensions;
\ir ../../../migrations/086_company_staff.sql
SET search_path = public, extensions;
\ir ../../../migrations/087_continuity_edit_permissions.sql
SET search_path = public, extensions;
\ir ../../../migrations/088_integrations_hub.sql
SET search_path = public, extensions;
\ir ../../../migrations/089_continuity_attachment_cleanup_schedule.sql
SET search_path = public, extensions;
\ir ../../../migrations/090_ihub_worker_schedule.sql
SET search_path = public, extensions;
\ir ../../../migrations/091_continuity_scoped_handover.sql
SET search_path = public, extensions;
\ir ../../../migrations/092_company_feature_overrides.sql
SET search_path = public, extensions;
\ir ../../../migrations/093_continuity_collab_actions.sql
SET search_path = public, extensions;
SET client_min_messages = notice;
