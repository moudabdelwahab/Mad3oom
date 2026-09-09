/**
 * company-activity.js — سجل نشاط الحساب داخل لوحة الشركة.
 *
 * مستوحى من «سجل النشاط» في لوحة الإدارة، بفارق جوهري: هناك سجل المنصة كلها،
 * وهنا سجل هذا الحساب وحده. المصدر واحد مشترك مع بوابة العميل:
 *
 *   assets/js/customer/customer-data.js  fetchAccountActivity (مقيَّد بالحساب)
 *   assets/js/customer/activity-model.js toTimeline — allow-list خالصة تحدّد
 *                                        ما يجوز أن يراه غير الطاقم أصلًا
 *
 * الفلترة في القاعدة (migrations/010) لا هنا؛ الـallow-list طبقة ثانية.
 */

import { fetchAccountActivity } from '/assets/js/customer/customer-data.js';
import { toTimeline } from '/assets/js/customer/activity-model.js';
import { escapeHtml, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';

const PAGE_SIZE = 25;

let container = null;
let timeline = [];
let activeGroup = null;

export function initCompanyActivity() {
    container = document.getElementById('companyActivity');
}

/** المجموعات الموجودة فعلًا في السجل — لا قائمة ثابتة تعرض تبويبات فارغة. */
export function groupsIn(items) {
    const seen = new Map();
    for (const item of items || []) {
        if (!item?.group) continue;
        seen.set(item.group, (seen.get(item.group) || 0) + 1);
    }
    return [...seen.entries()].map(([key, count]) => ({ key, count }));
}

const GROUP_LABELS = {
    security: 'الأمان والدخول',
    tickets: 'التذاكر',
    account: 'الحساب',
    subscription: 'الاشتراك',
    other: 'أخرى'
};

export async function loadCompanyActivity() {
    if (!container) return;
    renderSkeletonLines(container, 5);

    const result = await fetchAccountActivity(120);
    if (!result.ok) {
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل سجل النشاط',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'activity', variant: 'btn-primary' }
        });
        return;
    }

    timeline = toTimeline(result.data || [], { limit: 120 });
    render();
}

function render() {
    const groups = groupsIn(timeline);
    const visible = activeGroup ? timeline.filter(i => i.group === activeGroup) : timeline;
    const shown = visible.slice(0, PAGE_SIZE);

    container.innerHTML = `
        <section class="panel" aria-labelledby="companyActivityHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyActivityHeading">نشاط الحساب</h2>
                    <p class="panel-subtitle">ما جرى على حساب شركتك، بترتيب زمني</p>
                </div>
            </div>

            ${groups.length > 1 ? `
            <div class="view-tabs" role="tablist">
                <button type="button" role="tab" class="view-tab" aria-selected="${!activeGroup}"
                        data-activity-group="">الكل <span class="view-tab-count">${timeline.length}</span></button>
                ${groups.map(g => `
                    <button type="button" role="tab" class="view-tab" aria-selected="${activeGroup === g.key}"
                            data-activity-group="${escapeHtml(g.key)}">
                        ${escapeHtml(GROUP_LABELS[g.key] || g.key)}
                        <span class="view-tab-count">${g.count}</span>
                    </button>`).join('')}
            </div>` : ''}

            <div id="companyActivityList"></div>
            ${visible.length > shown.length ? `
            <div class="company-form-actions">
                <button type="button" class="btn btn-secondary" id="companyActivityMore">
                    عرض المزيد (${visible.length - shown.length})
                </button>
            </div>` : ''}
        </section>`;

    const list = document.getElementById('companyActivityList');
    if (!shown.length) {
        renderState(list, {
            variant: 'empty',
            title: activeGroup ? 'لا نشاط في هذه المجموعة' : 'لا يوجد نشاط مسجّل بعد',
            text: 'يظهر هنا الدخول وتغييرات الحساب وحركة التذاكر.'
        });
    } else {
        list.innerHTML = `
            <div class="activity-timeline">
                ${shown.map(item => `
                    <div class="activity-item">
                        <div>
                            <div class="activity-text">${escapeHtml(item.label)}</div>
                            <div class="activity-time">
                                ${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}
                            </div>
                        </div>
                    </div>`).join('')}
            </div>`;
    }

    container.querySelectorAll('[data-activity-group]').forEach(btn => {
        btn.addEventListener('click', () => {
            activeGroup = btn.getAttribute('data-activity-group') || null;
            render();
        });
    });

    // «عرض المزيد» يوسّع القائمة في مكانها — بلا تنقّل وبلا إعادة جلب
    document.getElementById('companyActivityMore')?.addEventListener('click', () => {
        const list2 = document.getElementById('companyActivityList');
        list2.innerHTML = `
            <div class="activity-timeline">
                ${visible.map(item => `
                    <div class="activity-item">
                        <div>
                            <div class="activity-text">${escapeHtml(item.label)}</div>
                            <div class="activity-time">
                                ${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}
                            </div>
                        </div>
                    </div>`).join('')}
            </div>`;
        document.getElementById('companyActivityMore')?.remove();
    });
}
