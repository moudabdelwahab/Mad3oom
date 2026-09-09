/**
 * api-token-modal.js — نافذة إنشاء مفتاح API.
 *
 * كل الخيارات المعروضة تُرسَم من api-token-model.js، فقائمة الصلاحيات
 * موجودة **مرة واحدة** في الكود وتطابق عقد الدالة المنشورة. إضافة صلاحية
 * جديدة هناك تظهر هنا بلا تعديل في هذا الملف ولا في الـHTML.
 *
 * السرّ يُعرض مرة واحدة ثم لا يُخزَّن ولا يُسجَّل: مفيش console.log له،
 * ومفيش حفظ في أي مكان، والنافذة نفسها لا تُغلق بـEscape ولا بالنقر على
 * الخلفية بعد ظهوره — إغلاق بالخطأ يعني مفتاحًا ضائعًا لا استرجاع له.
 */

import {
    SCOPE_CATALOG, CREDENTIAL_TYPES, EXPIRY_PRESETS, DEFAULT_EXPIRY_PRESET, DEFAULT_SCOPES,
    validateTokenForm, toCreatePayload, credentialsFromResponse,
    expiryFromPreset, minCustomExpiryDate, maxCustomExpiryDate
} from '/assets/js/company/api-token-model.js';
import { createCompanyApiToken } from '/assets/js/company/company-data.js';
import { escapeHtml, formatDate } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const MODAL_ID = 'createApiTokenModal';

let onCreated = null;
let wired = false;
let revealed = false;   // ظهر سرّ في النافذة؟ لو أيوه فالإغلاق العَرَضي ممنوع

export function initApiTokenModal({ onCreated: handler } = {}) {
    onCreated = handler || null;

    const modal = document.getElementById(MODAL_ID);
    if (!modal || wired) return;
    wired = true;

    renderCredentialTypes();
    renderScopes();
    renderExpiryPresets();

    document.getElementById('createApiTokenClose')?.addEventListener('click', requestClose);
    document.getElementById('cancelApiTokenBtn')?.addEventListener('click', requestClose);
    document.getElementById('doneApiTokenBtn')?.addEventListener('click', () => { revealed = false; closeModal(); });

    modal.addEventListener('click', (event) => {
        if (event.target === modal) requestClose();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('active')) requestClose();
    });

    document.getElementById('createApiTokenForm')?.addEventListener('submit', onSubmit);
}

/* ── فتح وإغلاق ─────────────────────────────────────────────────────────── */

export function openApiTokenModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    revealed = false;
    clearErrors();
    resetForm();

    document.getElementById('createApiTokenForm').hidden = false;
    document.getElementById('createApiTokenResult').hidden = true;
    modal.classList.add('active');
    document.getElementById('fTokenName')?.focus();
}

/** الإغلاق العَرَضي ممنوع بعد ظهور السرّ — فيه زر صريح لذلك. */
function requestClose() {
    if (revealed) return;
    closeModal();
}

function closeModal() {
    document.getElementById(MODAL_ID)?.classList.remove('active');
    // نمسح السرّ من الـDOM فور الإغلاق بدل ما يفضل في الصفحة
    const secrets = document.getElementById('createApiTokenSecrets');
    if (secrets) secrets.innerHTML = '';
    document.getElementById('companyCreateKey')?.focus();
}

function resetForm() {
    const form = document.getElementById('createApiTokenForm');
    form.reset();

    // الافتراضات: نوع الاعتماد الموصى به، صلاحيات الدالة الافتراضية،
    // ومدّة محدودة. القيم دي هي اللي بيختارها أغلب الناس فعلًا.
    setCredentialType(CREDENTIAL_TYPES.find(t => t.recommended)?.key || CREDENTIAL_TYPES[0].key);
    setScopes(DEFAULT_SCOPES);
    setExpiryPreset(DEFAULT_EXPIRY_PRESET);

    const btn = document.getElementById('submitApiTokenBtn');
    btn.disabled = false;
    btn.textContent = 'إنشاء المفتاح';
}

/* ── رسم الخيارات من النموذج ────────────────────────────────────────────── */

function renderCredentialTypes() {
    const box = document.getElementById('apiTokenCredentialTypes');
    if (!box) return;

    box.innerHTML = CREDENTIAL_TYPES.map(type => `
        <label class="choice-card">
            <input type="radio" name="credentialType" value="${escapeHtml(type.key)}">
            <span class="choice-body">
                <span class="choice-title">
                    ${escapeHtml(type.label)}
                    ${type.recommended ? '<span class="choice-badge">موصى به</span>' : ''}
                </span>
                <span class="choice-hint">${type.hint}</span>
            </span>
        </label>`).join('');
}

function renderScopes() {
    const box = document.getElementById('apiTokenScopes');
    if (!box) return;

    box.innerHTML = SCOPE_CATALOG.map(group => `
        <section class="scope-group">
            <header class="scope-group-head">
                <div>
                    <h3 class="scope-group-title">${escapeHtml(group.label)}</h3>
                    <p class="scope-group-hint">${escapeHtml(group.hint)}</p>
                </div>
                <button type="button" class="panel-link" data-scope-group="${escapeHtml(group.key)}">تحديد الكل</button>
            </header>
            <div class="scope-list">
                ${group.scopes.map(scope => `
                    <label class="scope-item${scope.danger ? ' scope-item--danger' : ''}">
                        <input type="checkbox" name="scopes" value="${escapeHtml(scope.key)}">
                        <span class="scope-label">${escapeHtml(scope.label)}</span>
                        <code class="scope-key">${escapeHtml(scope.key)}</code>
                    </label>`).join('')}
            </div>
        </section>`).join('');

    box.querySelectorAll('[data-scope-group]').forEach(btn => {
        btn.addEventListener('click', () => toggleGroup(btn.getAttribute('data-scope-group'), btn));
    });
    box.addEventListener('change', () => {
        updateScopeCount();
        syncGroupButtons();
    });

    updateScopeCount();
    syncGroupButtons();
}

function renderExpiryPresets() {
    const box = document.getElementById('apiTokenExpiryPresets');
    if (!box) return;

    box.innerHTML = EXPIRY_PRESETS.map(preset => `
        <label class="chip">
            <input type="radio" name="expiryPreset" value="${escapeHtml(preset.key)}">
            <span>
                ${escapeHtml(preset.label)}
                ${preset.recommended ? '<span class="choice-badge">موصى به</span>' : ''}
            </span>
        </label>`).join('');

    box.addEventListener('change', () => {
        const preset = currentExpiryPreset();
        document.getElementById('apiTokenCustomExpiryField').hidden = preset !== 'custom';
        if (preset === 'custom') document.getElementById('fTokenExpiry')?.focus();
        updateExpiryHint();
    });

    const input = document.getElementById('fTokenExpiry');
    if (input) {
        input.min = minCustomExpiryDate();
        input.max = maxCustomExpiryDate();
        input.addEventListener('change', updateExpiryHint);
    }
}

/* ── قراءة/كتابة حالة النموذج ───────────────────────────────────────────── */

function setCredentialType(key) {
    document.querySelectorAll('#apiTokenCredentialTypes input[name="credentialType"]')
        .forEach(input => { input.checked = input.value === key; });
}

function currentCredentialType() {
    return document.querySelector('#apiTokenCredentialTypes input[name="credentialType"]:checked')?.value
        || CREDENTIAL_TYPES[0].key;
}

function setScopes(keys) {
    const wanted = new Set(keys || []);
    document.querySelectorAll('#apiTokenScopes input[name="scopes"]')
        .forEach(input => { input.checked = wanted.has(input.value); });
    updateScopeCount();
    syncGroupButtons();
}

function currentScopes() {
    return [...document.querySelectorAll('#apiTokenScopes input[name="scopes"]:checked')].map(i => i.value);
}

function setExpiryPreset(key) {
    document.querySelectorAll('#apiTokenExpiryPresets input[name="expiryPreset"]')
        .forEach(input => { input.checked = input.value === key; });
    document.getElementById('apiTokenCustomExpiryField').hidden = key !== 'custom';
    updateExpiryHint();
}

function currentExpiryPreset() {
    return document.querySelector('#apiTokenExpiryPresets input[name="expiryPreset"]:checked')?.value
        || DEFAULT_EXPIRY_PRESET;
}

function toggleGroup(groupKey, btn) {
    const group = SCOPE_CATALOG.find(g => g.key === groupKey);
    if (!group) return;

    const inputs = group.scopes.map(s =>
        document.querySelector(`#apiTokenScopes input[value="${CSS.escape(s.key)}"]`)).filter(Boolean);
    const allOn = inputs.every(i => i.checked);
    inputs.forEach(i => { i.checked = !allOn; });

    btn.textContent = allOn ? 'تحديد الكل' : 'إلغاء الكل';
    updateScopeCount();
    syncGroupButtons();
}

function syncGroupButtons() {
    for (const group of SCOPE_CATALOG) {
        const btn = document.querySelector(`[data-scope-group="${CSS.escape(group.key)}"]`);
        if (!btn) continue;
        const inputs = group.scopes.map(s =>
            document.querySelector(`#apiTokenScopes input[value="${CSS.escape(s.key)}"]`)).filter(Boolean);
        btn.textContent = inputs.length && inputs.every(i => i.checked) ? 'إلغاء الكل' : 'تحديد الكل';
    }
}

function updateScopeCount() {
    const label = document.getElementById('apiTokenScopeCount');
    if (!label) return;
    const count = currentScopes().length;
    label.textContent = count ? `${count} مُختارة` : 'لم تُختَر صلاحية بعد';
}

/** يعرض التاريخ الفعلي الناتج عن الاختيار — لا تخمين للمستخدم. */
function updateExpiryHint() {
    const hint = document.getElementById('apiTokenExpiryHint');
    if (!hint) return;

    const preset = currentExpiryPreset();
    const iso = expiryFromPreset(preset, { customDate: document.getElementById('fTokenExpiry')?.value });

    if (!iso) {
        hint.textContent = preset === 'custom'
            ? 'اختر تاريخًا في المستقبل.'
            : 'المفتاح يبقى صالحًا حتى توقفه أو تسحبه يدويًا.';
        return;
    }
    hint.textContent = `المفتاح ينتهي في ${formatDate(iso)}.`;
}

/* ── الأخطاء ────────────────────────────────────────────────────────────── */

function clearErrors() {
    document.querySelectorAll('#createApiTokenForm [data-token-error-for]').forEach(el => {
        el.hidden = true;
        el.textContent = '';
    });
    const box = document.getElementById('createApiTokenError');
    box.hidden = true;
    box.textContent = '';
}

function showFieldErrors(errors) {
    for (const [field, message] of Object.entries(errors)) {
        const el = document.querySelector(`#createApiTokenForm [data-token-error-for="${field}"]`);
        if (el) { el.textContent = message; el.hidden = false; }
    }
}

function showError(message) {
    const box = document.getElementById('createApiTokenError');
    box.textContent = message;
    box.hidden = false;
}

/* ── الإرسال ────────────────────────────────────────────────────────────── */

async function onSubmit(event) {
    event.preventDefault();
    clearErrors();

    const values = {
        name: document.getElementById('fTokenName').value,
        description: document.getElementById('fTokenDescription').value,
        credentialType: currentCredentialType(),
        scopes: currentScopes(),
        expiryPreset: currentExpiryPreset(),
        customExpiry: document.getElementById('fTokenExpiry')?.value || ''
    };

    const validation = validateTokenForm(values);
    if (!validation.isValid) {
        showFieldErrors(validation.errors);
        return;
    }

    const btn = document.getElementById('submitApiTokenBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإنشاء…';

    // createCompanyApiToken بتعيد قراءة استحقاق api_tokens من القاعدة قبل
    // النداء، فالرفض بيحصل على الخادم لا في الزر.
    const result = await createCompanyApiToken(toCreatePayload(values));

    btn.disabled = false;
    btn.textContent = 'إنشاء المفتاح';

    if (!result.ok) {
        // الفشل يظل داخل النافذة كرسالة مفهومة — مفيش أي تحويل لأي صفحة.
        showError(result.error || 'تعذّر إنشاء المفتاح. حاول مرة أخرى.');
        return;
    }

    const credentials = credentialsFromResponse(result.data);
    if (!credentials.length) {
        showError('أُنشئ المفتاح لكن تعذّر عرض قيمه. راجع القائمة ثم اسحبه وأنشئ بديلًا.');
        await onCreated?.();
        return;
    }

    revealSecrets(credentials);
    await onCreated?.();
}

/* ── لحظة العرض الوحيدة ─────────────────────────────────────────────────── */

function revealSecrets(credentials) {
    revealed = true;
    document.getElementById('createApiTokenForm').hidden = true;
    document.getElementById('createApiTokenResult').hidden = false;

    const box = document.getElementById('createApiTokenSecrets');
    box.innerHTML = credentials.map((cred, index) => `
        <section class="secret-card" data-secret-card="${index}">
            <h3 class="secret-card-title">${escapeHtml(cred.label)}</h3>
            ${cred.apiKey ? field('المعرّف العلني (api_key)', cred.apiKey, `key-${index}`) : ''}
            ${field(cred.kind === 'bearer' ? 'رمز Bearer' : 'السرّ (secret)', cred.secret, `secret-${index}`)}
            ${field('رأس المصادقة الجاهز', cred.headerValue, `header-${index}`)}
        </section>`).join('');

    box.querySelectorAll('[data-copy-target]').forEach(btn => {
        btn.addEventListener('click', () => copyField(btn));
    });

    document.getElementById('doneApiTokenBtn')?.focus();
}

function field(label, value, id) {
    return `
        <div class="secret-field">
            <label class="secret-label" for="secretValue-${escapeHtml(id)}">${escapeHtml(label)}</label>
            <div class="secret-row">
                <input type="text" class="form-control secret-input" id="secretValue-${escapeHtml(id)}"
                       value="${escapeHtml(value)}" readonly spellcheck="false" dir="ltr">
                <button type="button" class="btn btn-secondary secret-copy"
                        data-copy-target="secretValue-${escapeHtml(id)}">نسخ</button>
            </div>
        </div>`;
}

async function copyField(btn) {
    const input = document.getElementById(btn.getAttribute('data-copy-target'));
    if (!input) return;

    const done = () => {
        const original = btn.textContent;
        btn.textContent = 'تم النسخ';
        setTimeout(() => { btn.textContent = original; }, 1500);
    };

    try {
        await navigator.clipboard.writeText(input.value);
        done();
    } catch {
        // متصفح بلا صلاحية حافظة: التحديد اليدوي أوضح من رسالة فشل
        input.select();
        ui?.showToast?.('انسخ القيمة المحدَّدة يدويًا (Ctrl+C)', 'info');
    }
}
