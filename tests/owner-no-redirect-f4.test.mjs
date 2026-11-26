/**
 * F4 — إضافات التذاكر، وبورت إعدادات الإدارة، وروابط الإشعارات العميقة (بلا متصفح).
 *
 * خالصة + فحوصات نصية ثابتة على الملفات المبنية: تعيين روابط الإشعارات، وغياب أي رابط
 * تنقّل إلى /admin/* في الملفات التي لمستها F4، ووجود أقسام إعدادات المالك الثمانية عشر،
 * واستدعاء إضافات التذكرة لدوال tickets-service.js نفسها لا نسخًا منها.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// owner-notifications.js يستورد safeNotificationHref بمسار مطلق للمتصفح؛ نضمّنه كما
// في owner-governance.render.test.mjs.
const ownerNotifs = await import('data:text/javascript,' + encodeURIComponent(
    fs.readFileSync(new URL('../assets/js/owner/owner-notifications.js', import.meta.url), 'utf8')
        .replace("import { safeNotificationHref } from '/assets/js/admin/notification-safety.js';",
            fs.readFileSync(new URL('../assets/js/admin/notification-safety.js', import.meta.url), 'utf8'))));

const { ownerDestinationFor, storeOwnerNotice, takeOwnerNotice, OWNER_NOTICE_KEY } = ownerNotifs;
const SECTIONS = ['overview', 'authority', 'governance', 'audit', 'users', 'pi', 'notifications'];
const O = 'https://mad3oom.com';

/* ── C: تعيين روابط الإشعارات ─────────────────────────────────────────── */

test('C: روابط /admin/* المعروفة تُعاد إلى مقابلها الأصيل في لوحة المالك', () => {
    assert.deepEqual(ownerDestinationFor({ link: '/admin/tickets.html' }, O, SECTIONS),
        { kind: 'href', href: '/owner/tickets.html' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/tickets.html?ticket_id=11111111-1111-4111-8111-111111111111' }, O, SECTIONS),
        { kind: 'href', href: '/owner/tickets.html?ticket=11111111-1111-4111-8111-111111111111' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/settings.html' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/account-requests.html' }, O, SECTIONS),
        { kind: 'href', href: '/owner/account-requests.html' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/settings.html#ticket-rules' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html#rules' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/settings.html#working-hours' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html#hours' });
    assert.deepEqual(ownerDestinationFor({ link: '/admin/settings.html#data-retention' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html#retention' });
    // قسم إدارة بلا مقابل في صفحة المالك: يبقى الرابط للصفحة بلا تبويب.
    assert.deepEqual(ownerDestinationFor({ link: '/admin/settings.html#device-management' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html' });
});

test('C: روابط /admin/* بلا مقابل تعود لقسم الإشعارات مع تنبيه، لا تُتبَع', () => {
    for (const [link, notice] of [
        ['/admin/continuity.html?record=22222222-2222-4222-8222-222222222222',
            'تذكير استمرارية بلا صفحة أصيلة في لوحة المالك بعد — بقيت في الإشعارات.'],
        ['/admin/suggestions.html', 'صفحة الاقتراحات ليس لها مقابل أصيل في لوحة المالك بعد — بقيت في الإشعارات.'],
        ['/admin/anything-else.html', 'هذه الصفحة من لوحة الإدارة وليس لها مقابل في لوحة المالك بعد.']
    ]) {
        assert.deepEqual(ownerDestinationFor({ link }, O, SECTIONS),
            { kind: 'section', section: 'notifications', notice }, link);
    }
});

test('C: روابط المالك نفسها وروابط الصفحات الأصيلة الأخرى لا تتغير', () => {
    assert.deepEqual(ownerDestinationFor({ link: '/owner-dashboard.html#governance' }, O, SECTIONS),
        { kind: 'section', section: 'governance' });
    assert.deepEqual(ownerDestinationFor({ link: '/owner/tickets.html?ticket=abc' }, O, SECTIONS),
        { kind: 'href', href: '/owner/tickets.html?ticket=abc' });
    assert.deepEqual(ownerDestinationFor({ link: '/owner/settings.html#rules' }, O, SECTIONS),
        { kind: 'href', href: '/owner/settings.html#rules' });
    assert.deepEqual(ownerDestinationFor({ link: 'https://evil.test/x' }, O, SECTIONS), { kind: 'none' });
});

test('C: التنبيه المحفوظ يُقرأ مرة واحدة ثم يُمسح', () => {
    assert.equal(OWNER_NOTICE_KEY, 'mad3oom-owner-notice');
    // بلا sessionStorage (Node): لا يرمي، ويعيد null.
    assert.equal(takeOwnerNotice(), null);
    const store = new Map();
    globalThis.sessionStorage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null,
        removeItem: (k) => store.delete(k) };
    try {
        storeOwnerNotice('تنبيه تجريبي');
        assert.equal(store.get(OWNER_NOTICE_KEY), 'تنبيه تجريبي');
        assert.equal(takeOwnerNotice(), 'تنبيه تجريبي');
        assert.equal(store.has(OWNER_NOTICE_KEY), false);
        assert.equal(takeOwnerNotice(), null);
    } finally {
        delete globalThis.sessionStorage;
    }
});

/* ── لا روابط تنقّل إلى /admin/* في ملفات F4 ───────────────────────────── */

test('F4: لا رابط href إلى /admin/* في صفحات المالك التي لمستها المجموعة', () => {
    for (const rel of ['owner/tickets.html', 'owner/settings.html',
        'assets/js/owner/pages/tickets.js', 'assets/js/owner/pages/settings.js']) {
        const src = read(rel);
        assert.doesNotMatch(src, /href=["']\/admin\//, rel);
        assert.doesNotMatch(src, /location\.href\s*=\s*['"`][^'"`]*\/admin\//, rel);
    }
    // تذكرة المالك بلا أي إشارة تنقّل لمساحة عمل الدعم، وصفحتها لا تذكرها أصلًا.
    assert.doesNotMatch(read('owner/tickets.html'), /\/admin\/tickets\.html/, 'owner/tickets.html');
    assert.doesNotMatch(read('assets/js/owner/pages/tickets.js'), /\/admin\/tickets\.html/, 'tickets.js');
    // الجدول القديم ADMIN_ONLY_SETTINGS (يزعم role='admin') حُذف من إعدادات المالك —
    // التعريف لا التعليق التوثيقي في رأس الملف.
    assert.doesNotMatch(read('assets/js/owner/pages/settings.js'), /const ADMIN_ONLY_SETTINGS/, 'settings.js');
    assert.doesNotMatch(read('owner/settings.html'), /\/admin\/settings\.html/, 'owner/settings.html');
});

/* ── B15: تبويبات إعدادات المالك ──────────────────────────────────────── */

test('B15: صفحة إعدادات المالك تحمل التبويبات الثمانية عشر وأقسامها', () => {
    const html = read('owner/settings.html');
    const js = read('assets/js/owner/pages/settings.js');
    const tabs = ['registration', 'profile', 'security', 'switches', 'platform', 'bot', 'ads',
        'branding', 'hours', 'distribution', 'retention', 'sla', 'telegram', 'rules', 'roles',
        'webhooks', 'advanced', 'users'];
    for (const tab of tabs) {
        assert.match(html, new RegExp(`data-tab="${tab}"`), `زر التبويب ${tab}`);
        assert.match(html, new RegExp(`id="tab-${tab}"`), `قسم التبويب ${tab}`);
        assert.match(js, new RegExp(`'${tab}'`), `قائمة التبويبات في JS: ${tab}`);
    }
    // كل قسم تشغيلي له محمّل: مفاتيح المنصة، البوت، الإعلانات، الهوية، الساعات، التوزيع،
    // الاحتفاظ، SLA، تيليجرام، القواعد، الأدوار، الويبهوكس، المحرر العام، الانتظار.
    for (const fn of ['platform()', 'bot()', 'ads()', 'branding()', 'hours()', 'distribution()',
        'retention()', 'sla()', 'telegram()', 'rules()', 'roles()', 'webhooks()', 'advanced()',
        'waitlist()', 'profile()']) {
        assert.match(js, new RegExp(fn.replace('()', '\\(\\)')), `محمّل ${fn}`);
    }
    assert.match(js, /run_data_retention_cleanup/, 'زر التشغيل الفوري ينادي RPC الاحتفاظ');
    assert.match(js, /send_test_telegram_alert/, 'زر اختبار تيليجرام ينادي RPC الاختبار');
    assert.match(js, /mountAccountSettings/, 'الملف الشخصي من الوحدة الموحّدة');
});

/* ── B13: إضافات التذكرة تستعمل tickets-service.js نفسه ──────────────── */

test('B13: نافذة التذكرة تحمل الوسوم والمرفقات والردود الجاهزة من الخدمة المشتركة', () => {
    const js = read('assets/js/owner/pages/tickets.js');
    for (const name of ['wireTicketTags', 'wireTicketAttachments', 'wireCannedChips', 'openCannedManager']) {
        assert.match(js, new RegExp(name), name);
    }
    assert.match(js, /import\('\/tickets-service\.js'\)/, 'استيراد الخدمة المشتركة');
    for (const fn of ['fetchTicketAttachments', 'uploadTicketAttachment', 'fetchTags', 'createTag',
        'deleteTag', 'fetchTicketTags', 'addTagToTicket', 'removeTagFromTicket', 'fetchCannedResponses',
        'createCannedResponse', 'updateCannedResponse', 'deleteCannedResponse']) {
        assert.match(js, new RegExp(`svc\\.${fn}`), `استدعاء ${fn} من الخدمة`);
    }
    // خارج النطاق عمدًا: لا تغيير جماعي ولا حذف جماعي ولا فلاتر محفوظة هنا.
    assert.doesNotMatch(js, /bulkUpdateTicketStatus|bulkUpdateTicketAssignee|fetchSavedFilters/, 'بلا جماعي');
    assert.match(read('owner/tickets.html'), /التغيير الجماعي/, 'ملاحظة القيود تذكر المؤجل');
});
