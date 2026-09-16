/**
 * mcp-ui-state.js — منطق الحالة والأخطاء لواجهة تكاملات MCP.
 * ------------------------------------------------------------
 * مفصول عن mcp-integrations.js عمدًا: هذا الملف بلا أي استيراد، فيمكن
 * اختباره في Node مباشرة. الوحدة الأخرى تستورد supabase عبر mcp-service.js
 * ولا تعمل خارج المتصفح.
 *
 * ملاحظة على القيم النصّية أدناه ('connected' / 'error'): هي نفس قيم
 * MCP_STATUSES في mcp-service.js، وهي قيم عمود status في
 * mcp_server_connections. نكرّرها هنا نصًّا لإبقاء الملف بلا تبعيات؛
 * أي تغيير في تلك القيم لا بد أن ينعكس هنا.
 */

const DB_CONNECTED = 'connected';
const DB_ERROR = 'error';

/* ══════════════════ حالات العرض ══════════════════ */

/**
 * الحالات المخزّنة في mcp_server_connections.status أربع فقط:
 * connected / disconnected / error / pending.
 *
 * الحالتان المطلوبتان في التصميم — connecting و authorization_required —
 * غير مخزَّنتين، ولا نضيف عمودًا لأجلهما (لا migration في هذه المرحلة).
 * فتُشتقّان للعرض فقط:
 *   connecting            → حالة عابرة في الواجهة أثناء عملية جارية
 *   authorization_required → يُستنتج من غياب توكن OAuth أو من نص الخطأ
 *
 * هذا اشتقاق عرض لا ادّعاء تخزين — لا شيء يُكتب في القاعدة.
 */
export const UI_STATES = {
    CONNECTED: 'connected',
    CONNECTING: 'connecting',
    AUTH_REQUIRED: 'auth_required',
    ERROR: 'error',
    DISCONNECTED: 'disconnected',
};

export const STATE_LABEL = {
    connected: 'متصل',
    connecting: 'جارٍ الربط',
    auth_required: 'يحتاج تفويض',
    error: 'فشل الاتصال',
    disconnected: 'غير متصل',
};

/** أنماط تدلّ على أن المشكلة تفويض لا عطل عام. */
const AUTH_ERROR_PATTERNS = [
    /\b401\b/, /\b403\b/, /unauthor/i, /forbidden/i, /invalid[_\s-]?token/i,
    /expired/i, /توكن/, /تفويض/, /صلاحية/, /المصادقة/,
];

function looksLikeAuthProblem(message) {
    if (!message) return false;
    return AUTH_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * يشتقّ حالة العرض من صف الاتصال كما تعيده fetchServers().
 * @param {object|null} server
 * @returns {string} إحدى قيم UI_STATES
 */
export function deriveUiState(server) {
    if (!server || !server.connection_id) return UI_STATES.DISCONNECTED;

    if (server.status === DB_CONNECTED) return UI_STATES.CONNECTED;

    // اتصال OAuth أُنشئ ولم يكتمل تفويضه بعد: لا توكن ⇒ ينقصه تفويض،
    // لا «خطأ». التمييز مهم لأن الإجراء المطلوب مختلف تمامًا.
    const isOauth = server.auth_type === 'oauth2';
    const hasToken = Boolean(server.oauth_token_expires_at);

    if (server.status === DB_ERROR) {
        if (isOauth && (!hasToken || looksLikeAuthProblem(server.last_error))) return UI_STATES.AUTH_REQUIRED;
        if (looksLikeAuthProblem(server.last_error)) return UI_STATES.AUTH_REQUIRED;
        return UI_STATES.ERROR;
    }

    if (isOauth && !hasToken) return UI_STATES.AUTH_REQUIRED;
    return UI_STATES.DISCONNECTED;
}

/* ══════════════════ ترجمة الأخطاء ══════════════════ */

/**
 * يحوّل رسالة تقنية إلى شيء يفهمه المستخدم ويعرف ما يفعله حياله.
 * الرسالة الأصلية لا تُفقد أبدًا — تُعاد في `detail` وتُعرض تحت
 * «عرض التفاصيل التقنية».
 *
 * @param {string} raw
 * @returns {{title:string, message:string, action:string, detail:string}}
 */
export function explainError(raw) {
    const text = String(raw || '').trim();
    const detail = text || 'لا توجد تفاصيل إضافية.';

    const rules = [
        {
            when: /\b401\b|unauthor|invalid[_\s-]?token|توكن غير|المصادقة مرفوضة/i,
            title: 'التفويض لم يُقبل',
            message: 'الخدمة رفضت بيانات الدخول المحفوظة. غالبًا انتهت صلاحيتها أو أُلغيت من جهة الخدمة.',
            action: 'إعادة الربط',
        },
        {
            when: /\b403\b|forbidden|الوصول مرفوض/i,
            title: 'الصلاحيات غير كافية',
            message: 'الحساب مربوط لكنه لا يملك صلاحية تنفيذ هذه العملية على الخدمة.',
            action: 'إعادة الربط بصلاحيات أوسع',
        },
        {
            when: /\b404\b|not found|غير موجود/i,
            title: 'العنوان غير صحيح',
            message: 'لم نجد نقطة نهاية MCP على هذا الرابط. تأكد أنه الرابط الذي توفّره الخدمة للاتصال.',
            action: 'مراجعة الرابط',
        },
        {
            when: /\b405\b|only post|يحوّل الطلب/i,
            title: 'الرابط لا يستقبل هذا النوع من الطلبات',
            message: 'العنوان المُدخل على الأرجح ليس نقطة نهاية MCP، أو أنه يحوّل الطلب إلى عنوان آخر.',
            action: 'مراجعة الرابط',
        },
        {
            when: /\b406\b/,
            title: 'الخدمة رفضت صيغة الرد',
            message: 'حدث تعارض في التفاوض على صيغة الرد مع الخدمة.',
            action: 'إعادة المحاولة',
        },
        {
            when: /\b429\b|rate limit|حد الطلبات/i,
            title: 'تم تجاوز حد الطلبات',
            message: 'الخدمة تستقبل طلبات أكثر مما تسمح به حاليًا.',
            action: 'إعادة المحاولة بعد قليل',
        },
        {
            when: /timeout|مهلة|abort/i,
            title: 'الخدمة لم تستجب',
            message: 'انتهت المهلة قبل أن يصل رد. قد تكون الخدمة متوقفة مؤقتًا أو بطيئة.',
            action: 'إعادة المحاولة',
        },
        {
            when: /\b5\d\d\b|internal error|خطأ داخلي/i,
            title: 'عطل لدى الخدمة',
            message: 'المشكلة من جهة الخدمة نفسها لا من إعدادك.',
            action: 'إعادة المحاولة لاحقًا',
        },
        {
            when: /access token|لا يوجد OAuth|أعد ربط الخادم عبر OAuth/i,
            title: 'الربط لم يكتمل',
            message: 'لم يصلنا تفويض من الخدمة بعد. أكمل تسجيل الدخول والموافقة.',
            action: 'إكمال الربط',
        },
    ];

    const hit = rules.find((r) => r.when.test(text));
    if (hit) return { title: hit.title, message: hit.message, action: hit.action, detail };

    return {
        title: 'تعذّر الاتصال بالخدمة',
        message: 'لم ينجح الاتصال. التفاصيل التقنية بالأسفل تساعد فريق الدعم على تحديد السبب.',
        action: 'إعادة المحاولة',
        detail,
    };
}

/* ══════════════════ التحقق من قيم الاعتماد ══════════════════ */

/**
 * يمنع القيم التي سترفضها الخدمة لاحقًا، قبل أن يُرسَل المستخدم إليها.
 *
 * سبب وجود هذه الدالة: اتصال Supabase حُفظ بـClient ID = رابط المشروع
 * (`https://<ref>.supabase.co`) بدل معرّف تطبيق OAuth. الواجهة قبلت القيمة
 * بلا اعتراض، فظهر العطل أخيرًا على صفحة Supabase نفسها كـ
 * `{"message":"client_id: Invalid UUID"}` — رسالة إنجليزية، في مكان آخر،
 * بعد أن غادر المستخدم المنصّة. الفحص هنا يوقف ذلك عند الحقل.
 *
 * @param {string} serviceKey مفتاح الخدمة في الكتالوج (supabase/github/…)
 * @param {string} fieldName  oauth_client_id | oauth_client_secret | bearer_token | api_key
 * @param {string} value      ما أدخله المستخدم
 * @returns {string|null} رسالة الخطأ، أو null إن كانت القيمة مقبولة
 */
export function validateCredential(serviceKey, fieldName, value) {
    const raw = String(value ?? '');
    const v = raw.trim();

    if (!v) return 'هذا الحقل مطلوب.';

    // رابط في خانة اعتماد خطأ دائمًا، لأي خدمة: لا مزوّد يستخدم URL كمعرّف
    // أو مفتاح. وهو أشيع خطأ لصق، فيستحق رسالة تسمّي ما حدث.
    if (/^https?:\/\//i.test(v)) {
        return 'هذه القيمة رابط (URL)، وليست معرّف تطبيق أو مفتاحًا. الصق القيمة نفسها من إعدادات الخدمة لا رابط لوحتها.';
    }

    // المسافات الطرفية تُقصّ قبل الفحص؛ مسافة في المنتصف تعني لصقًا ناقصًا.
    if (/\s/.test(v)) return 'القيمة تحتوي على مسافات — تأكد أنك نسختها كاملة وبلا زيادة.';

    // Supabase يصدر معرّف تطبيق OAuth على هيئة UUID، ويرفض أي شكل آخر
    // برسالة "client_id: Invalid UUID" — فنفحصه هنا بدل تركه يفشل هناك.
    if (serviceKey === 'supabase' && fieldName === 'oauth_client_id' && !isUuid(v)) {
        return 'معرّف تطبيق OAuth في Supabase يكون على هيئة UUID مثل 123e4567-e89b-12d3-a456-426614174000. راجع إعدادات المنظمة ← OAuth Apps.';
    }

    return null;
}

/** @param {string} s */
export function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s).trim());
}

/* ══════════════════ ملخّص الصحة وترتيب العرض ══════════════════ */

/**
 * الترتيب الذي تُقترح به الخدمات في «الأكثر استخدامًا» داخل نافذة الإضافة.
 *
 * قائمة ثابتة مقصودة، لا إحصاء: لا يوجد في القاعدة أي عدّاد استخدام
 * لخدمات الكتالوج، فادّعاء «الأكثر استخدامًا» من بيانات غير موجودة كذب
 * في الواجهة. هذه ترتيب افتراضي مُحرَّر يدويًا — أسهل ثلاثة مسارات ربط
 * أولًا — ويُستبدل بإحصاء حقيقي متى وُجد عمود يحمله.
 *
 * تعيش هنا لا في mcp-service.js لأن mcp-service.js له نسختان متطابقتان
 * في المستودع (الجذر و mcp/)، وإضافة حقل إلى الكتالوج كانت ستُلزم
 * تعديلهما معًا أو تُفرّقهما. هذا ترتيب عرض بحت، فمكانه وحدة العرض.
 */
export const POPULAR_KEYS = ['github', 'supabase', 'notion'];

/** @param {string} key @returns {boolean} */
export function isPopular(key) {
    return POPULAR_KEYS.includes(key);
}

/**
 * الحالات التي تعني «هذا الاتصال لا يعمل الآن ويحتاج تدخّلًا».
 * disconnected ليست منها: اتصال مفصول عمدًا ليس عطلًا.
 */
const ATTENTION_STATES = [UI_STATES.ERROR, UI_STATES.AUTH_REQUIRED];

/** @param {string} state @returns {boolean} */
export function needsAttention(state) {
    return ATTENTION_STATES.includes(state);
}

/**
 * عدّادات شريط الملخّص فوق شبكة التكاملات.
 *
 * تُحسب من نفس الصفوف المعروضة لا من استعلام منفصل، فلا يمكن أن يختلف
 * العدّاد عمّا تراه العين. `tools` يجمع أدوات الاتصالات المتصلة فقط:
 * عدّ أدوات اتصال فاشل يعطي رقمًا لا يقابله شيء قابل للاستدعاء.
 *
 * @param {Array} rows صفوف الخوادم المعروضة (كل منها له connection_id)
 * @param {(server:any)=>string} stateOf دالة اشتقاق الحالة — تُمرَّر
 *        لتُحقَن حالة «جارٍ الربط» العابرة من الوحدة المستدعية.
 * @returns {{total:number, connected:number, attention:number, tools:number}}
 */
export function summarize(rows, stateOf = deriveUiState) {
    const list = Array.isArray(rows) ? rows : [];
    let connected = 0;
    let attention = 0;
    let tools = 0;

    for (const server of list) {
        const state = stateOf(server);
        if (state === UI_STATES.CONNECTED) {
            connected += 1;
            if (Array.isArray(server?.tools)) tools += server.tools.length;
        }
        if (needsAttention(state)) attention += 1;
    }

    return { total: list.length, connected, attention, tools };
}

/**
 * يرتّب الصفوف بحيث يظهر ما يحتاج تدخّلًا أولًا.
 *
 * ترتيب ثابت (stable): داخل كل مجموعة يبقى ترتيب المصدر كما هو، حتى لا
 * تقفز البطاقات بين إعادة رسم وأخرى. لا يُعدِّل المصفوفة الأصلية.
 *
 * @param {Array} rows
 * @param {(server:any)=>string} stateOf
 * @returns {Array}
 */
export function sortByHealth(rows, stateOf = deriveUiState) {
    const rank = (server) => {
        const state = stateOf(server);
        if (needsAttention(state)) return 0;
        if (state === UI_STATES.CONNECTED || state === UI_STATES.CONNECTING) return 1;
        return 2;
    };
    return (Array.isArray(rows) ? rows : [])
        .map((server, i) => ({ server, i, r: rank(server) }))
        .sort((a, b) => (a.r - b.r) || (a.i - b.i))
        .map((x) => x.server);
}
