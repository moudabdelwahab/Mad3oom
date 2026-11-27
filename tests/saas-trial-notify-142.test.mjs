/**
 * إشعار طلب التجربة في لوحة المالك (142) — فحوص ساكنة + توجيه الجرس.
 *
 *   ① الفجوة موثّقة: 137 بلا أي إشعار عند إرسال الطلب (لا إدراج في
 *      notifications ولا نداء إشعار في request_saas_trial)، و 142 هو
 *      وحده من يسدّها — وبلا تعديل على ملف 137.
 *   ② 142 على القناة القائمة نفسها: notifications لمالك المنصة، بلا
 *      جدول جديد وبلا قناة جديدة وبلا صفحة جديدة.
 *   ③ الطلب ينادي الإشعار بعد الإدراج، ودالة الإشعار داخلية.
 *   ④ نقرة الإشعار في جرس المالك تفتح صفحة الموافقة owner/trials.html
 *      (ownerDestinationFor)، والصفحة نفسها تعرض الطلبات المعلّقة أولًا.
 * المنطق الخادمي (SQL) موثَّق في tests/sql/saas-trial-notify-142.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION_142 = fs.readFileSync(path.join(ROOT, 'migrations/142_trial_request_notification.sql'), 'utf8');
const MIGRATION_137 = fs.readFileSync(path.join(ROOT, 'migrations/137_saas_trial_3_days.sql'), 'utf8');
const ROLLBACK_142 = fs.readFileSync(path.join(ROOT, 'migrations/_rollback/142_trial_request_notification.down.sql'), 'utf8');
const OWNER_PAGE = fs.readFileSync(path.join(ROOT, 'owner/trials.html'), 'utf8');
const OWNER_JS = fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/trials.js'), 'utf8');
const NOTIF_SERVICE = fs.readFileSync(path.join(ROOT, 'notifications-service.js'), 'utf8');

/** جسم الترحيل بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');
}
const CODE_142 = codeOnly(MIGRATION_142);
const CODE_137 = codeOnly(MIGRATION_137);
const CODE_BEFORE_SELF_CHECK_142 = CODE_142.slice(0, CODE_142.indexOf("raise notice '142:"));

/* ── ① الفجوة في 137 موثّقة، و142 وحده يسدّها ─────────────────────────── */

test('① 137 بلا إشعار أصلًا: لا إدراج في notifications ولا نداء إشعار في الطلب', () => {
    assert.doesNotMatch(CODE_137, /insert into public\.notifications/i);
    assert.doesNotMatch(CODE_137, /_trial_request_notify_owners/);
    assert.doesNotMatch(CODE_137, /notify.*trial|trial.*notif/i);
    // والواجهة نفسها بلا منطق إشعار عن الطلب الجديد: لا سكربت إشعارات
    // ولا نداء fetch ولا قسم إشعارات — رابط portal-notifications.css
    // وحده ورقة أنماط مشتركة للقشرة، لا ميزة إشعار.
    assert.doesNotMatch(OWNER_PAGE, /notifications\.js|owner-notifications|fetchNotifications|createOwnerNotifications/);
    assert.doesNotMatch(OWNER_JS, /notif/i);
});

test('① 142 لا يعدّل 137: ملف 137 بلا أي أثر لـ 142', () => {
    assert.doesNotMatch(CODE_137, /142/);
});

/* ── ② القناة القائمة نفسها، بلا جديد ─────────────────────────────────── */

test('② الإشعار في جدول notifications القائم، لمالك المنصة، بالرابط والتصنيف والمرجع', () => {
    assert.match(CODE_142, /create or replace function public\._trial_request_notify_owners\(p_request uuid\)/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /insert into public\.notifications \(user_id, title, message, type, link, category, reference_id\)/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /platform_authority a on a\.level = 'owner'/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /profiles p on p\.id = a\.user_id and p\.role = 'platform_owner'/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /'طلب تجربة مجانية جديد'/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /'\/owner\/trials\.html'/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /'subscription'/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /company_name/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /coalesce\(sp\.name_ar, sp\.name, r\.plan_key\)/);
    assert.match(CODE_BEFORE_SELF_CHECK_142, /requested_at at time zone 'Africa\/Cairo'/);
});

test('② بلا قناة جديدة: لا جدول ولا صفحة ولا ملف JS في 142', () => {
    assert.doesNotMatch(CODE_142, /create table/i);
    assert.doesNotMatch(CODE_142, /sandbox/i);
    assert.equal(fs.existsSync(path.join(ROOT, 'owner/trial-notifications.html')), false);
});

/* ── ③ الطلب ينادي الإشعار، والدالة داخلية ─────────────────────────────── */

test('③ request_saas_trial نسخة 137 + نداء الإشعار بعد الإدراج مباشرةً، وبلا اشتراك', () => {
    // جسم الدالة وحده: من create حتى end $$; الأولى بعده — فحصوص §4
    // الذاتية تذكر whatsapp_subscriptions كسلسلة نصية في شروطها، فلا
    // يصح أن تدخل في فحص «الدالة لا تنشئ اشتراكًا».
    const fnStart = CODE_142.indexOf('create or replace function public.request_saas_trial(p_plan_key text)');
    const fn = CODE_142.slice(fnStart, CODE_142.indexOf('end $$;', fnStart));
    assert.match(fn, /insert into public\.saas_trial_requests \(company_id, plan_key, requested_by\)/);
    assert.match(fn, /perform public\._trial_request_notify_owners\(v_request_id\);/);
    assert.match(fn, /return public\._trial_request_json\(v_request_id\);/);
    assert.ok(fn.indexOf('_trial_request_notify_owners') > fn.indexOf('returning id into v_request_id'),
        'النداء بعد الإدراج لا قبله');
    assert.doesNotMatch(fn, /insert into public\.whatsapp_subscriptions/);
    assert.match(fn, /current_company_id/);
    assert.match(fn, /user_id <> auth\.uid\(\)/);
});

test('③ التراجع يحذف دالة الإشعار ويعيد الطلب إلى نسخة 137 بلا نداء', () => {
    assert.match(ROLLBACK_142, /drop function if exists public\._trial_request_notify_owners\(uuid\);/);
    assert.match(ROLLBACK_142, /create or replace function public\.request_saas_trial\(p_plan_key text\)/);
    assert.doesNotMatch(codeOnly(ROLLBACK_142), /_trial_request_notify_owners\(v_request_id\)/);
    assert.match(ROLLBACK_142, /comment on function public\.request_saas_trial\(text\) is\n\s*'137:/);
});

/* ── ④ الجرس يفتح صفحة الموافقة ───────────────────────────────────────── */

const ownerNotifs = await import('data:text/javascript,' + encodeURIComponent(
    fs.readFileSync(new URL('../assets/js/owner/owner-notifications.js', import.meta.url), 'utf8')
      .replace("import { safeNotificationHref } from '/assets/js/admin/notification-safety.js';",
               fs.readFileSync(new URL('../assets/js/admin/notification-safety.js', import.meta.url), 'utf8'))));

test('④ نقرة إشعار التجربة في جرس المالك تفتح صفحة الموافقة owner/trials.html', () => {
    const origin = 'https://mad3oom.com';
    assert.deepEqual(
        ownerNotifs.ownerDestinationFor({ link: '/owner/trials.html' }, origin, ownerNotifs.OWNER_SECTIONS),
        { kind: 'href', href: '/owner/trials.html' });
    // والرابط نفسه آمن على أصل المنصة (لا مخطط تنفيذ ولا نطاق آخر)
    assert.equal(ownerNotifs.ownerDestinationFor({ link: 'javascript:alert(1)' }, origin, ownerNotifs.OWNER_SECTIONS).kind, 'none');
});

test('④ الجرس يقرأ إشعارات المالك نفسه (user_id)، وصفحة الموافقة تعرض المعلّقة أولًا', () => {
    assert.match(NOTIF_SERVICE, /\.from\('notifications'\)/);
    assert.match(NOTIF_SERVICE, /\.eq\('user_id', user\.id\)/);
    assert.match(OWNER_JS, /owner_list_saas_trial_requests/);
    assert.match(OWNER_PAGE, /طلبات التجربة/);
});
