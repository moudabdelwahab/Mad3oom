/**
 * company-billing.js — «الاستخدام والحدود» (مجال الاشتراك والفوترة).
 *
 * المصدر my_ticket_wallet() (065/069): نفس الدالة التي يمنع بها محفّز
 * tickets_enforce_quota إنشاء تذكرة بعد نفاد الرصيد — فالمعروض هو بالضبط ما
 * ستطبّقه القاعدة. walletView من plan-pricing-model.js (المشترك مع شارة الشريط
 * العلوي) فلا يختلف الرقمان.
 *
 * لا أسعار ولا فواتير هنا: لا يوجد مصدر بيانات لقائمة فواتير الشركة (الفاتورة
 * مرفقة بتذكرة طلب الاشتراك نفسها)، فلا نخترع سجلًا.
 */
import { fetchCompanyTicketWallet } from '/assets/js/company/company-data.js';
import { walletView, resetText } from '/assets/js/plan-pricing-model.js';
import { escapeHtml, formatDate, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';

export async function loadCompanyUsage() {
    const box = document.getElementById('companyUsage');
    if (!box) return;
    renderSkeletonLines(box, 4);

    const result = await fetchCompanyTicketWallet();
    const view = result.ok ? walletView(result.data) : null;
    if (!view) {
        box.innerHTML = `
            <div class="state-block state-block--error">
                <p class="state-title">تعذّر تحميل رصيد التذاكر</p>
                <p class="state-text">لا نعرض رقمًا لم نقرأه. تحقق من اتصالك ثم أعد المحاولة.</p>
                <button type="button" class="btn btn-primary" id="companyUsageRetry">إعادة المحاولة</button>
            </div>`;
        document.getElementById('companyUsageRetry')?.addEventListener('click', loadCompanyUsage);
        return;
    }

    const billingUsed = Number(result.data?.billing_used);
    const billingLimit = Number(result.data?.billing_limit);
    const hasBilling = Number.isFinite(billingUsed) && Number.isFinite(billingLimit) && billingLimit > 0;
    const tone = view.tone === 'empty' ? 'is-danger' : view.tone === 'warn' ? 'is-warning' : '';

    box.innerHTML = `
        <section class="panel" aria-labelledby="companyUsageHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyUsageHeading">رصيد تذاكر الدعم هذا الشهر</h2>
                    <p class="panel-subtitle">${escapeHtml(view.isFree ? 'الخطة المجانية' : `حسب ${view.planLabel}`)}${view.resetsAt ? ` · ${escapeHtml(resetText(view.daysToReset))}` : ''}</p>
                </div>
                <a class="panel-link" href="/subscriptions.html">استعراض الباقات</a>
            </div>

            <div class="company-usage ${tone}">
                <p class="company-usage-figure">
                    ${view.unlimited
                        ? '<span class="company-usage-big">غير محدود</span>'
                        : `<span class="company-usage-big">${escapeHtml(String(view.remaining))}</span>
                           <span class="company-usage-of">تذكرة متبقية من ${escapeHtml(String(view.limit))}</span>`}
                </p>
                ${view.unlimited ? '' : `
                <div class="meter company-usage-meter" role="progressbar" aria-label="المستخدم من رصيد التذاكر"
                     aria-valuemin="0" aria-valuemax="${escapeHtml(String(view.limit))}" aria-valuenow="${escapeHtml(String(view.used))}">
                    <div class="meter-fill${view.tone === 'empty' ? ' meter-fill--danger' : view.tone === 'warn' ? ' meter-fill--warning' : ''}"
                         style="width:${Math.max(0, Math.min(100, view.percent))}%"></div>
                </div>`}
                <p class="company-usage-sub">${escapeHtml(view.sub)}</p>
            </div>

            <dl class="company-facts company-usage-facts">
                <div class="company-fact">
                    <dt>المستخدم هذا الشهر</dt>
                    <dd>${escapeHtml(String(view.used))} تذكرة</dd>
                </div>
                <div class="company-fact">
                    <dt>يتجدد الرصيد في</dt>
                    <dd>${view.resetsAt ? escapeHtml(formatDate(view.resetsAt.toISOString())) : '<span class="is-muted">غير محدد</span>'}</dd>
                </div>
                ${hasBilling ? `
                <div class="company-fact">
                    <dt>طلبات الاشتراك والفوترة</dt>
                    <dd>${escapeHtml(String(billingUsed))} من ${escapeHtml(String(billingLimit))} هذا الشهر</dd>
                </div>` : ''}
            </dl>

            ${view.shared ? '<p class="company-notice">الرصيد مشترك لحساب الشركة كله: أنت وباقي أعضاء الفريق.</p>' : ''}
        </section>`;
}
