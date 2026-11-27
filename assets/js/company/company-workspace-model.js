/**
 * company-workspace-model.js — نموذج مساحة عمل الشركة (دوال خالصة، بلا DOM).
 *
 * مساحة العمل إرساء (dock) فوق المسارين الموجودين — تذاكر العملاء وصندوق
 * الرسائل — لا صفحة جديدة ولا بيانات جديدة: اللوحات تقرأ صفوف المسارين
 * وملخص الصندوق كما هي، بلا جلب ثانٍ.
 *
 * محرك الترتيب هو assets/js/admin/workspace/dock-model.js نفسه (دوال خالصة
 * بلا DOM، فيُستورد هنا مباشرةً): الشجرة مجموعات وتقسيمات، واللوحة مفتاح
 * يمنع التكرار. ما يخصّ الشركة هنا فقط: أنواع اللوحات الثلاث، والترتيب
 * الافتراضي، ومفتاح الحفظ في localStorage، وعدّ التذاكر وأحدثها.
 *
 * الحفظ localStorage وحده في v1 — لا دالة تخطيط جديدة في القاعدة.
 */
import {
    createLayout, openPanel, serializeLayout, parseLayout
} from '../admin/workspace/dock-model.js';
import { isClosed } from '../customer/ticket-view-model.js';

/** لوحات المساحة: المفتاح = نوع اللوحة في dock-model، tab = قسمها الكامل في اللوحة. */
export const WORKSPACE_PANELS = Object.freeze({
    customerTickets: { label: 'تذاكر العملاء', tab: 'customerTickets' },
    inbox:           { label: 'صندوق الرسائل', tab: 'inbox' },
    platformTickets: { label: 'تذاكري مع مدعوم', tab: 'tickets' }
});

export const WORKSPACE_STORAGE_PREFIX = 'mad3oom:company-workspace:';

/** مفتاح الحفظ لشركة بعينها — فلا يتسرب ترتيب شركة إلى أخرى. */
export function workspaceStorageKey(companyId) {
    return `${WORKSPACE_STORAGE_PREFIX}${companyId || 'default'}`;
}

/** مفتاح منع التكرار للوحة: نوع واحد = لوحة واحدة في المساحة. */
export function workspacePanelKey(type) {
    return `workspace:${type}`;
}

/** اللوحة صالحة للاستعادة من ترتيب محفوظ؟ غير المعروفة تُسقَط وحدها. */
export function validateWorkspacePanel(type) {
    if (!WORKSPACE_PANELS[type]) return null;
    return { params: {}, key: workspacePanelKey(type) };
}

/** الترتيب الافتراضي: تذاكر العملاء بجانب صندوق الرسائل. */
export function defaultWorkspaceLayout() {
    let layout = createLayout();
    ({ layout } = openPanel(layout,
        { type: 'customerTickets', key: workspacePanelKey('customerTickets') }, {}));
    ({ layout } = openPanel(layout,
        { type: 'inbox', key: workspacePanelKey('inbox') }, { edge: 'end' }));
    return layout;
}

/** يقرأ ترتيبًا محفوظًا (نص localStorage)؛ المعطوب ⇒ null فيبدأ الافتراضي. */
export function parseWorkspaceLayout(raw) {
    if (!raw) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return parseLayout(parsed, { validatePanel: validateWorkspacePanel });
}

/** يحوّل الترتيب إلى نص للحفظ؛ الفشل ⇒ null فلا يُكتب شيء معطوب. */
export function serializeWorkspaceLayout(layout) {
    try {
        return JSON.stringify(serializeLayout(layout));
    } catch {
        return null;
    }
}

/** يقلب اتجاه التقسيم الجذري: صف (جنبًا إلى جنب) ↔ عمود (فوق بعض). */
export function toggleWorkspaceDirection(layout) {
    if (!layout || layout.root?.kind !== 'split') return layout;
    return {
        ...layout,
        root: { ...layout.root, dir: layout.root.dir === 'row' ? 'column' : 'row' }
    };
}

/**
 * أعداد المساحة من صفوف المسارين وملخص الصندوق — بلا جلب ثانٍ.
 * «مفتوحة» هنا بمعنى statusInfo نفسه في ticket-view-model (لا قائمة حالات مكررة).
 */
export function workspaceCounts({ customerRows = [], platformRows = [], inboxSummary = null } = {}) {
    const count = (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        return { total: list.length, open: list.filter(t => !isClosed(t)).length };
    };
    const customers = count(customerRows);
    const platform = count(platformRows);
    return {
        customersTotal: customers.total,
        customersOpen: customers.open,
        platformTotal: platform.total,
        platformOpen: platform.open,
        inboxOpen: Number(inboxSummary?.open) || 0,
        inboxUnread: Number(inboxSummary?.unread) || 0,
        inboxAvailable: inboxSummary !== null
    };
}

/** أحدث التذاكر للعرض المختصر في اللوحة — الأحدث تحديثًا أولًا. */
export function recentTickets(rows, limit = 5) {
    const stamp = (t) => new Date(t?.last_updated_at || t?.created_at || 0).getTime() || 0;
    return [...(Array.isArray(rows) ? rows : [])]
        .sort((a, b) => stamp(b) - stamp(a))
        .slice(0, Math.max(0, limit))
        .map(t => ({
            id: String(t?.id || ''),
            number: t?.ticket_number ?? null,
            title: String(t?.title || 'بلا عنوان'),
            status: String(t?.status || ''),
            closed: isClosed(t),
            updatedAt: t?.last_updated_at || t?.created_at || null
        }));
}
