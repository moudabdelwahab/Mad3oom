/**
 * invite.js — قبول دعوة شركة من رابط البريد (/portal/invite.html، 112).
 *
 * لا حارس صفحة هنا عمدًا: حساب جديد في قائمة الانتظار يحوّله الحارس إلى بوابة الحساب، وهذه الصفحة
 * تربط الدعوة به قبل ذلك (company_invitation_claim لا يطلب حسابًا مفعّلًا؛ القبول يطلبه).
 * القرار كله في القاعدة: الرمز يربط صاحب البريد المؤكَّد نفسه فقط، والقبول company_invitation_respond (096).
 */
import { supabase } from '/api-config.js';
import { logout } from '/auth-client.js';
import { renderState, escapeHtml } from '/assets/js/customer/portal-ui.js';
import { PENDING_INVITE_KEY, tokenFromHash, storedToken, loginUrl, inviteState } from '/assets/js/portal/invite-model.js';

const store = {
    get() { try { return localStorage.getItem(PENDING_INVITE_KEY); } catch { return null; } },
    set(token) { try { localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ token, at: Date.now() })); } catch { /* تخزين مغلق */ } },
    clear() { try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* تخزين مغلق */ } }
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
    const body = document.getElementById('inviteBody');
    const fromLink = tokenFromHash(window.location.hash);
    if (fromLink) {
        store.set(fromLink);
        // الرمز لا يبقى في شريط العنوان ولا في السجل
        history.replaceState(null, '', window.location.pathname);
    }
    const token = fromLink || storedToken(store.get());

    let session = null;
    try { ({ data: { session } } = await supabase.auth.getSession()); } catch { /* بلا جلسة */ }
    const claim = token && session
        ? await supabase.rpc('company_invitation_claim', { p_token: token }).then(r => r, () => ({ error: { code: 'network' } }))
        : null;
    const state = inviteState({ token, signedIn: !!session, claim });
    if (state.clearStored) store.clear();
    render(body, state);
}

function render(body, state) {
    const company = state.companyName || 'الشركة'; // renderState يهرّب النصوص
    const views = {
        'no-token': { variant: 'empty', title: 'لا توجد دعوة في هذا الرابط',
                      text: 'افتح رابط الدعوة من البريد كما وصلك.', action: { label: 'بوابة العملاء', goto: '/portal/', variant: 'btn-secondary' } },
        'sign-in': { variant: 'empty', title: 'دعوة للانضمام إلى شركة على مدعوم',
                     text: 'ادخل بنفس البريد الإلكتروني الذي وصلته الدعوة لتظهر لك. ليس لديك حساب؟ أنشئه بنفس البريد من صفحة الدخول.',
                     action: { label: 'تسجيل الدخول', goto: loginUrl(), variant: 'btn-primary' } },
        'not-found': { variant: 'error', title: 'الدعوة غير موجودة أو انتهت',
                       text: 'قد تكون الدعوة أُلغيت أو انتهت أو أُعيد إرسالها برابط أحدث، أو أنك داخل بحساب غير البريد المدعو.',
                       action: { label: 'الدخول بحساب آخر', act: 'switch', variant: 'btn-secondary' } },
        ineligible: { variant: 'error', title: 'هذا الحساب لا ينضم إلى الشركات كعميل',
                      text: 'حسابات فريق المنصة ومالكي الشركات لا تُضاف كعملاء.', action: null },
        disabled: { variant: 'empty', title: 'دعوات الشركات غير مفعّلة حاليًا', text: 'أعد المحاولة لاحقًا.', action: null },
        error: { variant: 'error', title: 'تعذّر فتح الدعوة', text: 'تحقق من اتصالك ثم أعد المحاولة.',
                 action: { label: 'إعادة المحاولة', act: 'reload', variant: 'btn-primary' } },
        'already-member': { variant: 'empty', title: `أنت من عملاء ${company} بالفعل`, text: '',
                            action: { label: 'بوابة العملاء', goto: '/portal/', variant: 'btn-primary' } },
        inactive: { variant: 'empty', title: `رُبطت دعوة ${company} بحسابك`,
                    text: 'حسابك بانتظار التفعيل. بعد تفعيله تجد الدعوة في بوابة العملاء لتقبلها قبل انتهاء صلاحيتها.', action: null }
    };
    if (state.kind === 'ready') return renderReady(body, state);
    renderState(body, views[state.kind] || views.error);
    body.querySelector('[data-goto]')?.addEventListener('click', (e) => { window.location.href = e.currentTarget.getAttribute('data-goto'); });
    body.querySelector('[data-action="reload"]')?.addEventListener('click', () => window.location.reload());
    body.querySelector('[data-action="switch"]')?.addEventListener('click', async () => {
        try { await logout(); } catch { /* الخروج أفضل جهد */ }
        window.location.href = loginUrl();
    });
}

function renderReady(body, state) {
    body.innerHTML = `
        <div class="invite-card">
            <h2 class="panel-title">دعوة من ${escapeHtml(state.companyName || 'شركة')}</h2>
            <p class="panel-subtitle">بقبولها تصبح من عملاء الشركة وتتابع تذاكرك ورسائلك معها من بوابة العملاء. لا تنضم لفريقها ولا ترى بياناتها.</p>
            <p class="field-error" id="inviteError" role="alert" hidden></p>
            <div class="invite-actions">
                <button type="button" class="btn btn-primary" data-accept="true">قبول الدعوة</button>
                <button type="button" class="btn btn-secondary" data-accept="false">رفض</button>
            </div>
        </div>`;
    body.querySelectorAll('[data-accept]').forEach(btn => btn.addEventListener('click', async () => {
        const accept = btn.getAttribute('data-accept') === 'true';
        body.querySelectorAll('[data-accept]').forEach(b => { b.disabled = true; });
        const { data, error } = await supabase.rpc('company_invitation_respond', { p_invitation: state.invitationId, p_accept: accept })
            .then(r => r, () => ({ error: { message: 'network' } }));
        if (error) {
            const box = document.getElementById('inviteError');
            box.textContent = error.code === 'P0002' ? 'الدعوة لم تعد متاحة.' : 'تعذّر تنفيذ الطلب. حاول مرة أخرى.';
            box.hidden = false;
            body.querySelectorAll('[data-accept]').forEach(b => { b.disabled = false; });
            return;
        }
        renderState(body, data?.accepted
            ? { variant: 'empty', title: `انضممت إلى ${state.companyName || 'الشركة'}`, text: '',
                action: { label: 'بوابة العملاء', goto: '/portal/', variant: 'btn-primary' } }
            : { variant: 'empty', title: 'رُفضت الدعوة', text: 'لن تُضاف إلى الشركة.', action: null });
        body.querySelector('[data-goto]')?.addEventListener('click', (e) => { window.location.href = e.currentTarget.getAttribute('data-goto'); });
    }));
}
