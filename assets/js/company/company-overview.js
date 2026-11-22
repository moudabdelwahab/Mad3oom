/**
 * company-overview.js — صفحة «نظرة عامة»: توجيه سريع لا نسخة مصغّرة من اللوحة.
 *
 * تعرض فقط: تنبيهات تحتاج قرارًا، ملخّص التذاكر، اختصارات لأقسام قائمة، وآخر
 * الإشعارات والنشاط — وكل تفصيل في صفحته. لا رقم من مصدر فشلت قراءته: «تعذّر
 * التحميل» بدل صفر كاذب.
 *
 * فوق الوحدات المشتركة نفسها:
 *   subscription-model.js / company-model.js   قراءة الاشتراكات والسجل التجاري
 *   ticket-view-model.js (countByView)         نفس عدّادات تبويبات التذاكر
 *   notifications-service.js                   نفس قراءة صفحة الإشعارات
 *   customer-data.js + activity-model.js       نفس قراءة صفحة النشاط
 */
import { overviewAlerts } from '/assets/js/company/company-pages-model.js';
import { pageAvailable } from '/assets/js/company/company-routes.js';
import { countByView } from '/assets/js/customer/ticket-view-model.js';
import { fetchNotifications } from '/notifications-service.js';
import { fetchAccountActivity } from '/assets/js/customer/customer-data.js';
import { toTimeline } from '/assets/js/customer/activity-model.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';
import { icon } from '/assets/js/company/company-ui.js';

/* ── التنبيهات ────────────────────────────────────────────────────────────── */

const ALERT_ICONS = { danger: 'warning', warning: 'alert', info: 'info' };

export function renderOverviewAlerts(dashboard, viewerRole) {
    const box = document.getElementById('companyAlerts');
    if (!box) return;
    const alerts = overviewAlerts(dashboard, viewerRole);
    box.hidden = !alerts.length;
    box.innerHTML = alerts.length ? `
        <ul class="company-alert-list" aria-label="تنبيهات">
            ${alerts.map(a => `
                <li class="company-alert is-${escapeHtml(a.tone)}">
                    <span class="company-alert-icon">${icon(ALERT_ICONS[a.tone] || 'info', 18)}</span>
                    <span class="company-alert-body">
                        <strong class="company-alert-title">${escapeHtml(a.title)}</strong>
                        <span class="company-alert-text">${escapeHtml(a.date ? `${a.text} ${formatDate(a.date)}.` : a.text)}</span>
                    </span>
                    <a class="company-alert-action" href="/company-dashboard/#${escapeHtml(a.page)}"
                       data-tab="${escapeHtml(a.page)}">${escapeHtml(a.action)}</a>
                </li>`).join('')}
        </ul>` : '';
}

/* ── إجراءات سريعة ────────────────────────────────────────────────────────
   اختصارات لصفحات قائمة فعلًا ومتاحة لهذا الدور (pageAvailable) — لا زر لميزة
   غير جاهزة. القاعدة تبقى الحارس؛ هذه روابط تنقّل لا صلاحيات. */
const QUICK_ACTIONS = [
    { page: 'support', icon: 'plus', title: 'فتح تذكرة دعم', text: 'تواصل مع فريق مدعوم بخصوص حساب شركتك' },
    { page: 'customerTickets', icon: 'chat', title: 'تذاكر العملاء', text: 'تابع طلبات عملاء شركتك وردّ عليها' },
    { page: 'inbox', icon: 'inbox', title: 'صندوق الرسائل', text: 'رسائل عملاء الشركة من بوابتهم' },
    { page: 'members', icon: 'users', title: 'الفريق', text: 'الأعضاء وأدوارهم في فريق الشركة' },
    { page: 'usage', icon: 'gauge', title: 'رصيد التذاكر', text: 'المتبقي هذا الشهر وموعد التجديد' },
    { page: 'api', icon: 'code', title: 'مفاتيح API', text: 'أنشئ المفاتيح وراجع آخر النداءات' }
];

export function quickActionsFor(ctx) {
    // الستة كلها: الشبكة في company-dashboard.css عمودان (صفان ونصف لستة
    // عناصر، وعمود واحد على الجوال)، فلا اقتطاع ولا كسر للتخطيط.
    return QUICK_ACTIONS.filter(action => pageAvailable(action.page, ctx));
}

export function renderQuickActions(ctx) {
    const box = document.getElementById('companyQuickActions');
    if (!box) return;
    box.innerHTML = `
        <ul class="company-actions">
            ${quickActionsFor(ctx).map(action => `
                <li>
                    <a class="company-action" href="/company-dashboard/#${escapeHtml(action.page)}" data-tab="${escapeHtml(action.page)}">
                        <span class="company-action-icon">${icon(action.icon, 18)}</span>
                        <span class="company-action-body">
                            <span class="company-action-title">${escapeHtml(action.title)}</span>
                            <span class="company-action-text">${escapeHtml(action.text)}</span>
                        </span>
                        ${icon('forward', 16, 'company-action-go')}
                    </a>
                </li>`).join('')}
        </ul>`;
}

/* ── قائمة «ابدأ هنا» لمالك الشركة الجديد ─────────────────────────────────
   خطوات أولى تُشتق حالة إكمال كلٍّ منها من بيانات محمّلة أصلًا في اللوحة
   (الأعضاء/العملاء/المتجر/التذاكر) — بلا أي جلب جديد وبلا أي تغيير خادم.
   غياب بيانات = الخطوة غير مكتملة، ولا يُرمى خطأ أبدًا (دفاعي تمامًا).
   خطوة المتجر لحسابات المتاجر وحدها؛ لغيرها لا معنى لها فتُستبعد من القائمة
   ومن حساب الاكتمال. اكتمال ربط المتجر نفسه لا يُشتق من البيانات المتاحة
   (حالة ربط Shopify تُقرأ في صفحة Shopify وحدها)، فتظهر غير مكتملة برابط
   لصفحتها دون ادعاء اكتمالها.
   الإخفاء اليدوي يُحفظ في localStorage بالمفتاح أدناه؛ والاكتمال الكامل
   يخفي القائمة دون حفظ (فلو تغيّرت البيانات ظهرت مجددًا). */

/** مفتاح إخفاء قائمة «ابدأ هنا» — إغلاق يدوي يبقى مخفيًا عبر الجلسات. */
export const GETTING_STARTED_DISMISSED_KEY = 'mad3oom.company.getting-started.dismissed.v1';

/** اشتقاق خالص لحالة الخطوات من عدّادات محمّلة أصلًا. */
export function gettingStartedSteps({ membersCount = 0, customersCount = 0, isStoreAccount = false, platformTicketsCount = 0 } = {}) {
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const steps = [
        { key: 'team', title: 'أضف فريقك', text: 'أضف مستخدمًا آخر لشركتك ليظهر في الفريق.', page: 'members', done: n(membersCount) > 1 },
        { key: 'customers', title: 'ادعُ عملاءك', text: 'ادعُ عميلًا بالبريد لينضم إلى شركتك.', page: 'customers', done: n(customersCount) > 0 },
        { key: 'ticket', title: 'افتح أول تذكرة', text: 'تواصل مع فريق مدعوم بأول طلب دعم.', page: 'support', done: n(platformTicketsCount) > 0 }
    ];
    if (isStoreAccount) {
        steps.splice(2, 0, { key: 'store', title: 'اربط متجرك', text: 'أكمل ربط متجر Shopify لتصل بياناته إلى الدعم.', page: 'shopify', done: false });
    }
    return steps;
}

/**
 * يرسم القائمة (أو يحدّثها في مكانها، أو يزيلها عند اكتمال كل الخطوات أو
 * عند إغلاقها يدويًا). يُنادى من loadOverview عبر refreshOverviewTickets
 * بعد تحميل التذاكر، ومن onTicketCreated عبر المسار نفسه.
 */
export function renderGettingStarted(input = {}) {
    try {
        const host = document.getElementById('overviewTabContent');
        if (!host) return;
        const existing = document.getElementById('companyGettingStarted');
        let dismissed = false;
        try { dismissed = window.localStorage?.getItem(GETTING_STARTED_DISMISSED_KEY) === '1'; } catch { dismissed = false; }
        const steps = gettingStartedSteps(input);
        if (dismissed || steps.length === 0 || steps.every(s => s.done)) {
            existing?.remove();
            return;
        }
        const html = `
        <section class="panel" id="companyGettingStarted" aria-labelledby="companyGettingStartedHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyGettingStartedHeading">ابدأ هنا</h2>
                    <p class="panel-subtitle">خطوات أولى لتجهيز شركتك — تختفي عند اكتمالها، ويمكن إغلاقها في أي وقت</p>
                </div>
                <button type="button" class="panel-link" id="companyGettingStartedDismiss">إغلاق</button>
            </div>
            <ul class="company-sub-list">
                ${steps.map((step, i) => `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${i + 1}. ${escapeHtml(step.title)}</p>
                        <p class="company-sub-dates">${escapeHtml(step.text)}</p>
                    </div>
                    <div class="company-sub-side">
                        ${step.done
                            ? '<span class="pill status-tone-success">✓ مكتملة</span>'
                            : `<a class="panel-link" href="/company-dashboard/#${escapeHtml(step.page)}" data-tab="${escapeHtml(step.page)}">فتح الصفحة</a>`}
                    </div>
                </li>`).join('')}
            </ul>
        </section>`;
        if (existing) {
            existing.outerHTML = html;
        } else {
            const anchor = document.getElementById('companyAlerts');
            if (anchor && anchor.parentNode === host) anchor.insertAdjacentHTML('afterend', html);
            else host.insertAdjacentHTML('afterbegin', html);
        }
        document.getElementById('companyGettingStartedDismiss')?.addEventListener('click', () => {
            try { window.localStorage?.setItem(GETTING_STARTED_DISMISSED_KEY, '1'); } catch { /* التخزين غير متاح: الإغلاق لهذه الجلسة فقط */ }
            document.getElementById('companyGettingStarted')?.remove();
        });
    } catch {
        // دفاعي تمامًا: قائمة البداية لا تكسر النظرة العامة أبدًا.
    }
}

/* ── ملخّص التذاكر ───────────────────────────────────────────────────────── */

/**
 * platform / customers: { ok, rows } لكل مسار بعد تحميله المشترك. نفس countByView
 * التي تعدّ تبويبات القسمين — رقم واحد للشيء الواحد في الشاشتين.
 */
export function renderOverviewTickets({ platform, customers, userId, showCustomers = true }) {
    const box = document.getElementById('companyOverviewTickets');
    if (!box) return;

    const p = platform?.ok ? countByView(platform.rows, userId) : null;
    const c = customers?.ok ? countByView(customers.rows, userId) : null;
    const unavailable = 'تعذّر التحميل — افتح الصفحة لإعادة المحاولة';

    const stat = ({ page, iconName, label, value, hint, tone = '' }) => `
        <li>
            <a class="company-stat ${tone}" href="/company-dashboard/#${page}" data-tab="${page}">
                <span class="company-stat-icon">${icon(iconName, 18)}</span>
                <span class="company-stat-body">
                    <span class="company-stat-label">${escapeHtml(label)}</span>
                    <span class="company-stat-hint">${escapeHtml(hint)}</span>
                </span>
                <span class="company-stat-value">${escapeHtml(value)}</span>
            </a>
        </li>`;

    box.innerHTML = `
        <ul class="company-stats">
            ${stat({
                page: 'tickets', iconName: 'mail', label: 'مفتوحة مع مدعوم',
                value: p ? String(p.open) : '—',
                hint: p ? `من ${p.all} تذكرة مع فريق مدعوم` : unavailable
            })}
            ${stat({
                page: 'tickets', iconName: 'alert', label: 'بانتظار ردّك',
                value: p ? String(p.awaiting) : '—',
                hint: p ? (p.awaiting ? 'ردّ فريق مدعوم ولم تردّ بعد' : 'لا تذكرة تنتظر ردّك') : unavailable,
                tone: p && p.awaiting ? 'is-attention' : ''
            })}
            ${showCustomers ? stat({
                page: 'customerTickets', iconName: 'chat', label: 'تذاكر عملاء مفتوحة',
                value: c ? String(c.open) : '—',
                hint: c ? `من ${c.all} تذكرة من عملاء الشركة` : unavailable
            }) : ''}
        </ul>`;
}

export function renderOverviewTicketsLoading() {
    const box = document.getElementById('companyOverviewTickets');
    if (box) renderSkeletonLines(box, 3);
}

/* ── آخر الإشعارات ───────────────────────────────────────────────────────
   قراءة فقط: لا تعليم كمقروء من هنا. النقر يفتح صفحة الإشعارات حيث التفاصيل
   (نافذة الإشعار) والتعليم كمقروء كما هي. */
export async function renderRecentNotifications(limit = 4) {
    const box = document.getElementById('companyRecentNotifications');
    if (!box) return;
    renderSkeletonLines(box, 3);
    let rows;
    try {
        rows = (await fetchNotifications()) || [];
    } catch (err) {
        console.error('[CompanyOverview] notifications:', err?.message || err);
        renderState(box, { variant: 'error', icon: false, title: 'تعذّر تحميل الإشعارات',
            text: 'افتح صفحة الإشعارات لإعادة المحاولة.' });
        return;
    }
    if (!rows.length) {
        renderState(box, { variant: 'empty', icon: false, title: 'لا إشعارات بعد',
            text: 'يصلك هنا ما يخص تذاكرك واشتراكات شركتك.' });
        return;
    }
    box.innerHTML = `
        <ul class="company-feed">
            ${rows.slice(0, limit).map(n => `
                <li>
                    <a class="company-feed-item${n.is_read ? '' : ' is-unread'}" href="/company-dashboard/#notifications" data-tab="notifications">
                        <span class="company-feed-dot" aria-hidden="true"></span>
                        <span class="company-feed-body">
                            <span class="company-feed-title">${escapeHtml(n.title || 'إشعار')}</span>
                            <span class="company-feed-meta">${n.is_read ? '' : '<span class="visually-hidden">غير مقروء · </span>'}${escapeHtml(timeAgo(n.created_at))}</span>
                        </span>
                    </a>
                </li>`).join('')}
        </ul>`;
}

/* ── آخر النشاط ──────────────────────────────────────────────────────────── */
export async function renderRecentActivity(limit = 5) {
    const box = document.getElementById('companyRecentActivity');
    if (!box) return;
    renderSkeletonLines(box, 3);
    const result = await fetchAccountActivity(limit);
    if (!result.ok) {
        renderState(box, { variant: 'error', icon: false, title: 'تعذّر تحميل النشاط',
            text: 'افتح صفحة النشاط لإعادة المحاولة.' });
        return;
    }
    const items = toTimeline(result.data || [], { limit });
    if (!items.length) {
        renderState(box, { variant: 'empty', icon: false, title: 'لا يوجد نشاط مسجّل بعد',
            text: 'يظهر هنا الدخول وتغييرات الحساب وحركة التذاكر.' });
        return;
    }
    box.innerHTML = `
        <ul class="company-feed">
            ${items.map(item => `
                <li class="company-feed-item is-static">
                    <span class="company-feed-dot" aria-hidden="true"></span>
                    <span class="company-feed-body">
                        <span class="company-feed-title">${escapeHtml(item.label)}</span>
                        <span class="company-feed-meta">${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}</span>
                    </span>
                </li>`).join('')}
        </ul>`;
}
