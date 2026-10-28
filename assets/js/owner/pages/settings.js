/**
 * owner/settings.html — إعدادات المنصة كما يملكها مالكها.
 *
 * إعدادات المالك نفسه (وضع التسجيل، أمانه، مفاتيح التفعيل) هنا. وإعدادات التشغيل اليومي (advanced_settings
 * وworking_hours وticket_distribution_config وrules_engine…) تُدار بواجهتها الكاملة في /admin/settings.html — كانت
 * سياساتها تشترط الرتبة الحرفية 'admin' فتُرسم للمالك فارغة، ومنذ 117 صارت is_admin() فيعدّلها المالك هناك.
 */
import { supabase, bootOwnerPage, esc, when, table, errorBlock, friendlyError } from '/assets/js/owner/owner-page.js';
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
    const result = await supabase.rpc('get_public_registration_settings');
    const s = resolveRegistrationSettings(result);
    const names = {
        [REGISTRATION_MODE.open]: ['مفتوح', 'status-resolved', 'أي زائر يُنشئ حسابًا مباشرة.'],
        [REGISTRATION_MODE.waitlist]: ['قائمة انتظار', 'status-pending', 'التسجيل يُضيف الزائر لقائمة الانتظار حتى الإطلاق.'],
        [REGISTRATION_MODE.unavailable]: ['غير متاح', 'status-rejected', 'القاعدة لم تُرجع وضعًا معروفًا، فنموذج التسجيل مغلق.']
    };
    const [name, tone, hint] = names[s.mode];
    $('settingsRegistration').innerHTML = `
        <p><span class="pill ${tone}">${esc(name)}</span></p>
        <p class="panel-subtitle">${esc(hint)}</p>
        ${s.mode === REGISTRATION_MODE.waitlist ? `<p class="panel-subtitle">موعد الإطلاق المعروض: ${esc(s.launchDate)}</p>` : ''}
        ${result.error ? errorBlock(friendlyError(result.error)) : ''}
        <p class="panel-subtitle owner-status-line">تغيير الوضع يتم من <code>advanced_settings</code> — إعداد إداري (انظر أسفل الصفحة). وطلبات الانتظار نفسها في
            <a href="/admin/waitlist.html">قائمة الانتظار</a>.</p>`;
}

async function security(status) {
    const { data, error } = await supabase.rpc('owner_security_status');
    if (error) { $('settingsSecurity').innerHTML = errorBlock(friendlyError(error)); return; }
    const ctx = CONTEXT_PRESENTATION[status.active_context]?.name || status.active_context || '—';
    $('settingsSecurity').innerHTML = `
        <dl class="owner-detail-grid">
            <div><dt>التحقق بخطوتين</dt><dd>${data?.mfa_enrolled
                ? '<span class="pill status-resolved">مفعّل</span>' : '<span class="pill status-rejected">غير مفعّل</span>'}</dd></div>
            <div><dt>وضع العمليات الحساسة</dt><dd>${data?.step_up_fresh
                ? `<span class="pill status-resolved">مفتوح</span> حتى ${esc(when(data.step_up_expires_at))}`
                : '<span class="pill status-neutral">مغلق</span>'}</dd></div>
            <div><dt>الواجهة الحالية</dt><dd>${esc(ctx)}</dd></div>
            <div><dt>تنتهي الواجهة</dt><dd>${esc(when(status.expires_at))}</dd></div>
        </dl>
        <p class="panel-subtitle"><a href="/owner-dashboard.html#authority">إدارة التحقق بخطوتين وفتح العمليات الحساسة</a> · <a href="/owner-contexts.html">واجهة اللوحات</a></p>`;
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
        + `<p class="panel-subtitle owner-status-line"><a href="/admin/settings.html">فتح إعدادات الإدارة</a> — تعمل للمالك من هذه الواجهة أو من واجهة «الإدارة».</p>`;
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    const run = () => Promise.all([registration(), security(ctx.status), switches()]);
    $('settingsRefresh').addEventListener('click', run);
    adminOnly();
    run();
})();
