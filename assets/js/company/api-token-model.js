/**
 * api-token-model.js — لغة مفاتيح API كوحدات خالصة.
 *
 * الملف ده **مرآة** لعقد الدالة المنشورة create-api-token (تمّت قراءته من
 * الإنتاج، لا من الذاكرة). أي قيمة هنا موجودة هناك حرفيًا:
 *
 *   POST create-api-token   (verify_jwt: true)
 *   body { name, description?, credential_type?, scopes?, expires_at? }
 *     name             مطلوب، ≤ 80 حرفًا
 *     description      اختياري، ≤ 200 حرف
 *     credential_type  'api_key_secret' | 'bearer' | 'both'
 *     scopes           مصفوفة من ALLOWED_SCOPES أدناه (غيابها ⇒ DEFAULT_SCOPES)
 *     expires_at       تاريخ صالح لـnew Date()، أو غيابه ⇒ بلا انتهاء
 *   200 → { token, secret } | { token, bearer_token }
 *       | { credential_group_id, api_key_secret:{…}, bearer:{…} }
 *
 * قاعدة الثقة: التحقّق هنا **راحة للمستخدم**، والرفض النهائي عند الدالة.
 * كل رسالة خطأ هنا مطابقة لما ترده الدالة، عشان ما يبقاش في تعريفين لنفس
 * القاعدة يفترقا مع الوقت.
 */

/** القائمة المسموحة كما هي في الدالة المنشورة — لا نُنقص ولا نزيد. */
export const ALLOWED_SCOPES = Object.freeze([
    'tickets:read', 'tickets:write', 'tickets:delete',
    'knowledge_base:read', 'knowledge_base:write',
    'customers:read', 'customers:write',
    'whatsapp:read', 'whatsapp:send',
    'analytics:read',
    'settings:manage',
    'oauth:manage',
    'mcp:connect',
    'chatbot:read',
    'admin:full',
    'subscriptions:read', 'subscriptions:write', 'subscriptions:renew',
    'subscriptions:cancel', 'subscriptions:plans',
    'notifications:read', 'notifications:send', 'notifications:manage'
]);

/** ما تختاره الدالة تلقائيًا حين لا تُرسل scopes إطلاقًا. */
export const DEFAULT_SCOPES = Object.freeze([
    'tickets:read', 'tickets:write', 'whatsapp:send', 'whatsapp:read', 'chatbot:read'
]);

/**
 * صلاحيات **لا تعرضها لوحة الشركة**.
 *
 * الثلاثة دي صلاحيات مشغّل منصة لا صاحب شركة: admin:full صُمّمت لتخطّي
 * الفحوص، settings:manage تمسّ إعدادات المنصة، oauth:manage تدير عملاء
 * OAuth. الدالة المنشورة تقبلها من **أي** حساب مسجّل (لا فحص رتبة فيها)،
 * فامتناع اللوحة عن عرضها أقلّ امتيازٍ ممكن — ومع ذلك هو **ليس حاجزًا
 * أمنيًا**: من ينادي الدالة مباشرةً يتخطّاه. الثغرة في الخادم لا هنا،
 * ومكانها الصحيح فحص رتبة داخل create-api-token نفسها.
 */
export const PRIVILEGED_SCOPES = Object.freeze(['admin:full', 'settings:manage', 'oauth:manage']);

/** الصلاحيات المعروضة، مبوّبة بالعربي. المفاتيح تقنية والعرض بشري. */
export const SCOPE_CATALOG = Object.freeze([
    {
        key: 'tickets',
        label: 'التذاكر',
        hint: 'قراءة تذاكرك وتذاكر عملائك والكتابة فيها',
        scopes: [
            { key: 'tickets:read', label: 'قراءة التذاكر' },
            { key: 'tickets:write', label: 'إنشاء التذاكر والرد عليها' },
            { key: 'tickets:delete', label: 'حذف التذاكر', danger: true }
        ]
    },
    {
        key: 'whatsapp',
        label: 'واتساب',
        hint: 'إرسال الرسائل وقراءة حالتها',
        scopes: [
            { key: 'whatsapp:read', label: 'قراءة الرسائل والحالة' },
            { key: 'whatsapp:send', label: 'إرسال الرسائل' }
        ]
    },
    {
        key: 'customers',
        label: 'العملاء',
        hint: 'بيانات عملائك المرتبطين بحسابك',
        scopes: [
            { key: 'customers:read', label: 'قراءة بيانات العملاء' },
            { key: 'customers:write', label: 'تعديل بيانات العملاء' }
        ]
    },
    {
        key: 'knowledge_base',
        label: 'قاعدة المعرفة',
        hint: 'مقالات المساعدة',
        scopes: [
            { key: 'knowledge_base:read', label: 'قراءة المقالات' },
            { key: 'knowledge_base:write', label: 'تحرير المقالات' }
        ]
    },
    {
        key: 'subscriptions',
        label: 'الاشتراكات',
        hint: 'قراءة اشتراكاتك وإجراءات التجديد والإلغاء',
        scopes: [
            { key: 'subscriptions:read', label: 'قراءة الاشتراكات' },
            { key: 'subscriptions:plans', label: 'قراءة الباقات' },
            { key: 'subscriptions:write', label: 'تعديل الاشتراكات' },
            { key: 'subscriptions:renew', label: 'التجديد' },
            { key: 'subscriptions:cancel', label: 'الإلغاء', danger: true }
        ]
    },
    {
        key: 'notifications',
        label: 'الإشعارات',
        hint: 'قراءة الإشعارات وإرسالها',
        scopes: [
            { key: 'notifications:read', label: 'قراءة الإشعارات' },
            { key: 'notifications:send', label: 'إرسال الإشعارات' },
            { key: 'notifications:manage', label: 'إدارة الإشعارات' }
        ]
    },
    {
        key: 'tools',
        label: 'التحليلات والأدوات',
        hint: 'تقارير للقراءة فقط، وربط الأدوات الخارجية',
        scopes: [
            { key: 'analytics:read', label: 'قراءة التحليلات' },
            { key: 'chatbot:read', label: 'قراءة بيانات الشات بوت' },
            { key: 'mcp:connect', label: 'ربط عميل MCP' }
        ]
    }
]);

/** كل الصلاحيات المعروضة مسطّحة — مصدر واحد للتحقّق ولا قائمة ثانية. */
export const SELECTABLE_SCOPES = Object.freeze(
    SCOPE_CATALOG.flatMap(group => group.scopes.map(s => s.key))
);

export const CREDENTIAL_TYPES = Object.freeze([
    {
        key: 'api_key_secret',
        label: 'مفتاح + سرّ',
        hint: 'الشكل الكلاسيكي: يُرسَل كـ Bearer &lt;api_key&gt;.&lt;secret&gt;',
        recommended: true
    },
    {
        key: 'bearer',
        label: 'رمز Bearer واحد',
        hint: 'رمز واحد يُرسَل كما هو — أبسط في الأدوات الجاهزة'
    },
    {
        key: 'both',
        label: 'الاثنان معًا',
        hint: 'يُنشئ اعتمادين مرتبطين، لكل واحد سطر في القائمة'
    }
]);

/**
 * مُدد الانتهاء المعروضة. القيمة أيام؛ و0 تعني «بلا انتهاء».
 *
 * قرار منتَجي: الافتراضي 90 يومًا لا «بلا انتهاء» — مفتاح دائم لا يُدوَّر
 * هو أطول نافذة تسريب ممكنة، والافتراضات هي ما يختاره أغلب الناس فعلًا.
 */
export const EXPIRY_PRESETS = Object.freeze([
    { key: '30', days: 30, label: '30 يومًا' },
    { key: '90', days: 90, label: '90 يومًا', recommended: true },
    { key: '180', days: 180, label: '180 يومًا' },
    { key: '365', days: 365, label: 'سنة' },
    { key: 'custom', days: null, label: 'تاريخ محدَّد' },
    { key: 'never', days: 0, label: 'بلا انتهاء' }
]);

export const DEFAULT_EXPIRY_PRESET = '90';

/** أقصى مدى مسموح للتاريخ المخصَّص — سنتان، حدٌّ عمليّ لا حدّ خادم. */
export const MAX_EXPIRY_DAYS = 730;

/**
 * يحوّل اختيار المدّة إلى expires_at كما تنتظره الدالة (ISO أو null).
 * الحساب باليوم من «الآن»، فالنتيجة لحظة زمنية مطلقة لا تاريخ محلي —
 * ودي النقطة اللي بتخلي الفارق الزمني بين المتصفح والخادم بلا أثر.
 */
export function expiryFromPreset(preset, { now = Date.now(), customDate = '' } = {}) {
    if (preset === 'never') return null;
    if (preset === 'custom') {
        const value = String(customDate || '').trim();
        if (!value) return null;
        // تاريخ اليوم يعني «نهاية ذلك اليوم» لا منتصف ليلته، وإلا انتهى
        // المفتاح قبل أن يُستخدم في يومه الأول.
        const parsed = new Date(`${value}T23:59:59`);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const entry = EXPIRY_PRESETS.find(p => p.key === preset);
    if (!entry || !entry.days) return null;
    return new Date(now + entry.days * 86400000).toISOString();
}

/** أقصى تاريخ مسموح اختياره في حقل التاريخ (YYYY-MM-DD). */
export function maxCustomExpiryDate(now = Date.now()) {
    return new Date(now + MAX_EXPIRY_DAYS * 86400000).toISOString().slice(0, 10);
}

/** أدنى تاريخ مسموح: الغد — تاريخ اليوم أو ما قبله مفتاح ميت عند الولادة. */
export function minCustomExpiryDate(now = Date.now()) {
    return new Date(now + 86400000).toISOString().slice(0, 10);
}

/**
 * تحقّق من نموذج إنشاء المفتاح.
 *
 * القواعد الأربع الأولى منقولة حرفيًا من الدالة المنشورة؛ الخامسة
 * (صلاحية واحدة على الأقل) قاعدة واجهة: إرسال [] يُنشئ مفتاحًا بلا أي
 * صلاحية — يُقبَل من الخادم ولا يصلح لشيء، فمنعه هنا يمنع مفتاحًا ميتًا.
 */
export function validateTokenForm(values, { now = Date.now() } = {}) {
    const errors = {};
    const name = String(values?.name || '').trim();
    const description = String(values?.description || '').trim();
    const credentialType = values?.credentialType || 'api_key_secret';
    const scopes = Array.isArray(values?.scopes) ? values.scopes : [];
    const preset = values?.expiryPreset || DEFAULT_EXPIRY_PRESET;

    if (!name) errors.name = 'الاسم مطلوب';
    else if (name.length > 80) errors.name = 'الاسم طويل جدًا (الحد الأقصى 80 حرفًا)';

    if (description.length > 200) errors.description = 'الوصف طويل جدًا (الحد الأقصى 200 حرف)';

    if (!CREDENTIAL_TYPES.some(t => t.key === credentialType)) {
        errors.credentialType = 'نوع الاعتماد غير صالح';
    }

    if (!scopes.length) {
        errors.scopes = 'اختر صلاحية واحدة على الأقل — مفتاح بلا صلاحيات لا يصلح لشيء';
    } else if (scopes.some(s => !ALLOWED_SCOPES.includes(s))) {
        errors.scopes = 'صلاحية غير معروفة';
    } else if (scopes.some(s => PRIVILEGED_SCOPES.includes(s))) {
        errors.scopes = 'هذه الصلاحية مخصّصة لمشغّل المنصة ولا تُمنَح من لوحة الشركة';
    }

    if (preset === 'custom') {
        const value = String(values?.customExpiry || '').trim();
        if (!value) {
            errors.expiry = 'حدّد تاريخ الانتهاء';
        } else {
            const iso = expiryFromPreset('custom', { customDate: value });
            if (!iso) {
                errors.expiry = 'تاريخ غير صالح';
            } else if (new Date(iso).getTime() <= now) {
                errors.expiry = 'التاريخ يجب أن يكون في المستقبل';
            } else if (new Date(iso).getTime() > now + MAX_EXPIRY_DAYS * 86400000) {
                errors.expiry = `أقصى مدّة مسموحة ${MAX_EXPIRY_DAYS} يومًا`;
            }
        }
    }

    return { isValid: Object.keys(errors).length === 0, errors };
}

/** الحمولة النهائية كما تُرسَل للدالة — نقطة واحدة تبني الطلب. */
export function toCreatePayload(values, { now = Date.now() } = {}) {
    return {
        name: String(values?.name || '').trim(),
        description: String(values?.description || '').trim() || undefined,
        credential_type: values?.credentialType || 'api_key_secret',
        scopes: Array.isArray(values?.scopes) ? values.scopes.slice() : DEFAULT_SCOPES.slice(),
        expires_at: expiryFromPreset(values?.expiryPreset || DEFAULT_EXPIRY_PRESET, {
            now,
            customDate: values?.customExpiry
        })
    };
}

/**
 * يوحّد أشكال الرد الثلاثة في قائمة اعتمادات تُعرض **مرة واحدة**.
 *
 * السرّ لا يعود من القاعدة أبدًا بعد هذه اللحظة: المخزَّن hash فقط
 * (secret_hash / bearer_token_hash). فالعرض هنا ليس تساهلًا أمنيًا — هو
 * الفرصة الوحيدة الممكنة تقنيًا، وبعدها لا سبيل لاسترجاعه حتى للخادم.
 */
export function credentialsFromResponse(payload) {
    if (!payload) return [];

    const list = [];
    const pushKeySecret = (entry) => {
        if (!entry?.token || !entry?.secret) return;
        list.push({
            kind: 'api_key_secret',
            label: 'مفتاح + سرّ',
            tokenId: entry.token.id,
            apiKey: entry.token.api_key,
            secret: entry.secret,
            headerValue: `Bearer ${entry.token.api_key}.${entry.secret}`
        });
    };
    const pushBearer = (entry) => {
        const value = entry?.bearer_token;
        if (!entry?.token || !value) return;
        list.push({
            kind: 'bearer',
            label: 'رمز Bearer',
            tokenId: entry.token.id,
            apiKey: null,
            secret: value,
            headerValue: `Bearer ${value}`
        });
    };

    if (payload.api_key_secret || payload.bearer) {
        pushKeySecret(payload.api_key_secret);
        pushBearer(payload.bearer);
        return list;
    }

    if (payload.bearer_token) { pushBearer(payload); return list; }
    pushKeySecret(payload);
    return list;
}
