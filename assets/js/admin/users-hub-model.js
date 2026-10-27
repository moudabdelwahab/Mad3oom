/**
 * users-hub-model.js — منطق صفحة «المستخدمين» الموحّدة (بلا DOM ولا شبكة).
 *
 * الصفحة تجمع في مكان واحد ما كان موزّعًا على ثماني صفحات: كل المستخدمين،
 * المحظورون، العملاء، Super Users، مستخدميني، طلبات الحسابات، طلبات حسابات
 * الشركات، قائمة الانتظار.
 *
 * من يرى أي تبويب: نفس القواعد التي كانت تُظهر روابطها في القائمة الجانبية
 * (sidebar.js → applySidebarPermissions)، منقولة كما هي. الإخفاء هنا تنظيم
 * عرض فقط: كل صفحة وكل دالة تتحقق في القاعدة بنفسها.
 */
import { isAccountRestricted } from '../account-status.js';

/** التبويبات بترتيب العرض. src = الصفحة القائمة التي يستضيفها التبويب (وضع التضمين). */
export const HUB_TABS = Object.freeze([
    { id: 'all',             label: 'كل المستخدمين' },
    { id: 'customers',       label: 'العملاء',               src: '/admin/customers.html' },
    { id: 'superUsers',      label: 'Super Users',           src: '/admin/super-users.html' },
    { id: 'myUsers',         label: 'مستخدميني',              src: '/admin/my-users.html' },
    { id: 'banned',          label: 'المحظورون' },
    { id: 'accountRequests', label: 'طلبات الحسابات',         src: '/admin/account-requests.html' },
    { id: 'companyRequests', label: 'طلبات حسابات الشركات',   src: '/admin/company-requests.html' },
    { id: 'waitlist',        label: 'قائمة الانتظار',          src: '/admin/waitlist.html' }
]);

/**
 * التبويبات المتاحة لصلاحيات الحساب الحالي.
 * access: { isAdmin, isSupport, isSuperUser, isMainAdmin } كما يحسبها sidebar.js.
 *
 * المقابلة مع الروابط القديمة:
 *   all, banned, customers, accountRequests → كانت ضمن STAFF_ONLY_LINK_IDS
 *     (تُخفى عن Super User الصِّرف)، والعملاء وطلبات الحسابات للأدمن فقط.
 *   companyRequests, waitlist → للأدمن فقط.
 *   superUsers → للأدمن الرئيسي فقط (has_elevated_authority).
 *   myUsers → لـ Super User أو الأدمن.
 */
export function visibleHubTabs(access = {}) {
    const { isAdmin = false, isSupport = false, isSuperUser = false, isMainAdmin = false } = access;
    const pureSuperUser = isSuperUser && !isAdmin && !isSupport && !isMainAdmin;
    const allowed = {
        all: !pureSuperUser,
        banned: !pureSuperUser,
        customers: isAdmin && !pureSuperUser,
        accountRequests: isAdmin && !pureSuperUser,
        companyRequests: isAdmin,
        waitlist: isAdmin,
        superUsers: isMainAdmin,
        myUsers: isSuperUser || isAdmin
    };
    return HUB_TABS.filter(t => allowed[t.id]);
}

/** التبويب المطلوب من الـhash إن كان متاحًا، وإلا أول تبويب متاح. */
export function resolveHubTab(hash, tabs) {
    const wanted = String(hash || '').replace(/^#/, '');
    return tabs.find(t => t.id === wanted)?.id || tabs[0]?.id || null;
}

export const ROLE_LABELS = Object.freeze({
    user: 'مستخدم',
    super_user: 'مستخدم مميز',
    admin: 'مدير',
    support: 'دعم فني',
    platform_owner: 'مالك المنصة'
});

export function roleLabel(role) {
    return ROLE_LABELS[role] || ROLE_LABELS.user;
}

// profiles بلا عمود status: الحظر في ban_status/ban_until، بنفس شرط is_banned() في القاعدة
export const isBanned = (u) => isAccountRestricted(u);

/** نص البحث: الاسم والبريد والجوال، بلا اعتبار لحالة الأحرف أو المسافات الزائدة. */
function haystack(u) {
    return [u.full_name, u.email, u.phone, u.whatsapp_phone].filter(Boolean).join(' ').toLowerCase();
}

/**
 * تصفية وترتيب قائمة المستخدمين في المتصفح (الصفحة تجلب الملفات كلها كما كانت).
 * filters: { q, role, status: ''|'active'|'banned'|'frozen', from, to (YYYY-MM-DD), sort }
 * frozen: Map/Set لمعرّفات المحافظ المجمّدة (اختياري).
 */
export function filterUsers(users, filters = {}, frozen = null) {
    const q = String(filters.q || '').trim().toLowerCase();
    const from = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const to = filters.to ? new Date(`${filters.to}T23:59:59.999`) : null;
    const isFrozen = (id) => !!(frozen && (frozen.get ? frozen.get(id) : frozen.has(id)));

    const rows = (users || []).filter(u => {
        if (q && !haystack(u).includes(q)) return false;
        if (filters.role && (u.role || 'user') !== filters.role) return false;
        if (filters.status === 'banned' && !isBanned(u)) return false;
        if (filters.status === 'active' && isBanned(u)) return false;
        if (filters.status === 'frozen' && !isFrozen(u.id)) return false;
        const created = u.created_at ? new Date(u.created_at) : null;
        if (from && (!created || created < from)) return false;
        if (to && (!created || created > to)) return false;
        return true;
    });

    const byName = (u) => String(u.full_name || u.email || '');
    const byDate = (u) => (u.created_at ? Date.parse(u.created_at) : 0);
    const sorters = {
        newest: (a, b) => byDate(b) - byDate(a),
        oldest: (a, b) => byDate(a) - byDate(b),
        name: (a, b) => byName(a).localeCompare(byName(b), 'ar'),
        points: (a, b) => (Number(b.points) || 0) - (Number(a.points) || 0)
    };
    return rows.sort(sorters[filters.sort] || sorters.newest);
}

/**
 * إجراءات قائمة «خيارات» لصف مستخدم — نفس الإجراءات القائمة قبلًا، بنفس شروطها:
 *   view        «عرض» (الدخول كمستخدم) — كان زرًّا في كل صف.
 *   points      «النقاط» — كان زرًّا في كل صف.
 *   role:*      تغيير الصلاحية — كان في النافذة الجانبية، ومخفي حين يفتح
 *               Super User خياراته هو.
 *   ban/unban   الحظر (النافذة) وإلغاؤه (صفحة المحظورين).
 *   freeze      تجميد الرصيد — كان يظهر فقط لحساب الدعم الرئيسي.
 *   sie         إعدادات SIE — لمن ترجع له is_sie_admin() true فقط.
 *   copyEmail   نسخ البريد (لا يغيّر شيئًا).
 * ctx: { viewer: { id, role, email }, isSieAdmin, frozen: boolean }
 */
export function userActions(target, ctx = {}) {
    const viewer = ctx.viewer || {};
    const isSelf = !!viewer.id && viewer.id === target.id;
    const superUserSelf = isSelf && viewer.role === 'super_user';
    const role = target.role || 'user';
    const actions = [
        { id: 'view', label: 'عرض الحساب (الدخول كمستخدم)' },
        { id: 'points', label: 'تعديل النقاط' }
    ];
    if (!superUserSelf) {
        actions.push({ group: 'تغيير الصلاحية' });
        for (const [r, label] of [['user', 'عضو'], ['super_user', 'Super User'], ['admin', 'Admin']]) {
            actions.push({ id: `role:${r}`, label, current: role === r });
        }
    }
    actions.push({ group: 'الحساب' });
    if (viewer.email === 'support@mad3oom.online') {
        actions.push({ id: 'freeze', label: ctx.frozen ? 'إلغاء تجميد الرصيد' : 'تجميد الرصيد' });
    }
    if (ctx.isSieAdmin) actions.push({ id: 'sie', label: 'إعدادات محرك الدعم (SIE)…' });
    if (target.email) actions.push({ id: 'copyEmail', label: 'نسخ البريد الإلكتروني' });
    actions.push(isBanned(target)
        ? { id: 'unban', label: 'إلغاء الحظر' }
        : { id: 'ban', label: 'حظر المستخدم', danger: true });
    return actions;
}
