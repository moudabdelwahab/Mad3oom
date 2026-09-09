/**
 * company-account.js — قسما «الملف الشخصي» و«الأمان» داخل لوحة الشركة.
 *
 * الحساب المرتبط بشركة يظل حسابًا شخصيًا له اسم وهاتف وكلمة مرور و2FA.
 * كانت هذه الوظائف تعيش في بوابة العميل، فكان أي وصول إليها من لوحة الشركة
 * يخرج بالمستخدم منها. صارت هنا، فوق نفس الوحدات المشتركة:
 *
 *   auth-client.js                        updateProfile / updatePassword
 *   assets/js/customer/customer-data.js   حالة الحساب ونشاطه
 *   assets/js/customer/activity-model.js  تصفية سجل النشاط (خالصة)
 *
 * ما لم يُنقَل عمدًا: إدارة 2FA وتيليجرام. القسم يعرض حالتهما بدقة ويشرح
 * أن تغييرهما يتم عبر الدعم — لأن شاشاتهما تعيش في مسار تحقّق مستقل
 * (2fa-verify.html / telegram-otp.html) خارج نطاق هذه المهمة، ونسخها هنا
 * كان سيضاعف مسار تحقّق أمني بلا داعٍ.
 */

import { updateProfile, updatePassword } from '/auth-client.js';
import { fetchAccountStatus, fetchAccountActivity } from '/assets/js/customer/customer-data.js';
import { toTimeline } from '/assets/js/customer/activity-model.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';

let account = null;

/* ── الملف الشخصي ───────────────────────────────────────────────────────── */

/** تحقّق خالص — نفس قواعد بوابة العميل حرفيًا. */
export function validateProfileForm(values) {
    const errors = {};
    const fullName = String(values?.fullName || '').trim();
    const phone = String(values?.phone || '').trim();

    if (fullName.length < 3) errors.fullName = 'الاسم يجب أن يكون 3 أحرف على الأقل';
    if (phone && !/^[\d+\-\s()]{7,20}$/.test(phone)) errors.phone = 'أدخل رقم هاتف صحيح';

    return { isValid: Object.keys(errors).length === 0, errors };
}

/** تحقّق خالص لتغيير كلمة المرور — نفس قاعدة قوة كلمة المرور في المنصة. */
export function validatePasswordForm(values) {
    const errors = {};
    const password = String(values?.password || '');
    const confirm = String(values?.passwordConfirm || '');

    if (!password) {
        errors.password = 'كلمة المرور الجديدة مطلوبة';
    } else if (password.length < 8) {
        errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        errors.password = 'كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم';
    }

    if (!errors.password && confirm !== password) {
        errors.passwordConfirm = 'كلمتا المرور غير متطابقتين';
    }

    return { isValid: Object.keys(errors).length === 0, errors };
}

export async function loadCompanyProfile() {
    const container = document.getElementById('companyAccountProfile');
    if (!container) return;
    renderSkeletonLines(container, 4);

    const result = await fetchAccountStatus();
    if (!result.ok) {
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل بيانات الحساب',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'profile', variant: 'btn-primary' }
        });
        return;
    }

    account = result.data || {};

    container.innerHTML = `
        <section class="panel" aria-labelledby="companyMyProfileHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyMyProfileHeading">الملف الشخصي</h2>
                    <p class="panel-subtitle">بيانات حسابك أنت — منفصلة عن بيانات الشركة</p>
                </div>
            </div>
            <form id="companyAccountForm" class="company-form" novalidate>
                <div class="form-grid">
                    <div class="form-field is-full">
                        <label for="fAccountName">الاسم الكامل <span aria-hidden="true">*</span></label>
                        <input type="text" id="fAccountName" class="form-control" required
                               value="${escapeHtml(account.full_name || '')}" autocomplete="name">
                        <p class="field-error" data-account-error-for="fullName" hidden></p>
                    </div>
                    <div class="form-field">
                        <label for="fAccountEmail">البريد الإلكتروني</label>
                        <input type="email" id="fAccountEmail" class="form-control"
                               value="${escapeHtml(account.email || '')}" disabled>
                        <p class="panel-subtitle">البريد يُغيَّر عبر الدعم لأنه هوية الحساب.</p>
                    </div>
                    <div class="form-field">
                        <label for="fAccountPhone">رقم الهاتف</label>
                        <input type="tel" id="fAccountPhone" class="form-control"
                               value="${escapeHtml(account.phone || '')}" autocomplete="tel">
                        <p class="field-error" data-account-error-for="phone" hidden></p>
                    </div>
                </div>
                <p class="field-error" id="companyAccountError" role="alert" hidden></p>
                <p class="panel-subtitle" id="companyAccountOk" hidden>تم حفظ بياناتك.</p>
                <div class="company-form-actions">
                    <button type="submit" class="btn btn-primary" id="companyAccountSave">حفظ التغييرات</button>
                </div>
            </form>
        </section>`;

    document.getElementById('companyAccountForm')?.addEventListener('submit', onSaveProfile);
}

async function onSaveProfile(event) {
    event.preventDefault();

    document.querySelectorAll('[data-account-error-for]').forEach(el => { el.hidden = true; el.textContent = ''; });
    const error = document.getElementById('companyAccountError');
    const ok = document.getElementById('companyAccountOk');
    error.hidden = true;
    ok.hidden = true;

    const values = {
        fullName: document.getElementById('fAccountName').value,
        phone: document.getElementById('fAccountPhone').value
    };

    const validation = validateProfileForm(values);
    if (!validation.isValid) {
        for (const [field, message] of Object.entries(validation.errors)) {
            const el = document.querySelector(`[data-account-error-for="${field}"]`);
            if (el) { el.textContent = message; el.hidden = false; }
        }
        return;
    }

    const btn = document.getElementById('companyAccountSave');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ الحفظ…';

    const { error: saveError } = await updateProfile({
        full_name: values.fullName.trim(),
        phone: values.phone.trim() || null
    });

    btn.disabled = false;
    btn.textContent = original;

    if (saveError) {
        error.textContent = saveError.message || 'تعذّر حفظ البيانات. حاول مرة أخرى.';
        error.hidden = false;
        return;
    }

    ok.hidden = false;
    // اسم القائمة الجانبية يتبع الاسم الجديد فورًا
    const menuName = document.getElementById('customerMenuName');
    if (menuName) menuName.textContent = values.fullName.trim();
}

/* ── الأمان ─────────────────────────────────────────────────────────────── */

export async function loadCompanySecurity() {
    const container = document.getElementById('companySecurity');
    if (!container) return;
    renderSkeletonLines(container, 5);

    const [accountRes, activityRes] = await Promise.all([
        fetchAccountStatus(),
        fetchAccountActivity(40)
    ]);

    if (!accountRes.ok) {
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل بيانات الأمان',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'security', variant: 'btn-primary' }
        });
        return;
    }

    const p = accountRes.data || {};
    // نفس allow-list سجل النشاط المستخدمة في بوابة العميل — بلا تعريف ثانٍ
    const loginEvents = toTimeline((activityRes.ok ? activityRes.data : []) || [], { limit: 40 })
        .filter(item => item.group === 'security')
        .slice(0, 8);

    const pill = (on, yes, no) => on
        ? `<span class="pill status-tone-success">${yes}</span>`
        : `<span class="pill status-neutral">${no}</span>`;

    container.innerHTML = `
        <section class="panel" aria-labelledby="companyProtectionHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyProtectionHeading">حماية الحساب</h2>
                    <p class="panel-subtitle">وسائل الحماية المفعّلة على حسابك حاليًا</p>
                </div>
            </div>
            <dl class="company-facts">
                <div class="company-fact">
                    <dt>التحقق بخطوتين (2FA)</dt>
                    <dd>${pill(p.two_factor_enabled, 'مفعّل', 'غير مفعّل')}</dd>
                </div>
                <div class="company-fact">
                    <dt>تنبيهات تيليجرام</dt>
                    <dd>${pill(p.telegram_otp_enabled, 'مفعّلة', 'غير مفعّلة')}</dd>
                </div>
                <div class="company-fact">
                    <dt>آخر تغيير لكلمة المرور</dt>
                    <dd>${escapeHtml(p.last_password_change ? formatDate(p.last_password_change) : 'غير مسجَّل')}</dd>
                </div>
                <div class="company-fact">
                    <dt>حالة التوثيق</dt>
                    <dd>${pill(p.is_verified, 'موثّق', 'غير موثّق')}</dd>
                </div>
            </dl>
            <p class="panel-subtitle">
                تفعيل أو إيقاف التحقق بخطوتين وتنبيهات تيليجرام يتم عبر فريق الدعم —
                افتح تذكرة من «مركز الدعم».
            </p>
        </section>

        <section class="panel" aria-labelledby="companyPasswordHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyPasswordHeading">تغيير كلمة المرور</h2>
                    <p class="panel-subtitle">تُطبَّق فورًا على هذا الحساب</p>
                </div>
            </div>
            <form id="companyPasswordForm" class="company-form" novalidate>
                <div class="form-grid">
                    <div class="form-field">
                        <label for="fNewPassword">كلمة المرور الجديدة <span aria-hidden="true">*</span></label>
                        <input type="password" id="fNewPassword" class="form-control" required autocomplete="new-password">
                        <p class="field-error" data-password-error-for="password" hidden></p>
                    </div>
                    <div class="form-field">
                        <label for="fNewPasswordConfirm">تأكيد كلمة المرور <span aria-hidden="true">*</span></label>
                        <input type="password" id="fNewPasswordConfirm" class="form-control" required autocomplete="new-password">
                        <p class="field-error" data-password-error-for="passwordConfirm" hidden></p>
                    </div>
                </div>
                <p class="panel-subtitle">8 أحرف على الأقل، وتحتوي على حرف كبير وحرف صغير ورقم.</p>
                <p class="field-error" id="companyPasswordError" role="alert" hidden></p>
                <p class="panel-subtitle" id="companyPasswordOk" hidden>تم تغيير كلمة المرور.</p>
                <div class="company-form-actions">
                    <button type="submit" class="btn btn-primary" id="companyPasswordSave">تغيير كلمة المرور</button>
                </div>
            </form>
        </section>

        <section class="panel" aria-labelledby="companyLoginsHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyLoginsHeading">آخر عمليات الدخول</h2>
                    <p class="panel-subtitle">لو فيه دخول ليس منك، غيّر كلمة المرور فورًا</p>
                </div>
            </div>
            ${loginEvents.length ? `
                <div class="activity-timeline">
                    ${loginEvents.map(item => `
                        <div class="activity-item">
                            <div>
                                <div class="activity-text">${escapeHtml(item.label)}</div>
                                <div class="activity-time">${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}</div>
                            </div>
                        </div>`).join('')}
                </div>` : `
                <div class="state-block state-block--compact">
                    <p class="state-title">لا يوجد سجل دخول محفوظ</p>
                    <p class="state-text">ستظهر هنا عمليات الدخول إلى حسابك.</p>
                </div>`}
        </section>`;

    document.getElementById('companyPasswordForm')?.addEventListener('submit', onChangePassword);
}

async function onChangePassword(event) {
    event.preventDefault();

    document.querySelectorAll('[data-password-error-for]').forEach(el => { el.hidden = true; el.textContent = ''; });
    const error = document.getElementById('companyPasswordError');
    const ok = document.getElementById('companyPasswordOk');
    error.hidden = true;
    ok.hidden = true;

    const values = {
        password: document.getElementById('fNewPassword').value,
        passwordConfirm: document.getElementById('fNewPasswordConfirm').value
    };

    const validation = validatePasswordForm(values);
    if (!validation.isValid) {
        for (const [field, message] of Object.entries(validation.errors)) {
            const el = document.querySelector(`[data-password-error-for="${field}"]`);
            if (el) { el.textContent = message; el.hidden = false; }
        }
        return;
    }

    const btn = document.getElementById('companyPasswordSave');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ التغيير…';

    const { error: saveError } = await updatePassword(values.password);

    btn.disabled = false;
    btn.textContent = original;

    if (saveError) {
        error.textContent = saveError.message || 'تعذّر تغيير كلمة المرور. حاول مرة أخرى.';
        error.hidden = false;
        return;
    }

    document.getElementById('companyPasswordForm').reset();
    ok.hidden = false;
}
