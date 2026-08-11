-- ============================================================================
-- 003 — متابعات نظام مزوّدي الذكاء الاصطناعي
-- ----------------------------------------------------------------------------
-- كل ما في هذا الملف additive وآمن وقابل للتراجع، ولا يحذف أي بيانات.
-- الملف يوثّق تغييرات طُبّقت على قاعدة البيانات أثناء تشغيل النظام مع مزوّد
-- حقيقي (AgentRouter)، حتى تبقى بيئة جديدة قابلة للبناء من الصفر بنفس النتيجة.
--
-- المحتوى:
--   1. external_integrations.base_urls   — رابط أساسي مستقل لكل بروتوكول
--   2. ai_provider_catalog.default_model — ملاذ أخير لاسم الموديل
--   3. سياسة كتابة على external_integration_models (كانت SELECT فقط)
--   4. تحديث صف AgentRouter: المضيف الرسمي + اكتشاف الموديلات عبر /v1beta
--
-- التراجع (rollback) في نهاية الملف كتعليق.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) رابط أساسي لكل بروتوكول
-- ----------------------------------------------------------------------------
-- العمود القديم base_url واحد لكل تكامل، وهذا لا يكفي لمزوّد يتكلم أكثر من
-- بروتوكول: AgentRouter يحتاج https://agentrouter.org لبروتوكول anthropic
-- (لأن البروتوكول نفسه يضيف /v1/messages) و https://agentrouter.org/v1
-- لبروتوكول openai. رابط واحد مطبَّق على الاثنين كان يرسل اكتشاف الموديلات
-- إلى مسار صفحة الويب فيرجع HTML بدل JSON.
--
-- base_url القديم يبقى كما هو ويظل يعمل — يُطبَّق على البروتوكول المختار فقط.
ALTER TABLE public.external_integrations
    ADD COLUMN IF NOT EXISTS base_urls jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.external_integrations.base_urls IS
    'رابط أساسي مستقل لكل بروتوكول: {"anthropic":"https://...","openai":"https://.../v1"}. فارغ = استخدم default_endpoints من الكتالوج.';

-- ----------------------------------------------------------------------------
-- 2) موديل افتراضي على مستوى المزوّد
-- ----------------------------------------------------------------------------
-- بدونه كان النداء يفشل بـ "لم يُحدَّد موديل" لمجرد أن المزامنة لم تُشغَّل بعد،
-- أو لأن المزوّد لا يعرض قائمة موديلات أصلاً. هذه بيانات في الكتالوج وليست
-- خريطة مكتوبة في الكود، فيستفيد منها كل مسار (الشات بوت والبوابة معًا).
ALTER TABLE public.ai_provider_catalog
    ADD COLUMN IF NOT EXISTS default_model text;

COMMENT ON COLUMN public.ai_provider_catalog.default_model IS
    'اسم موديل يُستخدم كملاذ أخير عندما لا يوجد موديل محدّد يدويًا ولا مكتشف.';

-- ----------------------------------------------------------------------------
-- 3) صلاحية الكتابة على جدول الموديلات
-- ----------------------------------------------------------------------------
-- الجدول كان يحمل سياسة SELECT فقط مع تفعيل RLS، فكل كتابة من لوحة الإدارة
-- (تفعيل/تعطيل موديل، تعيين افتراضي، حفظ القدرات) كانت تُرفض بصمت: الواجهة
-- تعرض نجاحًا والصف لا يتغيّر. السياسة هنا تعكس صلاحيات external_integrations
-- نفسها حرفيًا — لا تمنح أحدًا وصولًا جديدًا على تكامل لا يملكه أصلاً.
DROP POLICY IF EXISTS "Manage models of writable integrations" ON public.external_integration_models;

CREATE POLICY "Manage models of writable integrations"
    ON public.external_integration_models
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.external_integrations ei
            WHERE ei.id = external_integration_models.integration_id
              AND (
                  public.is_admin()
                  OR (ei.owner_scope <> 'platform' AND public.is_owner_or_super_of(ei.owner_id))
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.external_integrations ei
            WHERE ei.id = external_integration_models.integration_id
              AND (
                  public.is_admin()
                  OR (ei.owner_scope <> 'platform' AND public.is_owner_or_super_of(ei.owner_id))
              )
        )
    );

-- ----------------------------------------------------------------------------
-- 4) صف AgentRouter — تصحيح المضيف ومسار اكتشاف الموديلات
-- ----------------------------------------------------------------------------
-- مضيفان بنفس الاسم تقريبًا، ووظيفتان مختلفتان تمامًا — قيس ولا تخمّن:
--
--   agentrouter.org      → الموقع/الكونسول، خلفه Aliyun WAF. يرد 200 مع صفحة
--                          HTML لأي مسار API، حتى مع ترويسات متصفّح كاملة
--                          (User-Agent / Referer / Sec-Fetch-*). غير صالح
--                          كمضيف API من الخادم إطلاقًا.
--   co.agentrouter.org   → واجهة الـ API الحقيقية (nginx + new-api).
--                          GET /v1/models بلا مفتاح  → 401 JSON:
--                            "Missing API Key! Please provide
--                             'Authorization: Bearer <token>', 'x-google-api-key',
--                             'x-goog-api-key', or 'x-api-key' header."
--                          أي أنها تقبل أكثر من ترويسة مصادقة، فبروتوكولا
--                          anthropic (x-api-key) و openai (Bearer) كلاهما يعمل.
--                          /v1beta/models عليها → 404، فلا وجود لمسار Gemini.
--
-- لذلك: المضيف يبقى co.agentrouter.org كما في 002، ولا يُضاف بروتوكول gemini.
-- الجديد هنا هو default_model فقط. الصفحة الرسمية تعلن مسارات (/v1/rerank,
-- /v1beta/models …) لكنها لا تدل على المضيف — وهذه بالضبط كانت مصدر الخطأ.
--
-- ملاحظة: لو فشل مسار الاكتشاف المعلن، تُجرَّب بقية بروتوكولات المزوّد تلقائيًا
-- (راجع resolveDiscoveryProtocols في ai-gateway/catalog.ts) — لا افتراض بأن
-- كل مزوّد يعرض الموديلات على نفس المسار أو بنفس آلية المصادقة.
UPDATE public.ai_provider_catalog
SET protocols         = ARRAY['anthropic', 'openai'],
    default_endpoints = '{"anthropic":"https://co.agentrouter.org","openai":"https://co.agentrouter.org/v1"}'::jsonb,
    models_discovery  = '{"supported":true,"protocol":"openai"}'::jsonb,
    default_model     = 'claude-opus-4-8',
    updated_at        = now()
WHERE id = 'agentrouter';

COMMIT;

-- ============================================================================
-- التراجع (نفّذه يدويًا فقط عند الحاجة):
--
--   BEGIN;
--   UPDATE public.ai_provider_catalog
--   SET models_discovery = '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
--       default_model    = NULL
--   WHERE id = 'agentrouter';
--
--   DROP POLICY IF EXISTS "Manage models of writable integrations" ON public.external_integration_models;
--   ALTER TABLE public.ai_provider_catalog     DROP COLUMN IF EXISTS default_model;
--   ALTER TABLE public.external_integrations   DROP COLUMN IF EXISTS base_urls;
--   COMMIT;
--
-- تحذير: إسقاط base_urls يفقد أي روابط لكل بروتوكول أدخلها الأدمن.
-- ============================================================================
