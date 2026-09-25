/**
 * chatbot-mode-selector.js
 * ------------------------------------------------------------
 * لوحة «خطة SIE» للعميل: وضع الرد (SIE فقط)، الخطة الحالية، الاستخدام
 * (المستخدم / المتبقي / الإجمالي / النسبة / موعد التجدد)، والنزول لخطة أقل.
 *
 * كانت هذه نافذة اختيار «وضع الشات بوت» (تقليدي / نموذج / تلقائي / SIE).
 * الوضع التقليدي أُزيل، والنموذج/التلقائي مخفيّان لأنهما لم يكن لهما محرك
 * حقيقي خلفهما. أسماء التصدير بقيت كما هي لأن customer-settings-modal.js
 * وchat-logic.js يستوردانها:
 *
 *   renderChatbotModeInto(container, { userId })   داخل تبويب الإعدادات
 *   openChatbotModeDialog({ userId, onPlanChanged }) نافذة منبثقة
 *
 * الخادم هو مصدر الحقيقة: sie_my_entitlement() / sie_customer_downgrade()
 * (sie-plan-service.js). الواجهة لا تحسب أي قاعدة ولا تستخدم localStorage؛
 * أزرار النزول تُرسم فقط مما يسمح به الخادم، والخادم يرفض غيرها أصلًا.
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';
import { fetchEntitlement, downgradePlan } from '/assets/js/sie-plan-service.js';
import { usageView } from '/assets/js/sie-plan-model.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const SIE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"></path><path d="M9.5 12l1.8 1.8L15 10"></path></svg>';

let stylesInjected = false;
function injectStyles() {
    if (stylesInjected || document.getElementById('chatbotModeSelectorStyles')) { stylesInjected = true; return; }
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'chatbotModeSelectorStyles';
    style.textContent = `
        .cms-scope {
            --cms-bg: #ffffff;
            --cms-bg-elevated: #f4f6f8;
            --cms-border: rgba(0, 51, 102, 0.12);
            --cms-text: #23272b;
            --cms-text-secondary: #5c6570;
            --cms-accent: #003366;
            --cms-accent-hover: #0055aa;
            --cms-success: #16a34a;
            --cms-danger: #d9534f;
            --cms-warning: #c98a00;
            font-family: 'Cairo', system-ui, sans-serif;
            color: var(--cms-text);
            direction: rtl;
        }
        .cms-overlay {
            position: fixed; inset: 0;
            background: rgba(15, 23, 32, 0.45);
            display: flex; align-items: center; justify-content: center;
            z-index: 100000; padding: 1rem;
            animation: cmsFadeIn 0.15s ease-out;
        }
        @keyframes cmsFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cmsSlideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .cms-dialog {
            background: var(--cms-bg); border-radius: 16px;
            width: 100%; max-width: 440px; max-height: min(640px, 88vh);
            display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            animation: cmsSlideUp 0.18s ease-out;
        }
        .cms-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 1.1rem 1.25rem; background: var(--cms-accent); color: #fff; flex-shrink: 0;
        }
        .cms-header h3 { margin: 0; font-size: 1.05rem; font-weight: 700; }
        .cms-header p { margin: 0.2rem 0 0; font-size: 0.78rem; opacity: 0.85; }
        .cms-close-btn {
            background: rgba(255,255,255,0.12); border: none; color: #fff;
            width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
            font-size: 1.2rem; line-height: 1; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
        }
        .cms-close-btn:hover { background: rgba(255,255,255,0.22); }
        .cms-close-btn:focus-visible, .cms-scope button:focus-visible { outline: 2px solid var(--cms-accent-hover); outline-offset: 2px; }
        .cms-body { flex: 1; overflow-y: auto; padding: 1rem 1.1rem 1.25rem; }

        .cms-loading-state, .cms-error-state {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            text-align: center; gap: 0.6rem; padding: 2rem 1rem;
            color: var(--cms-text-secondary); font-size: 0.88rem;
        }
        .cms-spinner {
            width: 26px; height: 26px; border-radius: 50%;
            border: 3px solid var(--cms-border); border-top-color: var(--cms-accent);
            animation: cmsSpin 0.7s linear infinite;
        }
        @keyframes cmsSpin { to { transform: rotate(360deg); } }
        .cms-retry-btn {
            border: 1.5px solid var(--cms-accent); color: var(--cms-accent); background: transparent;
            padding: 0.4rem 1rem; border-radius: 8px; font-family: inherit;
            font-size: 0.82rem; font-weight: 700; cursor: pointer;
        }

        .cms-section { margin-bottom: 1rem; }
        .cms-section:last-child { margin-bottom: 0; }
        .cms-section-title { display: block; font-size: 0.8rem; font-weight: 700; color: var(--cms-text-secondary); margin-bottom: 0.45rem; }
        .cms-mode-card {
            display: flex; align-items: flex-start; gap: 0.75rem;
            border: 1.5px solid var(--cms-accent); border-radius: 12px;
            padding: 0.85rem 0.9rem; background: rgba(0, 51, 102, 0.05);
        }
        .cms-mode-icon {
            width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px;
            background: var(--cms-bg); color: var(--cms-accent);
            display: flex; align-items: center; justify-content: center;
        }
        .cms-mode-icon svg { width: 20px; height: 20px; }
        .cms-mode-info { flex: 1; min-width: 0; }
        .cms-mode-title { font-weight: 700; font-size: 0.92rem; }
        .cms-mode-desc { font-size: 0.78rem; color: var(--cms-text-secondary); margin-top: 0.2rem; line-height: 1.5; }
        .cms-check { color: var(--cms-accent); font-weight: 800; }

        .cms-plan-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
        .cms-plan-badge {
            font-size: 0.78rem; font-weight: 800; padding: 0.2rem 0.65rem; border-radius: 999px;
            background: rgba(0, 51, 102, 0.1); color: var(--cms-accent); white-space: nowrap;
        }
        .cms-usage { background: var(--cms-bg-elevated); border-radius: 12px; padding: 0.75rem 0.85rem; }
        .cms-usage-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.82rem; }
        .cms-usage-pct { font-weight: 800; }
        .cms-usage-bar { height: 8px; border-radius: 999px; background: var(--cms-border); overflow: hidden; margin: 0.45rem 0; }
        .cms-usage-bar span { display: block; height: 100%; border-radius: inherit; background: var(--cms-success); }
        .cms-usage[data-tone="warn"] .cms-usage-bar span { background: var(--cms-warning); }
        .cms-usage[data-tone="full"] .cms-usage-bar span { background: var(--cms-danger); }
        .cms-usage-nums { color: var(--cms-text-secondary); }
        .cms-usage-nums span { white-space: nowrap; unicode-bidi: isolate; }
        .cms-usage-reset { font-size: 0.76rem; color: var(--cms-text-secondary); margin-top: 0.3rem; }

        .cms-note { font-size: 0.8rem; color: var(--cms-text-secondary); line-height: 1.6; margin: 0; }
        .cms-alert {
            margin: 0.6rem 0 0; font-size: 0.8rem; font-weight: 600; line-height: 1.6;
            color: #a3231f; background: rgba(217, 83, 79, 0.1);
            border: 1px solid rgba(217, 83, 79, 0.25); border-radius: 8px; padding: 0.55rem 0.7rem;
        }
        .cms-error { margin: 0.6rem 0 0; font-size: 0.8rem; color: var(--cms-danger); }

        .cms-downgrade-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .cms-downgrade-btn {
            border: 1.5px solid var(--cms-border); background: var(--cms-bg); color: var(--cms-text);
            padding: 0.5rem 0.9rem; border-radius: 10px; font-family: inherit;
            font-size: 0.82rem; font-weight: 700; cursor: pointer;
        }
        .cms-downgrade-btn:hover:not(:disabled) { border-color: var(--cms-accent); }
        .cms-downgrade-btn.is-confirm { border-color: var(--cms-danger); color: var(--cms-danger); }
        .cms-downgrade-btn:disabled { opacity: 0.6; cursor: progress; }
        .cms-hint { font-size: 0.74rem; color: var(--cms-text-secondary); margin: 0.45rem 0 0; }

        @media (max-width: 480px) {
            .cms-overlay { align-items: flex-end; padding: 0; }
            .cms-dialog { max-width: 100%; max-height: 92vh; border-radius: 14px 14px 0 0; }
        }
        @media (prefers-reduced-motion: reduce) {
            .cms-overlay, .cms-dialog { animation: none; }
            .cms-spinner { animation-duration: 2s; }
        }
    `;
    document.head.appendChild(style);
}

function loadingHtml() {
    return `<div class="cms-loading-state"><div class="cms-spinner" aria-hidden="true"></div><span>جاري تحميل خطة SIE…</span></div>`;
}

/** HTML اللوحة من حالة الاستحقاق المطبّعة (normalizeEntitlement). دالة نقية. */
export function planPanelHtml(ent, now = Date.now()) {
    const v = usageView(ent, now);
    let usageHtml;
    if (ent.status === 'signed_out') {
        usageHtml = '<p class="cms-note">سجّل الدخول لعرض خطتك واستخدامك.</p>';
    } else if (ent.status !== 'ok') {
        usageHtml = '<p class="cms-note">تعذّر تحميل بيانات الاستخدام الآن. الشات يعمل كالمعتاد.</p>';
    } else if (!v.available) {
        usageHtml = '<p class="cms-note">لا توجد بيانات استخدام بعد.</p>';
    } else {
        usageHtml = `
            <div class="cms-usage" data-tone="${v.tone}">
                <div class="cms-usage-row"><span>الاستخدام</span>${v.percent !== null ? `<span class="cms-usage-pct">${v.percent}%</span>` : ''}</div>
                ${v.percent !== null ? `<div class="cms-usage-bar" role="progressbar" aria-label="نسبة الاستخدام" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.percent}"><span style="width:${v.percent}%"></span></div>` : ''}
                <div class="cms-usage-row cms-usage-nums"><span dir="ltr">${escapeHtml(v.usedText)}</span><span>${escapeHtml(v.remainingText)}</span></div>
                ${v.resetText ? `<div class="cms-usage-reset">${escapeHtml(v.resetText)}</div>` : ''}
            </div>`;
    }

    const reason = ent.status === 'ok' && !ent.hasAccess && ent.reasonText
        ? `<p class="cms-alert" role="status">${escapeHtml(ent.reasonText)} رسائلك تصل لفريق الدعم وهيرد عليك في المحادثة.</p>` : '';

    const downgrades = ent.status === 'ok' && ent.downgradeTo.length
        ? `<div class="cms-section">
               <span class="cms-section-title">تغيير الخطة</span>
               <div class="cms-downgrade-list">${ent.downgradeTo.map((d) => `
                   <button type="button" class="cms-downgrade-btn" data-plan="${escapeHtml(d.plan)}" data-focus-key="down-${escapeHtml(d.plan)}">النزول إلى ${escapeHtml(d.label)}</button>`).join('')}
               </div>
               <p class="cms-hint">الترقية لخطة أعلى بتتم من فريق المنصة.</p>
           </div>` : '';

    return `
        <div class="cms-section">
            <span class="cms-section-title">وضع الرد</span>
            <div class="cms-mode-card">
                <span class="cms-mode-icon">${SIE_ICON}</span>
                <span class="cms-mode-info">
                    <span class="cms-mode-title">محرك الدعم الذكي (SIE)</span>
                    <span class="cms-mode-desc" style="display:block">يفهم المشكلة، يشخّصها، ويرد أو يفتح تذكرة بنفسه.</span>
                </span>
                <span class="cms-check" aria-label="الوضع الحالي">✓</span>
            </div>
        </div>
        <div class="cms-section">
            <div class="cms-plan-row">
                <span class="cms-section-title" style="margin:0">الخطة الحالية</span>
                <span class="cms-plan-badge">${ent.status === 'ok' ? `SIE ${escapeHtml(ent.planLabel)}` : '—'}</span>
            </div>
            ${usageHtml}
            ${reason}
        </div>
        ${downgrades}
        <p class="cms-error" role="alert" hidden></p>`;
}

/**
 * يرسم اللوحة داخل حاوية ويربط أزرار النزول. يرجع دالة إعادة تحميل.
 * @param {HTMLElement} body
 * @param {{onPlanChanged?: (ent:Object) => void}} opts
 */
function mountPanel(body, { onPlanChanged } = {}) {
    let confirmTimer = null;
    let current = null;

    const render = (ent) => {
        current = ent;
        const focusKey = body.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey : null;
        body.innerHTML = planPanelHtml(ent);
        body.querySelectorAll('.cms-downgrade-btn').forEach((btn) => btn.addEventListener('click', () => onDowngrade(btn)));
        if (focusKey) body.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
    };

    const load = async () => {
        body.innerHTML = loadingHtml();
        const ent = await fetchEntitlement(supabase);
        if (ent.status === 'unavailable') {
            body.innerHTML = `<div class="cms-error-state"><span>تعذّر تحميل خطة SIE الآن. الشات يعمل كالمعتاد.</span>
                <button type="button" class="cms-retry-btn">إعادة المحاولة</button></div>`;
            body.querySelector('.cms-retry-btn').addEventListener('click', load);
            return ent;
        }
        render(ent);
        return ent;
    };

    // ضغطة أولى تطلب التأكيد، والثانية تنفّذ على الخادم (نفس نمط الويدجت).
    const onDowngrade = async (btn) => {
        const plan = btn.dataset.plan;
        const label = current?.downgradeTo.find((d) => d.plan === plan)?.label || plan;
        if (btn.dataset.confirm !== '1') {
            body.querySelectorAll('.cms-downgrade-btn.is-confirm').forEach((b) => {
                if (b === btn) return;
                b.dataset.confirm = '';
                b.classList.remove('is-confirm');
                b.textContent = `النزول إلى ${current?.downgradeTo.find((d) => d.plan === b.dataset.plan)?.label || b.dataset.plan}`;
            });
            btn.dataset.confirm = '1';
            btn.classList.add('is-confirm');
            btn.textContent = `تأكيد النزول إلى ${label}؟`;
            clearTimeout(confirmTimer);
            confirmTimer = setTimeout(() => current && render(current), 5000);
            return;
        }
        clearTimeout(confirmTimer);
        btn.disabled = true;
        btn.textContent = 'جاري التغيير…';
        const result = await downgradePlan(supabase, plan);
        const ent = await fetchEntitlement(supabase);
        if (ent.status === 'ok') render(ent);
        if (!result.ok) {
            const err = body.querySelector('.cms-error');
            if (err) { err.textContent = result.errorText; err.hidden = false; }
            return;
        }
        onPlanChanged?.(ent.status === 'ok' ? ent : null, { plan, label });
    };

    return load;
}

/**
 * يرسم لوحة الخطة داخل حاوية موجودة (تبويب الإعدادات).
 * @param {HTMLElement} container
 * @param {{userId?:string, onPlanChanged?:Function, onModeChanged?:Function}} opts
 */
export function renderChatbotModeInto(container, { userId, onPlanChanged, onModeChanged } = {}) {
    injectStyles();
    if (!container) return null;
    container.classList.add('cms-scope');
    if (!userId) {
        container.innerHTML = '<p class="cms-note">يجب تسجيل الدخول لعرض خطة SIE.</p>';
        return null;
    }
    const load = mountPanel(container, { onPlanChanged: onPlanChanged || onModeChanged });
    load();
    return { reload: load };
}

/**
 * نافذة منبثقة بلوحة الخطة (صفحة الشات الكاملة).
 * @param {{userId?:string, onPlanChanged?:Function, onModeChanged?:Function, returnFocus?:HTMLElement}} opts
 */
export function openChatbotModeDialog({ userId, onPlanChanged, onModeChanged, returnFocus } = {}) {
    injectStyles();
    if (!userId) {
        console.error('[chatbot-mode-selector] userId مطلوب لفتح لوحة خطة SIE');
        return null;
    }
    document.querySelector('.cms-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cms-overlay cms-scope';
    overlay.innerHTML = `
        <div class="cms-dialog" role="dialog" aria-modal="true" aria-labelledby="cmsDialogTitle">
            <div class="cms-header">
                <div>
                    <h3 id="cmsDialogTitle">خطة SIE</h3>
                    <p>وضع الرد، استخدامك، وتغيير الخطة</p>
                </div>
                <button type="button" class="cms-close-btn" aria-label="إغلاق">×</button>
            </div>
            <div class="cms-body" id="cmsBody"></div>
        </div>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.cms-dialog');
    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        returnFocus?.focus?.({ preventScroll: true });
    };
    // Esc يغلق، وTab يدور داخل النافذة فقط.
    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        const items = [...dialog.querySelectorAll('button:not([disabled])')];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.cms-close-btn').addEventListener('click', close);
    overlay.querySelector('.cms-close-btn').focus({ preventScroll: true });

    const load = mountPanel(overlay.querySelector('#cmsBody'), { onPlanChanged: onPlanChanged || onModeChanged });
    load();
    return { close, reload: load };
}
