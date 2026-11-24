/**
 * company-billing.js — «الاستخدام والحدود» (مجال الاشتراك والفوترة).
 *
 * المصدر my_ticket_wallet() (065/069): نفس الدالة التي يمنع بها محفّز
 * tickets_enforce_quota إنشاء تذكرة بعد نفاد الرصيد — فالمعروض هو بالضبط ما
 * ستطبّقه القاعدة. walletView من plan-pricing-model.js (المشترك مع شارة الشريط
 * العلوي) فلا يختلف الرقمان.
 *
 * لا أسعار ولا فواتير هنا: لا يوجد مصدر بيانات لقائمة فواتير الشركة (الفاتورة
 * مرفقة بتذكرة طلب الاشتراك نفسها)، فلا نخترع سجلًا. التحقق موثّق في
 * company-invoices-model.js: جدول accounting_invoices (005) بلا عمود
 * company_id، وسياسة قراءته فردية (user_id = auth.uid())، وحمولة اللوحة
 * (016) بلا ticket_id فلا ربط اشتراك↔تذكرة من الواجهة — فيُعرض أسفل رصيد
 * التذاكر قسم «فواتير الشركة» بحالة فراغ صريحة ورابط إلى تذاكر الشركة مع
 * مدعوم حيث تعيش تذاكر طلبات الاشتراك وفواتيرها المرفقة.
 */
import { fetchCompanyTicketWallet } from '/assets/js/company/company-data.js';
import { walletView, resetText } from '/assets/js/plan-pricing-model.js';
import { escapeHtml, formatDate, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { invoiceEmptyState } from '/assets/js/company/company-invoices-model.js';

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
        renderCompanyInvoices(box);
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

    renderCompanyInvoices(box);
}

/**
 * قسم «فواتير الشركة» — قراءة فقط، وحالة فراغ صريحة لا سجل مخترع.
 * يُلحَق بعد رصيد التذاكر سواء نجحت قراءته أم فشلت: محتواه ثابت لا يعتمد
 * على المحفظة. الرابط إلى قسم التذاكر مع مدعوم داخل اللوحة نفسها
 * (data-tab يبدّل الصفحة عبر معالِج النقر في company-dashboard.js،
 * والهاش #tickets بديله).
 */
function renderCompanyInvoices(box) {
    const state = invoiceEmptyState();
    box.insertAdjacentHTML('beforeend', `
        <section class="panel" aria-labelledby="companyInvoicesHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyInvoicesHeading">فواتير الشركة</h2>
                    <p class="panel-subtitle">سجل الفواتير والمدفوعات — قراءة فقط</p>
                </div>
            </div>
            <div class="state-block">
                <p class="state-title">${escapeHtml(state.title)}</p>
                <p class="state-text">${escapeHtml(state.text)}</p>
                <p class="state-text">${escapeHtml(state.ticketHint)}</p>
                <a class="btn btn-primary" href="#${escapeHtml(state.ticketTab)}"
                   data-tab="${escapeHtml(state.ticketTab)}">${escapeHtml(state.ticketLabel)}</a>
            </div>
        </section>`);
}
