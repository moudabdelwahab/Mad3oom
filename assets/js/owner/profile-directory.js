/**
 * profile-directory.js — دليل حسابات لوحة المالك: أسماء عند الحاجة فقط.
 *
 * كانت لوحة المالك تسحب جدول profiles كاملًا (كل الأعمدة لكل الحسابات)
 * عند كل دخول، لمجرد عدّ الرتب وعرض أسماء قليلة في السجل والمدفوعات.
 * الآن:
 *  • العدّادات عدّ دقيق head-count بلا صفوف (في owner-dashboard.html).
 *  • فريق المنصة وحده (مالك/إداري/دعم — مجموعة صغيرة بطبيعتها) يُجلب
 *    عند الدخول ويُزرع في هذا الدليل.
 *  • أي اسم آخر يُجلب عند الحاجة فقط: دفعة واحدة بـ .in('id', …) للأسماء
 *    الظاهرة في سجل أو مدفوعات، أو بحث مقيّد (20 نتيجة) عند إضافة عضو
 *    للفريق — لا قائمة عملاء كاملة في الذاكرة أبدًا.
 *
 * الدليل خالص من DOM: يُختبَر بلا متصفح بمحاكي supabase صغير.
 */

/** رتب فريق المنصة — المجموعة الوحيدة التي تُجلب كاملة عند الدخول. */
export const STAFF_ROLES = Object.freeze(['platform_owner', 'admin', 'support']);

/** أعمدة الاسم وحدها — لا سحب لصف كامل بلا حاجة. */
export const PROFILE_NAME_COLUMNS = 'id, email, full_name, role, pi_uid';

/** أقصى نتائج بحث عن حساب عند إضافة عضو للفريق. */
export const USER_SEARCH_LIMIT = 20;

/** أقل طول لاستعلام البحث — حرف واحد يطابق آلاف الحسابات بلا فائدة. */
export const USER_SEARCH_MIN_LENGTH = 2;

/** هل هذه رتبة من فريق المنصة؟ */
export function isStaffRole(role) {
    return STAFF_ROLES.includes(role);
}

/**
 * دليل حسابات فوق صفوف مزروعة (فريق المنصة عند الدخول).
 * get() قراءة متزامنة من الذاكرة؛ ensure() يجلب الغائبين دفعة واحدة؛
 * refresh() يعيد جلب معرّفات معروفة بعد تغيير رتبتها؛ searchUsers()
 * يبحث في حسابات العملاء (role='user') بالبريد أو الاسم، مقيّدًا.
 */
export function createProfileDirectory(supabase, seedRows = []) {
    const cache = new Map();
    for (const p of seedRows || []) {
        if (p && p.id) cache.set(p.id, { ...p });
    }

    async function fetchByIds(ids) {
        const { data, error } = await supabase.from('profiles')
            .select(PROFILE_NAME_COLUMNS)
            .in('id', ids);
        if (error) throw error;
        const rows = data || [];
        for (const p of rows) {
            if (p && p.id) cache.set(p.id, { ...p });
        }
        return rows;
    }

    return {
        /** حساب من الذاكرة أو null — بلا شبكة، وبلا اختراع اسم. */
        get(id) {
            return cache.get(id) || null;
        },

        /** كل الحسابات المعروفة حتى الآن (المزروعة + المجلبة عند الحاجة). */
        all() {
            return [...cache.values()];
        },

        /** فريق المنصة من المعروف حتى الآن. */
        staff() {
            return [...cache.values()].filter((p) => isStaffRole(p.role));
        },

        /** جلب الغائبين عن الذاكرة دفعة واحدة؛ الموجودون لا يُعاد جلبهم. */
        async ensure(ids) {
            const missing = [...new Set((ids || []).filter(Boolean))]
                .filter((id) => !cache.has(id));
            if (!missing.length) return [];
            return fetchByIds(missing);
        },

        /** إعادة جلب معرّفات معروفة بعد تغيير (مثل تغيير رتبة). */
        async refresh(ids) {
            const wanted = [...new Set((ids || []).filter(Boolean))];
            if (!wanted.length) return [];
            return fetchByIds(wanted);
        },

        /** بحث مقيّد في حسابات العملاء بالبريد أو الاسم؛ أقل من حرفين يرجع []. */
        async searchUsers(query) {
            const q = String(query || '').trim();
            if (q.length < USER_SEARCH_MIN_LENGTH) return [];
            const { data, error } = await supabase.from('profiles')
                .select('id, email, full_name, role')
                .eq('role', 'user')
                .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
                .order('email')
                .limit(USER_SEARCH_LIMIT);
            if (error) throw error;
            const rows = data || [];
            for (const p of rows) {
                if (p && p.id) cache.set(p.id, { ...p });
            }
            return rows;
        },
    };
}
