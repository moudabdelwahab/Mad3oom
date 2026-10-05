/**
 * my-subscription.js — صفحة «اشتراكي» (my-subscription.html).
 *
 * صفحة للمشترك تشرح اشتراكه بوضوح، منفصلة عن صفحة الأسعار: الخطة الحالية
 * وحالتها ومدتها، رصيد التذاكر، ما تشمله الخطة، وسجل طلباته.
 *
 * المصادر كلها من القاعدة: my_ticket_wallet() (الخطة الفعلية والرصيد كما
 * يفرضه محفّز التذاكر)، subscription_plans (الأسعار)، whatsapp_subscriptions
 * (سجل الطلبات — RLS تعرض للمستخدم صفوفه هو فقط).
 */
import { supabase } from '/api-config.js';
import { guardPage } from '/assets/js/page-guard.js';
import { initCustomerSidebar, initCompanyShell } from '/assets/js/customer-sidebar.js';
import { fetchTicketWallet, renderWalletPanel } from '/assets/js/ticket-wallet.js';
import { PAYMENT_METHOD_LABELS } from '/whatsapp-subscription-service.js';
import {
    PLAN_LABELS, formatMoney, walletView, cycleProgress, planFeatureRows, nextPlanKey, subscriptionStatus
} from '/assets/js/plan-pricing-model.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }) : '—');
const CYCLE = { monthly: 'شهريًا', yearly: 'سنويًا' };
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

async function pickShell() {
    try {
        const { data } = await supabase.rpc('current_company_id');
        if (data) {
            document.body.classList.add('company-shell');
            return initCompanyShell();
        }
    } catch { /* بلا شركة */ }
    return initCustomerSidebar();
}

async function loadData() {
    const [wallet, plans, history] = await Promise.all([
        fetchTicketWallet().catch((err) => { console.error('[MySubscription] wallet:', err); return null; }),
        supabase.from('subscription_plans').select('key, name_ar, price_monthly, price_yearly, currency').then(r => r.data || []),
        supabase.from('whatsapp_subscriptions')
            .select('id, plan, status, billing_cycle, start_date, end_date, created_at, is_renewal, payment_method, upgrade_amount, upgraded_from_subscription_id, price_snapshot')
            .order('created_at', { ascending: false })
            .then(r => r.data || [])
    ]);
    return { wallet, plans, history };
}

function priceOf(plans, key, cycle) {
    const p = plans.find(x => x.key === key);
    if (!p) return null;
    return { amount: cycle === 'yearly' ? p.price_yearly : p.price_monthly, currency: p.currency };
}

function planCard({ wallet, plans, history }) {
    const isFree = !wallet || wallet.is_free;
    const planKey = wallet?.plan_key || 'free';
    const current = !isFree ? history.find(h => h.id === wallet.subscription_id) : null;
    const status = subscriptionStatus(isFree ? null : (current || { status: 'active', end_date: wallet.subscription_end }));
    const cycle = current?.billing_cycle || wallet?.billing_cycle || 'monthly';
    const price = isFree ? null : priceOf(plans, planKey, cycle);
    const pending = history.find(h => h.status === 'pending');
    const next = nextPlanKey(planKey);

    let body;
    if (isFree) {
        body = `
            <p class="ms-note" style="margin-top:1rem">أنت على الخطة المجانية: ${wallet?.monthly_limit ?? 20} تذكرة شهريًا بدون أي تكلفة.
            رقّي خطتك لما تحتاج تذاكر أكتر، ونطاق فرعي، وأعضاء فريق، ومفاتيح API.</p>
            <div class="ms-actions">
                <a href="/customer-subscriptions.html" class="btn btn-primary">ترقية إلى ${esc(PLAN_LABELS.support)}</a>
                <a href="/subscriptions.html" class="btn btn-secondary">قارن الخطط</a>
            </div>`;
    } else {
        const start = current?.start_date;
        const end = current?.end_date || wallet.subscription_end;
        const prog = start && end ? cycleProgress(start, end) : null;
        const daysLeft = prog ? prog.daysLeft : Math.max(0, Math.ceil((new Date(end) - new Date()) / 86400000));
        const barTone = daysLeft <= 7 ? ' is-warn' : '';
        body = `
            <div class="ms-dates">
                <div class="ms-date"><div class="l">بدأ في</div><div class="v">${esc(fmtDate(start))}</div></div>
                <div class="ms-date"><div class="l">ينتهي في</div><div class="v">${esc(fmtDate(end))}</div></div>
                <div class="ms-date"><div class="l">المتبقي</div><div class="v">${daysLeft} يوم</div></div>
            </div>
            ${prog ? `<div class="ms-bar${barTone}"><span style="width:${prog.percentLeft}%"></span></div>
                <div class="ms-bar-note">متبقي ${prog.daysLeft} من ${prog.totalDays} يوم في دورة الاشتراك الحالية</div>` : ''}
            ${!current && wallet.shared_account ? '<p class="ms-note">الاشتراك باسم صاحب الحساب، وأنت عضو فيه — نفس المزايا والرصيد.</p>' : ''}
            <div class="ms-actions">
                <a href="/customer-subscriptions.html" class="btn btn-primary">تجديد الاشتراك</a>
                ${next ? `<a href="/customer-subscriptions.html" class="btn btn-secondary">ترقية إلى ${esc(PLAN_LABELS[next])}</a>` : ''}
            </div>`;
    }

    return `
        <section class="ms-card">
            <div class="ms-plan-top">
                <div>
                    <div class="ms-eyebrow">خطتك الحالية</div>
                    <div class="ms-plan-name">${esc(wallet?.plan_name_ar || PLAN_LABELS[planKey])}</div>
                    <div class="ms-price">${price ? `${esc(formatMoney(price.amount, price.currency))} ${esc(CYCLE[cycle] || '')}` : 'مجانًا'}</div>
                </div>
                <span class="ms-pill tone-${status.tone}">${esc(status.label)}</span>
            </div>
            ${pending ? `<p class="ms-note" style="color:#F5A623">عندك طلب ${pending.is_renewal ? 'تجديد' : pending.upgraded_from_subscription_id ? 'ترقية' : 'اشتراك'} في ${esc(PLAN_LABELS[pending.plan] || pending.plan)} قيد المراجعة من فريق الدعم.</p>` : ''}
            ${body}
        </section>`;
}

function walletCard(wallet) {
    const view = walletView(wallet);
    if (!view) {
        return `<section class="ms-card"><h2>رصيد التذاكر</h2><div class="ms-empty">تعذّر تحميل الرصيد الآن. حدّث الصفحة بعد قليل.</div></section>`;
    }
    const billing = Number(wallet.billing_used) || 0;
    return `
        <section class="ms-card ms-wallet">
            ${renderWalletPanel(view)}
            <p class="ms-note">طلبات الاشتراك والترقية والتجديد مش بتتحسب من رصيدك (متاح ${Math.max(0, (wallet.billing_limit || 5) - billing)} من ${wallet.billing_limit || 5} هذا الشهر).</p>
        </section>`;
}

function featuresCard(planKey, plans) {
    const rows = planFeatureRows(planKey);
    const next = nextPlanKey(planKey);
    const nextPrice = next ? priceOf(plans, next, 'monthly') : null;
    const nextLine = next === 'ultimate'
        ? 'تذاكر غير محدودة ودعم أولوية 24/7'
        : '300 تذكرة شهريًا، ونطاق فرعي، وأعضاء فريق، ومفاتيح API';
    return `
        <section class="ms-card">
            <h2>اللي بتشمله خطتك</h2>
            <ul class="ms-features">
                ${rows.map(r => `<li class="${r.included ? 'yes' : 'no'}">${r.included ? CHECK : CROSS}<span>${esc(r.label)}</span>${r.value ? `<span class="v">${esc(r.value)}</span>` : ''}</li>`).join('')}
            </ul>
            ${next ? `<div class="ms-upsell">
                <span><strong>${esc(PLAN_LABELS[next])}:</strong> ${esc(nextLine)}${nextPrice ? ` — ${esc(formatMoney(nextPrice.amount, nextPrice.currency))} شهريًا` : ''}</span>
                <a href="/customer-subscriptions.html" class="btn btn-primary">ترقية</a>
            </div>` : ''}
        </section>`;
}

function historyCard(history, plans) {
    const kind = (h) => (h.upgraded_from_subscription_id ? 'ترقية' : h.is_renewal ? 'تجديد' : 'اشتراك جديد');
    const amount = (h) => {
        if (h.upgrade_amount != null) return formatMoney(h.upgrade_amount, h.price_snapshot?.currency || 'EGP');
        const p = priceOf(plans, h.plan, h.billing_cycle);
        return p ? formatMoney(p.amount, p.currency) : '—';
    };
    return `
        <section class="ms-card">
            <h2>سجل الاشتراكات والطلبات</h2>
            ${history.length ? `<div class="ms-table-wrap"><table class="ms-table">
                <thead><tr><th>الخطة</th><th>نوع الطلب</th><th>الحالة</th><th>المدة</th><th>المبلغ</th><th>وسيلة الدفع</th><th>تاريخ الطلب</th></tr></thead>
                <tbody>${history.map(h => {
                    const st = subscriptionStatus(h);
                    return `<tr>
                        <td><strong>${esc(PLAN_LABELS[h.plan] || h.plan)}</strong><div class="ms-note" style="margin:0">${esc(CYCLE[h.billing_cycle] || '')}</div></td>
                        <td>${esc(kind(h))}</td>
                        <td><span class="ms-pill tone-${st.tone}">${esc(st.label)}</span></td>
                        <td>${esc(fmtDate(h.start_date))} ← ${esc(fmtDate(h.end_date))}</td>
                        <td>${esc(amount(h))}</td>
                        <td>${esc(PAYMENT_METHOD_LABELS[h.payment_method] || '—')}</td>
                        <td>${esc(fmtDate(h.created_at))}</td>
                    </tr>`;
                }).join('')}</tbody></table></div>`
                : '<div class="ms-empty">لا توجد اشتراكات أو طلبات على حسابك حتى الآن.</div>'}
        </section>`;
}

async function render() {
    const data = await loadData();
    const planKey = data.wallet?.plan_key || 'free';
    $('msContent').innerHTML = `
        <div class="ms-grid">
            ${planCard(data)}
            ${walletCard(data.wallet)}
        </div>
        ${featuresCard(planKey, data.plans)}
        <div style="height:1.25rem"></div>
        ${historyCard(data.history, data.plans)}`;
}

async function init() {
    const user = await guardPage(null);
    if (!user) return;
    await pickShell();
    await render();
    window.addEventListener('mad3oom:tickets-changed', render);
}

init();
