/**
 * chatbot-mode-selector.js
 * ------------------------------------------------------------
 * مكوّن واجهة قابل لإعادة الاستخدام: نافذة اختيار "وضع الشات بوت"
 * (تقليدي / نموذج ذكاء اصطناعي / تلقائي / SIE)، بما فيها اختيار
 * المزوّد والموديل عند اختيار وضع "نموذج ذكاء اصطناعي".
 *
 * مصمم ليُستخدم من أي سياق (الويدجت العائم chat-widget.js، أو صفحة الشات
 * الكاملة chat-logic.js) عن طريق:
 *
 *   import { openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
 *   openChatbotModeDialog({
 *     userId: currentUser.id,
 *     onModeChanged: (newState) => { ... }
 *   });
 *
 * لا يعتمد على أي إطار عمل (Vanilla JS)، بنفس أسلوب باقي المشروع، ويحقن
 * الـ CSS الخاصة به مرة واحدة فقط بأسماء متغيرات معزولة (--cms-*) حتى لا
 * تتعارض مع أي نظام ألوان موجود في الصفحة المضيفة.
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';
import {
    CHATBOT_MODES,
    CHATBOT_MODE_LABELS,
    CHATBOT_MODE_DESCRIPTIONS,
    isModeAvailableForEntitlement,
    hasChatbotEntitlement,
    fetchChatbotModeState,
    saveChatbotModeState,
    fetchCustomerVisibleIntegrations,
    fetchCustomerVisibleModels,
    getAutoModeExplanation,
    getSiePlaceholderInfo
} from '/assets/js/chatbot-mode-service.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const MODE_ICONS = {
    [CHATBOT_MODES.TRADITIONAL]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h10M7 13h6"></path></svg>',
    [CHATBOT_MODES.AI_MODEL]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M9 8V5a3 3 0 0 1 6 0v3"></path><circle cx="9" cy="13.5" r="1"></circle><circle cx="15" cy="13.5" r="1"></circle></svg>',
    [CHATBOT_MODES.AUTO]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"></path><circle cx="12" cy="12" r="4"></circle></svg>',
    [CHATBOT_MODES.SIE]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"></path><path d="M9.5 12l1.8 1.8L15 10"></path></svg>'
};

let stylesInjected = false;
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'chatbotModeSelectorStyles';
    style.textContent = `
        .cms-overlay {
            --cms-bg: #ffffff;
            --cms-bg-elevated: #f4f6f8;
            --cms-border: rgba(0, 51, 102, 0.12);
            --cms-text: #23272b;
            --cms-text-secondary: #5c6570;
            --cms-accent: #003366;
            --cms-accent-hover: #0055aa;
            --cms-success: #22c55e;
            --cms-danger: #d9534f;
            --cms-warning: #e0a800;
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 32, 0.45);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100000;
            padding: 1rem;
            font-family: 'Cairo', system-ui, sans-serif;
            animation: cmsFadeIn 0.15s ease-out;
        }
        @keyframes cmsFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cmsSlideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .cms-dialog {
            background: var(--cms-bg);
            border-radius: 16px;
            width: 100%;
            max-width: 480px;
            max-height: min(640px, 88vh);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            animation: cmsSlideUp 0.18s ease-out;
            direction: rtl;
        }

        .cms-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1.1rem 1.25rem;
            background: var(--cms-accent);
            color: #fff;
            flex-shrink: 0;
        }
        .cms-header h3 { margin: 0; font-size: 1.05rem; font-weight: 700; }
        .cms-header p { margin: 0.2rem 0 0; font-size: 0.78rem; opacity: 0.85; }
        .cms-close-btn {
            background: rgba(255,255,255,0.12);
            border: none;
            color: #fff;
            width: 30px; height: 30px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1.2rem;
            line-height: 1;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
            transition: background 0.15s ease;
        }
        .cms-close-btn:hover { background: rgba(255,255,255,0.22); }

        .cms-body {
            flex: 1;
            overflow-y: auto;
            padding: 1rem 1.1rem 1.25rem;
        }

        .cms-loading-state, .cms-error-state, .cms-empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            gap: 0.6rem;
            padding: 2.25rem 1rem;
            color: var(--cms-text-secondary);
            font-size: 0.88rem;
        }
        .cms-spinner {
            width: 26px; height: 26px;
            border-radius: 50%;
            border: 3px solid var(--cms-border);
            border-top-color: var(--cms-accent);
            animation: cmsSpin 0.7s linear infinite;
        }
        @keyframes cmsSpin { to { transform: rotate(360deg); } }
        .cms-error-state svg, .cms-empty-state svg { width: 34px; height: 34px; color: var(--cms-text-secondary); }
        .cms-error-state { color: var(--cms-danger); }
        .cms-retry-btn {
            margin-top: 0.25rem;
            border: 1.5px solid var(--cms-accent);
            color: var(--cms-accent);
            background: transparent;
            padding: 0.4rem 1rem;
            border-radius: 8px;
            font-family: inherit;
            font-size: 0.82rem;
            font-weight: 700;
            cursor: pointer;
        }
        .cms-retry-btn:hover { background: rgba(0,51,102,0.06); }

        .cms-mode-list { display: flex; flex-direction: column; gap: 0.6rem; }

        .cms-mode-card {
            display: flex;
            align-items: flex-start;
            gap: 0.75rem;
            border: 1.5px solid var(--cms-border);
            border-radius: 12px;
            padding: 0.85rem 0.9rem;
            cursor: pointer;
            transition: border-color 0.15s ease, background 0.15s ease;
            text-align: right;
            background: var(--cms-bg);
        }
        .cms-mode-card:hover:not(.cms-mode-card-disabled) { border-color: var(--cms-accent); background: var(--cms-bg-elevated); }
        .cms-mode-card.cms-mode-card-active { border-color: var(--cms-accent); background: rgba(0, 51, 102, 0.06); }
        .cms-mode-card-disabled { opacity: 0.55; cursor: not-allowed; }

        .cms-mode-icon {
            width: 38px; height: 38px;
            flex-shrink: 0;
            border-radius: 10px;
            background: var(--cms-bg-elevated);
            color: var(--cms-accent);
            display: flex; align-items: center; justify-content: center;
        }
        .cms-mode-icon svg { width: 20px; height: 20px; }

        .cms-mode-info { flex: 1; min-width: 0; }
        .cms-mode-title-row { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
        .cms-mode-title { font-weight: 700; font-size: 0.92rem; color: var(--cms-text); }
        .cms-mode-desc { font-size: 0.78rem; color: var(--cms-text-secondary); margin-top: 0.2rem; line-height: 1.5; }

        .cms-badge {
            font-size: 0.68rem;
            font-weight: 700;
            padding: 0.15rem 0.5rem;
            border-radius: 999px;
            display: inline-block;
        }
        .cms-badge-locked { background: rgba(224, 168, 0, 0.15); color: #9a6c00; }
        .cms-badge-soon { background: rgba(92, 101, 112, 0.15); color: var(--cms-text-secondary); }
        .cms-badge-active { background: rgba(34, 197, 94, 0.15); color: #15803d; }

        .cms-radio-dot {
            width: 20px; height: 20px;
            border-radius: 50%;
            border: 2px solid var(--cms-border);
            flex-shrink: 0;
            margin-top: 2px;
            display: flex; align-items: center; justify-content: center;
        }
        .cms-mode-card-active .cms-radio-dot { border-color: var(--cms-accent); }
        .cms-mode-card-active .cms-radio-dot::after {
            content: '';
            width: 10px; height: 10px;
            border-radius: 50%;
            background: var(--cms-accent);
        }

        .cms-locked-note {
            margin-top: 0.5rem;
            font-size: 0.74rem;
            color: #9a6c00;
            background: rgba(224, 168, 0, 0.1);
            border-radius: 8px;
            padding: 0.5rem 0.65rem;
            line-height: 1.5;
        }

        .cms-section-title {
            font-size: 0.8rem;
            font-weight: 700;
            color: var(--cms-text);
            margin: 1.1rem 0 0.5rem;
        }

        .cms-select {
            width: 100%;
            padding: 0.6rem 0.75rem;
            border-radius: 10px;
            border: 1.5px solid var(--cms-border);
            font-family: inherit;
            font-size: 0.85rem;
            color: var(--cms-text);
            background: var(--cms-bg);
            appearance: none;
        }
        .cms-select:disabled { opacity: 0.6; cursor: not-allowed; }
        .cms-field-help { font-size: 0.74rem; color: var(--cms-text-secondary); margin-top: 0.35rem; line-height: 1.5; }

        .cms-info-box {
            background: var(--cms-bg-elevated);
            border-radius: 10px;
            padding: 0.75rem 0.85rem;
            font-size: 0.82rem;
            color: var(--cms-text-secondary);
            line-height: 1.6;
            margin-top: 0.6rem;
        }

        .cms-footer {
            display: flex;
            gap: 0.6rem;
            padding: 0.9rem 1.1rem;
            border-top: 1px solid var(--cms-border);
            flex-shrink: 0;
        }
        .cms-btn {
            flex: 1;
            padding: 0.65rem 1rem;
            border-radius: 10px;
            font-family: inherit;
            font-size: 0.85rem;
            font-weight: 700;
            cursor: pointer;
            border: none;
            transition: opacity 0.15s ease, background 0.15s ease;
        }
        .cms-btn-primary { background: var(--cms-accent); color: #fff; }
        .cms-btn-primary:hover:not(:disabled) { background: var(--cms-accent-hover); }
        .cms-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
        .cms-btn-secondary { background: var(--cms-bg-elevated); color: var(--cms-text); }
        .cms-btn-secondary:hover { background: var(--cms-border); }

        .cms-toast {
            position: fixed;
            bottom: 1.5rem;
            left: 50%;
            transform: translateX(-50%);
            background: var(--cms-text, #23272b);
            color: #fff;
            padding: 0.6rem 1.1rem;
            border-radius: 10px;
            font-family: 'Cairo', system-ui, sans-serif;
            font-size: 0.85rem;
            z-index: 100001;
            box-shadow: 0 8px 24px rgba(0,0,0,0.25);
            animation: cmsFadeIn 0.15s ease-out;
        }
        .cms-toast-success { background: #15803d; }
        .cms-toast-error { background: var(--cms-danger, #d9534f); }

        @media (max-width: 480px) {
            .cms-dialog { max-width: 100%; max-height: 92vh; border-radius: 14px 14px 0 0; align-self: flex-end; }
            .cms-overlay { align-items: flex-end; padding: 0; }
        }
    `;
    document.head.appendChild(style);
}

function showToast(message, kind = 'success') {
    const existing = document.querySelector('.cms-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `cms-toast ${kind === 'error' ? 'cms-toast-error' : 'cms-toast-success'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
}

/**
 * يرسم واجهة اختيار الوضع (بدون الفوتر/الحوار) داخل أي عنصر حاوٍ (container)
 * موجود بالفعل في الصفحة. يُستخدم هذا مباشرة من التبويب داخل نافذة إعدادات
 * العميل (customer-settings-modal)، وأيضًا داخليًا من openChatbotModeDialog.
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {(state: {mode:string, integrationId:?string, modelId:?string}) => void} [opts.onModeChanged]
 * @param {boolean} [opts.showFooterButtons=true] - هل تُعرض أزرار حفظ/إلغاء منفصلة، أم يُحفظ فور الاختيار (للاستخدام داخل تبويب)
 */
export function renderChatbotModeInto(container, { userId, onModeChanged, showFooterButtons = true } = {}) {
    injectStyles();
    if (!container) return;
    if (!userId) {
        container.innerHTML = `<div class="cms-empty-state">يجب تسجيل الدخول لعرض إعدادات وضع الشات بوت.</div>`;
        return;
    }
    container.innerHTML = `
        <div class="cms-loading-state">
            <div class="cms-spinner"></div>
            <span>جاري تحميل الإعدادات...</span>
        </div>
    `;
    loadAndRender({ userId, body: container, onModeChanged, showFooterButtons, isDialog: false });
}

/**
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {(state: {mode:string, integrationId:?string, modelId:?string}) => void} [opts.onModeChanged]
 */
export function openChatbotModeDialog({ userId, onModeChanged } = {}) {
    injectStyles();

    if (!userId) {
        console.error('[chatbot-mode-selector] userId مطلوب لفتح نافذة اختيار الوضع');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'cms-overlay';
    overlay.innerHTML = `
        <div class="cms-dialog" role="dialog" aria-modal="true" aria-label="اختيار وضع الشات بوت">
            <div class="cms-header">
                <div>
                    <h3>وضع الشات بوت</h3>
                    <p>اختار طريقة رد البوت على رسائلك</p>
                </div>
                <button type="button" class="cms-close-btn" id="cmsCloseBtn" aria-label="إغلاق">×</button>
            </div>
            <div class="cms-body" id="cmsBody">
                <div class="cms-loading-state">
                    <div class="cms-spinner"></div>
                    <span>جاري تحميل الإعدادات...</span>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cmsCloseBtn').addEventListener('click', close);
    const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    const body = overlay.querySelector('#cmsBody');
    loadAndRender({ userId, body, overlay, onModeChanged, showFooterButtons: true, isDialog: true });

    return { close };
}

async function loadAndRender({ userId, body, overlay, onModeChanged, showFooterButtons, isDialog }) {
    let entitled = false;
    let state = null;
    try {
        [entitled, state] = await Promise.all([
            hasChatbotEntitlement(userId),
            fetchChatbotModeState(userId)
        ]);
    } catch (err) {
        renderErrorState(body, 'حصل خطأ أثناء تحميل إعدادات وضع الشات بوت.', () => loadAndRender({ userId, body, overlay, onModeChanged, showFooterButtons, isDialog }));
        return;
    }

    let integrations = [];
    let integrationsError = null;
    try {
        integrations = await fetchCustomerVisibleIntegrations();
    } catch (err) {
        console.warn('[chatbot-mode-selector] تعذّر تحميل المزوّدات:', err?.message || err);
        integrationsError = err;
    }

    renderModeList({ body, overlay, userId, entitled, state, integrations, integrationsError, onModeChanged, showFooterButtons, isDialog });
}

function renderErrorState(body, message, onRetry) {
    body.innerHTML = `
        <div class="cms-error-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.01"></path></svg>
            <span>${escapeHtml(message)}</span>
            <button type="button" class="cms-retry-btn" id="cmsRetryBtn">إعادة المحاولة</button>
        </div>
    `;
    body.querySelector('#cmsRetryBtn')?.addEventListener('click', onRetry);
}

function renderModeList({ body, overlay, userId, entitled, state, integrations, integrationsError, onModeChanged, showFooterButtons, isDialog }) {
    let selectedMode = state.chatbot_mode;
    let selectedIntegrationId = state.chatbot_selected_integration_id;
    let selectedModelId = state.chatbot_selected_model_id;

    const modesOrder = [CHATBOT_MODES.TRADITIONAL, CHATBOT_MODES.AI_MODEL, CHATBOT_MODES.AUTO, CHATBOT_MODES.SIE];
    const sie = getSiePlaceholderInfo();

    function modeCardHtml(mode) {
        const available = isModeAvailableForEntitlement(mode, entitled) && !(mode === CHATBOT_MODES.SIE && !sie.available);
        const isActive = selectedMode === mode;
        let badge = '';
        if (mode === CHATBOT_MODES.SIE && !sie.available) {
            badge = `<span class="cms-badge cms-badge-soon">${escapeHtml(sie.statusLabel)}</span>`;
        } else if (!available) {
            badge = `<span class="cms-badge cms-badge-locked">للمشتركين فقط</span>`;
        } else if (isActive) {
            badge = `<span class="cms-badge cms-badge-active">مفعّل</span>`;
        }
        return `
            <button type="button" class="cms-mode-card ${isActive ? 'cms-mode-card-active' : ''} ${!available ? 'cms-mode-card-disabled' : ''}" data-mode="${mode}" ${!available ? 'disabled' : ''}>
                <div class="cms-radio-dot"></div>
                <div class="cms-mode-icon">${MODE_ICONS[mode]}</div>
                <div class="cms-mode-info">
                    <div class="cms-mode-title-row">
                        <span class="cms-mode-title">${escapeHtml(CHATBOT_MODE_LABELS[mode])}</span>
                        ${badge}
                    </div>
                    <div class="cms-mode-desc">${escapeHtml(mode === CHATBOT_MODES.SIE ? sie.description : CHATBOT_MODE_DESCRIPTIONS[mode])}</div>
                </div>
            </button>
        `;
    }

    body.innerHTML = `
        <div class="cms-mode-list" id="cmsModeList">
            ${modesOrder.map(modeCardHtml).join('')}
        </div>
        ${!entitled ? `<div class="cms-locked-note">الأوضاع المتقدمة (نموذج ذكاء اصطناعي، تلقائي، SIE) متاحة للمشتركين فقط. تقدر تشترك من صفحة الاشتراكات.</div>` : ''}
        <div id="cmsExtraSection"></div>
    `;

    renderExtraSection();

    body.querySelectorAll('.cms-mode-card').forEach(card => {
        card.addEventListener('click', () => {
            if (card.disabled) return;
            selectedMode = card.dataset.mode;
            body.querySelectorAll('.cms-mode-card').forEach(c => c.classList.remove('cms-mode-card-active'));
            card.classList.add('cms-mode-card-active');
            const activeBadge = card.querySelector('.cms-badge-locked, .cms-badge-soon');
            if (!activeBadge) {
                card.querySelector('.cms-mode-title-row').insertAdjacentHTML('beforeend', `<span class="cms-badge cms-badge-active">مفعّل</span>`);
            }
            body.querySelectorAll('.cms-mode-card:not(.cms-mode-card-active) .cms-badge-active').forEach(b => b.remove());
            renderExtraSection();
        });
    });

    function renderExtraSection() {
        const extra = body.querySelector('#cmsExtraSection');
        if (!extra) return;

        if (selectedMode === CHATBOT_MODES.AI_MODEL) {
            extra.innerHTML = buildProviderModelSectionHtml();
            wireProviderModelSection(extra);
        } else if (selectedMode === CHATBOT_MODES.AUTO) {
            extra.innerHTML = `<div class="cms-info-box">${escapeHtml(getAutoModeExplanation())}</div>`;
        } else if (selectedMode === CHATBOT_MODES.SIE) {
            extra.innerHTML = `<div class="cms-info-box">${escapeHtml(sie.description)}</div>`;
        } else {
            extra.innerHTML = '';
        }
    }

    function buildProviderModelSectionHtml() {
        if (integrationsError) {
            return `
                <div class="cms-error-state" style="padding:1.1rem 0.5rem;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.01"></path></svg>
                    <span>تعذّر تحميل قائمة المزوّدات المتاحة.</span>
                    <button type="button" class="cms-retry-btn" id="cmsRetryIntegrations">إعادة المحاولة</button>
                </div>
            `;
        }
        if (!integrations.length) {
            return `
                <div class="cms-empty-state" style="padding:1.1rem 0.5rem;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M9 8V5a3 3 0 0 1 6 0v3"></path></svg>
                    <span>لا يوجد مزوّدات ذكاء اصطناعي متاحة حاليًا.</span>
                </div>
            `;
        }
        return `
            <div class="cms-section-title">المزوّد</div>
            <select class="cms-select" id="cmsIntegrationSelect">
                <option value="">اختر مزوّدًا...</option>
                ${integrations.map(i => `<option value="${i.id}" ${i.id === selectedIntegrationId ? 'selected' : ''}>${escapeHtml(i.display_name)}</option>`).join('')}
            </select>
            <div class="cms-section-title">الموديل</div>
            <select class="cms-select" id="cmsModelSelect" disabled>
                <option value="">${selectedIntegrationId ? 'جاري التحميل...' : 'اختر مزوّدًا أولاً'}</option>
            </select>
            <div class="cms-field-help">لو المزوّد مفعّل لكن مفيش موديلات مكتشفة له بعد، هيتم استخدام الموديل الافتراضي المضبوط من الإدارة تلقائيًا.</div>
        `;
    }

    function wireProviderModelSection(extra) {
        const retryBtn = extra.querySelector('#cmsRetryIntegrations');
        if (retryBtn) {
            retryBtn.addEventListener('click', async () => {
                try {
                    integrations = await fetchCustomerVisibleIntegrations();
                    integrationsError = null;
                } catch (err) {
                    integrationsError = err;
                }
                renderExtraSection();
            });
            return;
        }

        const integrationSelect = extra.querySelector('#cmsIntegrationSelect');
        const modelSelect = extra.querySelector('#cmsModelSelect');
        if (!integrationSelect || !modelSelect) return;

        async function loadModelsFor(integrationId) {
            selectedModelId = null;
            if (!integrationId) {
                modelSelect.innerHTML = '<option value="">اختر مزوّدًا أولاً</option>';
                modelSelect.disabled = true;
                return;
            }
            modelSelect.disabled = true;
            modelSelect.innerHTML = '<option value="">جاري التحميل...</option>';
            try {
                const models = await fetchCustomerVisibleModels(integrationId);
                if (!models.length) {
                    // لا توجد موديلات مكتشفة - هذا متوقع لبعض المزوّدات (راجع §3.4:
                    // fallback إلى DEFAULT_MODELS في الباك إند)، فليس خطأ بل حالة طبيعية.
                    modelSelect.innerHTML = '<option value="">سيتم استخدام الموديل الافتراضي</option>';
                    modelSelect.disabled = true;
                    return;
                }
                modelSelect.innerHTML = models.map(m =>
                    `<option value="${m.model_id}" ${m.model_id === selectedModelId ? 'selected' : ''}>${escapeHtml(m.display_name || m.model_id)}${m.is_default ? ' (افتراضي)' : ''}</option>`
                ).join('');
                modelSelect.disabled = false;
            } catch (err) {
                console.warn('[chatbot-mode-selector] تعذّر تحميل الموديلات:', err?.message || err);
                modelSelect.innerHTML = '<option value="">تعذّر تحميل الموديلات</option>';
                modelSelect.disabled = true;
            }
        }

        integrationSelect.addEventListener('change', () => {
            selectedIntegrationId = integrationSelect.value || null;
            loadModelsFor(selectedIntegrationId);
        });
        modelSelect.addEventListener('change', () => {
            selectedModelId = modelSelect.value || null;
        });

        if (selectedIntegrationId) loadModelsFor(selectedIntegrationId);
    }

    async function doSave(saveBtn) {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'جاري الحفظ...';
        }

        const result = await saveChatbotModeState(userId, {
            mode: selectedMode,
            integrationId: selectedMode === CHATBOT_MODES.AI_MODEL ? selectedIntegrationId : null,
            modelId: selectedMode === CHATBOT_MODES.AI_MODEL ? selectedModelId : null
        });

        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ';
        }

        if (!result.ok) {
            showToast('حصل خطأ أثناء حفظ الإعدادات، حاول تاني.', 'error');
            return false;
        }

        showToast('تم حفظ وضع الشات بوت بنجاح');
        if (typeof onModeChanged === 'function') {
            onModeChanged({ mode: selectedMode, integrationId: selectedIntegrationId, modelId: selectedModelId });
        }
        return true;
    }

    if (isDialog && showFooterButtons) {
        // ===== الفوتر (حفظ/إلغاء) - داخل الحوار المنبثق =====
        const dialog = overlay.querySelector('.cms-dialog');
        const existingFooter = dialog.querySelector('.cms-footer');
        if (existingFooter) existingFooter.remove();
        const footer = document.createElement('div');
        footer.className = 'cms-footer';
        footer.innerHTML = `
            <button type="button" class="cms-btn cms-btn-secondary" id="cmsCancelBtn">إلغاء</button>
            <button type="button" class="cms-btn cms-btn-primary" id="cmsSaveBtn">حفظ</button>
        `;
        dialog.appendChild(footer);

        footer.querySelector('#cmsCancelBtn').addEventListener('click', () => overlay.remove());
        footer.querySelector('#cmsSaveBtn').addEventListener('click', async () => {
            const ok = await doSave(footer.querySelector('#cmsSaveBtn'));
            if (ok) overlay.remove();
        });
    } else {
        // ===== وضع مضمّن (داخل تبويب): زر حفظ ثابت أسفل القائمة، بدون إلغاء/إغلاق =====
        const existingInlineFooter = body.querySelector('.cms-inline-footer');
        if (existingInlineFooter) existingInlineFooter.remove();
        const inlineFooter = document.createElement('div');
        inlineFooter.className = 'cms-inline-footer';
        inlineFooter.style.cssText = 'margin-top:1rem;';
        inlineFooter.innerHTML = `<button type="button" class="cms-btn cms-btn-primary" id="cmsInlineSaveBtn" style="width:100%;">حفظ</button>`;
        body.appendChild(inlineFooter);
        inlineFooter.querySelector('#cmsInlineSaveBtn').addEventListener('click', () => doSave(inlineFooter.querySelector('#cmsInlineSaveBtn')));
    }
}
