// ============================================================
// scope-grant.js — تقرير ما يُمنَح فعلًا لتطبيق خارجي
// ------------------------------------------------------------
// **JavaScript خالص بلا أنواع، عمدًا.** Deno يستورده من index.ts بلا
// مشكلة، و Node يستورده في tests/oauth-consent-scopes.test.mjs مباشرة.
// فالقاعدة الأمنية الأهم في المنصّة تُختبَر بالتنفيذ لا بفحص النصّ —
// ولا يوجد مصدران لها يفترقان مع الوقت.
//
// النموذج الأمني: fail-closed / least privilege.
//
// هذه منصّة MCP تُستخدم مع Claude و ChatGPT وأي عميل خارجي، فالافتراض
// أن الطلب قد يكون مُلفَّقًا لا أن يكون سليمًا.
// ============================================================

/** الصلاحيات التي لا تُمنَح إلا باختيار صريح من المستخدم. */
export const PRIVILEGED_SCOPES = ["admin:full", "settings:manage", "oauth:manage"];

/** @param {string} s @returns {boolean} */
export function isPrivileged(s) {
    return PRIVILEGED_SCOPES.includes(s);
}

/**
 * الحد الأدنى المقترَح على شاشة الموافقة: كل ما طُلب **عدا** المرتفع.
 * تُعلَن في ردّ `info` باسم default_scopes.
 *
 * @param {string[]} validScopes ما طلبه التطبيق، مُرشَّحًا على ALLOWED_SCOPES
 * @returns {string[]}
 */
export function defaultScopesFor(validScopes) {
    return (Array.isArray(validScopes) ? validScopes : []).filter((s) => !isPrivileged(s));
}

/**
 * يقرّر ما يُمنَح فعلًا.
 *
 * القاعدة، وهي كل الأمان هنا:
 *
 *   1. `granted_scopes` **مُرشِّح لا مصدر**. النتيجة تُبنى دائمًا من
 *      `validScopes` — وهي أصلًا تقاطع (ما طلبه التطبيق ∩ ALLOWED_SCOPES).
 *      فمهما أرسل العميل، لا يستطيع إضافة صلاحية لم يطلبها التطبيق ولا
 *      صلاحية خارج القائمة المسموحة. الاتجاه الوحيد الممكن هو التضييق.
 *
 *   2. **غياب `granted_scopes` يُرفض.** لا يعني «امنح كل ما طُلب» ولا
 *      «امنح الافتراضي». شاشة الموافقة ترسل الحقل دائمًا، فغيابه يعني
 *      إمّا صفحة قديمة مخزَّنة في المتصفح وإمّا طلبًا مُصاغًا يدويًا —
 *      وكلاهما لا يجوز أن يُنتج منحًا صامتًا. المستخدم يُعاد إلى مسار
 *      الموافقة بتحديث الصفحة، فيصير المنح عن اختيار مرئي لا عن افتراض.
 *
 *   3. اختيار فارغ (بعد التقاطع) يُرفض: منح صفر صلاحية ليس موافقة.
 *
 * @param {string[]} validScopes ما طلبه التطبيق ∩ ALLOWED_SCOPES
 * @param {unknown} grantedScopesInput ما أرسله المتصفح، بلا أي ثقة
 * @returns {{ok: true, scopes: string[]} | {ok: false, reason: string, error: string}}
 */
export function decideGrantedScopes(validScopes, grantedScopesInput) {
    const requested = Array.isArray(validScopes) ? validScopes : [];

    if (!Array.isArray(grantedScopesInput)) {
        return {
            ok: false,
            reason: "missing_granted_scopes",
            error: "لم تصل قائمة الصلاحيات المختارة. حدّث صفحة الموافقة وأعد المحاولة — لن تُمنَح أي صلاحية بدون اختيار صريح.",
        };
    }

    const picked = new Set(grantedScopesInput.filter((s) => typeof s === "string"));
    // الترشيح ينطلق من requested لا من picked — هذا هو السطر الذي يمنع التوسيع.
    const scopes = requested.filter((s) => picked.has(s));

    if (!scopes.length) {
        return {
            ok: false,
            reason: "empty_selection",
            error: "لم تُحدَّد أي صلاحية - اختر صلاحية واحدة على الأقل أو ارفض الطلب",
        };
    }

    return { ok: true, scopes };
}
