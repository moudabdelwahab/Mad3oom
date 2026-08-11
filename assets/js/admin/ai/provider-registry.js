/**
 * Provider Registry (واجهة)
 * --------------------------------------------------------
 * يقرأ ai_provider_catalog من Supabase ويخزّنه مؤقتًا في الذاكرة.
 *
 * قاعدة صارمة: لا يوجد في هذا الملف — ولا في أي ملف واجهة آخر — أي
 * `if (provider === 'agentrouter')` أو قائمة مزوّدين مكتوبة يدويًا.
 * كل ما تعرضه الواجهة عن أي مزوّد (اسمه، بروتوكولاته، روابطه، حقول
 * الاعتماد الخاصة به) يأتي من صف الكتالوج. إضافة مزوّد جديد = صف جديد.
 */

import { supabase } from '/api-config.js';

const TABLE = 'ai_provider_catalog';

let _cache = null;
let _cachedAt = 0;
const TTL_MS = 60_000;

/** أنواع المزوّدين التي تُعتبر "ذكاء اصطناعي" (بعكس messaging/webhook). */
export const AI_PROVIDER_KINDS = ['ai_provider', 'ai_gateway', 'custom'];

export const PROVIDER_KIND_LABELS = {
    ai_provider: 'مزوّد مباشر',
    ai_gateway: 'بوابة (Gateway)',
    messaging: 'مراسلة',
    webhook: 'Webhook',
    custom: 'مخصّص',
};

export const PROTOCOL_LABELS = {
    openai: 'OpenAI Compatible',
    anthropic: 'Anthropic Compatible',
    gemini: 'Gemini Compatible',
    custom_http: 'Custom HTTP API',
};

/** كل صفوف الكتالوج المفعّلة، مرتّبة كما يريد الأدمن (sort_order). */
export async function fetchProviderCatalog({ force = false } = {}) {
    if (!force && _cache && Date.now() - _cachedAt < TTL_MS) return _cache;

    const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .eq('is_enabled', true)
        .order('sort_order', { ascending: true });

    if (error) throw new Error('فشل قراءة كتالوج المزوّدين: ' + error.message);

    _cache = data || [];
    _cachedAt = Date.now();
    return _cache;
}

export function invalidateProviderCatalog() {
    _cache = null;
    _cachedAt = 0;
}

/** صف مزوّد واحد بالمعرّف، أو null. لا ترمِ استثناءً — الواجهة تعرض "غير معروف". */
export function findProvider(catalog, providerId) {
    return (catalog || []).find((p) => p.id === providerId) || null;
}

export function providerLabel(catalog, providerId) {
    return findProvider(catalog, providerId)?.label_ar
        || findProvider(catalog, providerId)?.label
        || providerId;
}

export function isAiProvider(catalog, providerId) {
    const row = findProvider(catalog, providerId);
    return !!row && AI_PROVIDER_KINDS.includes(row.kind);
}

/** البروتوكول الفعلي لتكامل: المختار، وإلا أول بروتوكول يدعمه المزوّد. */
export function effectiveProtocol(catalog, integration) {
    const row = findProvider(catalog, integration?.provider);
    const chosen = (integration?.protocol || '').trim();
    if (chosen && row?.protocols?.includes(chosen)) return chosen;
    return row?.protocols?.[0] || '';
}

/**
 * الرابط الفعلي الذي سيُستخدم — بنفس منطق الخادم بالضبط.
 * لا يُضاف "/v1" تلقائيًا: البروتوكول هو ما يحدّد المسار.
 */
export function effectiveBaseUrl(catalog, integration, protocol) {
    const row = findProvider(catalog, integration?.provider);
    const proto = protocol || effectiveProtocol(catalog, integration);

    // نفس ترتيب الخادم: رابط البروتوكول أولًا، ثم الرابط القديم (للبروتوكول
    // المختار فقط)، ثم رابط الكتالوج.
    const perProtocol = (integration?.base_urls?.[proto] || '').trim();
    const selected = (integration?.protocol || row?.protocols?.[0] || '').trim();
    const legacy = selected === proto
        ? (integration?.base_url || integration?.credentials_meta?.base_url || '').trim()
        : '';

    return (perProtocol || legacy || row?.default_endpoints?.[proto] || '').replace(/\/+$/, '');
}

/**
 * المسارات الافتراضية لكل بروتوكول — نسخة طبق الأصل مما يفعله الـ Gateway،
 * لغرض واحد فقط: عرض الرابط النهائي للمستخدم قبل الحفظ.
 *
 * السبب: البروتوكول openai يفترض أن الـ Base URL يتضمّن /v1 بالفعل، بينما
 * anthropic يفترض العكس. بدون معاينة، إدخال رابط بلا /v1 ينتهي بنداء على
 * مسار الموقع بدل الـ API ورد HTML غامض.
 */
export const PROTOCOL_PATHS = {
    openai:      { chat: '/chat/completions', models: '/models' },
    anthropic:   { chat: '/v1/messages', models: '/v1/models' },
    gemini:      { chat: '/models/{model}:generateContent', models: '/models' },
    custom_http: { chat: '', models: '' },
};

/** الروابط النهائية التي سيناديها الـ Gateway فعليًا لهذا البروتوكول. */
export function resolveEndpoints(catalog, providerId, protocol, baseUrlOverride = '') {
    const row = findProvider(catalog, providerId);
    const base = (baseUrlOverride || row?.default_endpoints?.[protocol] || '').trim().replace(/\/+$/, '');
    if (!base) return { base: '', chat: '', models: '' };

    const custom = row?.endpoint_paths?.[protocol] || {};
    const fallback = PROTOCOL_PATHS[protocol] || PROTOCOL_PATHS.custom_http;

    return {
        base,
        chat: base + (custom.chat || fallback.chat),
        models: base + (custom.models || fallback.models),
    };
}

/**
 * يبدو المفتاح مقنّعًا/ناقصًا؟ الأسباب الشائعة: نسخ القيمة المعروضة في جدول
 * المفاتيح (sk-fSDF***) بدل استخدام زر النسخ، أو قصّ ناقص.
 */
export function looksMasked(value) {
    const v = String(value || '');
    return /[*•…]/.test(v) || v.length < 12;
}

/** مواصفات حقول الاعتماد للفورم الديناميكي (تأتي من الكتالوج، ليست مكتوبة في الواجهة). */
export function credentialFields(catalog, providerId) {
    const row = findProvider(catalog, providerId);
    const fields = row?.credential_fields;
    return Array.isArray(fields) ? fields : [];
}

export function supportsModelDiscovery(catalog, providerId) {
    return findProvider(catalog, providerId)?.models_discovery?.supported !== false;
}

/** عرض المفتاح مقنّعًا من البصمة المحفوظة، دون قراءة المفتاح نفسه أبدًا. */
export function maskedKey(integration) {
    const meta = integration?.credentials_meta || {};
    if (!meta.key_last_four) return null;
    return `${meta.key_prefix || ''}${'•'.repeat(8)}${meta.key_last_four}`;
}
