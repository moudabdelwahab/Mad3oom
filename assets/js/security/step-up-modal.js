/**
 * step-up-modal.js — نافذة التحقق بخطوتين لحظة الإجراء المحمي، وشارة «جلسة التحرير» (121).
 *
 *   requestStepUp({ reason })   يفتح النافذة ⇒ true بعد تحقق ناجح (owner_step_up)، false عند الإلغاء
 *   ensureStepUp({ reason })    جلسة سارية؟ true فورًا؛ وإلا النافذة
 *   installCriticalGuard(root)  نقرة على [data-critical] بلا جلسة ⇒ النافذة، ثم تُعاد النقرة نفسها
 *   mountSessionChip(el)        الشارة: مقفلة/مفتوحة مع العدّ التنازلي، وإنهاء الجلسة
 *
 * المدة من سياسة المالك (owner_security_policy) وتُفرض في القاعدة؛ هذه الواجهة تعرضها فقط. الرمز لا يُحفظ
 * ولا يُسجَّل في أي مكان: يذهب إلى owner_step_up ويُمسح من الحقل.
 */
import { supabase } from '/api-config.js';

export const STEP_UP_EVENT = 'owner:step-up-changed';

const ERRORS = {
    invalid_code: 'الرمز غير صحيح أو مستعمل من قبل. أدخل الرمز الحالي من تطبيق المصادقة.',
    mfa_not_enrolled: 'التحقق بخطوتين غير مفعّل على حسابك بعد.',
    too_many_attempts: 'محاولات كثيرة متتالية. انتظر قليلًا ثم حاول مجددًا.'
};

let cached = { at: 0, status: null };

export async function stepUpStatus({ refresh = false } = {}) {
    if (!refresh && cached.status && Date.now() - cached.at < 5000) return cached.status;
    const { data, error } = await supabase.rpc('owner_security_status');
    if (error) return null;
    cached = { at: Date.now(), status: data };
    return data;
}

function ensureStyles() {
    if (document.getElementById('stepUpStyles')) return;
    const link = document.createElement('link');
    link.id = 'stepUpStyles';
    link.rel = 'stylesheet';
    link.href = '/assets/css/step-up.css';
    document.head.appendChild(link);
}

function announce(text) {
    document.dispatchEvent(new CustomEvent(STEP_UP_EVENT, { detail: { text } }));
}

let open = null;

/** @returns {Promise<boolean>} */
export function requestStepUp({ reason = '' } = {}) {
    if (open) return open;
    open = new Promise((resolve) => {
        ensureStyles();
        const opener = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'stepup-overlay';
        overlay.innerHTML = `
            <div class="stepup-dialog" role="dialog" aria-modal="true" aria-labelledby="stepUpTitle" aria-describedby="stepUpDesc">
                <div class="stepup-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>
                </div>
                <h2 class="stepup-title" id="stepUpTitle">تأكيد هويتك</h2>
                <p class="stepup-reason" id="stepUpReason"></p>
                <p class="stepup-desc" id="stepUpDesc">أدخل الرمز الحالي من Google Authenticator لفتح جلسة تحرير.</p>
                <form class="stepup-form" id="stepUpModalForm" novalidate>
                    <label class="stepup-label" for="stepUpModalCode" id="stepUpModalLabel">رمز التحقق (6 أرقام)</label>
                    <input class="form-control stepup-code" id="stepUpModalCode" name="code" dir="ltr" autocomplete="one-time-code"
                           inputmode="numeric" maxlength="6" placeholder="000000" required>
                    <p class="stepup-error" id="stepUpModalError" role="alert" hidden></p>
                    <div class="stepup-actions">
                        <button type="submit" class="btn btn-primary" id="stepUpModalSubmit">تحقق ومتابعة</button>
                        <button type="button" class="btn btn-outline" id="stepUpModalCancel">إلغاء</button>
                    </div>
                    <button type="button" class="stepup-switch" id="stepUpModalMode">فقدت التطبيق؟ استخدم رمز استرداد</button>
                </form>
            </div>`;
        const $ = (id) => overlay.querySelector('#' + id);
        $('stepUpReason').textContent = reason || 'هذا الإجراء محمي ويتطلب تحققًا إضافيًا.';
        $('stepUpReason').hidden = false;
        let mode = 'totp';

        const finish = (ok) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            document.body.classList.remove('stepup-open');
            if (opener?.focus) opener.focus({ preventScroll: true });
            open = null;
            resolve(ok);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            if (e.key === 'Tab') {   // التركيز يبقى داخل النافذة
                const f = [...overlay.querySelectorAll('input, button')].filter(el => !el.disabled && el.offsetParent !== null);
                if (!f.length) return;
                const i = f.indexOf(document.activeElement);
                if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); }
                else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
            }
        };
        const showError = (text) => { $('stepUpModalError').textContent = text; $('stepUpModalError').hidden = false; };

        $('stepUpModalCancel').addEventListener('click', () => finish(false));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
        $('stepUpModalMode').addEventListener('click', () => {
            mode = mode === 'totp' ? 'recovery' : 'totp';
            const input = $('stepUpModalCode');
            input.value = '';
            input.maxLength = mode === 'totp' ? 6 : 20;
            input.inputMode = mode === 'totp' ? 'numeric' : 'text';
            input.placeholder = mode === 'totp' ? '000000' : 'XXXXXXXXXX';
            $('stepUpModalLabel').textContent = mode === 'totp' ? 'رمز التحقق (6 أرقام)' : 'رمز استرداد (10 خانات، يُستعمل مرة واحدة)';
            $('stepUpModalMode').textContent = mode === 'totp' ? 'فقدت التطبيق؟ استخدم رمز استرداد' : 'استخدام تطبيق المصادقة';
            $('stepUpModalError').hidden = true;
            input.focus();
        });
        $('stepUpModalForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = $('stepUpModalCode');
            const code = input.value.replace(/\s/g, '');
            if (mode === 'totp' && !/^\d{6}$/.test(code)) { showError('الرمز ستة أرقام.'); input.focus(); return; }
            if (mode === 'recovery' && code.length < 8) { showError('رمز الاسترداد 10 خانات.'); input.focus(); return; }
            const btn = $('stepUpModalSubmit');
            btn.disabled = true; btn.setAttribute('aria-busy', 'true');
            const { data, error } = await supabase.rpc('owner_step_up', { p_code: code });
            btn.disabled = false; btn.removeAttribute('aria-busy');
            input.value = '';
            if (error || !data?.verified) {
                if (data?.error === 'mfa_not_enrolled') {
                    $('stepUpModalForm').innerHTML = `<p class="stepup-error">${ERRORS.mfa_not_enrolled}</p>
                        <div class="stepup-actions"><a class="btn btn-primary" href="/admin-security-settings.html">تفعيل التحقق بخطوتين</a>
                        <button type="button" class="btn btn-outline" data-close>إغلاق</button></div>`;
                    overlay.querySelector('[data-close]').addEventListener('click', () => finish(false));
                    return;
                }
                const retry = data?.retry_after_seconds ? ` (بعد ${Math.ceil(data.retry_after_seconds / 60)} دقيقة)` : '';
                showError((error?.message || ERRORS[data?.error] || 'تعذّر التحقق.') + retry);
                input.focus();
                return;
            }
            cached = { at: 0, status: null };
            announce(data.method === 'recovery_code' ? 'فُتحت جلسة التحرير برمز استرداد.' : 'فُتحت جلسة التحرير.');
            finish(true);
        });

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        document.body.classList.add('stepup-open');
        $('stepUpModalCode').focus({ preventScroll: true });

        // المدة الفعلية من السياسة (لا رقم ثابت في الواجهة)
        stepUpStatus().then((s) => {
            if (!s) return;
            if (!s.mfa_enrolled) {
                $('stepUpModalForm').innerHTML = `<p class="stepup-error">${ERRORS.mfa_not_enrolled} العمليات المحمية ترفضها القاعدة حتى تفعّله.</p>
                    <div class="stepup-actions"><a class="btn btn-primary" href="/admin-security-settings.html">تفعيل التحقق بخطوتين</a>
                    <button type="button" class="btn btn-outline" data-close>إغلاق</button></div>`;
                overlay.querySelector('[data-close]').addEventListener('click', () => finish(false));
                return;
            }
            if (s.step_up_minutes) {
                $('stepUpDesc').textContent = `أدخل الرمز الحالي من Google Authenticator. تُفتح جلسة تحرير لمدة ${s.step_up_minutes} دقيقة لهذه الجلسة وحدها، ثم يُطلب رمز جديد.`;
            }
        });
    });
    return open;
}

export async function ensureStepUp({ reason } = {}) {
    const s = await stepUpStatus({ refresh: true });
    if (s?.step_up_fresh) return true;
    return requestStepUp({ reason });
}

/** نقرة على [data-critical] بلا جلسة سارية ⇒ النافذة، وبعد التحقق تُعاد النقرة نفسها. */
export function installCriticalGuard(root = document) {
    if (root.__stepUpGuard) return;
    root.__stepUpGuard = true;
    let replaying = false;
    root.addEventListener('click', async (e) => {
        const el = e.target.closest?.('[data-critical]');
        if (!el || replaying || el.disabled) return;
        const s = cached.status && Date.now() - cached.at < 5000 ? cached.status : null;
        if (s?.step_up_fresh) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const ok = await ensureStepUp({ reason: el.getAttribute('data-critical-label') || `«${(el.textContent || '').trim()}» عملية محمية تتطلب جلسة تحرير.` });
        if (!ok || !el.isConnected) return;
        replaying = true;
        try { el.click(); } finally { replaying = false; }
    }, true);
}

/** شارة جلسة التحرير مع العدّ التنازلي. */
export function mountSessionChip(container) {
    if (!container || container.querySelector('.stepup-chip')) return;
    ensureStyles();
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stepup-chip';
    chip.setAttribute('aria-live', 'polite');
    container.appendChild(chip);
    let timer = null;
    let expiresAt = 0;

    const paint = () => {
        const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        if (!left) {
            chip.dataset.state = 'locked';
            chip.innerHTML = '<span class="stepup-chip-dot" aria-hidden="true"></span><span>جلسة التحرير مقفلة</span>';
            chip.title = 'افتح جلسة تحرير بالتحقق بخطوتين';
            clearInterval(timer); timer = null;
            document.documentElement.dataset.criticalOps = 'locked';
            return;
        }
        const mm = String(Math.floor(left / 60)).padStart(2, '0');
        const ss = String(left % 60).padStart(2, '0');
        chip.dataset.state = 'open';
        chip.innerHTML = `<span class="stepup-chip-dot" aria-hidden="true"></span><span>جلسة التحرير مفتوحة</span><span class="stepup-chip-time" dir="ltr">${mm}:${ss}</span>`;
        chip.title = 'انقر لإنهاء جلسة التحرير الآن';
        document.documentElement.dataset.criticalOps = 'open';
    };
    const refresh = async () => {
        const s = await stepUpStatus({ refresh: true });
        expiresAt = s?.step_up_fresh && s.step_up_expires_at ? Date.parse(s.step_up_expires_at) : 0;
        paint();
        if (expiresAt && !timer) timer = setInterval(paint, 1000);
    };
    chip.addEventListener('click', async () => {
        if (chip.dataset.state === 'open') {
            if (!window.confirm('إنهاء جلسة التحرير الآن؟ العمليات المحمية ستطلب رمزًا جديدًا.')) return;
            await supabase.rpc('owner_end_step_up');
            cached = { at: 0, status: null };
            announce('أُنهيت جلسة التحرير.');
            return;
        }
        await requestStepUp({ reason: 'فتح جلسة تحرير للعمليات المحمية.' });
    });
    document.addEventListener(STEP_UP_EVENT, refresh);
    refresh();
    return { refresh };
}
