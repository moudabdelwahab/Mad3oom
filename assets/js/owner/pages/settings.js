/**
 * owner/settings.html — إعدادات المنصة كما يملكها مالكها.
 *
 * وضع التسجيل يُعدَّل هنا مباشرة (advanced_settings.registration_mode). الكتابة تمر بسياسة «Admins can manage
 * advanced_settings» (is_admin) ثم perm_update (121: staff_write_ok('settings.manage')) التي تشترط جلسة تحرير
 * للمالك — فتظهر نافذة التحقق لحظة الحفظ، ويُسجَّل التغيير بقيمته القديمة والجديدة في سجل التغييرات.
 *
 * إعدادات المالك نفسه (وضع التسجيل، أمانه، مفاتيح التفعيل) هنا. وإعدادات التشغيل اليومي (advanced_settings
 * وworking_hours وticket_distribution_config وrules_engine…) تُدار بواجهتها الكاملة في /admin/settings.html — كانت
 * سياساتها تشترط الرتبة الحرفية 'admin' فتُرسم للمالك فارغة، ومنذ 117 صارت is_admin() فيعدّلها المالك هناك.
 */
import { supabase, bootOwnerPage, esc, when, table, errorBlock, friendlyError, writeResult, announce } from '/assets/js/owner/owner-page.js';
import { CONTEXT_PRESENTATION } from '/assets/js/owner/owner-context.js';
import { resolveRegistrationSettings, REGISTRATION_MODE } from '/assets/js/registration-mode.js';
import { switchView } from '/assets/js/owner/tenancy-governance.js';

const $ = (id) => document.getElementById(id);

/** إعدادات الإدارة التشغيلية: جدولها وما تتحكم فيه. السياسة في كل منها role = 'admin' (60_triggers_rls_policies). */
const ADMIN_ONLY_SETTINGS = Object.freeze([
    ['advanced_settings', 'الإعدادات المتقدمة: وضع التسجيل ونص الانتظار، التنبيهات، الاحتفاظ بالبيانات'],
    ['bot_settings', 'إعدادات بوت المحادثة لحسابات المنصة (قراءة الكل للإدارة؛ لكل حساب صفّه)'],
    ['working_hours', 'ساعات العمل ورسائل خارج الدوام'],
    ['ticket_distribution_config', 'توزيع التذاكر على فريق الدعم'],
    ['rules_engine', 'قواعد الأتمتة'],
    ['custom_roles', 'الأدوار المخصصة']
]);

async function registration() {
    const [result, row] = await Promise.all([
        supabase.rpc('get_public_registration_settings'),
        supabase.from('advanced_settings').select('id, value').eq('key', 'registration_mode').maybeSingle()
    ]);
    const s = resolveRegistrationSettings(result);
    const names = {
        [REGISTRATION_MODE.open]: ['مفتوح', 'status-resolved', 'أي زائر يُنشئ حسابًا مباشرة.'],
        [REGISTRATION_MODE.waitlist]: ['قائمة انتظار', 'status-pending', 'التسجيل يُضيف الزائر لقائمة الانتظار حتى الإطلاق.'],
        [REGISTRATION_MODE.unavailable]: ['غير متاح', 'status-rejected', 'القاعدة لم تُرجع وضعًا معروفًا، فنموذج التسجيل مغلق.']
    };
    const [name, tone, hint] = names[s.mode];
    const value = row.data?.value || {};
    $('settingsRegistration').innerHTML = `
        <p><span class="pill ${tone}">${esc(name)}</span> <span class="panel-subtitle">${esc(hint)}</span></p>
        ${result.error ? errorBlock(friendlyError(result.error)) : ''}
        <form class="owner-action-form" id="regForm" novalidate>
            <div class="form-grid">
                <div class="form-field">
                    <label for="regMode">الوضع</label>
                    <select class="form-control" id="regMode">
                        <option value="open" ${value.mode === 'open' ? 'selected' : ''}>مفتوح</option>
                        <option value="waitlist" ${value.mode === 'waitlist' ? 'selected' : ''}>قائمة انتظار</option>
                    </select>
                </div>
                <div class="form-field">
                    <label for="regLaunch">موعد الإطلاق المعروض</label>
                    <input class="form-control" id="regLaunch" maxlength="60" value="${esc(value.expected_launch_date || '')}">
                </div>
            </div>
            <div class="form-field">
                <label for="regMessage">نص صفحة الانتظار</label>
                <textarea class="form-control" id="regMessage" rows="3" maxlength="1000">${esc(value.waitlist_message || '')}</textarea>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm">حفظ وضع التسجيل</button>
                <span class="panel-subtitle">عملية محمية: يُطلب رمز التحقق إن لم تكن جلسة التحرير مفتوحة. طلبات الانتظار في <a href="/admin/waitlist.html">قائمة الانتظار</a>.</span>
            </div>
            <p class="owner-sie-status" id="regStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    $('regForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce($('regStatus'), text, tone);
        const next = { ...value, mode: $('regMode').value, expected_launch_date: $('regLaunch').value.trim() || null,
                       waitlist_message: $('regMessage').value.trim() || null };
        if (!['open', 'waitlist'].includes(next.mode)) { say('وضع غير معروف.', 'error'); return; }
        const btn = e.submitter || $('regForm').querySelector('button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const res = row.data?.id
            ? await supabase.from('advanced_settings').update({ value: next, updated_at: new Date().toISOString() }).eq('id', row.data.id).select('id')
            : await supabase.from('advanced_settings').insert({ key: 'registration_mode', value: next }).select('id');
        btn.disabled = false;
        const out = writeResult(res);
        if (!out.ok) { say(out.message, 'error'); return; }
        say('حُفظ وضع التسجيل، وسُجِّل في سجل التغييرات.', 'success');
        registration();
    });
}

async function security(status) {
    const { data, error } = await supabase.rpc('owner_security_status');
    if (error) { $('settingsSecurity').innerHTML = errorBlock(friendlyError(error)); return; }
    const ctx = CONTEXT_PRESENTATION[status.active_context]?.name || status.active_context || '—';
    $('settingsSecurity').innerHTML = `
        <dl class="owner-detail-grid">
            <div><dt>التحقق بخطوتين</dt><dd>${data?.mfa_enrolled
                ? '<span class="pill status-resolved">مفعّل</span>' : '<span class="pill status-rejected">غير مفعّل</span>'}</dd></div>
            <div><dt>مدة جلسة التحرير</dt><dd>${esc(String(data?.step_up_minutes ?? '—'))} دقيقة</dd></div>
            <div><dt>تغيير كلمة المرور</dt><dd>${data?.policy?.password_change_locked
                ? '<span class="pill status-resolved">مقفل — بموافقتك من البريد</span>' : '<span class="pill status-pending">غير مقفل</span>'}</dd></div>
            <div><dt>جلسة التحرير</dt><dd>${data?.step_up_fresh
                ? `<span class="pill status-resolved">مفتوح</span> حتى ${esc(when(data.step_up_expires_at))}`
                : '<span class="pill status-neutral">مغلق</span>'}</dd></div>
            <div><dt>الواجهة الحالية</dt><dd>${esc(ctx)}</dd></div>
            <div><dt>تنتهي الواجهة</dt><dd>${esc(when(status.expires_at))}</dd></div>
        </dl>
        <p class="panel-subtitle"><a href="/owner/security.html#policy">سياسة الأمان ومدة جلسة التحرير</a> · <a href="/owner/permissions.html">مصفوفة الصلاحيات</a> · <a href="/owner-contexts.html">واجهة اللوحات</a></p>`;
}

async function switches() {
    const { data, error } = await supabase.rpc('owner_feature_switches');
    if (error) { $('settingsSwitches').innerHTML = errorBlock(friendlyError(error)); return; }
    const all = Array.isArray(data) ? data : [];
    $('settingsSwitches').innerHTML = table(['المفتاح', 'الحالة', 'الوصف'], all.map(s => switchView(s, all)), v => `<tr>
        <td>${esc(v.label)}${v.guarded ? ' <span class="pill status-pending">حساس</span>' : ''}</td>
        <td>${v.enabled ? '<span class="pill status-resolved">مفعّل</span>' : '<span class="pill status-neutral">مطفأ</span>'}</td>
        <td><span class="owner-cell-muted">${esc(v.description)}</span></td>
    </tr>`, { empty: 'لا مفاتيح تفعيل مسجّلة.' });
}

function adminOnly() {
    $('settingsAdminOnly').innerHTML = table(['الجدول', 'ما يتحكم فيه'], ADMIN_ONLY_SETTINGS, ([t, d]) => `<tr>
        <td><span class="owner-mono">${esc(t)}</span></td><td>${esc(d)}</td></tr>`)
        + `<p class="panel-subtitle owner-status-line"><a href="/admin/settings.html">فتح إعدادات الإدارة</a> — تعمل للمالك من هذه الواجهة أو من واجهة «الإدارة»؛
            كتابتها تتطلب جلسة تحرير (settings.manage في <a href="/owner/permissions.html">مصفوفة الصلاحيات</a>)، وكل تغيير في <a href="/owner/security.html#changes">سجل التغييرات</a> بتراجع آمن.</p>`;
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    const run = () => Promise.all([registration(), security(ctx.status), switches()]);
    $('settingsRefresh').addEventListener('click', run);
    adminOnly();
    run();
})();
