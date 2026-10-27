/**
 * company-users-model.js — «المستخدمون» في لوحة الشركة (دوال خالصة، مُختبَرة في node).
 *
 * مكان واحد لكل من يرتبط بالشركة: أعضاء الفريق، وعملاء الشركة، والدعوات المعلّقة —
 * ببحث وفلاتر وقائمة «خيارات» لكل صف.
 *
 * لا قرار صلاحية هنا: ما يدخل القائمة هو ما رجّعته القاعدة لهذا الناظر (الأعضاء
 * بنطاقهم، والعملاء للمشرف، والدعوات لمن يملك الدعوة — customersPanelView كما هو)،
 * والإجراءات بنفس شروطها في صفحتي «أعضاء الفريق» و«عملاء الشركة». القاعدة تعيد فحص
 * كل نداء.
 */
import {
    memberRoleInfo, memberActions, staffRoleOf, staffRoleInfo, staffActions, STAFF_ROLE_OPTIONS,
    invitationStatusInfo, invitationEmailInfo
} from './company-model.js';

export const DIRECTORY_KINDS = Object.freeze({
    member: 'عضو في الفريق',
    customer: 'عميل الشركة',
    invitation: 'دعوة معلّقة'
});

/**
 * يجمع القوائم الثلاث في صفوف موحّدة.
 * input: { members, staff, customers, invitations }
 *   members     من company_members() (بنطاق الناظر)
 *   staff       من company_staff_list() (أو null)
 *   customers   قائمة العملاء حين customersPanelView(...).showList
 *   invitations الدعوات حين customersPanelView(...).canInvite (المعلّقة وحدها تُعرض)
 */
export function buildCompanyDirectory({ members = [], staff = null, customers = [], invitations = [] } = {}) {
    const rows = [];
    for (const m of members || []) {
        const role = memberRoleInfo(m);
        const staffInfo = staffRoleInfo(staffRoleOf(m, staff));
        rows.push({
            key: `member:${m.id}`, kind: 'member', id: m.id, raw: m,
            name: m.name || m.email || '—', email: m.email || '', phone: m.phone || '',
            roleLabel: role.label, rolePill: role.pill,
            staffLabel: staffInfo && !m.is_owner ? staffInfo.label : '',
            staffRole: staffRoleOf(m, staff),
            statusLabel: m.is_me ? 'أنت' : '', created_at: m.created_at || null,
            isMe: m.is_me === true, isOwner: m.is_owner === true
        });
    }
    for (const c of customers || []) {
        rows.push({
            key: `customer:${c.id}`, kind: 'customer', id: c.id, raw: c,
            name: c.name || c.email || '—', email: c.email || '', phone: c.phone || '',
            roleLabel: DIRECTORY_KINDS.customer, rolePill: 'status-neutral',
            staffLabel: '', statusLabel: '', created_at: c.created_at || null
        });
    }
    for (const i of invitations || []) {
        if (i?.status !== 'pending') continue;
        const info = invitationStatusInfo(i.status);
        const mail = invitationEmailInfo(i.status, i.email_status);
        rows.push({
            key: `invitation:${i.id}`, kind: 'invitation', id: i.id, raw: i,
            name: i.email || '—', email: i.email || '', phone: '',
            roleLabel: DIRECTORY_KINDS.invitation, rolePill: info.pill,
            staffLabel: '', statusLabel: mail?.label || info.label, statusPill: mail?.pill || info.pill,
            created_at: i.created_at || null
        });
    }
    return rows;
}

/**
 * فلترة: { q, kind: ''|'member'|'customer'|'invitation', staff: ''|'staff'|'customer' }
 * staff: «موظفون» (موظف دعم/مشرف/مدير الفريق) أو «بلا دور موظف» — للأعضاء.
 */
export function filterCompanyDirectory(rows, { q = '', kind = '', staff = '' } = {}) {
    const needle = String(q).trim().toLowerCase();
    return (rows || []).filter(r => {
        if (kind && r.kind !== kind) return false;
        if (staff) {
            if (r.kind !== 'member') return false;
            const isStaff = ['agent', 'supervisor', 'admin'].includes(r.staffRole) || r.isOwner;
            if (staff === 'staff' && !isStaff) return false;
            if (staff === 'customer' && isStaff) return false;
        }
        if (needle) {
            const hay = [r.name, r.email, r.phone].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(needle)) return false;
        }
        return true;
    });
}

/**
 * إجراءات «خيارات» للصف — نفس الأزرار القائمة بنفس شروطها:
 *   member   details (التفاصيل والإدارة: الملف، بيانات الدخول، رابط كلمة المرور، الإيقاف، النقل)
 *            لمن يدير الأعضاء على غير المالك وغير نفسه؛ staff:<role> حين staffActions().canEdit؛
 *            remove حين memberActions().canRemove؛ وmyProfile للحساب نفسه.
 *   invitation  resend/retry حسب حالة البريد، وcancel للمعلّقة.
 *   الكل    copyEmail/copyPhone حين توجد القيمة (لا تغيّر شيئًا).
 * ctx: { canManage, staff }
 */
export function companyUserActions(row, { canManage = false, staff = null } = {}) {
    const actions = [];
    if (row.kind === 'member') {
        const m = row.raw || {};
        if (canManage && !m.is_owner && !m.is_me) {
            actions.push({ id: 'details', label: 'التفاصيل والإدارة…' });
        }
        if (m.is_me) actions.push({ id: 'myProfile', label: 'ملفي الشخصي' });
        if (staffActions(m, staff).canEdit) {
            actions.push({ group: 'الدور في فريق الشركة' });
            const current = staffRoleOf(m, staff);
            for (const o of STAFF_ROLE_OPTIONS) actions.push({ id: `staff:${o.value}`, label: o.label, current: o.value === current });
        }
    }
    if (row.kind === 'invitation') {
        const mail = invitationEmailInfo(row.raw?.status, row.raw?.email_status);
        if (mail?.action) actions.push({ id: `invite:${mail.action}`, label: mail.action === 'retry' ? 'إعادة محاولة إرسال الدعوة' : 'إعادة إرسال الدعوة' });
    }

    const contact = [];
    if (row.email) contact.push({ id: 'copyEmail', label: 'نسخ البريد الإلكتروني' });
    if (row.phone) contact.push({ id: 'copyPhone', label: 'نسخ رقم الجوال' });
    if (contact.length) actions.push({ group: 'التواصل' }, ...contact);

    if (row.kind === 'member' && memberActions(row.raw, { canManage }).canRemove) {
        actions.push({ id: 'remove', label: 'إزالة من الشركة', danger: true });
    }
    if (row.kind === 'invitation' && row.raw?.status === 'pending') {
        actions.push({ id: 'cancelInvite', label: 'إلغاء الدعوة', danger: true });
    }
    return actions;
}
