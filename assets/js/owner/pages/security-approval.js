/**
 * owner/security-approval.html — رابطا بريد التنبيه: رفض أو موافقة على تغيير كلمة مرور/بريد المالك (121).
 *
 *   ?r=<request>&a=reject#t=<token>   الرفض لا يحتاج تسجيل دخول (رمز الرابط يكفي، ولا يغيّر شيئًا)، ويُخرج كل
 *                                      جلسات المالك في القاعدة — من حاول كان يملك جلسة.
 *   ?r=<request>&a=approve#t=<token>  الموافقة: المالك مسجَّل الدخول + رمز Google Authenticator (النافذة تظهر
 *                                      لحظة الطلب عبر step-up-fetch) + رمز الرابط. القرار في owner_approve_account_change.
 *
 * الرمز في الجزء بعد # فلا يصل لأي خادم في الطلب؛ يُمسح من شريط العنوان فور القراءة، ويُحفظ في
 * sessionStorage لهذه النافذة وحدها إن لزم تسجيل الدخول أولًا.
 */
import { supabase } from '/api-config.js';
import { rpcOutcome } from '/assets/js/owner/security-model.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readLink() {
    const params = new URLSearchParams(location.search);
    const request = params.get('r') || '';
    const action = params.get('a') === 'approve' ? 'approve' : 'reject';
    const key = `owner-approval:${request}:${action}`;
    let token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
    try {
        if (token) sessionStorage.setItem(key, token);
        else token = sessionStorage.getItem(key) || '';
    } catch { /* تخزين محجوب: يبقى الرمز في الذاكرة */ }
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return { request, action, token, key };
}

function render(html) { $('approvalBody').innerHTML = html; }
const done = (title, text, tone = 'ok') => render(`
    <div class="owner-stepup-state ${tone === 'ok' ? 'owner-stepup-state--ok' : 'owner-stepup-state--warn'}">
        <p class="owner-stepup-title">${esc(title)}</p><p class="owner-stepup-text">${esc(text)}</p>
    </div>
    <p><a class="panel-link" href="/login.html">تسجيل الدخول</a> · <a class="panel-link" href="/owner/security.html">مركز الأمان</a></p>`);

(async function init() {
    const link = readLink();
    if (!UUID_RE.test(link.request) || !link.token) {
        done('رابط غير صالح', 'افتح الرابط من رسالة التنبيه نفسها كاملًا. الرابط يُستعمل مرة واحدة وتنتهي مهلته بعد 30 دقيقة.', 'warn');
        return;
    }
    const clear = () => { try { sessionStorage.removeItem(link.key); } catch { /* لا شيء */ } };

    if (link.action === 'reject') {
        render(`<p class="panel-subtitle">إن لم تطلب هذا التغيير: ارفضه. القيمة الحالية تبقى، وتُخرج كل جلسات حساب المالك على كل الأجهزة.
                بعدها سجّل الدخول من جديد وراجع مركز الأمان.</p>
            <div class="stepup-actions"><button type="button" class="btn btn-primary is-danger" id="approvalReject">رفض التغيير وإخراج كل الجلسات</button></div>`);
        $('approvalReject').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            const out = rpcOutcome(await supabase.rpc('owner_reject_account_change', { p_request: link.request, p_token: link.token }));
            clear();
            if (!out.ok) { done('لم يُنفَّذ الرفض', out.message, 'warn'); return; }
            try { await supabase.auth.signOut(); } catch { /* الجلسات أُلغيت في القاعدة على أي حال */ }
            done('رُفض التغيير', 'لم يتغير شيء في حسابك، وخرجت كل الجلسات. سجّل الدخول من جديد.');
        });
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
        const back = encodeURIComponent(location.pathname + location.search);
        render(`<p class="panel-subtitle">الموافقة تتطلب تسجيل الدخول بحساب مالك المنصة ثم رمز تطبيق المصادقة.</p>
            <div class="stepup-actions"><a class="btn btn-primary" href="/login.html?redirect=${back}">تسجيل الدخول للمتابعة</a></div>`);
        return;
    }
    render(`<p class="panel-subtitle">ستُطبَّق القيمة الجديدة التي طُلبت، وتُخرج كل جلساتك الأخرى. سيُطلب رمز Google Authenticator قبل التنفيذ.</p>
        <div class="stepup-actions">
            <button type="button" class="btn btn-primary" id="approvalApprove">الموافقة على التغيير</button>
        </div>
        <p class="panel-subtitle">لم تطلبه؟ لا توافق، واستخدم رابط «ارفض» في رسالة التنبيه نفسها.</p>`);
    $('approvalApprove').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const out = rpcOutcome(await supabase.rpc('owner_approve_account_change', { p_request: link.request, p_token: link.token }));
        if (!out.ok) {
            e.currentTarget.disabled = false;
            if (out.code === 'step_up_required') { done('لم تكتمل الموافقة', 'يلزم رمز التحقق بخطوتين. أعد المحاولة.', 'warn'); return; }
            clear();
            done('لم تُطبَّق الموافقة', out.message, 'warn');
            return;
        }
        clear();
        done('طُبِّق التغيير', out.data.kind === 'email' ? 'تغيّر البريد الأساسي لحسابك.' : 'تغيّرت كلمة المرور. خرجت جلساتك الأخرى.');
    });
})();
