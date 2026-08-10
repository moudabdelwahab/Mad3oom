-- ============================================================================
-- 002_ai_provider_registry.sql
-- ----------------------------------------------------------------------------
-- نظام مزوّدي الذكاء الاصطناعي المرن (Provider Registry + Capabilities +
-- Routing/Fallback + Usage/Cost + Agent Sessions).
--
-- المبدأ: إضافة مزوّد جديد لاحقًا = INSERT صف واحد في ai_provider_catalog.
--         صفر تعديل كود، صفر إعادة نشر.
--
-- ⚠ هذه الـ migration ADDITIVE بالكامل:
--   - لا تحذف أي جدول أو عمود أو صف.
--   - لا تعدّل أي RLS policy موجودة.
--   - التغيير الوحيد على جدول قائم هو استبدال CHECK constraint جامد على
--     external_integrations.provider بمفتاح أجنبي على الكتالوج (بعد بذر
--     كل القيم الحالية فيه) — لا يفقد أي بيانات وقابل للتراجع بسطر واحد.
--
-- التراجع (Rollback): انظر التعليق في نهاية الملف.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) ai_provider_catalog — سجل أنواع المزوّدين (Provider Registry)
-- ----------------------------------------------------------------------------
-- كل صف يصف "نوع مزوّد" وليس بيانات اعتماد. بيانات الاعتماد تبقى في
-- external_integrations مشفّرة كما هي بالضبط.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_provider_catalog (
    id                 text PRIMARY KEY,
    label              text NOT NULL,
    label_ar           text,
    description_ar     text,

    -- ai_provider = مزوّد مباشر | ai_gateway = بوابة لعدة مزوّدين
    -- messaging / webhook / custom = تكاملات غير AI (توافق مع الموجود حاليًا)
    kind               text NOT NULL DEFAULT 'ai_provider'
                       CHECK (kind IN ('ai_provider', 'ai_gateway', 'messaging', 'webhook', 'custom')),

    -- البروتوكولات المدعومة. البروتوكول ≠ المزوّد: مزوّد واحد قد يدعم أكثر من بروتوكول
    protocols          text[] NOT NULL DEFAULT '{}',

    -- endpoint لكل بروتوكول. لا يُفترض أبدًا أن /v1 مطلوب — البروتوكول يحدّد المسار
    -- مثال AgentRouter: {"anthropic":"https://co.agentrouter.org","openai":"https://co.agentrouter.org/v1"}
    default_endpoints  jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- تخصيص مسارات غير قياسية لبروتوكول معيّن (اختياري تمامًا)
    -- مثال: {"openai":{"chat":"/chat/completions","models":"/models"}}
    endpoint_paths     jsonb NOT NULL DEFAULT '{}'::jsonb,

    auth_methods       text[] NOT NULL DEFAULT ARRAY['api_key']::text[],

    -- مواصفات الفورم الديناميكي في الواجهة (تحلّ محل الثوابت الجامدة في الـ JS)
    -- [{key,label,label_ar,type,placeholder,required}]
    credential_fields  jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- {"supported":true,"protocol":"openai","path":"/models"}
    models_discovery   jsonb NOT NULL DEFAULT '{}'::jsonb,

    default_headers    jsonb NOT NULL DEFAULT '{}'::jsonb,

    requires_base_url  boolean NOT NULL DEFAULT false,
    allows_base_url    boolean NOT NULL DEFAULT true,

    docs_url           text,
    icon               text,
    accent             text,

    is_builtin         boolean NOT NULL DEFAULT false,
    is_enabled         boolean NOT NULL DEFAULT true,
    sort_order         integer NOT NULL DEFAULT 100,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_provider_catalog IS
    'سجل أنواع مزوّدي الذكاء الاصطناعي والبوابات. إضافة مزوّد جديد = INSERT صف واحد هنا، بدون أي تعديل في الكود أو الواجهة.';

ALTER TABLE public.ai_provider_catalog ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_provider_catalog' AND policyname = 'Read provider catalog') THEN
        CREATE POLICY "Read provider catalog" ON public.ai_provider_catalog
            FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_provider_catalog' AND policyname = 'Admins manage provider catalog') THEN
        CREATE POLICY "Admins manage provider catalog" ON public.ai_provider_catalog
            FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- بذور الكتالوج. ON CONFLICT DO NOTHING → إعادة التشغيل آمنة، وأي تعديل يدوي
-- يقوم به الأدمن لاحقًا لا يُدهس.
-- ----------------------------------------------------------------------------

INSERT INTO public.ai_provider_catalog
    (id, label, label_ar, kind, protocols, default_endpoints, auth_methods, credential_fields, models_discovery,
     requires_base_url, allows_base_url, docs_url, icon, accent, is_builtin, sort_order, description_ar)
VALUES
    ('openai', 'OpenAI', 'OpenAI', 'ai_provider',
     ARRAY['openai'],
     '{"openai":"https://api.openai.com/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"sk-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://platform.openai.com/docs', 'openai', '#10a37f', true, 10,
     'الوصول المباشر لموديلات OpenAI عبر واجهة chat/completions.'),

    ('claude', 'Anthropic (Claude)', 'Claude (Anthropic)', 'ai_provider',
     ARRAY['anthropic'],
     '{"anthropic":"https://api.anthropic.com"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"sk-ant-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"anthropic","path":"/v1/models"}'::jsonb,
     false, true, 'https://docs.anthropic.com', 'anthropic', '#d97757', true, 20,
     'الوصول المباشر لموديلات Claude عبر واجهة Messages.'),

    ('gemini', 'Google Gemini', 'Gemini (Google)', 'ai_provider',
     ARRAY['gemini'],
     '{"gemini":"https://generativelanguage.googleapis.com/v1beta"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"AIza...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"gemini","path":"/models"}'::jsonb,
     false, true, 'https://ai.google.dev/docs', 'gemini', '#4285f4', true, 30,
     'موديلات Gemini عبر Generative Language API.'),

    ('openrouter', 'OpenRouter', 'OpenRouter', 'ai_gateway',
     ARRAY['openai'],
     '{"openai":"https://openrouter.ai/api/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"sk-or-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://openrouter.ai/docs', 'openrouter', '#6467f2', true, 40,
     'بوابة واحدة لعشرات المزوّدين بواجهة متوافقة مع OpenAI.'),

    ('groq', 'Groq', 'Groq', 'ai_provider',
     ARRAY['openai'],
     '{"openai":"https://api.groq.com/openai/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"gsk_...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://console.groq.com/docs', 'groq', '#f55036', true, 50,
     'استدلال سريع جدًا لموديلات مفتوحة بواجهة متوافقة مع OpenAI.'),

    -- ★ AgentRouter — بوابة رسمية داخل النظام، تدعم بروتوكولين في نفس الوقت
    ('agentrouter', 'AgentRouter', 'AgentRouter', 'ai_gateway',
     ARRAY['anthropic', 'openai'],
     '{"anthropic":"https://co.agentrouter.org","openai":"https://co.agentrouter.org/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"sk-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://agentrouter.org/docs', 'agentrouter', '#b45fe0', true, 15,
     'بوابة API واحدة لعدة موديلات (Claude / GPT / غيرها) بواجهتين: متوافقة مع Anthropic ومتوافقة مع OpenAI. الموديلات المتاحة تختلف حسب المفتاح، لذلك تُكتشف ديناميكيًا.'),

    ('deepseek', 'DeepSeek', 'DeepSeek', 'ai_provider',
     ARRAY['openai'],
     '{"openai":"https://api.deepseek.com/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"sk-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://api-docs.deepseek.com', 'deepseek', '#4d6bfe', true, 60,
     'موديلات DeepSeek (chat / reasoner) بواجهة متوافقة مع OpenAI.'),

    ('together', 'Together AI', 'Together AI', 'ai_gateway',
     ARRAY['openai'],
     '{"openai":"https://api.together.xyz/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://docs.together.ai', 'together', '#0f6fff', true, 70,
     'استضافة موديلات مفتوحة المصدر بواجهة متوافقة مع OpenAI.'),

    ('mistral', 'Mistral AI', 'Mistral AI', 'ai_provider',
     ARRAY['openai'],
     '{"openai":"https://api.mistral.ai/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://docs.mistral.ai', 'mistral', '#fa520f', true, 80,
     'موديلات Mistral بواجهة متوافقة مع OpenAI.'),

    ('xai', 'xAI (Grok)', 'xAI (Grok)', 'ai_provider',
     ARRAY['openai'],
     '{"openai":"https://api.x.ai/v1"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"xai-...","required":true}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     false, true, 'https://docs.x.ai', 'xai', '#111111', true, 90,
     'موديلات Grok بواجهة متوافقة مع OpenAI.'),

    ('telegram_bot', 'Telegram Bot', 'بوت تيليجرام', 'messaging',
     ARRAY['custom_http'],
     '{"custom_http":"https://api.telegram.org"}'::jsonb,
     ARRAY['api_key'],
     '[{"key":"bot_token","label":"Bot Token","label_ar":"توكن البوت","type":"password","placeholder":"123456:ABC-DEF...","required":true}]'::jsonb,
     '{"supported":false}'::jsonb,
     false, false, 'https://core.telegram.org/bots/api', 'telegram', '#2aabee', true, 200,
     'بوت تيليجرام لإرسال التنبيهات — ليس مزوّد ذكاء اصطناعي.'),

    ('webhook', 'Webhook', 'Webhook', 'webhook',
     ARRAY['custom_http'],
     '{}'::jsonb,
     ARRAY['none', 'api_key', 'bearer', 'custom_headers'],
     '[{"key":"url","label":"Webhook URL","label_ar":"رابط الـ Webhook","type":"url","placeholder":"https://example.com/webhook","required":true}]'::jsonb,
     '{"supported":false}'::jsonb,
     false, true, NULL, 'webhook', '#64748b', true, 210,
     'نقطة نهاية HTTP خارجية تستقبل أحداث المنصة.'),

    ('custom', 'Custom Provider', 'مزوّد مخصّص', 'custom',
     ARRAY['openai', 'anthropic', 'gemini', 'custom_http'],
     '{}'::jsonb,
     ARRAY['none', 'api_key', 'bearer', 'custom_headers'],
     '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","placeholder":"","required":false},{"key":"url","label":"Base URL","label_ar":"الرابط الأساسي","type":"url","placeholder":"https://api.example.com/v1","required":false}]'::jsonb,
     '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
     true, true, NULL, 'custom', '#8b5cf6', true, 300,
     'أي مزوّد آخر: تختار البروتوكول والرابط الأساسي بنفسك.')
ON CONFLICT (id) DO NOTHING;


-- ============================================================================
-- 2) external_integrations — أعمدة إضافية + فك القيد الجامد على provider
-- ============================================================================

ALTER TABLE public.external_integrations
    ADD COLUMN IF NOT EXISTS protocol              text,
    ADD COLUMN IF NOT EXISTS base_url              text,
    ADD COLUMN IF NOT EXISTS capabilities_override jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS tags                  text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.external_integrations.protocol IS
    'البروتوكول المستخدم فعليًا لهذا الربط (openai/anthropic/gemini/custom_http). NULL = أول بروتوكول في كتالوج المزوّد.';
COMMENT ON COLUMN public.external_integrations.base_url IS
    'رابط أساسي مخصّص يتفوّق على default_endpoints في الكتالوج. NULL = استخدام رابط الكتالوج للبروتوكول المختار.';

-- نقل أي base_url قديم كان مخزّنًا داخل credentials_meta إلى العمود الجديد (قراءة فقط، لا حذف)
UPDATE public.external_integrations
SET base_url = NULLIF(TRIM(credentials_meta ->> 'base_url'), '')
WHERE base_url IS NULL
  AND NULLIF(TRIM(credentials_meta ->> 'base_url'), '') IS NOT NULL;

-- ملء protocol للصفوف الحالية من الكتالوج (أول بروتوكول متاح)
UPDATE public.external_integrations ei
SET protocol = c.protocols[1]
FROM public.ai_provider_catalog c
WHERE ei.protocol IS NULL AND c.id = ei.provider AND array_length(c.protocols, 1) >= 1;

-- استبدال CHECK الجامد بمفتاح أجنبي على الكتالوج.
-- يُنفَّذ فقط لو كل قيم provider الحالية موجودة بالفعل في الكتالوج (وإلا يُترك القيد القديم كما هو).
DO $$
DECLARE
    v_missing integer;
BEGIN
    SELECT count(*) INTO v_missing
    FROM (SELECT DISTINCT provider FROM public.external_integrations) e
    LEFT JOIN public.ai_provider_catalog c ON c.id = e.provider
    WHERE c.id IS NULL;

    IF v_missing = 0 THEN
        ALTER TABLE public.external_integrations
            DROP CONSTRAINT IF EXISTS external_integrations_provider_check;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'external_integrations_provider_fkey'
              AND conrelid = 'public.external_integrations'::regclass
        ) THEN
            ALTER TABLE public.external_integrations
                ADD CONSTRAINT external_integrations_provider_fkey
                FOREIGN KEY (provider) REFERENCES public.ai_provider_catalog(id)
                ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
    ELSE
        RAISE NOTICE 'تم تخطي استبدال قيد provider: % قيمة غير موجودة في الكتالوج', v_missing;
    END IF;
END $$;


-- ============================================================================
-- 3) external_integration_models — نظام القدرات الموسّع
-- ============================================================================

ALTER TABLE public.external_integration_models
    ADD COLUMN IF NOT EXISTS supports_reasoning    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_coding       boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_agent        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_long_context boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_audio        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS category              text NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS capabilities          jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS capabilities_source   text NOT NULL DEFAULT 'heuristic',
    ADD COLUMN IF NOT EXISTS notes                 text;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'external_integration_models_capabilities_source_check'
          AND conrelid = 'public.external_integration_models'::regclass
    ) THEN
        ALTER TABLE public.external_integration_models
            ADD CONSTRAINT external_integration_models_capabilities_source_check
            CHECK (capabilities_source IN ('discovered', 'heuristic', 'manual'));
    END IF;
END $$;

COMMENT ON COLUMN public.external_integration_models.capabilities_source IS
    'discovered = من المزوّد مباشرة | heuristic = تخمين من اسم الموديل | manual = عدّلها الأدمن يدويًا (لا تُدهس عند إعادة المزامنة).';
COMMENT ON COLUMN public.external_integration_models.category IS
    'التصنيف الأساسي المعروض في الواجهة: general | reasoning | coding | agent | vision.';

-- تعبئة أولية للقدرات الجديدة للصفوف الموجودة (تخمين محافظ، لا يمس أي عمود قديم)
UPDATE public.external_integration_models
SET supports_long_context = true
WHERE supports_long_context = false AND context_window IS NOT NULL AND context_window >= 128000;

UPDATE public.external_integration_models
SET supports_agent = true
WHERE supports_agent = false AND supports_tools = true;


-- ============================================================================
-- 4) ai_usage_events — تتبّع الاستخدام والتكلفة (يكتبه الـ runtime فقط)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id uuid REFERENCES public.external_integrations(id) ON DELETE SET NULL,
    provider       text,
    protocol       text,
    model_id       text,
    mode           text,
    source         text NOT NULL DEFAULT 'unknown',
    session_id     uuid,
    request_id     text,
    user_id        uuid,

    status         text NOT NULL DEFAULT 'success'
                   CHECK (status IN ('success', 'error', 'fallback')),
    error_code     text,
    error_message  text,

    input_tokens   integer NOT NULL DEFAULT 0,
    output_tokens  integer NOT NULL DEFAULT 0,
    total_tokens   integer NOT NULL DEFAULT 0,
    cost           numeric(16, 8) NOT NULL DEFAULT 0,
    latency_ms     integer,
    attempt        integer NOT NULL DEFAULT 1,

    created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_usage_events IS
    'حدث لكل نداء AI (نجاح أو فشل أو تحوّل لاحتياطي). تكتبه Edge Functions بالـ service_role فقط — الواجهة تقرأ ملخصات مجمّعة.';

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_integration ON public.ai_usage_events (integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created     ON public.ai_usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_model       ON public.ai_usage_events (model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_session     ON public.ai_usage_events (session_id, created_at DESC);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_usage_events' AND policyname = 'Admins read ai usage') THEN
        CREATE POLICY "Admins read ai usage" ON public.ai_usage_events
            FOR SELECT TO authenticated USING (is_admin());
    END IF;
END $$;
-- لا توجد policy للكتابة عمدًا: الكتابة حصريًا بالـ service_role من داخل Edge Functions.


-- ============================================================================
-- 5) ai_routing_rules — التوجيه + سلسلة الاحتياطي (Fallback)
-- ----------------------------------------------------------------------------
-- سلسلة الاحتياطي = عدة صفوف بنفس (match_kind, match_value) مرتّبة بـ position.
-- position = 0 هو الأساسي (Primary)، ثم 1 = احتياطي أول، وهكذا.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_routing_rules (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL,
    match_kind     text NOT NULL DEFAULT 'mode'
                   CHECK (match_kind IN ('mode', 'capability', 'tag', 'default')),
    match_value    text,
    integration_id uuid REFERENCES public.external_integrations(id) ON DELETE CASCADE,
    model_id       text,
    position       integer NOT NULL DEFAULT 0,
    is_active      boolean NOT NULL DEFAULT true,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_routing_rules IS
    'قواعد اختيار المزوّد/الموديل حسب الوضع أو القدرة المطلوبة، مع سلسلة احتياطي مرتّبة بـ position.';

CREATE INDEX IF NOT EXISTS idx_ai_routing_rules_lookup
    ON public.ai_routing_rules (match_kind, match_value, position)
    WHERE is_active;

ALTER TABLE public.ai_routing_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_routing_rules' AND policyname = 'Admins manage routing rules') THEN
        CREATE POLICY "Admins manage routing rules" ON public.ai_routing_rules
            FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
    END IF;
END $$;


-- ============================================================================
-- 6) ai_agent_modes — الأوضاع كبيانات وليست كودًا
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_agent_modes (
    id                    text PRIMARY KEY,
    label                 text NOT NULL,
    label_ar              text,
    description_ar        text,
    required_capabilities text[] NOT NULL DEFAULT '{}'::text[],
    system_prompt         text,
    temperature           numeric(4, 2) NOT NULL DEFAULT 0.7,
    max_output_tokens     integer NOT NULL DEFAULT 2000,
    allow_tools           boolean NOT NULL DEFAULT false,
    icon                  text,
    sort_order            integer NOT NULL DEFAULT 100,
    is_enabled            boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_agent_modes IS
    'أوضاع تشغيل الوكيل (Chat/Reason/Code/Build/Debug/Review/Refactor). إضافة وضع جديد = INSERT صف، بدون تعديل كود.';

ALTER TABLE public.ai_agent_modes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_agent_modes' AND policyname = 'Read agent modes') THEN
        CREATE POLICY "Read agent modes" ON public.ai_agent_modes
            FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_agent_modes' AND policyname = 'Admins manage agent modes') THEN
        CREATE POLICY "Admins manage agent modes" ON public.ai_agent_modes
            FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
    END IF;
END $$;

INSERT INTO public.ai_agent_modes
    (id, label, label_ar, description_ar, required_capabilities, system_prompt, temperature, max_output_tokens, allow_tools, icon, sort_order)
VALUES
    ('chat', 'Chat', 'محادثة', 'محادثة عادية وأسئلة مباشرة.',
     '{}'::text[],
     'أنت مساعد تقني داخل لوحة إدارة منصة مدعوم. أجب بإيجاز ووضوح، وبنفس لغة المستخدم.',
     0.7, 2000, false, 'message', 10),

    ('reason', 'Reason', 'تحليل', 'تحليل المشكلة وتفكيكها قبل أي تنفيذ.',
     ARRAY['reasoning'],
     'أنت محلّل تقني. فكّك المشكلة إلى افتراضات ومجاهيل وخطوات تحقّق قبل اقتراح أي حل. اذكر المخاطر والمقايضات صراحةً، ولا تكتب كودًا إلا إذا طُلب منك.',
     0.4, 4000, false, 'brain', 20),

    ('code', 'Code', 'كتابة كود', 'كتابة كود لمهمة محدّدة.',
     ARRAY['coding'],
     'أنت مهندس برمجيات. اكتب كودًا صحيحًا وجاهزًا للتشغيل يطابق أسلوب المشروع القائم. اذكر مسار كل ملف قبل كتلته، ولا تشرح ما هو واضح من الكود نفسه.',
     0.2, 8000, true, 'code', 30),

    ('build', 'Build', 'تنفيذ مهمة', 'مهمة تطوير متعددة الخطوات من البداية للنهاية.',
     ARRAY['coding', 'agent'],
     'أنت وكيل تطوير. ابدأ بخطة مرقّمة قصيرة، ثم نفّذ خطوة خطوة، وأعلن بوضوح ما أُنجز وما تبقّى بعد كل خطوة. لا تعلن اكتمال المهمة إلا بعد تغطية كل بنودها.',
     0.3, 8000, true, 'layers', 40),

    ('debug', 'Debug', 'تصحيح أخطاء', 'تحليل خطأ أو سلوك غير متوقّع.',
     ARRAY['reasoning'],
     'أنت مصحّح أخطاء. ابدأ من الأعراض والأدلة المتاحة، وكوّن فرضيات مرتّبة بالاحتمالية، واقترح لكل فرضية اختبارًا يفنّدها أو يثبتها. لا تقترح إصلاحًا قبل تحديد السبب الجذري.',
     0.2, 6000, true, 'bug', 50),

    ('review', 'Review', 'مراجعة كود', 'مراجعة كود بحثًا عن أخطاء ومشاكل جودة.',
     ARRAY['coding', 'reasoning'],
     'أنت مراجع كود. ركّز على أخطاء الصحّة أولًا، ثم الأمان، ثم التبسيط والأداء. لكل ملاحظة اذكر الموقع والسيناريو الذي تفشل فيه. تجاهل تفضيلات الأسلوب الشخصية.',
     0.2, 6000, false, 'search', 60),

    ('refactor', 'Refactor', 'إعادة هيكلة', 'إعادة تنظيم وتحسين الكود دون تغيير سلوكه.',
     ARRAY['coding'],
     'أنت مسؤول عن إعادة الهيكلة. حافظ على السلوك الخارجي كما هو تمامًا، وقلّل التكرار والتعقيد. اذكر لكل تغيير ما الذي تحسّن ولماذا هو آمن.',
     0.2, 8000, true, 'refresh', 70)
ON CONFLICT (id) DO NOTHING;


-- ============================================================================
-- 7) ai_sessions / ai_session_messages — جلسات المحادثة والبرمجة
-- ----------------------------------------------------------------------------
-- ⚠ لا يوجد أي تنفيذ كود أو نظام ملفات حقيقي. workspace هنا مجرد بيان
--   (manifest) للقراءة، ونقاط الامتداد (sandbox/repository/terminal) موثّقة
--   في العمود extensions وتُرجع "غير مفعّلة" حتى يوفّرها backend لاحقًا.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_sessions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    title          text NOT NULL DEFAULT 'جلسة جديدة',
    mode           text NOT NULL DEFAULT 'chat',
    integration_id uuid REFERENCES public.external_integrations(id) ON DELETE SET NULL,
    model_id       text,
    system_prompt  text,
    workspace      jsonb NOT NULL DEFAULT '{"files":[],"source":"none"}'::jsonb,
    extensions     jsonb NOT NULL DEFAULT '{"sandbox":false,"repository":false,"github":false,"filesystem":false,"terminal":false,"code_execution":false}'::jsonb,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    total_tokens   integer NOT NULL DEFAULT 0,
    total_cost     numeric(16, 8) NOT NULL DEFAULT 0,
    last_active_at timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_owner ON public.ai_sessions (owner_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_session_messages (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   uuid NOT NULL REFERENCES public.ai_sessions(id) ON DELETE CASCADE,
    role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'event')),
    content      text NOT NULL DEFAULT '',
    mode         text,
    model_id     text,
    tool_calls   jsonb NOT NULL DEFAULT '[]'::jsonb,
    usage        jsonb NOT NULL DEFAULT '{}'::jsonb,
    channel      text NOT NULL DEFAULT 'session'
                 CHECK (channel IN ('session', 'terminal', 'changes', 'logs')),
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_session_messages_session ON public.ai_session_messages (session_id, created_at);

ALTER TABLE public.ai_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_session_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_sessions' AND policyname = 'Manage own ai sessions') THEN
        CREATE POLICY "Manage own ai sessions" ON public.ai_sessions
            FOR ALL TO authenticated
            USING (owner_id = auth.uid() OR is_admin())
            WITH CHECK (owner_id = auth.uid() OR is_admin());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_session_messages' AND policyname = 'Manage own ai session messages') THEN
        CREATE POLICY "Manage own ai session messages" ON public.ai_session_messages
            FOR ALL TO authenticated
            USING (EXISTS (SELECT 1 FROM public.ai_sessions s
                           WHERE s.id = ai_session_messages.session_id
                             AND (s.owner_id = auth.uid() OR is_admin())))
            WITH CHECK (EXISTS (SELECT 1 FROM public.ai_sessions s
                                WHERE s.id = ai_session_messages.session_id
                                  AND (s.owner_id = auth.uid() OR is_admin())));
    END IF;
END $$;


-- ============================================================================
-- 8) ملخص الاستخدام — RPC واحدة تقرأها الواجهة بدل سحب آلاف الصفوف
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_ai_usage_summary(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS TABLE (
    integration_id uuid,
    provider       text,
    model_id       text,
    requests       bigint,
    errors         bigint,
    input_tokens   bigint,
    output_tokens  bigint,
    total_tokens   bigint,
    total_cost     numeric,
    avg_latency_ms numeric,
    last_used_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        e.integration_id,
        max(e.provider)                                              AS provider,
        e.model_id,
        count(*)                                                     AS requests,
        count(*) FILTER (WHERE e.status = 'error')                   AS errors,
        coalesce(sum(e.input_tokens), 0)                             AS input_tokens,
        coalesce(sum(e.output_tokens), 0)                            AS output_tokens,
        coalesce(sum(e.total_tokens), 0)                             AS total_tokens,
        coalesce(sum(e.cost), 0)                                     AS total_cost,
        round(avg(e.latency_ms) FILTER (WHERE e.latency_ms IS NOT NULL), 0) AS avg_latency_ms,
        max(e.created_at)                                            AS last_used_at
    FROM public.ai_usage_events e
    WHERE e.created_at >= p_since
      AND public.is_admin()
    GROUP BY e.integration_id, e.model_id
    ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.get_ai_usage_summary(timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.get_ai_usage_summary(timestamptz) TO authenticated;

COMMENT ON FUNCTION public.get_ai_usage_summary(timestamptz) IS
    'ملخص استخدام/تكلفة مجمّع لكل (تكامل، موديل). يتحقّق من is_admin() داخليًا فيرجع صفرًا من الصفوف لغير الأدمن.';


COMMIT;

-- ============================================================================
-- التراجع (Rollback) — للمرجع فقط، لا يُنفَّذ تلقائيًا:
--
--   ALTER TABLE public.external_integrations DROP CONSTRAINT IF EXISTS external_integrations_provider_fkey;
--   ALTER TABLE public.external_integrations ADD CONSTRAINT external_integrations_provider_check
--       CHECK (provider IN ('openai','claude','gemini','openrouter','groq','telegram_bot','webhook','custom'));
--   DROP FUNCTION IF EXISTS public.get_ai_usage_summary(timestamptz);
--   DROP TABLE IF EXISTS public.ai_session_messages, public.ai_sessions,
--                        public.ai_agent_modes, public.ai_routing_rules,
--                        public.ai_usage_events, public.ai_provider_catalog CASCADE;
--   ALTER TABLE public.external_integrations DROP COLUMN IF EXISTS protocol, DROP COLUMN IF EXISTS base_url,
--       DROP COLUMN IF EXISTS capabilities_override, DROP COLUMN IF EXISTS tags;
--   ALTER TABLE public.external_integration_models
--       DROP COLUMN IF EXISTS supports_reasoning, DROP COLUMN IF EXISTS supports_coding,
--       DROP COLUMN IF EXISTS supports_agent, DROP COLUMN IF EXISTS supports_long_context,
--       DROP COLUMN IF EXISTS supports_audio, DROP COLUMN IF EXISTS category,
--       DROP COLUMN IF EXISTS capabilities, DROP COLUMN IF EXISTS capabilities_source,
--       DROP COLUMN IF EXISTS notes;
-- ============================================================================
