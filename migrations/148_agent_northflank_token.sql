-- ============================================================================
-- 148_agent_northflank_token.sql — توكن Northflank (قراءة فقط) لوكيل Hermes.
--
-- السياق: وكيل Hermes مستضاف على Northflank Sandbox (قرار 2026-11-27)،
-- ومقاييس CPU/RAM ومدة التشغيل لا تأتي من Hermes نفسه بل من Northflank.
-- إجراء `metrics` في agent-manager يقرأها من
-- `https://api.northflank.com/v1/projects/default/services/{slug}` —
-- والـ slug هو اسم الخدمة على Northflank.
--
-- التخزين (نفس نمط `api_key_encrypted` في هذا الجدول حرفيًا):
--   • `northflank_token_encrypted` — التوكن مشفَّر بـ AES-GCM بمفتاح
--     `AI_AGENTS_ENC_KEY` عبر `encryptText/decryptText` في agent-manager،
--     ولا يُعاد لأي واجهة أبدًا (ليس في PUBLIC_COLUMNS ولا في أي استجابة).
--   • `northflank_token_last4` — آخر 4 خانات فقط، للعرض في النموذج
--     (نفس سلوك `api_key_last4` المقنَّع).
-- العمودان nullable: وكيل بلا توكن يبقى صالحًا، وتُعرض مقاييسه من Hermes
-- وحدها مع `northflank.configured = false`.
--
-- ملاحظة ترقيم: فرع `owner-store-management-toggle` غير المدمج يحمل هو
-- الآخر ترحيلًا برقم 148 — يُحلّ التعارض عند الدمج (إعادة ترقيم أحد
-- الملفين)، ولا يُطبَّق هذا الملف حيًا قبل ذلك.
-- ============================================================================

alter table public.ai_agents
  add column if not exists northflank_token_encrypted text,
  add column if not exists northflank_token_last4 text;

comment on column public.ai_agents.northflank_token_encrypted is
  'توكن Northflank (قراءة فقط) مشفَّر بـ AES-GCM — لا يُعاد للواجهة أبدًا، مثل api_key_encrypted.';
comment on column public.ai_agents.northflank_token_last4 is
  'آخر 4 خانات من توكن Northflank — للعرض المقنَّع في النموذج فقط، مثل api_key_last4.';
