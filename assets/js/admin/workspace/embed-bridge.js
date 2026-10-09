/**
 * embed-bridge.js — جسر الصفحة المضمّنة مع مساحة العمل
 * ---------------------------------------------------------------------------
 * تستورده الصفحات القائمة (الصندوق، التذاكر، سجل العميل). خارج مساحة العمل
 * كل دواله لا تفعل شيئًا، فالصفحة المفتوحة مباشرةً تعمل كما كانت حرفيًا.
 *
 * البروتوكول رسائل postMessage على نفس الأصل فقط:
 *   { ns: 'mad3oom-ws', v: 1, type, … }
 *
 *   الصفحة ← مساحة العمل: ready · title · dirty · open · changed · unavailable · shortcut
 *   مساحة العمل ← الصفحة: theme · refresh
 *
 * هوية اللوحة لا تُرسل في الرسالة: مساحة العمل تعرف المرسل من الإطار نفسه
 * (event.source)، فلا تستطيع لوحة أن تتكلم باسم أخرى. وكل رسالة واردة هنا
 * تُقبل فقط من الأب ومن نفس الأصل.
 *
 * المسودات: مساحة العمل تسأل الصفحة مباشرةً قبل أي إغلاق
 * (window.__mad3oomEmbed.isDirty() — نفس الأصل)، والرسائل «dirty» لعرض
 * النقطة على التبويب فقط. فلا يمكن لرسالة متأخرة أن تُضيّع ردًا لم يُرسل.
 */
import { panelFromUrl } from './panel-registry.js';

const NS = 'mad3oom-ws';
const VIEWS = ['thread', 'ticket', 'customer'];

let context;           // undefined = لم يُحسب بعد، null = ليست مضمّنة
let dirtyFn = () => false;
let refreshFn = null;
let lastDirty = false;
let lastTitle = null;

/**
 * سياق التضمين أو null. نفس شروط embed-early.js، ويُعاد فحصها هنا بدل
 * الاعتماد على الصنف وحده.
 */
export function embedContext() {
    if (context !== undefined) return context;
    context = null;
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('embed') !== '1' || window.parent === window) return context;
        if (window.parent.location.origin !== window.location.origin) return context;
        const view = params.get('view');
        context = Object.freeze({ view: VIEWS.includes(view) ? view : 'full', params });
    } catch {
        context = null;
    }
    return context;
}

function post(type, payload = {}) {
    if (!embedContext()) return;
    window.parent.postMessage({ ns: NS, v: 1, type, ...payload }, window.location.origin);
}

/** الخطأ في فحص المسودة = «فيها مسودة»: السؤال قبل الإغلاق أهون من ضياع رد. */
function safeDirty() {
    try { return !!dirtyFn(); } catch { return true; }
}

function reportDirty() {
    const dirty = safeDirty();
    if (dirty === lastDirty) return;
    lastDirty = dirty;
    post('dirty', { dirty });
}

function onLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const panel = panelFromUrl(link.getAttribute('href'), window.location.origin);
    if (!panel) return;
    event.preventDefault();
    event.stopPropagation();
    post('open', { panel, side: event.ctrlKey || event.metaKey || event.shiftKey });
}

function onKeydown(event) {
    // KeyK لا key: في لوحة مفاتيح عربية الحرف «ن».
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        post('shortcut', { name: 'quickOpen' });
    }
}

function onMessage(event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.ns !== NS || msg.v !== 1) return;
    if (msg.type === 'theme' && (msg.theme === 'light' || msg.theme === 'dark')) {
        document.documentElement.setAttribute('data-theme', msg.theme);
    }
    if (msg.type === 'refresh' && refreshFn) {
        refreshFn({ entity: msg.entity ?? null, id: msg.id ?? null, customerId: msg.customerId ?? null, dirty: safeDirty() });
    }
}

/**
 * تفعيل الجسر. يُستدعى مرة في بداية الصفحة؛ يرجع السياق أو null.
 *
 * @param {{isDirty?: () => boolean, onRefresh?: (hint) => void}} options
 *        isDirty: هل في الصفحة كلام لم يُرسل (رد، ملاحظة، مرفق، تسجيل)؟
 *        onRefresh: سجل مرتبط تغيّر في لوحة أخرى. الصفحة تقرر — ولا تعيد
 *        الرسم فوق مسودة (hint.dirty).
 */
export function initEmbed({ isDirty, onRefresh } = {}) {
    const ctx = embedContext();
    if (!ctx) return null;
    if (isDirty) dirtyFn = isDirty;
    if (onRefresh) refreshFn = onRefresh;

    Object.defineProperty(window, '__mad3oomEmbed', {
        value: Object.freeze({ isDirty: safeDirty }),
        configurable: false, writable: false
    });

    const check = () => setTimeout(reportDirty, 0);
    for (const type of ['input', 'change', 'click', 'drop', 'paste', 'keyup']) {
        document.addEventListener(type, check, true);
    }
    // الإرسال يفرّغ الخانة برمجيًا بلا حدث input — فحص دوري رخيص يلتقطه.
    setInterval(reportDirty, 1500);

    document.addEventListener('click', onLinkClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('message', onMessage);
    post('ready');
    return ctx;
}

export function reportTitle(title) {
    const text = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text || text === lastTitle) return;
    lastTitle = text;
    post('title', { title: text });
}

/** السجل المعروض تغيّر (عادةً من Realtime) — تلميح للوحات المرتبطة. */
export function reportChanged(entity, id, { customerId = null } = {}) {
    post('changed', { entity, id, customerId });
}

export function reportUnavailable(reason = 'unavailable') {
    post('unavailable', { reason: String(reason).slice(0, 60) });
}

/** افتح سجلًا كتبويب في مساحة العمل (زر «افتح في تبويب»). */
export function openInWorkspace(panel, { side = false } = {}) {
    post('open', { panel, side });
}

export function recheckDirty() {
    reportDirty();
}
