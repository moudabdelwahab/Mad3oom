/**
 * Capability Registry (واجهة)
 * --------------------------------------------------------
 * المكان الوحيد الذي يعرّف "ما هي القدرات" وكيف تُعرض. أي قدرة جديدة
 * يضيفها الخادم مستقبلاً = سطر واحد هنا، والواجهة كلها تعرضها تلقائيًا
 * (الشارات، الفلاتر، شرط فتح بيئة التطوير... كلها مبنية على هذا السجل).
 */

/** مفتاح العمود في قاعدة البيانات ← تعريف العرض. الترتيب هو ترتيب العرض. */
export const CAPABILITIES = [
    { key: 'chat',         column: 'supports_chat',          label: 'محادثة',      en: 'Chat',        icon: 'message' },
    { key: 'reasoning',    column: 'supports_reasoning',     label: 'تفكير',       en: 'Reasoning',   icon: 'brain' },
    { key: 'coding',       column: 'supports_coding',        label: 'برمجة',       en: 'Coding',      icon: 'code' },
    { key: 'tools',        column: 'supports_tools',         label: 'أدوات',       en: 'Tools',       icon: 'tool' },
    { key: 'agent',        column: 'supports_agent',         label: 'وكيل',        en: 'Agent',       icon: 'layers' },
    { key: 'vision',       column: 'supports_vision',        label: 'رؤية',        en: 'Vision',      icon: 'eye' },
    { key: 'longContext',  column: 'supports_long_context',  label: 'سياق طويل',   en: 'Long Ctx',    icon: 'expand' },
    { key: 'streaming',    column: 'supports_streaming',     label: 'بث',          en: 'Streaming',   icon: 'zap' },
    { key: 'audio',        column: 'supports_audio',         label: 'صوت',         en: 'Audio',       icon: 'mic' },
];

/** التصنيفات المعروضة كفلاتر أعلى قائمة الموديلات. */
export const MODEL_CATEGORIES = [
    { id: 'all',       label: 'الكل' },
    { id: 'agent',     label: 'وكيل (Agent)' },
    { id: 'reasoning', label: 'تفكير (Reasoning)' },
    { id: 'coding',    label: 'برمجة (Coding)' },
    { id: 'vision',    label: 'رؤية (Vision)' },
    { id: 'general',   label: 'عام (General)' },
];

/** القدرات التي تفتح "بيئة التطوير" بدل صندوق الشات العادي. */
export const DEV_ENVIRONMENT_CAPABILITIES = ['coding', 'reasoning', 'agent'];

const CAP_BY_KEY = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c]));

/** يحوّل صف موديل من قاعدة البيانات إلى كائن قدرات مسطّح. */
export function toCapabilityMap(modelRow) {
    const out = {};
    for (const cap of CAPABILITIES) out[cap.key] = !!modelRow?.[cap.column];
    return out;
}

export function hasCapability(modelRow, key) {
    const cap = CAP_BY_KEY[key];
    return !!(cap && modelRow?.[cap.column]);
}

/** هل يستحق هذا الموديل زر "افتح بيئة التطوير"؟ */
export function supportsDevEnvironment(modelRow) {
    return DEV_ENVIRONMENT_CAPABILITIES.some((key) => hasCapability(modelRow, key));
}

/** القدرات المفعّلة فقط، جاهزة للعرض كشارات. */
export function activeCapabilities(modelRow) {
    return CAPABILITIES.filter((cap) => modelRow?.[cap.column]);
}

/** هل يحقّق الموديل كل القدرات التي يطلبها وضع معيّن (ai_agent_modes.required_capabilities)؟ */
export function meetsRequirements(modelRow, requiredCapabilities = []) {
    return (requiredCapabilities || []).every((key) => hasCapability(modelRow, key));
}

export function categoryLabel(id) {
    return MODEL_CATEGORIES.find((c) => c.id === id)?.label || id;
}

/** تنسيق نافذة السياق بشكل مقروء (128000 ← 128K). */
export function formatContext(tokens) {
    if (!tokens) return null;
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
    return String(tokens);
}

/** السعر مخزّن لكل توكن — نعرضه لكل مليون لأنه الشكل المألوف في التسعير. */
export function formatPricePerMillion(pricePerToken) {
    if (pricePerToken == null) return null;
    const perMillion = Number(pricePerToken) * 1_000_000;
    if (!Number.isFinite(perMillion) || perMillion === 0) return null;
    return `$${perMillion < 1 ? perMillion.toFixed(3) : perMillion.toFixed(2)}/M`;
}
