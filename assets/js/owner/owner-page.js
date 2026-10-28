/**
 * owner-page.js — أساس الصفحات المستقلة في لوحة المالك (/owner/*.html).
 *
 * كانت عناصر «الإدارة» و«التشغيل» في قائمة المالك روابط إلى صفحات /admin/ نفسها: تفتح بقشرة الإدارة
 * وقائمتها، وبعضها يُرسم فارغًا للمالك لأن سياساته تشترط الرتبة الحرفية 'admin' (الإعدادات، المحافظ).
 * هذه الصفحات نسخة المالك: قشرة المالك نفسها، وبوابة السياق نفسها، وما يملكه المالك فعلًا لا أكثر.
 *
 * القاعدة كما في owner-dashboard.html: لا قرار سلطة هنا. البوابة رسالة عرض، والرفض الحقيقي في القاعدة —
 * owner_capability() تشترط سياق «مالك المنصة» عند كل استعلام، فلو تجاوز أحد البوابة من devtools لما رأى
 * إلا جداول فارغة ونداءات مرفوضة.
 */
import { supabase } from '/api-config.js';
import { initOwnerShell } from '/assets/js/customer-sidebar.js';
import { contextStatus, mountContextBar, CONTEXT_PRESENTATION } from '/assets/js/owner/owner-context.js';
import { ownerDestinationFor, OWNER_HOME, OWNER_SECTIONS } from '/assets/js/owner/owner-notifications.js';
import { announce } from '/assets/js/owner/owner-workspace.js';

export { supabase, announce };

const $ = (id) => document.getElementById(id);

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const when = (t) => t
    ? new Date(t).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })
    : '—';

export const day = (t) => t ? new Date(t).toLocaleDateString('ar-EG') : '—';

export const num = (n) => (n === null || n === undefined || Number.isNaN(Number(n)))
    ? '—' : Number(n).toLocaleString('ar-EG');

/** نفس جدول لوحة المالك: .table-container + .admin-table. */
export function table(cols, rows, render, { empty = 'لا صفوف مطابقة.' } = {}) {
    if (!rows.length) return stateBlock({ text: empty });
    return `<div class="table-container">
        <table class="admin-table">
            <thead><tr>${cols.map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(render).join('')}</tbody>
        </table></div>`;
}

export function stateBlock({ title = '', text = '', tone = '' } = {}) {
    return `<div class="state-block state-block--compact ${tone === 'error' ? 'state-block--error' : ''}">
        ${title ? `<p class="state-title">${esc(title)}</p>` : ''}
        ${text ? `<p class="state-text">${esc(text)}</p>` : ''}</div>`;
}

export const errorBlock = (message) => stateBlock({ title: 'تعذّرت القراءة', text: message, tone: 'error' });

export const loadingBlock = () => '<div class="skeleton skeleton-card" aria-hidden="true"></div>';

export function kpis(items) {
    return items.map(([label, value, tone = '', hint = '']) => `
        <div class="kpi ${tone}">
            <p class="kpi-label">${esc(label)}</p>
            <p class="kpi-value">${esc(value)}</p>
            ${hint ? `<p class="kpi-hint">${esc(hint)}</p>` : ''}
        </div>`).join('');
}

/** أعمدة أفقية: الطول نسبة من الأكبر، والرقم مكتوب دائمًا (اللون ليس الحامل الوحيد للمعنى). */
export function bars(items) {
    const max = Math.max(1, ...items.map(i => i.value || 0));
    if (!items.some(i => i.value > 0)) return stateBlock({ text: 'لا بيانات بعد.' });
    return `<ul class="owner-bars">${items.map(i => `
        <li class="owner-bar">
            <span class="owner-bar-label">${esc(i.label)}</span>
            <span class="meter" role="presentation"><span class="meter-fill ${i.tone || ''}" style="width:${Math.round((i.value / max) * 100)}%"></span></span>
            <span class="owner-bar-value">${esc(num(i.value))}</span>
        </li>`).join('')}</ul>`;
}

/**
 * رسالة رفض القاعدة كما يفهمها المالك. 42501 = الخادم رفض الصلاحية (RLS أو حارس)، لا عطل في الصفحة.
 */
export function friendlyError(error) {
    if (!error) return '';
    if (error.code === '42501') {
        return error.message || 'القاعدة رفضت العملية: ليست من صلاحيات مالك المنصة في هذا السياق.';
    }
    return error.message || 'حدث خطأ غير متوقع.';
}

/** نتيجة الكتابة: الرفض بـRLS يعود بصفر صفوف بلا خطأ، فلا «تم» على ما لم يحدث. */
export function writeResult({ data, error }, { denied = 'لم يُحفظ التغيير — القاعدة لم تسمح بالتعديل.' } = {}) {
    if (error) return { ok: false, message: friendlyError(error) };
    if (Array.isArray(data) ? data.length === 0 : !data) return { ok: false, message: denied };
    return { ok: true };
}

/* ───────────────────────── النافذة المنبثقة ─────────────────────────
   نفس .modal/.modal-content في نظام التصميم. Escape والنقر خارج الحوار يغلقانها، والتركيز يعود لمن فتحها. */
export function openModal({ title, html = '', wide = false, onClose } = {}) {
    const opener = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal active owner-modal';
    overlay.innerHTML = `
        <div class="modal-content ${wide ? 'owner-modal--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="ownerModalTitle">
            <div class="modal-head">
                <h2 id="ownerModalTitle"></h2>
                <button type="button" class="modal-close" data-modal-close aria-label="إغلاق">&times;</button>
            </div>
            <div class="owner-modal-body">${html}</div>
        </div>`;
    overlay.querySelector('#ownerModalTitle').textContent = title || '';
    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        document.body.classList.remove('owner-modal-open');
        if (opener?.focus) opener.focus({ preventScroll: true });
        onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-modal-close]').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.classList.add('owner-modal-open');
    overlay.querySelector('[data-modal-close]').focus({ preventScroll: true });
    return { root: overlay, body: overlay.querySelector('.owner-modal-body'), close };
}

/* ───────────────────────── الإشعارات من صفحة مستقلة ───────────────────────── */
async function openNotification(notification) {
    if (!notification) return;
    if (!notification.is_read) {
        try {
            const { markAsRead } = await import('/notifications-service.js');
            await markAsRead(notification.id);
        } catch (err) {
            console.error('[OwnerPage] markAsRead:', err?.message || err);
        }
    }
    const dest = ownerDestinationFor(notification, location.origin, OWNER_SECTIONS);
    if (dest.kind === 'section') location.href = `${OWNER_HOME}#${dest.section}`;
    else if (dest.kind === 'href') location.href = dest.href;
    else location.href = `${OWNER_HOME}#notifications`;
}

function gate(title, text) {
    const box = $('ownerGate');
    box.hidden = false;
    $('ownerGateBody').innerHTML = `
        <p class="state-title"></p>
        <p class="state-text"></p>
        <a class="panel-link" href="/owner-contexts.html">الذهاب إلى واجهة اللوحات</a>`;
    $('ownerGateBody').querySelector('.state-title').textContent = title;
    $('ownerGateBody').querySelector('.state-text').textContent = text;
}

/**
 * يركّب قشرة المالك ثم يسأل الخادم: مالك المنصة؟ وفي سياقه؟ يعيد { session, status } أو null بعد عرض السبب.
 */
export async function bootOwnerPage() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
        const back = encodeURIComponent(location.pathname + location.search + location.hash);
        location.replace(`/login.html?redirect=${back}`);
        return null;
    }

    await initOwnerShell({
        notificationsPopover: true,
        onSeeAllNotifications: () => { location.href = `${OWNER_HOME}#notifications`; },
        onOpenNotification: openNotification,
        onReady: () => { mountContextBar().catch(err => console.error('[OwnerPage] context bar:', err?.message || err)); }
    });

    let status;
    try {
        status = await contextStatus();
    } catch (err) {
        gate('تعذّر التحقق', err.message);
        return null;
    }

    if (!status?.is_platform_owner) {
        gate('هذه الصفحة لمالك المنصة وحده',
             'حسابك مسجّل دخوله بشكل صحيح، لكن صفحات لوحة المالك ليست من صفحاته.');
        return null;
    }
    if (status.active_context !== 'owner') {
        const p = CONTEXT_PRESENTATION[status.active_context];
        gate('أنت خارج واجهة مالك المنصة',
             `واجهتك الحالية «${p?.name || 'غير محدّدة'}». صفحات لوحة المالك تعمل داخل واجهة «مالك المنصة» وحدها.`);
        return null;
    }

    $('ownerContent').hidden = false;
    return { session, status };
}

/** ترقيم بسيط: «السابق/التالي» ونطاق الصفوف. onPage(n) يعيد التحميل من الخادم. */
export function renderPager(el, { page, size, total, onPage, text }) {
    if (!el) return;
    el.hidden = !total || total <= size && page === 0;
    if (el.hidden) { el.innerHTML = ''; return; }
    const last = Math.max(0, Math.ceil(total / size) - 1);
    el.innerHTML = `
        <span>${esc(text)}</span>
        <span class="owner-pager-buttons">
            <button type="button" class="btn btn-outline btn-sm" data-pager="prev" ${page <= 0 ? 'disabled' : ''}>السابق</button>
            <button type="button" class="btn btn-outline btn-sm" data-pager="next" ${page >= last ? 'disabled' : ''}>التالي</button>
        </span>`;
    el.querySelector('[data-pager="prev"]').addEventListener('click', () => onPage(page - 1));
    el.querySelector('[data-pager="next"]').addEventListener('click', () => onPage(page + 1));
}

/** إخفاء رسالة النتيجة الطافية بالنقر — نفس سلوك .ows-toast في اللوحة. */
document.addEventListener('click', (e) => {
    const t = e.target.closest?.('.ows-toast');
    if (t) t.hidden = true;
});
