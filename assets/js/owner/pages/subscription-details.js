/**
 * owner/subscription-details.html — تفاصيل اشتراك واحد لمالك المنصة.
 *
 * كل منطق العرض والإجراءات في assets/js/admin/subscription-details-view.js
 * (renderSubscriptionDetails / wireSubscriptionActions / fetchSubscriptionDetails /
 * mountSubscriptionDetails) كما هو — نفس الدوال، نفس RPCs:
 * admin_list_subscriptions() + admin_subscription_audit() للقراءة،
 * admin_update_subscription() لتعديل الباقة والتواريخ (القطعة التي كانت ناقصة في
 * لوحة المالك)، وadmin_set_subscription_status() للتعطيل وإعادة التفعيل،
 * وplan_feature_keys() لمعاينة أثر تغيير الباقة. كلها is_admin() في القاعدة
 * فيمرّ المالك في سياقه. هذه الصفحة إطار مالك حول نفس الوحدة فقط.
 */
import { supabase, bootOwnerPage } from '/assets/js/owner/owner-page.js';
import { mountSubscriptionDetails, PLAN_LABELS } from '/assets/js/admin/subscription-details-view.js';

const $ = (id) => document.getElementById(id);
const subscriptionId = new URLSearchParams(window.location.search).get('id');
const body = $('root');

(async function start() {
    if (!await bootOwnerPage()) return;

    if (!subscriptionId) {
        body.innerHTML = '<div class="subd-notice subd-notice--error">لا يوجد معرّف اشتراك في الرابط.</div>';
        return;
    }

    mountSubscriptionDetails({
        client: supabase,
        subscriptionId,
        body,
        footer: document.querySelector('[data-subd-footer]'),
        root: $('shell'),
        closeLabel: 'رجوع للاشتراكات',
        onClose: () => { window.location.href = '/owner/subscriptions.html'; },
        onRecord: (record) => {
            const title = $('subdPageTitle');
            const sub = $('subdPageSubtitle');
            if (!record) {
                title.textContent = 'تفاصيل الاشتراك';
                sub.textContent = 'غير متاح';
                return;
            }
            title.textContent = `تفاصيل الاشتراك — ${record.customer_name || ''}`;
            const parts = [record.plan_name_ar || PLAN_LABELS[record.plan] || record.plan];
            if (record.company_name) parts.push(record.company_name);
            sub.textContent = parts.filter(Boolean).join(' • ');
        }
    });
})();
