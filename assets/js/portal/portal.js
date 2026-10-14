/**
 * portal.js — بوابة عملاء الشركة (/portal/، القرار D8، الترحيل 095).
 *
 * عميل الشركة يتواصل مع شركته من هنا: تذاكره معها (فتح، ردّ، إغلاق، إعادة فتح).
 * لا شيء من داخل الشركة: لا فريق ولا اشتراكات ولا تقارير ولا مفاتيح ولا تكاملات،
 * ولا شراء باقات مدعوم (السؤال 10: الشراء الشخصي من بوابة مدعوم الرسمية وحدها).
 *
 * الحماية ليست هنا: my_company_portal() تعيد null لغير عميل الشركة، و
 * tickets_select_policy تحصر التذاكر في tickets.user_id = المستخدم. هذا الملف يرسم
 * ما تسمح به القاعدة، ولا يعيد التوجيه تلقائيًا (قاعدة page-guard: رسالة + زر يدوي).
 */
import { guardPage } from '/assets/js/page-guard.js';
import { logout } from '/auth-client.js';
import { createTicket } from '/tickets-service.js';
import { createTicketStream } from '/assets/js/company/company-tickets.js';
import { renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { fetchPortalContext, portalState, validateTicketForm } from '/assets/js/portal/portal-data.js';

let stream = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
    // أي جلسة قائمة تمرّ من الحارس: من ليس عميل شركة يرى رسالة في مكانها.
    const user = await guardPage();
    if (!user) return;

    wireChrome();

    const gate = document.getElementById('portalGate');
    const main = document.getElementById('portalContent');
    renderSkeletonLines(document.getElementById('portalGateBody'), 3);

    const state = portalState(await fetchPortalContext());
    if (state.kind !== 'ready') {
        renderGate(state);
        return;
    }

    document.getElementById('portalCompanyName').textContent = state.companyName;
    document.title = `${state.companyName} — بوابة العملاء`;
    document.getElementById('portalPreviewStrip').hidden = !state.preview;
    gate.hidden = true;
    main.hidden = false;

    stream = createTicketStream('portal', {
        userId: user.id,
        onNewTicket: () => openNewTicket()
    });
    wireNewTicket(state.preview);
    await stream.load();
}

function renderGate(state) {
    const body = document.getElementById('portalGateBody');
    const content = {
        'not-customer': {
            variant: 'empty',
            title: 'هذه البوابة لعملاء الشركات',
            text: 'حسابك ليس مسجّلًا كعميل لدى شركة على مدعوم. يمكنك العودة إلى لوحتك.',
            action: { label: 'الذهاب إلى لوحتي', goto: '/customer-dashboard.html', variant: 'btn-primary' }
        },
        unavailable: {
            variant: 'empty',
            title: 'بوابة العملاء غير مفعّلة بعد',
            text: 'سيتاح الوصول إلى تذاكرك مع شركتك هنا قريبًا.',
            action: null
        },
        error: {
            variant: 'error',
            title: 'تعذّر تحميل البوابة',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', act: 'reload', variant: 'btn-primary' }
        }
    }[state.kind] || {};
    renderState(body, content);
    body.querySelector('[data-action="reload"]')?.addEventListener('click', () => window.location.reload());
    body.querySelector('[data-goto]')?.addEventListener('click', (e) => {
        window.location.href = e.currentTarget.getAttribute('data-goto');
    });
}

function wireChrome() {
    document.getElementById('portalSignOut')?.addEventListener('click', async (event) => {
        event.preventDefault();
        try { await logout(); } catch (err) { console.error('[Portal] logout:', err?.message || err); }
        window.location.replace('/login.html');
    });
}

/* ── تذكرة جديدة ─────────────────────────────────────────────────────────── */

function openNewTicket() {
    const panel = document.getElementById('portalNewTicket');
    panel.hidden = false;
    document.getElementById('portalTicketTitle')?.focus();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function wireNewTicket(preview) {
    const form = document.getElementById('portalNewTicketForm');
    const panel = document.getElementById('portalNewTicket');
    const errorBox = document.getElementById('portalTicketError');
    const submit = document.getElementById('portalTicketSubmit');

    document.getElementById('portalNewTicketBtn')?.addEventListener('click', openNewTicket);
    document.getElementById('portalTicketCancel')?.addEventListener('click', () => {
        form.reset();
        panel.hidden = true;
    });

    if (preview) {
        // منظور العضو لمالك المنصة للقراءة فقط — والقاعدة ترفض الكتابة فيه على أي حال
        submit.disabled = true;
        submit.title = 'المعاينة للقراءة فقط';
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.hidden = true;
        const check = validateTicketForm({
            title: form.elements.title.value,
            description: form.elements.description.value
        });
        if (!check.ok) {
            errorBox.textContent = Object.values(check.errors)[0];
            errorBox.hidden = false;
            return;
        }

        const original = submit.textContent;
        submit.disabled = true;
        submit.textContent = 'جارٍ الإرسال…';
        try {
            await createTicket({ title: check.values.title, description: check.values.description, category: 'other' });
            form.reset();
            panel.hidden = true;
            await stream.load();
        } catch (err) {
            errorBox.textContent = err?.message || 'تعذّر إرسال التذكرة. حاول مرة أخرى.';
            errorBox.hidden = false;
        } finally {
            submit.disabled = false;
            submit.textContent = original;
        }
    });
}

