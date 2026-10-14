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
 *
 * 096 (مفتاح العضويات المتعددة في القاعدة): دعوات الانضمام، ومحوّل الشركات لعميل
 * في أكثر من شركة، والمغادرة، وتعيين الأساسية حين لا أساسية. كل تبديل يمر بالقاعدة
 * (enter_customer_company) وتُعاد قراءة الصفحة منها، فلا تبقى في الشاشة شركة لم يقبلها الخادم.
 */
import { guardPage } from '/assets/js/page-guard.js';
import { logout } from '/auth-client.js';
import { createTicket } from '/tickets-service.js';
import { createTicketStream } from '/assets/js/company/company-tickets.js';
import { renderState, renderSkeletonLines, escapeHtml } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    fetchPortalContext, portalState, validateTicketForm, membershipView,
    fetchMyInvitations, respondToInvitation, switchCompany, leaveCompany, setPrimaryCompany
} from '/assets/js/portal/portal-data.js';

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

    const context = await fetchPortalContext();
    const state = portalState(context);
    await renderInvitations();
    if (state.kind !== 'ready') {
        renderGate(state);
        return;
    }
    renderCompanies(membershipView(context.data));

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

/* ── الدعوات والشركات (096) ─────────────────────────────────────────────── */

async function renderInvitations() {
    const panel = document.getElementById('invitations');
    const list = document.getElementById('portalInvitationList');
    const errorBox = document.getElementById('portalInvitationError');
    const result = await fetchMyInvitations();
    errorBox.hidden = result.ok;
    if (!result.ok) errorBox.textContent = result.error;
    const items = result.data || [];
    panel.hidden = result.ok && items.length === 0;
    list.innerHTML = items.map(inv => `
        <li class="company-sub portal-invitation">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(inv.company_name || 'شركة')}</p>
                <p class="company-sub-dates">تنتهي ${escapeHtml(formatDay(inv.expires_at))}</p>
            </div>
            <div class="portal-invitation-actions">
                <button type="button" class="btn btn-primary" data-invitation="${escapeHtml(inv.id)}" data-accept="true">قبول</button>
                <button type="button" class="btn btn-secondary" data-invitation="${escapeHtml(inv.id)}" data-accept="false">رفض</button>
            </div>
        </li>`).join('');
    list.querySelectorAll('[data-invitation]').forEach(btn => {
        btn.addEventListener('click', () => onRespond(btn));
    });
    if (!panel.hidden && window.location.hash === '#invitations') {
        panel.scrollIntoView({ block: 'nearest' });
    }
}

async function onRespond(btn) {
    const accept = btn.getAttribute('data-accept') === 'true';
    const errorBox = document.getElementById('portalInvitationError');
    document.querySelectorAll('#portalInvitationList button').forEach(b => { b.disabled = true; });
    const result = await respondToInvitation(btn.getAttribute('data-invitation'), accept);
    if (!result.ok) {
        errorBox.textContent = result.error;
        errorBox.hidden = false;
        document.querySelectorAll('#portalInvitationList button').forEach(b => { b.disabled = false; });
        return;
    }
    ui?.showToast?.(accept ? 'انضممت إلى الشركة' : 'تم رفض الدعوة', 'success');
    // القبول قد يجعل الحساب عميل شركة أو يضيف شركة للمحوّل: نعيد القراءة من القاعدة
    window.location.reload();
}

function renderCompanies(view) {
    const panel = document.getElementById('portalCompanies');
    if (!view.multi || !view.current) { panel.hidden = true; return; }
    panel.hidden = false;
    const select = document.getElementById('portalCompanySwitch');
    select.innerHTML = view.options.map(o => `
        <option value="${escapeHtml(o.id)}"${o.isCurrent ? ' selected' : ''}>${escapeHtml(o.name)}${o.isPrimary ? ' (الأساسية)' : ''}</option>`).join('');
    select.disabled = !view.showSwitcher;
    document.getElementById('portalPrimaryTag').hidden = !view.current.isPrimary;
    document.getElementById('portalSetPrimary').hidden = !view.canSetPrimary;
    document.getElementById('portalLeave').hidden = !view.canLeave;

    select.addEventListener('change', async () => {
        select.disabled = true;
        const result = await switchCompany(select.value);
        if (!result.ok) return showCompaniesError(result.error, () => { select.disabled = false; });
        window.location.reload();
    });
    document.getElementById('portalSetPrimary').addEventListener('click', async () => {
        const result = await setPrimaryCompany(view.current.id);
        if (!result.ok) return showCompaniesError(result.error);
        window.location.reload();
    });
    document.getElementById('portalLeave').addEventListener('click', async () => {
        const ok = await ui.showConfirm(
            'مغادرة الشركة؟',
            `لن تظهر لك تذاكر «${view.current.name}» الجديدة ولن تتمكن من مراسلتها من هنا. `
            + 'تذاكرك السابقة تبقى في سجلّ الشركة. العودة تحتاج دعوة جديدة.',
            { confirmLabel: 'مغادرة', cancelLabel: 'تراجع', danger: true }
        );
        if (!ok) return;
        const result = await leaveCompany(view.current.id);
        if (!result.ok) return showCompaniesError(result.error);
        window.location.reload();
    });
}

function showCompaniesError(message, after) {
    const box = document.getElementById('portalCompaniesError');
    box.textContent = message;
    box.hidden = false;
    after?.();
}

function formatDay(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
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

