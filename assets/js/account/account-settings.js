/**
 * account-settings.js — واجهة «الملف الشخصي والأمان» الموحّدة.
 *
 * تُركَّب داخل لوحة العميل ولوحة الشركة ولوحة الإدارة، وكل لوحة تحتفظ
 * بقشرتها وتنقّلها وتصميمها: الوحدة ترسم بأصناف تملكها كل لوحة أصلًا
 * (panel / form-control / btn) ولا تفرض شكلًا.
 *
 *   account-core.js      القواعد الخالصة (تحقّق، حالات عرض صادقة)
 *   account-service.js   النداءات
 *   هذا الملف            الرسم وربط الأحداث فقط
 *
 * إعدادات المنصة (سياسات الأمان العامة، الهوية، …) ليست هنا عمدًا: هذه
 * إعدادات حساب شخصي، وتلك في لوحة الإدارة وحدها.
 *
 * وضع القراءة فقط (readOnly): في التقمّص الجلسة جلسة الأدمن، فأي نموذج هنا
 * كان سيكتب على حساب الأدمن وهو يرى بيانات العميل (PS-17). لذلك يُعرض
 * الحساب المستهدف بلا أي نموذج أو زر كتابة.
 */

import { escapeHtml, formatDate, formatDateTime } from '/assets/js/customer/portal-ui.js';
import {
    PASSWORD_RULE_TEXT, validateNewPassword, validateFullName, validateEmail, validatePhone,
    validateAvatarFile, protectionFacts, isTrustedDeviceActive
} from '/assets/js/account/account-core.js';
import * as service from '/assets/js/account/account-service.js';

const READ_ONLY_TEXT = {
    impersonation: 'أنت تتصفّح حساب هذا العميل. بيانات الملف الشخصي والأمان معروضة للقراءة فقط، ولا يمكن تعديلها من هنا — أي تعديل كان سيقع على حسابك أنت لا على حسابه.',
    preview: 'وضع المعاينة للقراءة فقط.'
};

const PILL = {
    on: 'status-resolved', partial: 'status-pending', off: 'status-neutral',
    unavailable: 'status-neutral', unknown: 'status-neutral'
};

/* ── أدوات صغيرة ───────────────────────────────────────────────────────── */

function $(root, id) { return root.querySelector(`#${id}`); }

function showError(root, id, message) {
    const el = $(root, `${id}Error`);
    const field = $(root, id);
    if (el) { el.textContent = message; el.classList.remove('u-hidden'); }
    if (field) field.setAttribute('aria-invalid', 'true');
}

function clearError(root, id) {
    const el = $(root, `${id}Error`);
    const field = $(root, id);
    if (el) { el.textContent = ''; el.classList.add('u-hidden'); }
    if (field) field.removeAttribute('aria-invalid');
}

function setStatus(root, id, message, tone = 'ok') {
    const el = $(root, id);
    if (!el) return;
    el.textContent = message || '';
    el.dataset.tone = tone;
    el.classList.toggle('u-hidden', !message);
}

async function busy(button, label, fn) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try { return await fn(); } finally {
        button.disabled = false;
        button.textContent = original;
    }
}

function initials(name, email) {
    const src = String(name || email || '؟').trim();
    return escapeHtml(src.charAt(0).toUpperCase());
}

function panel(title, subtitle, body, extraClass = '') {
    return `
        <section class="panel acct-card ${extraClass}">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">${escapeHtml(title)}</h2>
                    ${subtitle ? `<p class="panel-subtitle">${escapeHtml(subtitle)}</p>` : ''}
                </div>
            </div>
            ${body}
        </section>`;
}

function field({ id, label, type = 'text', value = '', attrs = '', hint = '', full = false }) {
    return `
        <div class="form-field${full ? ' is-full' : ''}">
            <label for="${id}">${escapeHtml(label)}</label>
            <input type="${type}" id="${id}" class="form-control" value="${escapeHtml(value)}" ${attrs}>
            ${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ''}
            <p class="field-error u-hidden" id="${id}Error"></p>
        </div>`;
}

const statusLine = (id) => `<p class="acct-status u-hidden" id="${id}" role="status"></p>`;

/* ── الحالة المشتركة للعرض ─────────────────────────────────────────────── */

async function loadContext(opts) {
    const user = opts.userId ? null : await service.sessionUser();
    const userId = opts.userId || user?.id;
    if (!userId) return { error: 'لم يتم العثور على جلسة. سجّل الدخول مرة أخرى.' };
    const res = await service.getAccount(userId);
    if (!res.ok) return { error: res.error };
    return {
        userId,
        email: opts.email || user?.email || res.data.email || '',
        account: res.data,
        readOnly: !!opts.readOnly,
        readOnlyReason: opts.readOnlyReason || 'preview',
        notify: typeof opts.notify === 'function' ? opts.notify : null,
        onAccountChanged: typeof opts.onAccountChanged === 'function' ? opts.onAccountChanged : () => {}
    };
}

function readOnlyBanner(ctx) {
    return ctx.readOnly
        ? `<div class="acct-banner" role="note">${escapeHtml(READ_ONLY_TEXT[ctx.readOnlyReason] || READ_ONLY_TEXT.preview)}</div>`
        : '';
}

/* ── الملف الشخصي ──────────────────────────────────────────────────────── */

function renderProfile(ctx) {
    const a = ctx.account;
    const avatar = a.avatar_url
        ? `<img src="${escapeHtml(a.avatar_url)}" alt="" class="acct-avatar-img">`
        : `<span>${initials(a.full_name, ctx.email)}</span>`;

    if (ctx.readOnly) {
        return readOnlyBanner(ctx) + panel('البيانات الشخصية', '', `
            <div class="acct-avatar-row"><div class="acct-avatar">${avatar}</div></div>
            <dl class="acct-facts">
                <div><dt>الاسم الكامل</dt><dd>${escapeHtml(a.full_name || '—')}</dd></div>
                <div><dt>البريد الإلكتروني</dt><dd>${escapeHtml(a.email || '—')}</dd></div>
                <div><dt>رقم الهاتف</dt><dd>${escapeHtml(a.phone || '—')}</dd></div>
                <div><dt>نبذة</dt><dd>${escapeHtml(a.bio || '—')}</dd></div>
            </dl>`);
    }

    return `
        <div class="acct-grid">
            ${panel('البيانات الشخصية', 'تظهر لفريق الدعم عند التعامل مع طلباتك', `
                <div class="acct-avatar-row">
                    <div class="acct-avatar" id="acctAvatarPreview">${avatar}</div>
                    <div>
                        <input type="file" id="acctAvatarInput" accept="image/png,image/jpeg,image/webp" class="u-hidden">
                        <button type="button" class="btn btn-secondary btn-sm" id="acctAvatarBtn">تغيير الصورة</button>
                        <p class="field-hint">PNG أو JPG أو WEBP، حتى 2 ميجابايت.</p>
                        <p class="field-error u-hidden" id="acctAvatarInputError"></p>
                    </div>
                </div>
                <form id="profileForm" novalidate>
                    <div class="form-grid">
                        ${field({ id: 'profileFullName', label: 'الاسم الكامل', value: a.full_name || '', attrs: 'autocomplete="name" maxlength="120"', full: true })}
                        <div class="form-field is-full">
                            <label for="profileBio">نبذة عنك</label>
                            <textarea id="profileBio" class="form-control" rows="3" maxlength="500" placeholder="نبذة مختصرة (اختياري)">${escapeHtml(a.bio || '')}</textarea>
                        </div>
                    </div>
                    ${statusLine('acctProfileStatus')}
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary" id="profileSaveBtn">حفظ التغييرات</button>
                        <button type="button" class="btn btn-secondary" id="profileResetBtn">تراجع</button>
                    </div>
                </form>`)}

            ${panel('رقم الهاتف', 'مطلوب لبقاء الحساب مفعّلًا، ويُستخدم لتسجيل الدخول', `
                <form id="acctPhoneForm" novalidate>
                    <div class="form-grid">
                        ${field({ id: 'profilePhone', label: 'رقم الهاتف', type: 'tel', value: a.phone || '',
                                  attrs: 'autocomplete="tel" inputmode="tel"',
                                  hint: 'الرقم غير موثّق برمز حتى الآن.', full: true })}
                    </div>
                    ${statusLine('acctPhoneStatus')}
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary" id="acctPhoneSaveBtn">حفظ الرقم</button>
                    </div>
                </form>`)}

            ${panel('البريد الإلكتروني', 'هو هوية حسابك عند تسجيل الدخول', `
                <div class="form-grid">
                    ${field({ id: 'profileEmail', label: 'البريد الحالي', type: 'email', value: ctx.email, attrs: 'disabled', full: true })}
                </div>
                <form id="acctEmailForm" novalidate>
                    <div class="form-grid">
                        ${field({ id: 'acctNewEmail', label: 'البريد الجديد', type: 'email', attrs: 'autocomplete="email"',
                                  hint: 'سيصلك رابط تأكيد. لن يتغيّر بريدك قبل الضغط عليه.', full: true })}
                    </div>
                    ${statusLine('acctEmailStatus')}
                    <div class="form-actions">
                        <button type="submit" class="btn btn-secondary" id="acctEmailSaveBtn">طلب تغيير البريد</button>
                    </div>
                </form>`)}
        </div>`;
}

function wireProfile(root, ctx) {
    if (ctx.readOnly) return;
    let baseline = { fullName: ctx.account.full_name || '', bio: ctx.account.bio || '' };

    $(root, 'acctAvatarBtn')?.addEventListener('click', () => $(root, 'acctAvatarInput').click());
    $(root, 'acctAvatarInput')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        clearError(root, 'acctAvatarInput');
        const problem = validateAvatarFile(file);
        if (problem) { showError(root, 'acctAvatarInput', problem); return; }
        await busy($(root, 'acctAvatarBtn'), 'جارٍ الرفع…', async () => {
            const res = await service.uploadAvatar(file, ctx.userId);
            if (!res.ok) { showError(root, 'acctAvatarInput', res.error); return; }
            ctx.account.avatar_url = res.data.avatar_url;
            $(root, 'acctAvatarPreview').innerHTML = `<img src="${escapeHtml(res.data.avatar_url)}" alt="" class="acct-avatar-img">`;
            ctx.onAccountChanged({ ...ctx.account });
            ctx.notify?.('تم تحديث الصورة', 'success');
        });
        e.target.value = '';
    });

    $(root, 'profileForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fullName = $(root, 'profileFullName').value.trim();
        const bio = $(root, 'profileBio').value.trim();
        clearError(root, 'profileFullName');
        setStatus(root, 'acctProfileStatus', '');

        const problem = validateFullName(fullName);
        if (problem) { showError(root, 'profileFullName', problem); return; }
        if (fullName === baseline.fullName && bio === baseline.bio) {
            setStatus(root, 'acctProfileStatus', 'لا توجد تغييرات لحفظها', 'info');
            return;
        }
        await busy($(root, 'profileSaveBtn'), 'جارٍ الحفظ…', async () => {
            const res = await service.saveBasics({ fullName, bio });
            if (!res.ok) { setStatus(root, 'acctProfileStatus', `تعذّر الحفظ: ${res.error}`, 'error'); return; }
            baseline = { fullName, bio };
            Object.assign(ctx.account, { full_name: fullName, bio });
            ctx.onAccountChanged({ ...ctx.account });
            setStatus(root, 'acctProfileStatus', 'تم حفظ بياناتك');
            ctx.notify?.('تم حفظ بياناتك', 'success');
        });
    });

    $(root, 'profileResetBtn')?.addEventListener('click', () => {
        $(root, 'profileFullName').value = baseline.fullName;
        $(root, 'profileBio').value = baseline.bio;
        clearError(root, 'profileFullName');
        setStatus(root, 'acctProfileStatus', '');
    });

    $(root, 'acctPhoneForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = $(root, 'profilePhone').value.trim();
        clearError(root, 'profilePhone');
        setStatus(root, 'acctPhoneStatus', '');
        const problem = validatePhone(phone);
        if (problem) { showError(root, 'profilePhone', problem); return; }
        await busy($(root, 'acctPhoneSaveBtn'), 'جارٍ الحفظ…', async () => {
            const res = await service.savePhone(phone, ctx.account);
            if (!res.ok) { showError(root, 'profilePhone', res.error); return; }
            ctx.account.phone = res.data?.phone || ctx.account.phone;
            if (res.data?.whatsapp_phone !== undefined) ctx.account.whatsapp_phone = res.data.whatsapp_phone;
            $(root, 'profilePhone').value = ctx.account.phone || phone;
            ctx.onAccountChanged({ ...ctx.account });
            setStatus(root, 'acctPhoneStatus', 'تم حفظ رقم الهاتف');
        });
    });

    $(root, 'acctEmailForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $(root, 'acctNewEmail').value.trim();
        clearError(root, 'acctNewEmail');
        setStatus(root, 'acctEmailStatus', '');
        const problem = validateEmail(email);
        if (problem) { showError(root, 'acctNewEmail', problem); return; }
        if (email.toLowerCase() === String(ctx.email).toLowerCase()) {
            showError(root, 'acctNewEmail', 'هذا هو بريدك الحالي');
            return;
        }
        await busy($(root, 'acctEmailSaveBtn'), 'جارٍ الإرسال…', async () => {
            const res = await service.requestEmailChange(email);
            if (!res.ok) { showError(root, 'acctNewEmail', res.error); return; }
            $(root, 'acctNewEmail').value = '';
            setStatus(root, 'acctEmailStatus',
                'أُرسل رابط التأكيد. بريدك الحالي يبقى كما هو حتى تضغط الرابط.');
        });
    });
}

/* ── الأمان ────────────────────────────────────────────────────────────── */

function renderFacts(ctx) {
    return protectionFacts(ctx.account).map(f => {
        const value = f.key === 'password' && f.value ? formatDate(f.value) : f.value || f.note;
        const note = f.key === 'password' ? '' : f.note;
        return `
            <div class="acct-fact" data-fact="${f.key}">
                <dt>${escapeHtml(f.label)}</dt>
                <dd>
                    <span class="pill ${PILL[f.state] || 'status-neutral'}">${escapeHtml(value)}</span>
                    ${note ? `<p class="field-hint">${escapeHtml(note)}</p>` : ''}
                </dd>
            </div>`;
    }).join('');
}

function renderTwoFactor(ctx) {
    if (ctx.account.two_factor_enabled) {
        return `
            <p class="panel-subtitle">مفعّل. لإيقافه أدخل رمزًا حاليًا من تطبيق المصادقة، أو أحد رموز الاستعادة.</p>
            <form id="acctTfaDisableForm" novalidate>
                <div class="form-grid">
                    ${field({ id: 'acctTfaProof', label: 'الرمز أو رمز الاستعادة', attrs: 'autocomplete="one-time-code"', full: true })}
                </div>
                ${statusLine('acctTfaStatus')}
                <div class="form-actions">
                    <button type="submit" class="btn btn-danger" id="acctTfaDisableBtn">إيقاف التحقق بخطوتين</button>
                </div>
            </form>
            <p class="field-hint">رموز الاستعادة تُعرض مرة واحدة عند التفعيل ولا يمكن عرضها ثانيةً — هي محفوظة بصيغة مشفّرة لا تُقرأ. لإصدار رموز جديدة: أوقف التحقق ثم فعّله من جديد.</p>`;
    }
    return `
        <p class="panel-subtitle">غير مفعّل. عند التفعيل يُطلب رمز من تطبيق المصادقة (مثل Google Authenticator) عند كل تسجيل دخول.</p>
        <div id="acctTfaSetup" class="u-hidden">
            <ol class="acct-steps">
                <li>امسح الرمز بتطبيق المصادقة، أو أدخل المفتاح يدويًا.
                    <div class="acct-qr" id="acctTfaQr" aria-label="رمز QR لإعداد التحقق بخطوتين"></div>
                    <code class="acct-secret" id="acctTfaSecret"></code>
                </li>
                <li>أدخل الرمز المكوّن من 6 أرقام الظاهر في التطبيق.</li>
            </ol>
            <form id="acctTfaConfirmForm" novalidate>
                <div class="form-grid">
                    ${field({ id: 'acctTfaCode', label: 'رمز التحقق', attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"', full: true })}
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary" id="acctTfaConfirmBtn">تأكيد وتفعيل</button>
                    <button type="button" class="btn btn-secondary" id="acctTfaCancelBtn">إلغاء</button>
                </div>
            </form>
        </div>
        ${statusLine('acctTfaStatus')}
        <div class="form-actions" id="acctTfaStartRow">
            <button type="button" class="btn btn-primary" id="acctTfaStartBtn">تفعيل التحقق بخطوتين</button>
        </div>`;
}

function renderRecoveryCodes(codes) {
    return `
        <div class="acct-recovery" id="acctRecoveryCodes">
            <p><strong>احفظ رموز الاستعادة الآن.</strong> كل رمز يُستخدم مرة واحدة لتسجيل الدخول أو لإيقاف التحقق إن فقدت هاتفك. لن تظهر مرة أخرى.</p>
            <ul class="acct-code-grid">${codes.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" id="acctRecoveryCopyBtn">نسخ</button>
                <button type="button" class="btn btn-primary" id="acctRecoveryDoneBtn">حفظتها</button>
            </div>
        </div>`;
}

function renderDevices(devices) {
    if (!devices.length) {
        return '<p class="panel-subtitle">لا توجد أجهزة موثوقة.</p>';
    }
    return `<ul class="acct-devices">${devices.map(d => {
        const active = isTrustedDeviceActive(d);
        return `
            <li class="acct-device">
                <div>
                    <strong>${escapeHtml(d.device_name || 'جهاز بدون اسم')}</strong>
                    <p class="field-hint">
                        ${active
                            ? `يتخطّى رمز 2FA حتى ${escapeHtml(formatDate(d.trusted_until))}`
                            : 'منتهي — سيُطلب الرمز عند الدخول منه'}
                        · آخر استخدام ${escapeHtml(d.last_login ? formatDateTime(d.last_login) : 'غير معروف')}
                    </p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" data-remove-device="${escapeHtml(d.id)}">إزالة</button>
            </li>`;
    }).join('')}</ul>
    <div class="form-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="acctRemoveAllDevicesBtn">إزالة كل الأجهزة</button>
    </div>`;
}

function renderSecurity(ctx) {
    const facts = panel('حماية الحساب', 'الحالة الفعلية لوسائل الحماية على هذا الحساب',
        `<dl class="acct-facts">${renderFacts(ctx)}</dl>`);

    if (ctx.readOnly) return readOnlyBanner(ctx) + facts;

    return `
        ${facts}
        <div class="acct-grid">
            ${panel('كلمة المرور', 'تغييرها يُنهي جلساتك على الأجهزة الأخرى', `
                <form id="acctPasswordForm" novalidate>
                    <div class="form-grid">
                        ${field({ id: 'acctCurrentPassword', label: 'كلمة المرور الحالية', type: 'password', attrs: 'autocomplete="current-password"', full: true })}
                        ${field({ id: 'newPassword', label: 'كلمة المرور الجديدة', type: 'password', attrs: 'autocomplete="new-password"', hint: PASSWORD_RULE_TEXT, full: true })}
                        ${field({ id: 'confirmPassword', label: 'تأكيد كلمة المرور', type: 'password', attrs: 'autocomplete="new-password"', full: true })}
                    </div>
                    ${statusLine('acctPasswordStatus')}
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary" id="passwordSaveBtn">تحديث كلمة المرور</button>
                    </div>
                </form>`)}

            ${panel('التحقق بخطوتين', '', `<div id="acctTfaBody">${renderTwoFactor(ctx)}</div>`)}
        </div>

        <div class="acct-grid">
            ${panel('الجلسات', 'أين يوجد حسابك مفتوحًا الآن', `
                <p class="panel-subtitle">لا تتيح المنصة حاليًا قائمة تفصيلية بالجلسات. إن شككت في دخول ليس منك، أنهِ كل الجلسات الأخرى وغيّر كلمة المرور.</p>
                ${statusLine('acctSessionsStatus')}
                <div class="form-actions">
                    <button type="button" class="btn btn-danger" id="acctSignOutOthersBtn">تسجيل الخروج من كل الأجهزة الأخرى</button>
                </div>`)}

            ${panel('الأجهزة الموثوقة', 'أجهزة اخترت عليها «تذكّر هذا الجهاز» فلا يُطلب منها رمز 2FA', `
                <p class="field-hint">الجهاز الموثوق ليس جلسة دخول: إزالته لا تُخرج أحدًا، لكنها تعيد طلب رمز التحقق عند الدخول القادم منه.</p>
                <div id="acctDevicesBody"><p class="panel-subtitle">جارٍ التحميل…</p></div>
                ${statusLine('acctDevicesStatus')}`)}
        </div>`;
}

/** مكتبة QR محلية (assets/vendor) — لا يغادر سرّ 2FA المتصفح (PS-05). */
function loadQrLibrary() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/assets/vendor/qrcode-generator-1.4.4.js';
        s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qr')));
        s.onerror = () => reject(new Error('qr'));
        document.head.appendChild(s);
    });
}

async function renderQr(el, text) {
    try {
        const qrcode = await loadQrLibrary();
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
        el.innerHTML = '<p class="field-hint">تعذّر رسم رمز QR — أدخل المفتاح أدناه يدويًا.</p>';
    }
}

async function refreshDevices(root, ctx) {
    const body = $(root, 'acctDevicesBody');
    if (!body) return;
    const res = await service.listTrustedDevices(ctx.userId);
    if (!res.ok) { body.innerHTML = `<p class="field-error">${escapeHtml(res.error)}</p>`; return; }
    body.innerHTML = renderDevices(res.data);

    body.querySelectorAll('[data-remove-device]').forEach(btn => btn.addEventListener('click', async () => {
        await busy(btn, 'جارٍ الإزالة…', async () => {
            const r = await service.removeTrustedDevice(btn.dataset.removeDevice);
            setStatus(root, 'acctDevicesStatus', r.ok ? 'أُزيل الجهاز. سيُطلب رمز التحقق عند الدخول منه.' : r.error, r.ok ? 'ok' : 'error');
        });
        await refreshDevices(root, ctx);
    }));
    $(root, 'acctRemoveAllDevicesBtn')?.addEventListener('click', async (e) => {
        if (!window.confirm('إزالة كل الأجهزة الموثوقة؟ سيُطلب رمز التحقق عند الدخول من أي جهاز.')) return;
        await busy(e.currentTarget, 'جارٍ الإزالة…', async () => {
            const r = await service.removeAllTrustedDevices(ctx.userId);
            setStatus(root, 'acctDevicesStatus', r.ok ? 'أُزيلت كل الأجهزة الموثوقة.' : r.error, r.ok ? 'ok' : 'error');
        });
        await refreshDevices(root, ctx);
    });
}

function rerenderTwoFactor(root, ctx) {
    $(root, 'acctTfaBody').innerHTML = renderTwoFactor(ctx);
    const facts = root.querySelector('.acct-facts');
    if (facts) facts.innerHTML = renderFacts(ctx);
    wireTwoFactor(root, ctx);
}

function wireTwoFactor(root, ctx) {
    let pendingSecret = null;

    $(root, 'acctTfaStartBtn')?.addEventListener('click', async (e) => {
        setStatus(root, 'acctTfaStatus', '');
        await busy(e.currentTarget, 'جارٍ التجهيز…', async () => {
            const res = await service.startTwoFactorEnrollment();
            if (!res.ok) { setStatus(root, 'acctTfaStatus', res.error, 'error'); return; }
            pendingSecret = res.data.secret;
            $(root, 'acctTfaSecret').textContent = pendingSecret;
            await renderQr($(root, 'acctTfaQr'), res.data.otpauthUrl);
            $(root, 'acctTfaSetup').classList.remove('u-hidden');
            $(root, 'acctTfaStartRow').classList.add('u-hidden');
            $(root, 'acctTfaCode').focus();
        });
    });

    $(root, 'acctTfaCancelBtn')?.addEventListener('click', () => {
        pendingSecret = null;
        $(root, 'acctTfaSetup').classList.add('u-hidden');
        $(root, 'acctTfaStartRow').classList.remove('u-hidden');
        $(root, 'acctTfaQr').innerHTML = '';
        $(root, 'acctTfaSecret').textContent = '';
    });

    $(root, 'acctTfaConfirmForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError(root, 'acctTfaCode');
        const code = $(root, 'acctTfaCode').value.trim();
        if (!/^\d{6}$/.test(code)) { showError(root, 'acctTfaCode', 'أدخل الرمز المكوّن من 6 أرقام'); return; }
        if (!pendingSecret) { showError(root, 'acctTfaCode', 'ابدأ الإعداد من جديد'); return; }
        await busy($(root, 'acctTfaConfirmBtn'), 'جارٍ التحقق…', async () => {
            const res = await service.confirmTwoFactorEnrollment({ userId: ctx.userId, secret: pendingSecret, code });
            if (!res.ok) { showError(root, 'acctTfaCode', res.error); return; }
            pendingSecret = null;
            ctx.account.two_factor_enabled = true;
            rerenderTwoFactor(root, ctx);
            $(root, 'acctTfaBody').insertAdjacentHTML('afterbegin', renderRecoveryCodes(res.data.recoveryCodes));
            wireRecoveryCodes(root, res.data.recoveryCodes);
            ctx.onAccountChanged({ ...ctx.account });
        });
    });

    $(root, 'acctTfaDisableForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError(root, 'acctTfaProof');
        const proof = $(root, 'acctTfaProof').value.trim();
        if (!proof) { showError(root, 'acctTfaProof', 'أدخل الرمز الحالي أو رمز استعادة'); return; }
        if (!window.confirm('إيقاف التحقق بخطوتين يقلّل حماية حسابك. متابعة؟')) return;
        await busy($(root, 'acctTfaDisableBtn'), 'جارٍ الإيقاف…', async () => {
            const res = await service.disableTwoFactor(/^\d{6}$/.test(proof) ? { code: proof } : { recoveryCode: proof });
            if (!res.ok) { showError(root, 'acctTfaProof', res.error); return; }
            ctx.account.two_factor_enabled = false;
            rerenderTwoFactor(root, ctx);
            setStatus(root, 'acctTfaStatus', 'أُوقف التحقق بخطوتين.');
            ctx.onAccountChanged({ ...ctx.account });
        });
    });
}

function wireRecoveryCodes(root, codes) {
    $(root, 'acctRecoveryCopyBtn')?.addEventListener('click', async (e) => {
        try {
            await navigator.clipboard.writeText(codes.join('\n'));
            e.currentTarget.textContent = 'تم النسخ';
        } catch {
            e.currentTarget.textContent = 'انسخها يدويًا';
        }
    });
    $(root, 'acctRecoveryDoneBtn')?.addEventListener('click', () => $(root, 'acctRecoveryCodes')?.remove());
}

function wireSecurity(root, ctx) {
    if (ctx.readOnly) return;

    $(root, 'acctPasswordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        ['acctCurrentPassword', 'newPassword', 'confirmPassword'].forEach(id => clearError(root, id));
        setStatus(root, 'acctPasswordStatus', '');
        const current = $(root, 'acctCurrentPassword').value;
        const next = $(root, 'newPassword').value;
        const confirm = $(root, 'confirmPassword').value;

        if (!current) { showError(root, 'acctCurrentPassword', 'أدخل كلمة المرور الحالية'); return; }
        const v = validateNewPassword(next, confirm);
        if (!v.isValid) {
            if (v.errors.password) showError(root, 'newPassword', v.errors.password);
            if (v.errors.confirm) showError(root, 'confirmPassword', v.errors.confirm);
            return;
        }
        if (next === current) { showError(root, 'newPassword', 'اختر كلمة مرور مختلفة عن الحالية'); return; }

        await busy($(root, 'passwordSaveBtn'), 'جارٍ التحديث…', async () => {
            const res = await service.changePassword({ email: ctx.email, currentPassword: current, newPassword: next });
            if (!res.ok) {
                if (/الحالية/.test(res.error)) showError(root, 'acctCurrentPassword', res.error);
                else setStatus(root, 'acctPasswordStatus', res.error, 'error');
                return;
            }
            $(root, 'acctPasswordForm').reset();
            setStatus(root, 'acctPasswordStatus', res.data.otherSessionsEnded
                ? 'تم تحديث كلمة المرور، وأُنهيت جلساتك على الأجهزة الأخرى.'
                : 'تم تحديث كلمة المرور. تعذّر إنهاء الجلسات الأخرى تلقائيًا — استخدم زر «تسجيل الخروج من كل الأجهزة الأخرى».');
            ctx.notify?.('تم تحديث كلمة المرور', 'success');
        });
    });

    $(root, 'acctSignOutOthersBtn')?.addEventListener('click', async (e) => {
        if (!window.confirm('تسجيل الخروج من كل الأجهزة الأخرى؟ هذه الجلسة تبقى مفتوحة.')) return;
        await busy(e.currentTarget, 'جارٍ الإنهاء…', async () => {
            const res = await service.signOutOtherSessions();
            setStatus(root, 'acctSessionsStatus', res.ok
                ? 'أُنهيت كل الجلسات الأخرى.'
                : `تعذّر إنهاء الجلسات الأخرى: ${res.error}`, res.ok ? 'ok' : 'error');
        });
    });

    wireTwoFactor(root, ctx);
    refreshDevices(root, ctx);
}

/* ── نقطة الدخول ───────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {'profile'|'security'} opts.section
 * @param {string} [opts.userId]       الحساب المعروض (افتراضيًا حساب الجلسة)
 * @param {string} [opts.email]        بريد الدخول (افتراضيًا من الجلسة)
 * @param {boolean} [opts.readOnly]    التقمّص / المعاينة
 * @param {'impersonation'|'preview'} [opts.readOnlyReason]
 * @param {(msg: string, type: string) => void} [opts.notify]
 * @param {(account: object) => void} [opts.onAccountChanged]
 */
export async function mountAccountSettings(container, opts = {}) {
    if (!container) return null;
    container.innerHTML = '<div class="acct-root"><p class="panel-subtitle">جارٍ التحميل…</p></div>';
    const ctx = await loadContext(opts);
    if (ctx.error) {
        container.innerHTML = `<div class="acct-root">${panel('تعذّر تحميل بيانات الحساب', ctx.error, '')}</div>`;
        return null;
    }

    const root = document.createElement('div');
    root.className = 'acct-root';
    root.dataset.section = opts.section || 'profile';
    root.dataset.readOnly = String(ctx.readOnly);
    root.innerHTML = opts.section === 'security' ? renderSecurity(ctx) : renderProfile(ctx);
    container.replaceChildren(root);

    if (opts.section === 'security') wireSecurity(root, ctx);
    else wireProfile(root, ctx);

    return ctx;
}
