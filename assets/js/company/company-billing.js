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
import { fetchCompanyTicketWallet, fetchSaasTrialStatus, requestSaasTrial, cancelSaasTrial } from '/assets/js/company/company-data.js';
import { walletView, resetText } from '/assets/js/plan-pricing-model.js';
import {
    TRIAL_RULES_TEXT, trialRequestArgs, trialStatusView
} from '/assets/js/saas-trial-model.js';
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
        renderTrialSection(box);
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
    renderTrialSection(box);
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

/**
 * قسم «التجربة المجانية 3 أيام» (الترحيل 137) — للشركات والمتاجر معًا،
 * في تبويب الاستخدام والحدود نفسه.
 *
 *   • الطلب من مالك الشركة وحده (القاعدة ترفض غيره، والواجهة تعرض ذلك
 *     صراحةً بدل زر يفشل)؛ والطلب ينشئ طلبًا معلّقًا فقط — التجربة لا
 *     تبدأ إلا بموافقة المالك من لوحته.
 *   • بلا بطاقة وبلا دفع: النموذج خطة فقط، ولا حقل دفع فيه إطلاقًا.
 *   • التجربة الجارية تعرض أيامها المتبقية وتاريخ انتهائها، مع نص صريح
 *     أنها تنتهي تلقائيًا ولا تتحول لاشتراك مدفوع.
 *   • فشل قراءة الحالة لا يُسقط التبويب: القسم يعرض حالته وخطأه مستقلًا،
 *     وقبل تطبيق 137 تعود الدالة null فيُعرض «غير متاحة بعد» بدل خطأ.
 */
async function renderTrialSection(box) {
    const section = document.createElement('section');
    section.className = 'panel';
    section.setAttribute('aria-labelledby', 'companyTrialHeading');
    section.innerHTML = `
        <div class="panel-header">
            <div>
                <h2 class="panel-title" id="companyTrialHeading">التجربة المجانية 3 أيام</h2>
                <p class="panel-subtitle">${escapeHtml(TRIAL_RULES_TEXT)}</p>
            </div>
        </div>
        <div id="companyTrialBody" aria-live="polite"></div>`;
    box.appendChild(section);
    const body = section.querySelector('#companyTrialBody');
    renderSkeletonLines(body, 3);

    const result = await fetchSaasTrialStatus();
    if (!result.ok || !result.data) {
        body.innerHTML = `
            <div class="state-block">
                <p class="state-title">التجربة المجانية غير متاحة حاليًا</p>
                <p class="state-text">${result.ok
                    ? 'لم تُفعَّل بعد على المنصة — جرّب لاحقًا أو راجع الدعم.'
                    : 'تعذّر تحميل حالة التجربة. تحقق من اتصالك ثم أعد المحاولة.'}</p>
                <button type="button" class="btn btn-outline" id="companyTrialRetry">إعادة المحاولة</button>
            </div>`;
        body.querySelector('#companyTrialRetry')?.addEventListener('click', () => {
            section.remove();
            renderTrialSection(box);
        });
        return;
    }

    const view = trialStatusView(result.data);
    if (!view.hasCompany) {
        body.innerHTML = `
            <div class="state-block">
                <p class="state-title">التجربة المجانية لحسابات الشركات والمتاجر</p>
                <p class="state-text">ليس لديك شركة بعد — أنشئ حساب الشركة أولًا لتطلب تجربة باقة مدفوعة.</p>
            </div>`;
        return;
    }

    const active = view.activeTrial;
    const pending = view.pendingRequests;
    const past = view.requests.filter(r => !r.isPending && !r.isActive);

    body.innerHTML = `
        ${active ? `
        <div class="state-block">
            <p class="state-title">تجربتك جارية: ${escapeHtml(active.planLabel)}</p>
            <p class="state-text">متبقٍ ${escapeHtml(String(active.daysRemaining))} ${active.daysRemaining === 1 ? 'يوم' : 'أيام'}
                — تنتهي في ${active.endsAt ? escapeHtml(formatDate(active.endsAt)) : '—'}.
                تنتهي تلقائيًا بلا تجديد وبلا خصم، ولا تتحول لاشتراك مدفوع.</p>
        </div>` : ''}
        ${pending.map(r => `
        <div class="state-block">
            <p class="state-title">طلبك قيد المراجعة: ${escapeHtml(r.planLabel)}</p>
            <p class="state-text">بانتظار قرار المالك — تبدأ الـ 3 أيام فقط بعد موافقته.</p>
            <button type="button" class="btn btn-outline" data-trial-cancel="${escapeHtml(r.id)}">إلغاء الطلب</button>
        </div>`).join('')}
        ${view.canRequest && view.eligiblePlans.length ? `
        <form id="companyTrialForm" novalidate>
            <label class="form-label" for="companyTrialPlan">اختر الباقة لتجربتها مجانًا 3 أيام</label>
            <select class="form-control" id="companyTrialPlan">
                ${view.eligiblePlans.map(p => `<option value="${escapeHtml(p.planKey)}">${escapeHtml(p.planLabel)}</option>`).join('')}
            </select>
            <p class="state-text">بلا بطاقة وبلا دفع — تبدأ التجربة فقط بعد موافقة المالك، وتنتهي تلقائيًا بعد 3 أيام.</p>
            <button type="submit" class="btn btn-primary" id="companyTrialSubmit">اطلب التجربة المجانية</button>
            <p class="state-text" id="companyTrialMessage" role="status" aria-live="polite"></p>
        </form>` : ''}
        ${!view.canRequest ? `
        <p class="state-text">طلب التجربة المجانية لمالك الشركة وحده — إن لم تكن المالك، اطلب منه تقديم الطلب.</p>` : ''}
        ${view.ineligiblePlans.length ? `
        <dl class="company-facts">
            ${view.ineligiblePlans.map(p => `
            <div class="company-fact">
                <dt>${escapeHtml(p.planLabel)}</dt>
                <dd>${escapeHtml(p.reason)}</dd>
            </div>`).join('')}
        </dl>` : ''}
        ${past.length ? `
        <p class="state-text">طلبات سابقة: ${past.map(r => `${escapeHtml(r.planLabel)} — ${escapeHtml(r.statusLabel)}`).join(' · ')}</p>` : ''}`;

    body.querySelectorAll('[data-trial-cancel]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const res = await cancelSaasTrial(button.getAttribute('data-trial-cancel'));
            if (!res.ok) {
                button.disabled = false;
                sayTrial(body, res.error || 'تعذّر إلغاء الطلب.');
                return;
            }
            section.remove();
            renderTrialSection(box);
        });
    });

    const form = body.querySelector('#companyTrialForm');
    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const planKey = body.querySelector('#companyTrialPlan')?.value;
        const check = trialRequestArgs({ planKey });
        if (check.error) { sayTrial(body, check.error); return; }
        const submit = body.querySelector('#companyTrialSubmit');
        submit.disabled = true;
        const res = await requestSaasTrial(check.args.p_plan_key);
        if (!res.ok) {
            submit.disabled = false;
            sayTrial(body, res.error || 'تعذّر إرسال الطلب.');
            return;
        }
        sayTrial(body, 'أُرسل طلبك إلى المالك — تبدأ الـ 3 أيام فقط بعد موافقته.');
        section.remove();
        renderTrialSection(box);
    });
}

function sayTrial(body, text) {
    const message = body.querySelector('#companyTrialMessage');
    if (message) message.textContent = text;
}
