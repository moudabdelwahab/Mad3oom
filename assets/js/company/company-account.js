/**
 * company-account.js — قسما «الملف الشخصي» و«الأمان» داخل لوحة الشركة.
 *
 * الحساب المرتبط بشركة يظل حسابًا شخصيًا له اسم وهاتف وكلمة مرور و2FA.
 * كل ذلك يُرسم الآن بالوحدة الموحّدة نفسها المستخدمة في بوابة العميل ولوحة
 * الإدارة (assets/js/account)، داخل قشرة لوحة الشركة وتنقّلها — فلا يخرج
 * المستخدم من لوحته، ولا توجد نسخة ثانية من قواعد التحقق أو من مسار 2FA.
 *
 * كانت هذه اللوحة تحيل تفعيل 2FA إلى «فريق الدعم» بلا سبب تقني، وبقاعدة
 * كلمة مرور مختلفة عن بوابة العميل. الفرق أُزيل.
 *
 * ما يبقى خاصًا بالشركة هنا: سجل الدخول من allow-list النشاط نفسها
 * (customer-data.js + activity-model.js). ملف الشركة نفسه (صف companies)
 * كيان مختلف، ويعيش في «نظرة عامة» لا هنا.
 */

import { mountAccountSettings } from '/assets/js/account/account-settings.js';
import { fetchAccountActivity } from '/assets/js/customer/customer-data.js';
import { toTimeline } from '/assets/js/customer/activity-model.js';
import { escapeHtml, timeAgo } from '/assets/js/customer/portal-ui.js';

function onAccountChanged(account) {
    // اسم القائمة الجانبية يتبع الاسم الجديد فورًا
    const menuName = document.getElementById('customerMenuName');
    if (menuName && account.full_name) menuName.textContent = account.full_name;
}

export async function loadCompanyProfile() {
    await mountAccountSettings(document.getElementById('companyAccountProfile'), {
        section: 'profile',
        onAccountChanged
    });
}

export async function loadCompanySecurity() {
    const container = document.getElementById('companySecurity');
    if (!container) return;

    const accountEl = document.createElement('div');
    const [, activityRes] = await Promise.all([
        mountAccountSettings(accountEl, { section: 'security', onAccountChanged }),
        fetchAccountActivity(40)
    ]);

    // نفس allow-list سجل النشاط المستخدمة في بوابة العميل — بلا تعريف ثانٍ
    const loginEvents = toTimeline((activityRes.ok ? activityRes.data : []) || [], { limit: 40 })
        .filter(item => item.group === 'security')
        .slice(0, 8);

    const logins = document.createElement('section');
    logins.className = 'panel';
    logins.setAttribute('aria-labelledby', 'companyLoginsHeading');
    logins.innerHTML = `
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
            </div>`}`;

    container.replaceChildren(accountEl, logins);
}
