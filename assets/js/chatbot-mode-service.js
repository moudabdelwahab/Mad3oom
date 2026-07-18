/**
 * chatbot-mode-service.js
 * ------------------------------------------------------------
 * طبقة بيانات/منطق مشتركة لميزة "أوضاع الشات بوت" (تقليدي / نموذج ذكاء
 * اصطناعي / تلقائي / SIE)، تُستخدم من واجهة الويدجت العائم (chat-widget.js)
 * وصفحة الشات الكاملة (chat-logic.js) بنفس المنطق بالظبط، بدل تكرار الكود.
 *
 * هذا الملف Frontend فقط، مبني على مواصفة "Chatbot Modes — Phase 1
 * Implementation Report (Revision 4)". أي جزء يعتمد على شيء لم يُبنَ في
 * الباك إند بعد (أعمدة profiles الجديدة، has_chatbot_entitlement()،
 * chat_ai_usage_counters) معلّم بـ TODO صريح تحته، ومحاط بمحاولة/فشل
 * (try/catch) بحيث لو العمود أو الدالة مش موجودة لسه، الواجهة تتدهور
 * بلطف (graceful degradation) بدل ما تكسر الشات كله.
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';

// ===================== الأوضاع المتاحة =====================
export const CHATBOT_MODES = {
    TRADITIONAL: 'traditional',
    AI_MODEL: 'ai_model',
    AUTO: 'auto',
    SIE: 'sie'
};

export const CHATBOT_MODE_LABELS = {
    [CHATBOT_MODES.TRADITIONAL]: 'تقليدي',
    [CHATBOT_MODES.AI_MODEL]: 'نموذج ذكاء اصطناعي',
    [CHATBOT_MODES.AUTO]: 'تلقائي',
    [CHATBOT_MODES.SIE]: 'محرك الدعم الذكي (SIE)'
};

export const CHATBOT_MODE_DESCRIPTIONS = {
    [CHATBOT_MODES.TRADITIONAL]: 'ردود جاهزة وقوائم اختيار سريعة، بدون أي استدعاء لنموذج ذكاء اصطناعي.',
    [CHATBOT_MODES.AI_MODEL]: 'اختر مزوّد وموديل ذكاء اصطناعي بنفسك ليرد على استفساراتك.',
    [CHATBOT_MODES.AUTO]: 'المنصة تختار أفضل موديل متاح تلقائيًا حسب الأولوية والتوفر.',
    [CHATBOT_MODES.SIE]: 'محرك الدعم الذكي: يفهم المحادثة ويقرر بنفسه استخدام أدوات MCP المناسبة.'
};

// أوضاع مدفوعة (تتطلب has_chatbot_entitlement) — التقليدي فقط مجاني دايمًا
const PAID_MODES = new Set([CHATBOT_MODES.AI_MODEL, CHATBOT_MODES.AUTO, CHATBOT_MODES.SIE]);
// من هذه الأوضاع، الاختيار الحر للمزوّد/الموديل غير متاح إلا في AI_MODEL
export const MODE_SUPPORTS_PROVIDER_SELECTION = new Set([CHATBOT_MODES.AI_MODEL]);

export function isModeAvailableForEntitlement(mode, hasEntitlement) {
    if (!PAID_MODES.has(mode)) return true;
    return !!hasEntitlement;
}

// ===================== الاشتراك/الأهلية =====================
/**
 * يعادل has_chatbot_entitlement() الموصوفة في التقرير §2.2: يقرأ نفس
 * الأعمدة المخزّنة مؤقتًا (profiles.whatsapp_enabled / profiles.role)
 * بدل الاستعلام المباشر عن whatsapp_subscriptions — هذه هي بالضبط قاعدة
 * البيانات التي ستنفّذها الدالة نفسها بمجرد إنشائها في الباك إند.
 *
 * TODO(backend, Phase A §2.2 — بانتظار موافقتكم): has_chatbot_entitlement()
 * لم تُنشأ بعد كدالة SQL. عند إنشائها، استبدل هذا الاستعلام المباشر بنداء:
 *   const { data } = await supabase.rpc('has_chatbot_entitlement');
 *   return !!data;
 * هذا يزيل الاعتماد على معرفة الواجهة الأمامية بمنطق الأهلية، ويجعل الباك
 * إند هو مصدر الحقيقة الوحيد لهذا القرار كما يُفترض معماريًا.
 */
export async function hasChatbotEntitlement(userId) {
    if (!userId) return false;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('whatsapp_enabled, role')
            .eq('id', userId)
            .maybeSingle();

        if (error || !data) {
            console.warn('[chatbot-mode-service] تعذّر التحقق من الأهلية:', error);
            return false;
        }
        return data.whatsapp_enabled === true || data.role === 'super_user' || data.role === 'admin';
    } catch (err) {
        console.warn('[chatbot-mode-service] استثناء أثناء التحقق من الأهلية:', err?.message || err);
        return false;
    }
}

// ===================== قراءة/حفظ الوضع المختار (profiles) =====================
/**
 * TODO(backend, Phase A §2.1 — بانتظار موافقتكم): الأعمدة
 * chatbot_mode / chatbot_selected_integration_id / chatbot_selected_model_id
 * غير موجودة في profiles بعد. الدالتان التاليتان تفترضان وجودها (المخطط في
 * التقرير) وتفشلان بأمان (تُرجعان قيمًا افتراضية / لا تكتبان شيئًا) لو
 * الأعمدة غير موجودة، حتى لا تُكسر باقي صفحة الإعدادات لو استُخدمت هذه
 * الواجهة قبل تنفيذ migration الأعمدة.
 */
const DEFAULT_MODE_STATE = {
    chatbot_mode: CHATBOT_MODES.TRADITIONAL,
    chatbot_selected_integration_id: null,
    chatbot_selected_model_id: null
};

export async function fetchChatbotModeState(userId) {
    if (!userId) return { ...DEFAULT_MODE_STATE };
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('chatbot_mode, chatbot_selected_integration_id, chatbot_selected_model_id')
            .eq('id', userId)
            .maybeSingle();

        if (error) {
            // العمود على الأرجح غير موجود بعد (42703) أو خطأ آخر - نرجع للوضع الافتراضي
            console.warn('[chatbot-mode-service] تعذّر جلب حالة الوضع (ربما الأعمدة غير مُنشأة بعد):', error?.message || error);
            return { ...DEFAULT_MODE_STATE };
        }
        return {
            chatbot_mode: data?.chatbot_mode || DEFAULT_MODE_STATE.chatbot_mode,
            chatbot_selected_integration_id: data?.chatbot_selected_integration_id ?? null,
            chatbot_selected_model_id: data?.chatbot_selected_model_id ?? null
        };
    } catch (err) {
        console.warn('[chatbot-mode-service] استثناء أثناء جلب حالة الوضع:', err?.message || err);
        return { ...DEFAULT_MODE_STATE };
    }
}

/**
 * يحفظ اختيار العميل. ملاحظة مهمة (§2.1 من التقرير): هذا حفظ لتفضيل العرض
 * فقط. التحقق الفعلي من إن الحساب مسموح له باختيار وضع مدفوع لازم يحصل
 * في طبقة الكتابة بالباك إند (server-side)، مش في الواجهة الأمامية فقط -
 * الفحص هنا (isModeAvailableForEntitlement) تجربة استخدام (UX) بس، وليس
 * حماية أمنية. لا تعتبر نجاح هذا الاستدعاء تأكيدًا لصلاحية الوضع.
 */
export async function saveChatbotModeState(userId, { mode, integrationId, modelId } = {}) {
    if (!userId) return { ok: false, error: 'no_user' };
    const payload = {};
    if (mode !== undefined) payload.chatbot_mode = mode;
    if (integrationId !== undefined) payload.chatbot_selected_integration_id = integrationId;
    if (modelId !== undefined) payload.chatbot_selected_model_id = modelId;
    if (Object.keys(payload).length === 0) return { ok: true };

    try {
        const { error } = await supabase.from('profiles').update(payload).eq('id', userId);
        if (error) {
            console.warn('[chatbot-mode-service] تعذّر حفظ حالة الوضع (ربما الأعمدة غير مُنشأة بعد):', error?.message || error);
            return { ok: false, error };
        }
        return { ok: true };
    } catch (err) {
        console.warn('[chatbot-mode-service] استثناء أثناء حفظ حالة الوضع:', err?.message || err);
        return { ok: false, error: err };
    }
}

// ===================== المزوّدات والموديلات (لوضع "نموذج ذكاء اصطناعي") =====================
/**
 * قراءة آمنة ومحدودة الأعمدة لصفوف external_integrations للعرض للعميل -
 * عمدًا لا تستخدم select('*') الموجودة في النسخة الإدارية (mcp-service.js /
 * api-integrations.js)، لأن تلك تجلب أعمدة قد تكون حساسة (بيانات اعتماد
 * مشفّرة، رسائل اختبار داخلية...) وغير مناسبة لعرضها لعميل عادي.
 *
 * TODO(backend): هذا الاستعلام يفترض أن RLS الحالية على external_integrations
 * تسمح لعميل عادي (غير أدمن) بقراءة الصفوف النشطة على الأقل بعمود owner_scope
 * = 'platform'. هذا لم يُتحقّق منه هنا (خارج نطاق العمل - Frontend Only)،
 * فلو الاستعلام يرجع خطأ صلاحيات (RLS)، الواجهة تتعامل معه كحالة خطأ عادية
 * وتعرض رسالة واضحة بدل ما تفشل بصمت.
 */
export async function fetchCustomerVisibleIntegrations() {
    const { data, error } = await supabase
        .from('external_integrations')
        .select('id, display_name, provider, is_active')
        .eq('owner_scope', 'platform')
        .eq('is_active', true)
        .order('display_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * قراءة الموديلات المكتشفة لتكامل معيّن - نفس شكل الجدول المستخدم فعليًا في
 * mcp-service.js:fetchIntegrationModels، بأعمدة محدودة أيضًا وواضحة لعميل.
 */
export async function fetchCustomerVisibleModels(integrationId) {
    if (!integrationId) return [];
    const { data, error } = await supabase
        .from('external_integration_models')
        .select('id, model_id, display_name, supports_tools, is_default, is_enabled')
        .eq('integration_id', integrationId)
        .eq('is_enabled', true)
        .order('display_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

// ===================== وضع "تلقائي" (Auto Mode) =====================
/**
 * TODO(backend, §3.4): منطق التقييم الفعلي (scoring بحسب priority /
 * is_default / supports_tools، مع fallback إلى DEFAULT_MODELS للتكاملات
 * النشطة بدون صفوف موديلات مكتشفة زي groq حاليًا) موصوف في التقرير كمنطق
 * Edge Function وقت الطلب الفعلي، وليس شيئًا تحسبه الواجهة الأمامية أو
 * تعرضه كنتيجة نهائية. هذه الدالة تعرض فقط للعميل *أن* الوضع التلقائي
 * سيختار الأنسب تلقائيًا وقت إرسال الرسالة، دون أن تحاول محاكاة نتيجة
 * الاختيار بنفسها في الواجهة (لتفادي عرض اختيار قد يختلف عن قرار الباك إند
 * الفعلي وقت التنفيذ).
 */
export function getAutoModeExplanation() {
    return 'في الوضع التلقائي، هيتم اختيار أفضل موديل ذكاء اصطناعي متاح تلقائيًا وقت إرسال كل رسالة، حسب الأولوية والتوفر - مش محتاج تختار حاجة بنفسك.';
}

// ===================== SIE (محرك الدعم الذكي) =====================
/**
 * SIE مذكور في التقرير كامتداد يستخدم has_chatbot_entitlement() لنفس بوابة
 * الاشتراك، ويعتمد على listAiEnabledToolsForOwner (باك إند بالكامل، غير
 * موجود في نطاق هذا الملف). لا يوجد بعد أي جدول/عمود/دالة SIE فعلية في
 * قاعدة البيانات الحية (تم التحقق أثناء فحص المستودع)، لذلك هذه الدالة
 * ترجع بيانات نائبة (placeholder) ثابتة توضح الحالة لواجهة العميل، ولا
 * تحاول الاتصال بأي شيء غير موجود.
 *
 * TODO(backend): استبدل هذا بقراءة حقيقية بمجرد تحديد شكل بيانات SIE
 * (على الأرجح عمود/دالة أهلية مشابهة + نقطة دخول Edge Function خاصة بها،
 * غير محدد بعد في التقرير بما يكفي للتنفيذ الفعلي).
 */
export function getSiePlaceholderInfo() {
    return {
        available: false,
        statusLabel: 'قريبًا',
        description: 'محرك الدعم الذكي (SIE) قيد التطوير حاليًا وسيتيح له قرار استخدام أدوات MCP المناسبة تلقائيًا أثناء المحادثة. غير متاح للاستخدام بعد.'
    };
}
