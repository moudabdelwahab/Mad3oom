/**
 * إتاحة النوافذ المنبثقة (focus management)
 * ---------------------------------------------------------------------------
 * الصفحة فيها عشر نوافذ تُفتح وتُغلق بإضافة/إزالة الصنف ‎.open، من عشرات
 * المواضع في أربع وحدات مختلفة. بدل تعديل كل موضع، نراقب تغيّر الصنف نفسه:
 * أي نافذة تُفتح بأي طريقة تحصل على السلوك الصحيح تلقائيًا، والوحدات تبقى
 * غير عالمة بوجود هذا الملف.
 *
 * ما يعالجه:
 *   • التركيز كان يبقى على الزرّ خلف النافذة، فمستخدم الكيبورد يتنقّل داخل
 *     الصفحة المحجوبة بدل النافذة، وقارئ الشاشة لا يعلن فتح شيء أصلًا.
 *   • بعد الإغلاق كان التركيز يضيع لأول الصفحة بدل العودة لما فُتحت منه.
 *   • تمرير الخلفية خلف النافذة على الجوال.
 */

const OPEN_SELECTOR = '.modal-overlay.open';

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** من أين فُتحت كل نافذة — لإعادة التركيز إليه بعد الإغلاق. */
const openerOf = new WeakMap();
let lastActiveBeforeOpen = null;
let bodyLockCount = 0;

function visibleFocusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
        if (el.closest('[hidden]')) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
}

function topmostOpenModal() {
    const open = [...document.querySelectorAll(OPEN_SELECTOR)];
    return open.length ? open[open.length - 1] : null;
}

function onModalOpened(modal) {
    openerOf.set(modal, lastActiveBeforeOpen);

    modal.setAttribute('role', modal.getAttribute('role') || 'dialog');
    modal.setAttribute('aria-modal', 'true');

    if (bodyLockCount === 0) document.body.style.overflow = 'hidden';
    bodyLockCount += 1;

    // أول حقل إدخال هو المقصد الطبيعي؛ وإلا أول عنصر قابل للتركيز؛ وإلا النافذة نفسها
    requestAnimationFrame(() => {
        const focusables = visibleFocusables(modal);
        const firstField = focusables.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
        const target = firstField || focusables[0];
        if (target) {
            target.focus();
            target.select?.();
        } else {
            modal.setAttribute('tabindex', '-1');
            modal.focus();
        }
    });
}

function onModalClosed(modal) {
    modal.removeAttribute('aria-modal');

    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = '';

    const opener = openerOf.get(modal);
    openerOf.delete(modal);
    // نعيد التركيز فقط لو لم ينتقل إلى نافذة أخرى ما زالت مفتوحة
    if (opener?.isConnected && !topmostOpenModal()) opener.focus?.();
}

/** حبس Tab داخل النافذة العليا المفتوحة. */
function onKeyDown(e) {
    if (e.key !== 'Tab') return;
    const modal = topmostOpenModal();
    if (!modal) return;

    const focusables = visibleFocusables(modal);
    if (!focusables.length) { e.preventDefault(); return; }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!modal.contains(active)) { e.preventDefault(); first.focus(); return; }

    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

export function init() {
    // نلتقط ما كان مركَّزًا قبل أي نقرة/ضغطة، فهو الزرّ الذي سيفتح النافذة
    document.addEventListener('pointerdown', (e) => { lastActiveBeforeOpen = e.target?.closest?.('button, a, [role="button"]') || document.activeElement; }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') lastActiveBeforeOpen = document.activeElement; }, true);

    document.addEventListener('keydown', onKeyDown);

    const observer = new MutationObserver((records) => {
        for (const rec of records) {
            if (rec.attributeName !== 'class') continue;
            const el = rec.target;
            if (!el.classList?.contains('modal-overlay')) continue;

            const nowOpen = el.classList.contains('open');
            const wasOpen = openerOf.has(el);
            if (nowOpen && !wasOpen) onModalOpened(el);
            else if (!nowOpen && wasOpen) onModalClosed(el);
        }
    });

    observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });
}
