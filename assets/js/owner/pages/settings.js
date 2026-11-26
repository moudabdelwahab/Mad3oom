/**
 * owner/settings.html — إعدادات المنصة كما يملكها مالكها، أصلية هنا لا في /admin/settings.html.
 *
 * صفحة واحدة بتبويبات (hash) على نمط تنقّل إعدادات الإدارة، وكل قسم منها منقول حرفيًا
 * من assets/js/admin/settings.js (نفس المفاتيح والحقول وشكل الصفوف)، والكتابة تمر بسياسة
 * «Admins can manage advanced_settings» (is_admin) ثم perm_update (121: staff_write_ok('settings.manage'))
 * التي تشترط جلسة تحرير للمالك — فتظهر نافذة التحقق لحظة الحفظ، ويُسجَّل التغيير في سجل التغييرات.
 *
 * الأساس في القاعدة (117): rules_engine وcustom_roles وworking_hours وticket_distribution_config
 * وadvanced_settings وwebhooks (025/035) كلها is_admin()، فيعدّلها المالك في سياقه.
 * تحفظات موثقة (لا توسيع من هنا):
 *   • bot_settings: في المستودع سياسة قراءة is_admin() وحدها، بلا سياسة كتابة؛ وads_settings بلا
 *     سياسة أصلًا، وRLS غير مفعَّل عليهما في 134 — فالحفظ هنا يفحص الصفوف المكتوبة فعليًا
 *     (writeResult) ويفشل بصوت عالٍ بدل «تم» كاذب إن رفضت القاعدة الكتابة.
 *   • رفع شعار المنصة إلى مستودع platform-assets: لا سياسة إدراج له في المستودع — يُختبر حيًا.
 *   • run_data_retention_cleanup(): حارسها is_admin() (035) لكن التنفيذ مسحوب من authenticated
 *     (035:617) بلا منح لاحق في المستودع — زر «تشغيل الآن» سيُرفض حتى يُمنح التنفيذ (مجموعة SQL).
 *   • send_test_telegram_alert(): بلا حارس is_admin() أصلًا (134) — لكنها محصورة بذاتها: ترسل
 *     إلى telegram_chat_id الخاص بالمستدعي وحده، وممنوحة لـauthenticated؛ فلا خطر عبور،
 *     ويُترك تضييقها لمجموعة SQL إن أرادت.
 *   • إدارة المستخدمين (إسناد الأدوار، profiles.delete) ليست هنا عمدًا: سطح مجموعة F3 (B11)
 *     في قسم المستخدمون بلوحة المالك — رابط إليه في تبويب «إدارة المستخدمين».
 *   • تكاملات API ومفاتيحها (api-integrations.js) وإدارة الأجهزة: لم تُنقلا — خارج نطاق F4.
 *
 * الجدول القديم ADMIN_ONLY_SETTINGS (كان يزعم سياسات role='admin' الحرفية) حُذف: 117 وسّعتها
 * إلى is_admin()، والآن كل تلك الأقسام أصلية هنا.
 */
import { supabase, bootOwnerPage, esc, when, table, errorBlock, friendlyError, writeResult, announce, openModal } from '/assets/js/owner/owner-page.js';
import { CONTEXT_PRESENTATION } from '/assets/js/owner/owner-context.js';
import { resolveRegistrationSettings, REGISTRATION_MODE } from '/assets/js/registration-mode.js';
import { switchView } from '/assets/js/owner/tenancy-governance.js';
import { mountAccountSettings } from '/assets/js/account/account-settings.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_TABS = Object.freeze(['registration', 'profile', 'security', 'switches', 'platform', 'bot', 'ads',
    'branding', 'hours', 'distribution', 'retention', 'sla', 'telegram', 'rules', 'roles', 'webhooks', 'advanced', 'users']);

let me = null;
let myEmail = null;

/** التبويب الحالي من الـhash، أو التسجيل افتراضيًا. */
function tabFromHash() {
    const name = location.hash.slice(1);
    return SETTINGS_TABS.includes(name) ? name : 'registration';
}

function showTab(name) {
    const tab = SETTINGS_TABS.includes(name) ? name : 'registration';
    document.querySelectorAll('.owner-settings-tab').forEach(s => { s.hidden = s.id !== `tab-${tab}`; });
    document.querySelectorAll('#settingsTabs [data-tab]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
}

/**
 * حفظ مفتاح advanced_settings مع فحص الصفوف المكتوبة فعلًا — RLS يرفض بصفر صفوف بلا
 * خطأ، فبلا الفحص تظهر «تم» كاذبة (نفس ملاحظة saveAdvancedSetting في الإدارة).
 */
async function saveAdvancedSetting(key, value) {
    let res;
    try {
        const { data: existing } = await supabase.from('advanced_settings').select('id').eq('key', key).maybeSingle();
        res = existing
            ? await supabase.from('advanced_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key).select('id')
            : await supabase.from('advanced_settings').insert({ key, value }).select('id');
    } catch (err) {
        return { ok: false, message: friendlyError(err) };
    }
    const out = writeResult(res);
    return out.ok ? { ok: true, message: 'تم حفظ الإعدادات بنجاح.' } : { ok: false, message: out.message };
}

/** upsert صف واحد (bot/ads): نفس فحص الصفوف المكتوبة — بلا سياسة كتابة موثقة في المستودع. */
async function saveSingleRow(tableName, fields) {
    let res;
    try {
        const { data: existing } = await supabase.from(tableName).select('id').limit(1).maybeSingle();
        res = existing
            ? await supabase.from(tableName).update({ ...fields, updated_at: new Date().toISOString() }).eq('id', existing.id).select('id')
            : await supabase.from(tableName).insert(fields).select('id');
    } catch (err) {
        return { ok: false, message: friendlyError(err) };
    }
    const out = writeResult(res);
    return out.ok ? { ok: true, message: 'تم حفظ الإعدادات بنجاح.' } : { ok: false, message: out.message };
}

async function registration() {
    // انقطاع الشبكة يرمي: بلا التقاط يبقى القسم هيكلًا عظميًا وتتوقف run() كلها.
    let result, row;
    try {
        [result, row] = await Promise.all([
            supabase.rpc('get_public_registration_settings'),
            supabase.from('advanced_settings').select('id, value').eq('key', 'registration_mode').maybeSingle()
        ]);
    } catch (err) {
        $('settingsRegistration').innerHTML = errorBlock(friendlyError(err));
        return;
    }
    // قراءة القيمة الحالية فشلت: عرض النموذج بقيم افتراضية كان سيُظهر «مفتوح»
    // كوضع حالي وهو غير مؤكد — خطأ صريح بدل نموذج مضلِّل.
    if (row.error) {
        $('settingsRegistration').innerHTML = errorBlock(friendlyError(row.error));
        return;
    }
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
                <span class="panel-subtitle">عملية محمية: يُطلب رمز التحقق إن لم تكن جلسة التحرير مفتوحة. طلبات الانتظار في <a href="#waitlist">قائمة الانتظار</a> أدناه.</span>
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
        let res;
        try {
            res = row.data?.id
                ? await supabase.from('advanced_settings').update({ value: next, updated_at: new Date().toISOString() }).eq('id', row.data.id).select('id')
                : await supabase.from('advanced_settings').insert({ key: 'registration_mode', value: next }).select('id');
        } catch (err) {
            res = { data: null, error: err };
        } finally {
            btn.disabled = false;
        }
        const out = writeResult(res);
        if (!out.ok) { say(out.message, 'error'); return; }
        say('حُفظ وضع التسجيل، وسُجِّل في سجل التغييرات.', 'success');
        registration();
    });
}

/** طلبات قائمة الانتظار — للاطلاع فقط؛ القبول والرفض لم يُنقلا بعد. */
/* ───────────────────────── قائمة الانتظار ─────────────────────────
   نفس منطق admin/waitlist.js بلا صفحة إدارة: القراءة والرفض عبر جدول
   waitlist_entries مباشرة (سياسة waitlist_entries_admin_all مبنية على
   is_admin() فيمرّ المالك في سياقه)، والموافقة عبر دالة الحافة
   approve-waitlist-entry كما هي — إن رفضت للمالك وقت التشغيل يُبلَّغ عنه
   ولا تُبنى دالة حافة بديلة هنا. */
const WAITLIST_STATUS_LABELS = { pending: 'قيد المراجعة', approved: 'تمت الموافقة', rejected: 'مرفوض' };
const WAITLIST_STATUS_CLASSES = { pending: 'status-pending', approved: 'status-resolved', rejected: 'status-danger' };
// من أين جاء الطلب (migration 066): النموذج، أو حساب أُنشئ مباشرة فأُضيف تلقائيًا.
const WAITLIST_SOURCE_LABELS = {
    form: 'نموذج قائمة الانتظار', google: 'حساب Google', github: 'حساب GitHub',
    email: 'تسجيل مباشر بالبريد', admin: 'أضافه فريق الإدارة'
};
const waitlistSourceLabel = (entry) => WAITLIST_SOURCE_LABELS[entry.source] || WAITLIST_SOURCE_LABELS.form;

let waitlistEntries = [];

async function logWaitlist(action, detail) {
    // السجل best-effort: فشله لا يوقف المراجعة ولا يخفي نتيجتها.
    try {
        const { logActivity } = await import('/activity-service.js');
        logActivity(action, detail);
    } catch { /* لا شيء */ }
}

async function waitlist() {
    const box = $('settingsWaitlist');
    let data, error = null;
    try {
        ({ data, error } = await supabase.from('waitlist_entries').select('*').order('created_at', { ascending: false }));
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    waitlistEntries = Array.isArray(data) ? data : [];
    box.innerHTML = `
        <form class="toolbar owner-filters" id="waitlistFilters" role="search" novalidate>
            <label class="visually-hidden" for="waitlistSearch">ابحث بالاسم أو البريد أو الهاتف</label>
            <input type="search" class="form-control owner-filter-search" id="waitlistSearch" placeholder="ابحث بالاسم أو البريد أو الهاتف…" autocomplete="off" maxlength="100">
            <label class="visually-hidden" for="waitlistStatusFilter">الحالة</label>
            <select class="form-control owner-filter-select" id="waitlistStatusFilter">
                <option value="">كل الحالات</option>
                <option value="pending">قيد المراجعة</option>
                <option value="approved">تمت الموافقة</option>
                <option value="rejected">مرفوض</option>
            </select>
        </form>
        <div id="waitlistTable" aria-live="polite"></div>`;
    $('waitlistFilters').addEventListener('submit', (e) => { e.preventDefault(); renderWaitlist(); });
    $('waitlistSearch').addEventListener('input', renderWaitlist);
    $('waitlistStatusFilter').addEventListener('change', renderWaitlist);
    renderWaitlist();
}

function renderWaitlist() {
    const box = $('waitlistTable');
    if (!box) return;
    const search = ($('waitlistSearch').value || '').trim().toLowerCase();
    const statusFilter = $('waitlistStatusFilter').value;
    const filtered = waitlistEntries.filter((entry) => {
        if (statusFilter && entry.status !== statusFilter) return false;
        if (!search) return true;
        return [entry.name, entry.email, entry.phone].some(v => (v || '').toLowerCase().includes(search));
    });
    box.innerHTML = table(['الاسم', 'البريد', 'الهاتف', 'الحالة', 'التاريخ', ''], filtered, (entry) => `<tr>
        <td><div class="owner-account"><span class="owner-account-name">${esc(entry.name)}</span>
            <span class="owner-account-email">${esc(waitlistSourceLabel(entry))}</span></div></td>
        <td dir="ltr">${esc(entry.email)}</td>
        <td dir="ltr">${esc(entry.phone || '—')}</td>
        <td><span class="pill ${WAITLIST_STATUS_CLASSES[entry.status] || 'status-pending'}">${esc(WAITLIST_STATUS_LABELS[entry.status] || entry.status)}</span></td>
        <td>${esc(when(entry.created_at))}</td>
        <td><button type="button" class="btn btn-outline btn-sm" data-waitlist-entry="${esc(entry.id)}">عرض</button></td>
    </tr>`, { empty: 'لا توجد طلبات مطابقة.' });
    box.querySelectorAll('[data-waitlist-entry]').forEach(b => b.addEventListener('click', () =>
        openWaitlistDetail(b.dataset.waitlistEntry)));
}

function openWaitlistDetail(entryId) {
    const entry = waitlistEntries.find((e) => String(e.id) === String(entryId));
    if (!entry) return;
    const modal = openModal({
        title: `طلب انتظار — ${entry.name}`,
        html: `
        <dl class="owner-detail-grid">
            <div><dt>الاسم</dt><dd>${esc(entry.name)}</dd></div>
            <div><dt>البريد</dt><dd dir="ltr">${esc(entry.email)}</dd></div>
            <div><dt>الهاتف</dt><dd dir="ltr">${esc(entry.phone || '—')}</dd></div>
            <div><dt>المصدر</dt><dd>${esc(waitlistSourceLabel(entry))}</dd></div>
            <div><dt>الحالة</dt><dd>${esc(WAITLIST_STATUS_LABELS[entry.status] || entry.status)}</dd></div>
            <div><dt>أُنشئ</dt><dd>${esc(when(entry.created_at))}</dd></div>
            ${entry.reviewed_at ? `<div><dt>رُوجع</dt><dd>${esc(when(entry.reviewed_at))}</dd></div>` : ''}
        </dl>
        <div class="form-actions">
            ${entry.status === 'approved' ? '' : '<button type="button" class="btn btn-primary btn-sm" id="waitlistApprove">موافقة وإنشاء الحساب</button>'}
            ${entry.status === 'rejected' ? '' : '<button type="button" class="btn btn-outline btn-sm" id="waitlistReject">رفض الطلب</button>'}
        </div>
        <p class="owner-sie-status" id="waitlistDetailStatus" role="status" aria-live="polite" hidden></p>`
    });
    const status = (t, tone) => announce(modal.body.querySelector('#waitlistDetailStatus'), t, tone);
    modal.body.querySelector('#waitlistApprove')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        status(entry.approved_user_id ? 'جارٍ تفعيل الحساب…' : 'جارٍ إنشاء الحساب…');
        const result = await approveWaitlistEntry(entry.id);
        btn.disabled = false;
        if (!result.ok) { status(result.message, 'error'); return; }
        logWaitlist('waitlist_review', `Approved waitlist entry ${entry.id} (account ${result.data?.user_id})`);
        modal.close();
        showWaitlistCredentials(result.data);
        waitlist();
    });
    modal.body.querySelector('#waitlistReject')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        status('جارٍ الرفض…');
        let res;
        try {
            res = await supabase.from('waitlist_entries').update({
                status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: me
            }).eq('id', entry.id).select('id');
        } catch (err) {
            res = { data: null, error: err };
        }
        btn.disabled = false;
        const out = writeResult(res);
        if (!out.ok) { status(out.message, 'error'); return; }
        logWaitlist('waitlist_review', `Rejected waitlist entry ${entry.id}`);
        modal.close();
        waitlist();
    });
}

// الموافقة تُنشئ حسابًا حقيقيًا (auth user + profile) عبر edge function تعمل
// بمفتاح service role، لأن العميل لا يملك صلاحية إنشاء الحسابات.
async function approveWaitlistEntry(entryId) {
    let data, error = null;
    try {
        ({ data, error } = await supabase.functions.invoke('approve-waitlist-entry', { body: { entry_id: entryId } }));
    } catch (err) {
        error = err;
    }
    // أخطاء الـ edge function ترجع الرسالة داخل جسم الاستجابة، مش في error.message.
    const failure = error ? (await readInvokeError(error)) || error.message : data?.error;
    if (failure) return { ok: false, message: failure || 'حدث خطأ أثناء إنشاء الحساب' };
    return { ok: true, data };
}

async function readInvokeError(error) {
    try {
        const body = await error.context?.json();
        return body?.error || null;
    } catch {
        return null;
    }
}

// كلمة المرور المؤقتة تُعرض مرة واحدة فقط ولا تُخزَّن، فلازم المالك ينسخها الآن.
function showWaitlistCredentials(result) {
    if (!result) return;
    const modal = openModal({
        title: result.linked_existing ? 'تم تفعيل الحساب' : 'تم إنشاء الحساب',
        html: `
        <dl class="owner-detail-grid">
            <div><dt>البريد</dt><dd dir="ltr">${esc(result.email || '')}</dd></div>
            ${result.temp_password ? `<div><dt>كلمة المرور المؤقتة</dt><dd dir="ltr"><code id="waitlistCredPassword">${esc(result.temp_password)}</code></dd></div>` : ''}
        </dl>
        <p class="panel-subtitle">${esc(result.temp_password
            ? 'الحساب مفعَّل ومؤكَّد بدون بريد تحقق. كلمة المرور المؤقتة دي بتظهر مرة واحدة بس ومش متخزنة في أي مكان — انسخها وابعتها للعميل ونبّهه يغيّرها بعد أول تسجيل دخول.'
            : result.linked_existing
            ? 'الحساب موجود بالفعل واتفعّل دلوقتي. العميل يدخل بنفس الطريقة اللي سجّل بيها — مفيش كلمة مرور جديدة، وهيُطلب منه رقم الهاتف أول مرة.'
            : result.already_approved
            ? 'الطلب ده متوافق عليه قبل كده والحساب موجود بالفعل. لو العميل نسي كلمة المرور، استخدم "نسيت كلمة المرور".'
            : 'البريد ده كان له حساب بالفعل، فتم ربط الطلب بالحساب القائم بدون تغيير كلمة مروره.')}</p>
        <div class="form-actions">
            <button type="button" class="btn btn-primary btn-sm" id="waitlistCredCopy">نسخ البيانات</button>
        </div>
        <p class="owner-sie-status" id="waitlistCredStatus" role="status" aria-live="polite" hidden></p>`
    });
    modal.body.querySelector('#waitlistCredCopy')?.addEventListener('click', async () => {
        const password = modal.body.querySelector('#waitlistCredPassword')?.textContent || '';
        const text = password ? `${result.email}\n${password}` : (result.email || '');
        try {
            await navigator.clipboard.writeText(text);
            announce(modal.body.querySelector('#waitlistCredStatus'), 'تم نسخ البيانات.', 'success');
        } catch {
            announce(modal.body.querySelector('#waitlistCredStatus'), 'تعذر النسخ، انسخ البيانات يدويًا.', 'error');
        }
    });
}

async function profile() {
    try {
        await mountAccountSettings($('settingsProfile'),
            { section: 'profile', email: myEmail, notify: (msg, type) => announce($('pageStatus'), msg, type === 'error' ? 'error' : 'success') });
    } catch (err) {
        $('settingsProfile').innerHTML = errorBlock(friendlyError(err));
    }
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

/* ───────────────────────── التحكم في المنصة (5 مفاتيح advanced_settings) ─────────────────────────
 * نفس حقول الإدارة وأزرار حفظها. تنبيه الإدارة نفسه: قيم platform_control تُحفظ فقط ولا
 * يفرضها أي جزء من المنصة بعد — لا تُعتمد كحماية. */
async function platform() {
    const box = $('settingsPlatform');
    const keys = ['platform_control', 'communication_control', 'emergency_mode', 'account_policies', 'customer_experience'];
    let rows;
    try {
        const { data, error } = await supabase.from('advanced_settings').select('key, value').in('key', keys);
        if (error) throw error;
        rows = data || [];
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        return;
    }
    const val = (k) => rows.find(r => r.key === k)?.value || {};
    const pc = val('platform_control'), cm = val('communication_control'), em = val('emergency_mode'),
        ap = val('account_policies'), ce = val('customer_experience');
    const chk = (v) => v ? 'checked' : '';
    box.innerHTML = `
        <div class="owner-detail-section">
            <h3>التحكم في المنصة</h3>
            <p class="panel-subtitle"><strong>غير مطبّقة حاليًا.</strong> مدة الجلسة، ومنع الجلسات المتعددة، وتقييد الدولة وعناوين IP تُحفظ كقيم فقط، ولا يفرضها أي جزء من المنصة بعد — تفعيل أي خيار هنا لا يغيّر شيئًا في الدخول أو الجلسات. لا تعتمد عليها كحماية.</p>
            <form class="owner-action-form" id="platformForm" novalidate>
                <div class="form-grid">
                    <div class="form-field"><label for="pfSessionTimeout">مدة الجلسة (بالدقائق)</label>
                        <input type="number" class="form-control" id="pfSessionTimeout" value="${esc(pc.session_timeout ?? '30')}" min="5"></div>
                    <div class="form-field"><label for="pfAllowedCountries">الدول المسموح بها (ISO، مفصولة بفاصلة)</label>
                        <input class="form-control" id="pfAllowedCountries" value="${esc(pc.allowed_countries || '')}" placeholder="EG, SA, AE"></div>
                    <div class="form-field"><label for="pfIpList">قائمة عناوين IP</label>
                        <input class="form-control" id="pfIpList" value="${esc(pc.ip_list || '')}"></div>
                    <div class="form-field"><label for="pfIpRestrictionType">نوع تقييد IP</label>
                        <select class="form-control" id="pfIpRestrictionType">
                            <option value="whitelist" ${pc.ip_restriction_type !== 'blacklist' ? 'selected' : ''}>قائمة بيضاء</option>
                            <option value="blacklist" ${pc.ip_restriction_type === 'blacklist' ? 'selected' : ''}>قائمة سوداء</option>
                        </select></div>
                </div>
                <label><input type="checkbox" id="pfPreventMultipleSessions" ${chk(pc.prevent_multiple_sessions)}> منع الجلسات المتعددة</label>
                <label><input type="checkbox" id="pfRestrictByCountry" ${chk(pc.restrict_by_country)}> تقييد الدخول حسب الدولة</label>
                <label><input type="checkbox" id="pfRestrictByIP" ${chk(pc.restrict_by_ip)}> تقييد الدخول حسب IP</label>
                <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ التحكم في المنصة</button></div>
                <p class="owner-sie-status" id="platformStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </div>
        <div class="owner-detail-section">
            <h3>التحكم في التواصل</h3>
            <form class="owner-action-form" id="commForm" novalidate>
                <div class="form-grid">
                    <div class="form-field"><label for="cmMaxOpenTickets">أقصى تذاكر مفتوحة للعميل</label>
                        <input type="number" class="form-control" id="cmMaxOpenTickets" value="${esc(cm.max_open_tickets ?? '5')}" min="1"></div>
                    <div class="form-field"><label for="cmBannedWords">كلمات محظورة</label>
                        <input class="form-control" id="cmBannedWords" value="${esc(cm.banned_words || '')}"></div>
                    <div class="form-field"><label for="cmMaxMessagesPerMinute">أقصى رسائل في الدقيقة</label>
                        <input type="number" class="form-control" id="cmMaxMessagesPerMinute" value="${esc(cm.max_messages_per_minute ?? '10')}" min="1"></div>
                    <div class="form-field"><label for="cmMaxMessagesPerHour">أقصى رسائل في الساعة</label>
                        <input type="number" class="form-control" id="cmMaxMessagesPerHour" value="${esc(cm.max_messages_per_hour ?? '100')}" min="1"></div>
                </div>
                <label><input type="checkbox" id="cmPreventDuplicateTickets" ${chk(cm.prevent_duplicate_tickets !== false)}> منع التذاكر المكررة</label>
                <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ التحكم في التواصل</button></div>
                <p class="owner-sie-status" id="commStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </div>
        <div class="owner-detail-section">
            <h3>وضع الطوارئ</h3>
            <form class="owner-action-form" id="emergencyForm" novalidate>
                <label><input type="checkbox" id="emEmergencyModeEnabled" ${chk(em.enabled)}> تفعيل وضع الطوارئ</label>
                <label><input type="checkbox" id="emDisableTicketCreation" ${chk(em.disable_ticket_creation)}> تعطيل إنشاء التذاكر</label>
                <label><input type="checkbox" id="emDisableReplies" ${chk(em.disable_replies)}> تعطيل الردود</label>
                <label><input type="checkbox" id="emBotOnlyMode" ${chk(em.bot_only_mode)}> وضع البوت فقط</label>
                <div class="form-field"><label for="emMessageCreation">رسالة إنشاء التذاكر</label>
                    <textarea class="form-control" id="emMessageCreation" rows="2">${esc(em.message_creation || '')}</textarea></div>
                <div class="form-field"><label for="emMessageReplies">رسالة الردود</label>
                    <textarea class="form-control" id="emMessageReplies" rows="2">${esc(em.message_replies || '')}</textarea></div>
                <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ وضع الطوارئ</button></div>
                <p class="owner-sie-status" id="emergencyStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </div>
        <div class="owner-detail-section">
            <h3>سياسات الحساب</h3>
            <form class="owner-action-form" id="policiesForm" novalidate>
                <div class="form-grid">
                    <div class="form-field"><label for="apPasswordChangeInterval">تغيير كلمة المرور كل (يوم)</label>
                        <input type="number" class="form-control" id="apPasswordChangeInterval" value="${esc(ap.password_change_interval ?? '90')}" min="1"></div>
                    <div class="form-field"><label for="apPasswordStrength">قوة كلمة المرور</label>
                        <select class="form-control" id="apPasswordStrength">
                            ${['weak', 'medium', 'strong'].map(v => `<option value="${v}" ${ap.password_strength === v ? 'selected' : ''}>${v === 'weak' ? 'ضعيفة' : v === 'medium' ? 'متوسطة' : 'قوية'}</option>`).join('')}
                        </select></div>
                    <div class="form-field"><label for="apFailedLoginAttempts">محاولات الدخول الفاشلة قبل القفل</label>
                        <input type="number" class="form-control" id="apFailedLoginAttempts" value="${esc(ap.failed_login_attempts ?? '5')}" min="1"></div>
                    <div class="form-field"><label for="apLockoutDuration">مدة القفل (دقيقة)</label>
                        <input type="number" class="form-control" id="apLockoutDuration" value="${esc(ap.lockout_duration ?? '30')}" min="1"></div>
                </div>
                <label><input type="checkbox" id="apForce2FAForAdmins" ${chk(ap.force_2fa_admins)}> فرض التحقق بخطوتين على الإداريين</label>
                <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ سياسات الحساب</button></div>
                <p class="owner-sie-status" id="policiesStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </div>
        <div class="owner-detail-section">
            <h3>تجربة العميل</h3>
            <form class="owner-action-form" id="customerExpForm" novalidate>
                <div class="form-field"><label for="ceCustomerWelcomeMessage">رسالة ترحيب العميل</label>
                    <textarea class="form-control" id="ceCustomerWelcomeMessage" rows="2">${esc(ce.customer_welcome_message || '')}</textarea></div>
                <div class="form-field"><label for="ceSupportWhatsappNumber">رقم واتساب الدعم (أرقام فقط)</label>
                    <input class="form-control" id="ceSupportWhatsappNumber" value="${esc(ce.support_whatsapp || '')}" inputmode="numeric"></div>
                <label><input type="checkbox" id="ceAllowNewRegistrations" ${chk(ce.allow_new_registrations !== false)}> السماح بالتسجيل الجديد</label>
                <label><input type="checkbox" id="ceEnableRewardsSystem" ${chk(ce.enable_rewards_system !== false)}> تفعيل نظام المكافآت</label>
                <label><input type="checkbox" id="ceAllowTicketAttachments" ${chk(ce.allow_ticket_attachments !== false)}> السماح بمرفقات التذاكر</label>
                <label><input type="checkbox" id="ceAllowTicketRating" ${chk(ce.allow_ticket_rating !== false)}> السماح بتقييم التذاكر</label>
                <label><input type="checkbox" id="ceShowSupportOnlineStatus" ${chk(ce.show_support_online_status !== false)}> إظهار حالة اتصال الدعم</label>
                <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ تجربة العميل</button></div>
                <p class="owner-sie-status" id="customerExpStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </div>`;
    const save = (formId, statusId, key, collect) => {
        box.querySelector(`#${formId}`).addEventListener('submit', async (e) => {
            e.preventDefault();
            const say = (text, tone) => announce(box.querySelector(`#${statusId}`), text, tone);
            const btn = box.querySelector(`#${formId} button[type="submit"]`);
            btn.disabled = true;
            say('جارٍ الحفظ…');
            const out = await saveAdvancedSetting(key, collect());
            btn.disabled = false;
            say(out.message, out.ok ? 'success' : 'error');
        });
    };
    save('platformForm', 'platformStatus', 'platform_control', () => ({
        session_timeout: $('pfSessionTimeout').value,
        prevent_multiple_sessions: $('pfPreventMultipleSessions').checked,
        restrict_by_country: $('pfRestrictByCountry').checked,
        allowed_countries: $('pfAllowedCountries').value,
        restrict_by_ip: $('pfRestrictByIP').checked,
        ip_restriction_type: $('pfIpRestrictionType').value,
        ip_list: $('pfIpList').value
    }));
    save('commForm', 'commStatus', 'communication_control', () => ({
        max_open_tickets: $('cmMaxOpenTickets').value,
        prevent_duplicate_tickets: $('cmPreventDuplicateTickets').checked,
        banned_words: $('cmBannedWords').value,
        max_messages_per_minute: $('cmMaxMessagesPerMinute').value,
        max_messages_per_hour: $('cmMaxMessagesPerHour').value
    }));
    save('emergencyForm', 'emergencyStatus', 'emergency_mode', () => ({
        enabled: $('emEmergencyModeEnabled').checked,
        disable_ticket_creation: $('emDisableTicketCreation').checked,
        disable_replies: $('emDisableReplies').checked,
        bot_only_mode: $('emBotOnlyMode').checked,
        message_creation: $('emMessageCreation').value,
        message_replies: $('emMessageReplies').value
    }));
    save('policiesForm', 'policiesStatus', 'account_policies', () => ({
        password_change_interval: $('apPasswordChangeInterval').value,
        password_strength: $('apPasswordStrength').value,
        failed_login_attempts: $('apFailedLoginAttempts').value,
        lockout_duration: $('apLockoutDuration').value,
        force_2fa_admins: $('apForce2FAForAdmins').checked
    }));
    save('customerExpForm', 'customerExpStatus', 'customer_experience', () => ({
        allow_new_registrations: $('ceAllowNewRegistrations').checked,
        enable_rewards_system: $('ceEnableRewardsSystem').checked,
        customer_welcome_message: $('ceCustomerWelcomeMessage').value,
        allow_ticket_attachments: $('ceAllowTicketAttachments').checked,
        allow_ticket_rating: $('ceAllowTicketRating').checked,
        show_support_online_status: $('ceShowSupportOnlineStatus').checked,
        support_whatsapp: ($('ceSupportWhatsappNumber').value || '').replace(/[^\d]/g, '')
    }));
}

async function bot() {
    const box = $('settingsBot');
    let data, error;
    try {
        ({ data, error } = await supabase.from('bot_settings').select('*').limit(1).maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const s = data || {};
    box.innerHTML = `
        <form class="owner-action-form" id="botForm" novalidate>
            <label><input type="checkbox" id="botSmartMemory" ${s.smart_memory_enabled ? 'checked' : ''}> تفعيل الذاكرة الذكية</label>
            <div class="form-field">
                <label for="botSystemPrompt">رسالة نظام البوت</label>
                <textarea class="form-control" id="botSystemPrompt" rows="4">${esc(s.system_prompt || '')}</textarea>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ إعدادات البوت</button></div>
            <p class="owner-sie-status" id="botStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#botForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#botStatus'), text, tone);
        const btn = box.querySelector('#botForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const out = await saveSingleRow('bot_settings', {
            smart_memory_enabled: $('botSmartMemory').checked,
            system_prompt: $('botSystemPrompt').value
        });
        btn.disabled = false;
        say(out.message, out.ok ? 'success' : 'error');
    });
}

async function ads() {
    const box = $('settingsAds');
    let data, error;
    try {
        ({ data, error } = await supabase.from('ads_settings').select('*').limit(1).maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const s = data || {};
    box.innerHTML = `
        <form class="owner-action-form" id="adsForm" novalidate>
            <label><input type="checkbox" id="adsEnabled" ${s.enabled ? 'checked' : ''}> تفعيل الإعلان العلوي</label>
            <div class="form-field">
                <label for="adsContent">نص الإعلان</label>
                <textarea class="form-control" id="adsContent" rows="3">${esc(s.content || '')}</textarea>
            </div>
            <div class="form-field">
                <label for="adsLink">رابط الإعلان</label>
                <input class="form-control" id="adsLink" value="${esc(s.link || '')}" inputmode="url" dir="ltr">
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ الإعلانات</button></div>
            <p class="owner-sie-status" id="adsStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#adsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#adsStatus'), text, tone);
        const btn = box.querySelector('#adsForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const out = await saveSingleRow('ads_settings', {
            enabled: $('adsEnabled').checked,
            content: $('adsContent').value,
            link: $('adsLink').value
        });
        btn.disabled = false;
        say(out.message, out.ok ? 'success' : 'error');
    });
}

async function branding() {
    const box = $('settingsBranding');
    let row, error;
    try {
        ({ data: row, error } = await supabase.from('advanced_settings').select('*').eq('key', 'branding').maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const s = row?.value || {};
    box.innerHTML = `
        <form class="owner-action-form" id="brandingForm" novalidate>
            <div class="form-grid">
                <div class="form-field"><label for="brandSiteName">اسم المنصة</label>
                    <input class="form-control" id="brandSiteName" value="${esc(s.site_name || '')}" placeholder="مدعوم"></div>
                <div class="form-field"><label for="brandPrimaryColor">اللون الرئيسي</label>
                    <input class="form-control" id="brandPrimaryColor" type="color" value="${esc(s.primary_color || '#0077cc')}"></div>
            </div>
            <div class="form-grid">
                <div class="form-field"><label>الشعار الحالي</label>
                    <img id="brandLogoPreview" src="${esc(s.logo_url || '/assets/images/logo.png')}" alt="الشعار" style="max-height:64px">
                    <label for="brandLogoInput">رفع شعار جديد</label>
                    <input class="form-control" id="brandLogoInput" type="file" accept="image/*"></div>
                <div class="form-field"><label>الأيقونة الحالية</label>
                    <img id="brandFaviconPreview" src="${esc(s.favicon_url || '/assets/images/logo.png')}" alt="الأيقونة" style="max-height:64px">
                    <label for="brandFaviconInput">رفع أيقونة جديدة</label>
                    <input class="form-control" id="brandFaviconInput" type="file" accept="image/*"></div>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ الهوية البصرية</button></div>
            <p class="owner-sie-status" id="brandingStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    const preview = (inputId, imgId) => {
        $(inputId).addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => { $(imgId).src = ev.target.result; };
            reader.readAsDataURL(file);
        });
    };
    preview('brandLogoInput', 'brandLogoPreview');
    preview('brandFaviconInput', 'brandFaviconPreview');
    box.querySelector('#brandingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#brandingStatus'), text, tone);
        const btn = box.querySelector('#brandingForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            const next = { ...(s || {}) };
            next.site_name = $('brandSiteName').value;
            next.primary_color = $('brandPrimaryColor').value;
            const upload = async (file, prefix) => {
                const ext = file.name.split('.').pop();
                const path = `${prefix}/${Date.now()}.${ext}`;
                const { error: upErr } = await supabase.storage.from('platform-assets').upload(path, file, { upsert: true });
                if (upErr) throw upErr;
                return supabase.storage.from('platform-assets').getPublicUrl(path).data.publicUrl;
            };
            const logoFile = $('brandLogoInput').files[0];
            if (logoFile) next.logo_url = await upload(logoFile, 'logo');
            const faviconFile = $('brandFaviconInput').files[0];
            if (faviconFile) next.favicon_url = await upload(faviconFile, 'favicon');
            const out = await saveAdvancedSetting('branding', next);
            if (!out.ok) { say(out.message, 'error'); return; }
            $('brandLogoInput').value = '';
            $('brandFaviconInput').value = '';
            if (next.logo_url) $('brandLogoPreview').src = next.logo_url;
            if (next.favicon_url) $('brandFaviconPreview').src = next.favicon_url;
            say('تم حفظ الهوية البصرية بنجاح.', 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

const WEEK_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

async function hours() {
    const box = $('settingsHours');
    let wh, after, error;
    try {
        [{ data: wh, error }, { data: after }] = await Promise.all([
            supabase.from('working_hours').select('*').order('day_of_week', { ascending: true }),
            supabase.from('advanced_settings').select('value').eq('key', 'after_hours').maybeSingle()
        ]);
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const list = wh || [];
    const ah = after?.value || {};
    box.innerHTML = `
        <form class="owner-action-form" id="hoursForm" novalidate>
            <div id="workingHoursContainer">
                ${WEEK_DAYS.map((day, index) => {
                    const d = list.find(h => h.day_of_week === index) || { is_working_day: true, start_time: '09:00', end_time: '17:00' };
                    const open = d.is_working_day !== false;
                    return `<div class="form-row working-hours-row" data-day="${index}" style="align-items:center; margin-bottom:1rem; background:var(--color-muted); padding:.75rem; border-radius:.75rem;">
                        <div style="width:100px; font-weight:700;">${day}</div>
                        <div class="time-input-group">
                            <input type="time" class="form-control wh-start" value="${esc((d.start_time || '09:00').substring(0, 5))}" ${open ? '' : 'disabled'}>
                            <span>إلى</span>
                            <input type="time" class="form-control wh-end" value="${esc((d.end_time || '17:00').substring(0, 5))}" ${open ? '' : 'disabled'}>
                        </div>
                        <label class="switch">
                            <input type="checkbox" class="wh-toggle" ${open ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                        <span class="wh-status-label" style="margin-right:.5rem; font-size:.85rem;">${open ? 'مفتوح' : 'مغلق'}</span>
                    </div>`;
                }).join('')}
            </div>
            <div class="form-field"><label for="afterHoursAutoReply">الرد التلقائي خارج الدوام</label>
                <textarea class="form-control" id="afterHoursAutoReply" rows="2">${esc(ah.auto_reply || '')}</textarea></div>
            <label><input type="checkbox" id="botAfterHours" ${ah.bot_after_hours ? 'checked' : ''}> البوت يرد خارج الدوام</label>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ ساعات العمل</button></div>
            <p class="owner-sie-status" id="hoursStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelectorAll('.working-hours-row').forEach(row => {
        const toggle = row.querySelector('.wh-toggle');
        toggle.addEventListener('change', () => {
            const open = toggle.checked;
            row.querySelector('.wh-start').disabled = !open;
            row.querySelector('.wh-end').disabled = !open;
            row.querySelector('.wh-status-label').textContent = open ? 'مفتوح' : 'مغلق';
        });
    });
    box.querySelector('#hoursForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#hoursStatus'), text, tone);
        const btn = box.querySelector('#hoursForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            for (const row of box.querySelectorAll('.working-hours-row')) {
                const dayOfWeek = parseInt(row.dataset.day, 10);
                const payload = {
                    day_of_week: dayOfWeek,
                    is_working_day: row.querySelector('.wh-toggle').checked,
                    start_time: row.querySelector('.wh-start').value || '09:00',
                    end_time: row.querySelector('.wh-end').value || '17:00',
                    updated_at: new Date().toISOString()
                };
                const existing = list.find(h => h.day_of_week === dayOfWeek);
                const res = existing
                    ? await supabase.from('working_hours').update(payload).eq('id', existing.id).select('id')
                    : await supabase.from('working_hours').insert(payload).select('id');
                const out = writeResult(res);
                if (!out.ok) throw new Error(out.message);
            }
            const out = await saveAdvancedSetting('after_hours', {
                auto_reply: $('afterHoursAutoReply').value,
                bot_after_hours: $('botAfterHours').checked
            });
            if (!out.ok) throw new Error(out.message);
            // hours() يعيد بناء القسم فيمحو سطر الحالة — الرسالة بعده لا قبله.
            await hours();
            say('تم حفظ ساعات العمل والردود التلقائية.', 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

async function distribution() {
    const box = $('settingsDistribution');
    let agents, config, error;
    try {
        [{ data: agents, error }, { data: config }] = await Promise.all([
            supabase.from('profiles').select('id, full_name, email, role').in('role', ['admin', 'support']).order('full_name', { ascending: true }),
            supabase.from('ticket_distribution_config').select('*').eq('method', 'round_robin').maybeSingle()
        ]);
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const list = agents || [];
    const selected = config?.settings?.agent_ids || [];
    box.innerHTML = `
        <form class="owner-action-form" id="distributionForm" novalidate>
            <label><input type="checkbox" id="ticketDistributionEnabled" ${config?.is_active ? 'checked' : ''}> تفعيل التوزيع التلقائي (دوري)</label>
            <div class="form-field"><label>الموظفون المشمولون بالتوزيع</label>
                <div id="agentsList">
                    ${list.length ? list.map(a => `
                        <label><input type="checkbox" value="${esc(a.id)}" ${selected.includes(a.id) ? 'checked' : ''}> ${esc(a.full_name || a.email)}</label>`).join('')
                        : '<p class="panel-subtitle">لا يوجد موظفون إداريون لتوزيع التذاكر عليهم بعد.</p>'}
                </div>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ توزيع التذاكر</button></div>
            <p class="owner-sie-status" id="distributionStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#distributionForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#distributionStatus'), text, tone);
        const btn = box.querySelector('#distributionForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            const settings = { ...(config?.settings || {}), agent_ids: [...box.querySelectorAll('#agentsList input[type="checkbox"]:checked')].map(cb => cb.value) };
            const payload = { is_active: $('ticketDistributionEnabled').checked, method: 'round_robin', settings, updated_at: new Date().toISOString() };
            const res = config
                ? await supabase.from('ticket_distribution_config').update(payload).eq('id', config.id).select('id')
                : await supabase.from('ticket_distribution_config').insert(payload).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            await distribution();
            say('تم حفظ إعدادات توزيع التذاكر بنجاح.', 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

async function retention() {
    const box = $('settingsRetention');
    let row, error;
    try {
        ({ data: row, error } = await supabase.from('advanced_settings').select('*').eq('key', 'data_retention').maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const s = row?.value || {};
    box.innerHTML = `
        <form class="owner-action-form" id="retentionForm" novalidate>
            <label><input type="checkbox" id="retentionEnabled" ${s.enabled ? 'checked' : ''}> تفعيل سياسة الاحتفاظ</label>
            <div class="form-grid">
                <div class="form-field"><label for="retentionDays">الاحتفاظ بالتذاكر المغلقة لمدة (يوم)</label>
                    <input type="number" class="form-control" id="retentionDays" value="${esc(s.ticket_retention_days ?? 365)}" min="30"></div>
                <div class="form-field"><label for="retentionAction">الإجراء عند انتهاء المدة</label>
                    <select class="form-control" id="retentionAction">
                        <option value="archive" ${s.action !== 'delete' ? 'selected' : ''}>أرشفة</option>
                        <option value="delete" ${s.action === 'delete' ? 'selected' : ''}>حذف</option>
                    </select></div>
            </div>
            <p class="panel-subtitle">${s.last_run_at ? `آخر تشغيل: ${esc(when(s.last_run_at))}` : 'لم يتم التشغيل بعد.'}</p>
            <p class="panel-subtitle">ملاحظة: زر «تشغيل الآن» ينادي run_data_retention_cleanup() — حارسها is_admin() لكن التنفيذ مسحوب من authenticated في 035 بلا منح لاحق؛ إن رفضت القاعدة فالسبب المنح لا الصفحة.</p>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm">حفظ سياسة الاحتفاظ</button>
                <button type="button" class="btn btn-outline btn-sm" id="runRetentionNowBtn">تشغيل الآن</button>
            </div>
            <p class="owner-sie-status" id="retentionStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#retentionForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#retentionStatus'), text, tone);
        const btn = box.querySelector('#retentionForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const out = await saveAdvancedSetting('data_retention', {
            enabled: $('retentionEnabled').checked,
            ticket_retention_days: $('retentionDays').value,
            action: $('retentionAction').value
        });
        btn.disabled = false;
        say(out.message, out.ok ? 'success' : 'error');
    });
    box.querySelector('#runRetentionNowBtn').addEventListener('click', async (e) => {
        const say = (text, tone) => announce(box.querySelector('#retentionStatus'), text, tone);
        const btn = e.currentTarget;
        btn.disabled = true;
        say('جارٍ التشغيل…');
        try {
            const { data, error: rpcErr } = await supabase.rpc('run_data_retention_cleanup');
            if (rpcErr) throw rpcErr;
            if (data?.ran) {
                await retention();
                say(`تم التشغيل: ${data.affected} تذكرة تم ${data.action === 'delete' ? 'حذفها' : 'أرشفتها'}.`, 'success');
            } else {
                say('السياسة غير مفعّلة حاليًا، فعّلها واحفظ أولاً.', 'error');
            }
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

async function sla() {
    const box = $('settingsSla');
    let row, error;
    try {
        ({ data: row, error } = await supabase.from('advanced_settings').select('*').eq('key', 'sla_config').maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const s = row?.value || {};
    box.innerHTML = `
        <form class="owner-action-form" id="slaForm" novalidate>
            <label><input type="checkbox" id="slaEnabled" ${s.enabled ? 'checked' : ''}> تفعيل أهداف زمن الرد</label>
            <div class="form-grid">
                <div class="form-field"><label for="slaHighHours">أولوية عالية (ساعات)</label>
                    <input type="number" class="form-control" id="slaHighHours" value="${esc(s.high_hours ?? 4)}" min="1"></div>
                <div class="form-field"><label for="slaMediumHours">أولوية متوسطة (ساعات)</label>
                    <input type="number" class="form-control" id="slaMediumHours" value="${esc(s.medium_hours ?? 24)}" min="1"></div>
                <div class="form-field"><label for="slaLowHours">أولوية منخفضة (ساعات)</label>
                    <input type="number" class="form-control" id="slaLowHours" value="${esc(s.low_hours ?? 48)}" min="1"></div>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ أهداف الرد</button></div>
            <p class="owner-sie-status" id="slaStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#slaForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#slaStatus'), text, tone);
        const btn = box.querySelector('#slaForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const out = await saveAdvancedSetting('sla_config', {
            enabled: $('slaEnabled').checked,
            high_hours: $('slaHighHours').value,
            medium_hours: $('slaMediumHours').value,
            low_hours: $('slaLowHours').value
        });
        btn.disabled = false;
        say(out.message, out.ok ? 'success' : 'error');
    });
}

async function telegram() {
    const box = $('settingsTelegram');
    let data, error;
    try {
        ({ data, error } = await supabase.from('profiles').select('telegram_username, telegram_alert_events').eq('id', me).maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const events = data?.telegram_alert_events || [];
    box.innerHTML = `
        <p>${data?.telegram_username
            ? `متصل بحساب: <strong>@${esc(data.telegram_username)}</strong>`
            : 'لم تربط حسابك على تيليجرام بعد (من صفحة تسجيل الدخول بالبوت).'}</p>
        <form class="owner-action-form" id="telegramForm" novalidate>
            <label><input type="checkbox" id="alertUrgentTicket" ${events.includes('new_urgent_ticket') ? 'checked' : ''}> تنبيه عند تذكرة عاجلة جديدة</label>
            <label><input type="checkbox" id="alertSlaBreach" ${events.includes('sla_breach') ? 'checked' : ''}> تنبيه عند تجاوز مهلة الحل (SLA)</label>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm">حفظ تفضيلات التنبيهات</button>
                <button type="button" class="btn btn-outline btn-sm" id="testTelegramAlertBtn">إرسال رسالة اختبار</button>
            </div>
            <p class="owner-sie-status" id="telegramStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelector('#telegramForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#telegramStatus'), text, tone);
        const btn = box.querySelector('#telegramForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            const evts = [];
            if ($('alertUrgentTicket').checked) evts.push('new_urgent_ticket');
            if ($('alertSlaBreach').checked) evts.push('sla_breach');
            const res = await supabase.from('profiles').update({ telegram_alert_events: evts }).eq('id', me).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            say('تم حفظ تفضيلات التنبيهات بنجاح.', 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
    box.querySelector('#testTelegramAlertBtn').addEventListener('click', async (e) => {
        const say = (text, tone) => announce(box.querySelector('#telegramStatus'), text, tone);
        const btn = e.currentTarget;
        btn.disabled = true;
        say('جارٍ الإرسال…');
        try {
            const { data: res, error: rpcErr } = await supabase.rpc('send_test_telegram_alert');
            if (rpcErr) throw rpcErr;
            say(res?.success ? 'تم إرسال رسالة اختبار على تيليجرام، تأكد من وصولها.' : 'لازم تربط حسابك بتيليجرام الأول عشان يوصلك تنبيه.', res?.success ? 'success' : 'error');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

/* ───────────────────────── قواعد الأتمتة (rules_engine) ───────────────────────── */

const RULE_TRIGGERS = Object.freeze([
    ['ticket_created', 'تذكرة جديدة'], ['no_reply_48h', 'عدم الرد لمدة 48 ساعة'],
    ['payment_ticket', 'تذكرة دفع'], ['urgent_keyword', 'كلمة عاجلة']
]);
const RULE_ACTIONS = Object.freeze([
    ['set_priority_high', 'تعيين أولوية عالية'], ['auto_close', 'إغلاق تلقائي'],
    ['assign_to_admin', 'تعيين للمسؤول'], ['send_notification', 'إرسال إشعار']
]);

async function rules() {
    const box = $('settingsRules');
    let data, error;
    try {
        ({ data, error } = await supabase.from('rules_engine').select('*').order('priority', { ascending: false }));
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const list = data || [];
    const triggerName = (v) => RULE_TRIGGERS.find(([k]) => k === v)?.[1] || v;
    const actionName = (v) => RULE_ACTIONS.find(([k]) => k === v)?.[1] || v;
    box.innerHTML = `
        <div class="form-actions" style="margin-bottom:1rem;">
            <button type="button" class="btn btn-primary btn-sm" id="addRuleBtn">إضافة قاعدة جديدة</button>
        </div>
        ${table(['الاسم', 'الحدث', 'الشرط', 'الإجراء', 'الحالة', ''], list, r => `<tr>
            <td>${esc(r.name)}</td>
            <td>${esc(triggerName(r.trigger_event))}</td>
            <td>${esc(JSON.stringify(r.conditions).substring(0, 30))}…</td>
            <td>${esc(JSON.stringify(r.actions).substring(0, 30))}…</td>
            <td>${r.is_active ? '<span class="pill status-resolved">نشط</span>' : '<span class="pill status-pending">معطل</span>'}</td>
            <td>
                <button type="button" class="btn btn-outline btn-sm" data-edit-rule="${esc(r.id)}">تعديل</button>
                <button type="button" class="btn btn-outline btn-sm" data-delete-rule="${esc(r.id)}">حذف</button>
            </td>
        </tr>`, { empty: 'لا توجد قواعد محددة.' })}`;
    box.querySelector('#addRuleBtn').addEventListener('click', () => openRuleModal(null, rules));
    box.querySelectorAll('[data-edit-rule]').forEach(btn => btn.addEventListener('click', async () => {
        const { data: rule, error: e2 } = await supabase.from('rules_engine').select('*').eq('id', btn.dataset.editRule).single();
        if (e2) { announce($('pageStatus'), friendlyError(e2), 'error'); return; }
        openRuleModal(rule, rules);
    }));
    box.querySelectorAll('[data-delete-rule]').forEach(btn => btn.addEventListener('click', async () => {
        if (!window.confirm('هل أنت متأكد من حذف هذه القاعدة؟')) return;
        btn.disabled = true;
        try {
            const res = await supabase.from('rules_engine').delete().eq('id', btn.dataset.deleteRule).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            announce($('pageStatus'), 'تم حذف القاعدة بنجاح.', 'success');
            rules();
        } catch (err) {
            announce($('pageStatus'), friendlyError(err), 'error');
            btn.disabled = false;
        }
    }));
}

function openRuleModal(rule, reload) {
    const modal = openModal({ title: rule ? 'تعديل القاعدة' : 'إضافة قاعدة جديدة', wide: true, html: `
        <form class="owner-action-form" id="ruleForm" novalidate>
            <div class="form-grid">
                <div class="form-field"><label for="ruleName">اسم القاعدة</label>
                    <input class="form-control" id="ruleName" maxlength="120" required value="${esc(rule?.name || '')}"></div>
                <div class="form-field"><label for="ruleTrigger">الحدث (Trigger)</label>
                    <select class="form-control" id="ruleTrigger">
                        ${RULE_TRIGGERS.map(([v, l]) => `<option value="${v}" ${rule?.trigger_event === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select></div>
                <div class="form-field"><label for="ruleCondition">الشرط</label>
                    <input class="form-control" id="ruleCondition" placeholder="مثال: type = 'payment'" value="${esc(rule?.conditions?.raw || '')}"></div>
                <div class="form-field"><label for="ruleAction">الإجراء</label>
                    <select class="form-control" id="ruleAction">
                        ${RULE_ACTIONS.map(([v, l]) => `<option value="${v}" ${rule?.actions?.[0]?.type === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select></div>
            </div>
            <label><input type="checkbox" id="ruleActive" ${rule?.is_active !== false ? 'checked' : ''}> القاعدة مفعّلة</label>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ القاعدة</button></div>
            <p class="owner-sie-status" id="ruleStatus" role="status" aria-live="polite" hidden></p>
        </form>` });
    modal.body.querySelector('#ruleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(modal.body.querySelector('#ruleStatus'), text, tone);
        const name = modal.body.querySelector('#ruleName').value.trim();
        if (name.length < 2) { say('اكتب اسم القاعدة.', 'error'); return; }
        const payload = {
            name,
            trigger_event: modal.body.querySelector('#ruleTrigger').value,
            conditions: { raw: modal.body.querySelector('#ruleCondition').value },
            actions: [{ type: modal.body.querySelector('#ruleAction').value }],
            is_active: modal.body.querySelector('#ruleActive').checked
        };
        const btn = modal.body.querySelector('#ruleForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            const res = rule
                ? await supabase.from('rules_engine').update(payload).eq('id', rule.id).select('id')
                : await supabase.from('rules_engine').insert(payload).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            modal.close();
            announce($('pageStatus'), 'تم حفظ القاعدة بنجاح.', 'success');
            reload();
        } catch (err) {
            say(friendlyError(err), 'error');
            btn.disabled = false;
        }
    });
}

/* ───────────────────────── الأدوار المخصصة (custom_roles) ───────────────────────── */

const ROLE_PERMS = Object.freeze([
    ['view-tickets', 'view_tickets', 'عرض التذاكر'], ['reply', 'reply', 'الرد على التذاكر'],
    ['delete', 'delete', 'حذف التذاكر'], ['export', 'export', 'تصدير البيانات'],
    ['settings', 'settings', 'إدارة الإعدادات'], ['api', 'api', 'إدارة مفاتيح API']
]);

async function roles() {
    const box = $('settingsRoles');
    let data, error;
    try {
        ({ data, error } = await supabase.from('custom_roles').select('*').order('created_at', { ascending: false }));
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const list = data || [];
    box.innerHTML = `
        <div class="form-actions" style="margin-bottom:1rem;">
            <button type="button" class="btn btn-primary btn-sm" id="addRoleBtn">إضافة دور جديد</button>
        </div>
        ${table(['الدور', 'الوصف', 'عدد الصلاحيات', ''], list, r => {
            const count = Object.keys(r.permissions || {}).filter(k => r.permissions[k]).length;
            return `<tr>
                <td>${esc(r.name)}</td>
                <td>${esc(r.description || '—')}</td>
                <td>${esc(String(count))}</td>
                <td>
                    <button type="button" class="btn btn-outline btn-sm" data-edit-role="${esc(r.id)}">تعديل</button>
                    <button type="button" class="btn btn-outline btn-sm" data-delete-role="${esc(r.id)}">حذف</button>
                </td>
            </tr>`;
        }, { empty: 'لا توجد أدوار مخصصة.' })}`;
    box.querySelector('#addRoleBtn').addEventListener('click', () => openRoleModal(null, roles));
    box.querySelectorAll('[data-edit-role]').forEach(btn => btn.addEventListener('click', () => {
        openRoleModal(list.find(r => String(r.id) === btn.dataset.editRole) || null, roles);
    }));
    box.querySelectorAll('[data-delete-role]').forEach(btn => btn.addEventListener('click', async () => {
        if (!window.confirm('هل أنت متأكد من حذف هذا الدور؟')) return;
        btn.disabled = true;
        try {
            const res = await supabase.from('custom_roles').delete().eq('id', btn.dataset.deleteRole).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            announce($('pageStatus'), 'تم حذف الدور بنجاح.', 'success');
            roles();
        } catch (err) {
            announce($('pageStatus'), friendlyError(err), 'error');
            btn.disabled = false;
        }
    }));
}

function openRoleModal(role, reload) {
    const perms = role?.permissions || {};
    const modal = openModal({ title: role ? 'تعديل الدور' : 'إضافة دور جديد', wide: true, html: `
        <form class="owner-action-form" id="roleForm" novalidate>
            <div class="form-grid">
                <div class="form-field"><label for="roleName">اسم الدور</label>
                    <input class="form-control" id="roleName" maxlength="120" required value="${esc(role?.name || '')}"></div>
                <div class="form-field"><label for="roleDescription">الوصف</label>
                    <input class="form-control" id="roleDescription" maxlength="300" value="${esc(role?.description || '')}"></div>
            </div>
            <div class="form-field"><label>الصلاحيات</label>
                ${ROLE_PERMS.map(([id, key, label]) => `<label><input type="checkbox" id="perm-${id}" ${perms[key] ? 'checked' : ''}> ${label}</label>`).join('')}
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ الدور</button></div>
            <p class="owner-sie-status" id="roleStatus" role="status" aria-live="polite" hidden></p>
        </form>` });
    modal.body.querySelector('#roleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(modal.body.querySelector('#roleStatus'), text, tone);
        const name = modal.body.querySelector('#roleName').value.trim();
        if (name.length < 2) { say('اكتب اسم الدور.', 'error'); return; }
        const permissions = {};
        ROLE_PERMS.forEach(([id, key]) => { permissions[key] = modal.body.querySelector(`#perm-${id}`).checked; });
        const payload = { name, description: modal.body.querySelector('#roleDescription').value, permissions };
        const btn = modal.body.querySelector('#roleForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            const res = role
                ? await supabase.from('custom_roles').update(payload).eq('id', role.id).select('id')
                : await supabase.from('custom_roles').insert(payload).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            modal.close();
            announce($('pageStatus'), 'تم حفظ الدور بنجاح.', 'success');
            reload();
        } catch (err) {
            say(friendlyError(err), 'error');
            btn.disabled = false;
        }
    });
}

/* ───────────────────────── الويبهوكس (webhooks) ───────────────────────── */

const WEBHOOK_EVENTS = Object.freeze([
    ['ticket_created', 'إنشاء تذكرة'], ['ticket_status_changed', 'تغيير حالة التذكرة'], ['ticket_resolved', 'حل التذكرة']
]);

async function webhooks() {
    const box = $('settingsWebhooks');
    let data, error;
    try {
        ({ data, error } = await supabase.from('webhooks').select('*').order('created_at', { ascending: false }));
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const list = data || [];
    const label = (e) => WEBHOOK_EVENTS.find(([k]) => k === e)?.[1] || e;
    box.innerHTML = `
        <div class="form-actions" style="margin-bottom:1rem;">
            <button type="button" class="btn btn-primary btn-sm" id="addWebhookBtn">إضافة Webhook جديد</button>
        </div>
        ${table(['الاسم', 'الرابط', 'الأحداث', 'الحالة', ''], list, h => `<tr>
            <td>${esc(h.name)}</td>
            <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(h.url)}</td>
            <td>${esc((h.events || []).map(label).join('، '))}</td>
            <td>${h.is_active ? '<span class="pill status-resolved">نشط</span>' : '<span class="pill status-pending">معطل</span>'}</td>
            <td>
                <button type="button" class="btn btn-outline btn-sm" data-edit-webhook="${esc(h.id)}">تعديل</button>
                <button type="button" class="btn btn-outline btn-sm" data-delete-webhook="${esc(h.id)}">حذف</button>
            </td>
        </tr>`, { empty: 'لا توجد Webhooks مضافة.' })}`;
    box.querySelector('#addWebhookBtn').addEventListener('click', () => openWebhookModal(null, webhooks));
    box.querySelectorAll('[data-edit-webhook]').forEach(btn => btn.addEventListener('click', () => {
        openWebhookModal(list.find(h => String(h.id) === btn.dataset.editWebhook) || null, webhooks);
    }));
    box.querySelectorAll('[data-delete-webhook]').forEach(btn => btn.addEventListener('click', async () => {
        if (!window.confirm('هل أنت متأكد من حذف هذا الـ Webhook؟')) return;
        btn.disabled = true;
        try {
            const res = await supabase.from('webhooks').delete().eq('id', btn.dataset.deleteWebhook).select('id');
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            announce($('pageStatus'), 'تم حذف الـ Webhook بنجاح.', 'success');
            webhooks();
        } catch (err) {
            announce($('pageStatus'), friendlyError(err), 'error');
            btn.disabled = false;
        }
    }));
}

function openWebhookModal(hook, reload) {
    const events = hook?.events || [];
    const modal = openModal({ title: hook ? 'تعديل Webhook' : 'إضافة Webhook جديد', wide: true, html: `
        <form class="owner-action-form" id="webhookForm" novalidate>
            <div class="form-grid">
                <div class="form-field"><label for="webhookName">الاسم</label>
                    <input class="form-control" id="webhookName" maxlength="120" required value="${esc(hook?.name || '')}"></div>
                <div class="form-field"><label for="webhookUrl">الرابط</label>
                    <input class="form-control" id="webhookUrl" inputmode="url" dir="ltr" required value="${esc(hook?.url || '')}"></div>
            </div>
            <div class="form-field"><label>الأحداث</label>
                ${WEBHOOK_EVENTS.map(([v, l]) => `<label><input type="checkbox" id="webhook-event-${v}" ${events.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}
            </div>
            <label><input type="checkbox" id="webhookActive" ${hook?.is_active !== false ? 'checked' : ''}> الويبهوك مفعّل</label>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ الـ Webhook</button></div>
            <p class="owner-sie-status" id="webhookStatus" role="status" aria-live="polite" hidden></p>
        </form>` });
    modal.body.querySelector('#webhookForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(modal.body.querySelector('#webhookStatus'), text, tone);
        const name = modal.body.querySelector('#webhookName').value.trim();
        const url = modal.body.querySelector('#webhookUrl').value.trim();
        const evts = WEBHOOK_EVENTS.filter(([v]) => modal.body.querySelector(`#webhook-event-${v}`).checked).map(([v]) => v);
        if (!name || !url || !evts.length) { say('لازم تدخل اسم ورابط وتختار حدث واحد على الأقل.', 'error'); return; }
        const payload = { name, url, events: evts, is_active: modal.body.querySelector('#webhookActive').checked, updated_at: new Date().toISOString() };
        const btn = modal.body.querySelector('#webhookForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        try {
            let res;
            if (hook) {
                res = await supabase.from('webhooks').update(payload).eq('id', hook.id).select('id');
            } else {
                // سر عشوائي لتوقيع الحمولة (HMAC) بيتحقق منه السيرفر المستقبِل — كما في الإدارة.
                res = await supabase.from('webhooks').insert({ ...payload, secret: crypto.randomUUID().replace(/-/g, '') }).select('id');
            }
            const out = writeResult(res);
            if (!out.ok) throw new Error(out.message);
            modal.close();
            announce($('pageStatus'), 'تم حفظ الـ Webhook بنجاح.', 'success');
            reload();
        } catch (err) {
            say(friendlyError(err), 'error');
            btn.disabled = false;
        }
    });
}

/* ───────────────────────── محرر الإعدادات المتقدمة العام ───────────────────────── */

async function advanced() {
    const box = $('settingsAdvanced');
    let data, error;
    try {
        ({ data, error } = await supabase.from('advanced_settings').select('key, value').order('key', { ascending: true }));
    } catch (err) {
        error = err;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const rows = data || [];
    box.innerHTML = `
        ${table(['المفتاح', 'القيمة (مختصرة)', ''], rows, r => `<tr>
            <td><span class="owner-mono">${esc(r.key)}</span></td>
            <td style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(JSON.stringify(r.value))}</td>
            <td><button type="button" class="btn btn-outline btn-sm" data-edit-adv="${esc(r.key)}">تعديل</button></td>
        </tr>`, { empty: 'لا مفاتيح مسجّلة.' })}
        <form class="owner-action-form" id="advForm" novalidate>
            <div class="form-field"><label for="advKey">المفتاح</label>
                <input class="form-control owner-mono" id="advKey" dir="ltr" required placeholder="مثال: my_feature_flag"></div>
            <div class="form-field"><label for="advValue">القيمة (JSON)</label>
                <textarea class="form-control owner-mono" id="advValue" rows="6" dir="ltr" required placeholder='{"enabled": true}'></textarea></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ المفتاح</button></div>
            <p class="owner-sie-status" id="advStatus" role="status" aria-live="polite" hidden></p>
        </form>`;
    box.querySelectorAll('[data-edit-adv]').forEach(btn => btn.addEventListener('click', () => {
        const row = rows.find(r => r.key === btn.dataset.editAdv);
        if (!row) return;
        $('advKey').value = row.key;
        $('advValue').value = JSON.stringify(row.value, null, 2);
        $('advKey').focus();
    }));
    box.querySelector('#advForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const say = (text, tone) => announce(box.querySelector('#advStatus'), text, tone);
        const key = $('advKey').value.trim();
        if (!/^[a-z0-9_]+$/.test(key)) { say('المفتاح حروف إنجليزية صغيرة وأرقام وشرطة سفلية فقط.', 'error'); return; }
        let value;
        try {
            value = JSON.parse($('advValue').value);
        } catch {
            say('القيمة ليست JSON صالحًا.', 'error');
            return;
        }
        const btn = box.querySelector('#advForm button[type="submit"]');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        const out = await saveAdvancedSetting(key, value);
        btn.disabled = false;
        // advanced() يعيد بناء القسم فيمحو سطر الحالة — الرسالة بعده لا قبله.
        if (out.ok) await advanced();
        say(out.message, out.ok ? 'success' : 'error');
    });
}

/* ───────────────────────── التشغيل ───────────────────────── */

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    me = ctx.session.user.id;
    myEmail = ctx.session.user.email || null;

    document.querySelectorAll('#settingsTabs [data-tab]').forEach(b =>
        b.addEventListener('click', () => showTab(b.dataset.tab)));
    window.addEventListener('hashchange', () => showTab(tabFromHash()));
    showTab(tabFromHash());

    const run = () => Promise.allSettled([
        registration(), profile(), security(ctx.status), switches(), waitlist(),
        platform(), bot(), ads(), branding(), hours(), distribution(),
        retention(), sla(), telegram(), rules(), roles(), webhooks(), advanced()
    ]);
    $('settingsRefresh').addEventListener('click', run);
    run();
})();
