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
 *
 * وفي الأمان أيضًا — لمدير الشركة وحده:
 *   • تصدير بيانات الشركة (الترحيل 140: company_export_data) في ملف
 *     JSON واحد، مع سجل تدقيق لعمليات التصدير. الفواتير غير متاحة على
 *     مستوى الشركة، فتُذكر صراحةً بدل اختراعها.
 *   • طلب حذف حساب الشركة ذاتيًا (الترحيل 140:
 *     company_request_account_deletion) بخطوتي تأكيد وتحذير صريح عن
 *     عدم التراجع، مع سياسة موثقة بما يُحذف/يُجهَّل وما يُحتفظ به.
 */

import { mountAccountSettings } from '/assets/js/account/account-settings.js';
import { fetchAccountActivity } from '/assets/js/customer/customer-data.js';
import { toTimeline } from '/assets/js/customer/activity-model.js';
import { escapeHtml, timeAgo } from '/assets/js/customer/portal-ui.js';
import { supabase } from '/api-config.js';
import {
    buildExportDocument, downloadJsonDocument,
    DELETION_POLICY, DELETION_WARNING, validateDeletionReason,
    EXPORT_INVOICE_NOTE
} from '/assets/js/company/company-data-export-model.js';

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

    // أدوات بيانات الشركة — لمدير الشركة وحده، والفحص من الخادم
    await mountCompanyDataTools(container);
}

/* ── أدوات بيانات الشركة (الترحيل 140) ─────────────────────────────────── */

/** مدير الشركة وحده يرى أدوات التصدير والحذف — والفحص من الخادم لا من الواجهة. */
async function isCompanyAdmin() {
    try {
        const { data } = await supabase.rpc('is_company_admin');
        return data === true;
    } catch {
        return false;
    }
}

async function mountCompanyDataTools(container) {
    if (!(await isCompanyAdmin())) return;

    const exportEl = document.createElement('section');
    exportEl.className = 'panel';
    exportEl.setAttribute('aria-labelledby', 'companyExportHeading');
    exportEl.innerHTML = `
        <div class="panel-header">
            <div>
                <h2 class="panel-title" id="companyExportHeading">تصدير بيانات الشركة</h2>
                <p class="panel-subtitle">نسخة كاملة من بيانات شركتك في ملف JSON واحد — الملف الشخصي والأعضاء والتذاكر والاشتراكات وسجل النشاط</p>
            </div>
        </div>
        <p class="state-text">${escapeHtml(EXPORT_INVOICE_NOTE.reason)} وتُذكر في الملف صراحةً في قسم الفواتير.</p>
        <p class="state-text">هواتف الأعضاء وبيانات الدفع غير مشمولة في التصدير.</p>
        <div>
            <button type="button" class="btn btn-primary" data-export>تصدير بيانات الشركة (JSON)</button>
            <span role="status" data-status></span>
        </div>
        <div data-history></div>`;
    container.appendChild(exportEl);
    wireExportPanel(exportEl);

    const deletionEl = document.createElement('section');
    deletionEl.className = 'panel';
    deletionEl.setAttribute('aria-labelledby', 'companyDeletionHeading');
    container.appendChild(deletionEl);
    await renderDeletionPanel(deletionEl);
}

function exportCountsText(sections) {
    const s = sections || {};
    return `${s.members ?? 0} أعضاء · ${s.tickets ?? 0} تذاكر · ${s.subscriptions ?? 0} اشتراكات · ${s.activity ?? 0} في سجل النشاط`;
}

async function loadExportHistory(panel) {
    const box = panel.querySelector('[data-history]');
    if (!box) return;
    const { data, error } = await supabase.rpc('company_data_exports_list');
    if (error || !Array.isArray(data) || !data.length) {
        box.innerHTML = `<p class="state-text">لا توجد عمليات تصدير سابقة.</p>`;
        return;
    }
    box.innerHTML = `
        <div class="state-block state-block--compact">
            <p class="state-title">آخر عمليات التصدير</p>
            ${data.map(row => `
                <p class="state-text">${escapeHtml(timeAgo(row.exported_at))} — ${escapeHtml(row.file_name || '')} — ${escapeHtml(exportCountsText(row.sections))}</p>`).join('')}
        </div>`;
}

function wireExportPanel(panel) {
    const button = panel.querySelector('[data-export]');
    const status = panel.querySelector('[data-status]');
    loadExportHistory(panel);
    button?.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'جارٍ تجهيز ملف التصدير…';
        try {
            const { data, error } = await supabase.rpc('company_export_data');
            if (error) throw error;
            const doc = buildExportDocument(data);
            downloadJsonDocument(doc, doc.file_name);
            status.textContent = `تم تنزيل ملف التصدير — ${exportCountsText(doc.counts)}.`;
            await loadExportHistory(panel);
        } catch (err) {
            status.textContent = err?.message || 'تعذّر التصدير — حاول مرة أخرى.';
        } finally {
            button.disabled = false;
        }
    });
}

/* ── حذف حساب الشركة: خطوتا تأكيد، والطلب قيد الانتظار لا يحذف فورًا ───── */

async function renderDeletionPanel(panel) {
    let pending = null;
    try {
        const { data } = await supabase.rpc('company_deletion_request_status');
        pending = data || null;
    } catch {
        pending = null;
    }

    if (pending) {
        panel.innerHTML = `
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyDeletionHeading">حذف حساب الشركة</h2>
                    <p class="panel-subtitle">طلب حذف قيد الانتظار</p>
                </div>
            </div>
            <div class="state-block state-block--compact">
                <p class="state-title">طلب حذف قيد الانتظار منذ ${escapeHtml(timeAgo(pending.created_at))}</p>
                <p class="state-text">السبب: ${escapeHtml(pending.reason || '')}</p>
                <p class="state-text">لا يُحذف شيء فورًا، وتبقى الشركة نشطة حتى يراجع مالك المنصة الطلب. يمكنك إلغاء الطلب ما دام قيد الانتظار.</p>
            </div>
            <div>
                <button type="button" class="btn btn-secondary" data-cancel>إلغاء طلب الحذف</button>
                <span role="status" data-status></span>
            </div>`;
        panel.querySelector('[data-cancel]')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const status = panel.querySelector('[data-status]');
            button.disabled = true;
            try {
                const { error } = await supabase.rpc('company_cancel_deletion_request');
                if (error) throw error;
                await renderDeletionPanel(panel);
            } catch (err) {
                status.textContent = err?.message || 'تعذّر إلغاء الطلب — حاول مرة أخرى.';
                button.disabled = false;
            }
        });
        return;
    }

    panel.innerHTML = `
        <div class="panel-header">
            <div>
                <h2 class="panel-title" id="companyDeletionHeading">حذف حساب الشركة</h2>
                <p class="panel-subtitle">طلب حذف ذاتي — يراجعه مالك المنصة قبل أي إجراء</p>
            </div>
        </div>
        <p class="state-text"><strong>${escapeHtml(DELETION_WARNING)}</strong></p>
        <p class="state-text">ما يُحذف/يُجهَّل عند التنفيذ:</p>
        <ul>${DELETION_POLICY.deleted.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <p class="state-text">ما يُحتفظ به ولِمَ:</p>
        <ul>${DELETION_POLICY.kept.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <div data-request>
            <button type="button" class="btn btn-danger" data-start>طلب حذف حساب الشركة</button>
        </div>
        <div data-confirm hidden>
            <label>
                سبب طلب الحذف (20 حرفًا على الأقل)
                <textarea data-reason rows="3" placeholder="مثال: أغلقنا الشركة نهائيًا ونريد حذف بياناتها من المنصة"></textarea>
            </label>
            <p class="state-text" data-error role="alert"></p>
            <div>
                <button type="button" class="btn btn-danger" data-confirm-btn>تأكيد طلب الحذف</button>
                <button type="button" class="btn btn-secondary" data-back>تراجع</button>
                <span role="status" data-status></span>
            </div>
        </div>`;

    const requestBox = panel.querySelector('[data-request]');
    const confirmBox = panel.querySelector('[data-confirm]');
    const reasonInput = panel.querySelector('[data-reason]');
    const errorBox = panel.querySelector('[data-error]');
    const status = panel.querySelector('[data-status]');

    panel.querySelector('[data-start]')?.addEventListener('click', () => {
        requestBox.hidden = true;
        confirmBox.hidden = false;
        reasonInput?.focus();
    });
    panel.querySelector('[data-back]')?.addEventListener('click', () => {
        confirmBox.hidden = true;
        requestBox.hidden = false;
        if (errorBox) errorBox.textContent = '';
        if (status) status.textContent = '';
    });
    panel.querySelector('[data-confirm-btn]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const reasonError = validateDeletionReason(reasonInput?.value);
        if (reasonError) {
            errorBox.textContent = reasonError;
            return;
        }
        errorBox.textContent = '';
        button.disabled = true;
        status.textContent = 'جارٍ إرسال طلب الحذف…';
        try {
            const { error } = await supabase.rpc('company_request_account_deletion', {
                p_reason: reasonInput.value.trim()
            });
            if (error) throw error;
            await renderDeletionPanel(panel);
        } catch (err) {
            status.textContent = err?.message || 'تعذّر إرسال الطلب — حاول مرة أخرى.';
            button.disabled = false;
        }
    });
}
