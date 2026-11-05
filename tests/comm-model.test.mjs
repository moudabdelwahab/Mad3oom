/**
 * نموذج محرّك التواصل (assets/js/comm/comm-model.js) — دوال خالصة.
 * العزل نفسه في القاعدة (tests/sql/communication-engine.test.sql). هنا: أي نطاق يُعرض أين،
 * والتحقق قبل الإرسال، ورسائل الأخطاء، والنصوص بالعربية والإنجليزية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCOPES, SURFACE_SCOPES, CATEGORIES, scopesForSurface, totalUnread, filtersFor, scopeLabel, categoryLabel,
    validateStart, validateReply, checkFile, formatSize, errorMessage, ticketDescription, ticketCategoryFor,
    scopeFromUrl, strings, timeLabel
} from '../assets/js/comm/comm-model.js';

const OVERVIEW = {
    scopes: {
        customer_company: { side: 'responder', can_start: false, open: 2, unread: 1 },
        company_platform: { side: 'requester', can_start: true, open: 1, unread: 3 },
        admin_owner: { side: 'requester', can_start: true, open: 0, unread: 0 }
    },
    attachments: true
};

test('كل لوحة ترى نطاقاتها وحدها، حتى لو أعطى الخادم أكثر', () => {
    assert.deepEqual(scopesForSurface(OVERVIEW, 'portal').map(e => e.scope), ['customer_company']);
    assert.deepEqual(scopesForSurface(OVERVIEW, 'company').map(e => e.scope), ['company_platform', 'customer_company']);
    assert.deepEqual(scopesForSurface(OVERVIEW, 'admin').map(e => e.scope), ['company_platform', 'admin_owner']);
    assert.deepEqual(scopesForSurface(OVERVIEW, 'owner').map(e => e.scope), ['admin_owner', 'company_platform']);
    // التواصل الداخلي لا يظهر في لوحة الشركة ولا في البوابة بأي حال
    for (const s of ['portal', 'company']) assert.ok(!SURFACE_SCOPES[s].includes('admin_owner'), s);
    // ولا محادثات الشركة مع عملائها في لوحة الإدارة أو المالك
    for (const s of ['admin', 'owner']) assert.ok(!SURFACE_SCOPES[s].includes('customer_company'), s);
});

test('لا جانب ⇒ لا نطاق؛ لوحة غير معروفة أو نظرة فارغة ⇒ لا شيء', () => {
    assert.deepEqual(scopesForSurface({ scopes: { company_platform: { side: null } } }, 'company'), []);
    assert.deepEqual(scopesForSurface({ scopes: { company_platform: { side: 'admin' } } }, 'company'), []);
    assert.deepEqual(scopesForSurface(null, 'company'), []);
    assert.deepEqual(scopesForSurface(OVERVIEW, 'unknown'), []);
});

test('غير المقروء والفلاتر', () => {
    assert.equal(totalUnread(scopesForSurface(OVERVIEW, 'company')), 4);
    assert.deepEqual(filtersFor('company_platform', 'responder'), ['open', 'mine', 'unassigned', 'closed', 'all']);
    assert.deepEqual(filtersFor('admin_owner', 'responder'), ['open', 'closed', 'all']);
    assert.deepEqual(filtersFor('company_platform', 'requester'), ['open', 'closed', 'all']);
});

test('الأسماء بحسب الجانب واللغة', () => {
    assert.equal(scopeLabel('company_platform', 'requester').title, 'دعم مدعوم');
    assert.equal(scopeLabel('company_platform', 'responder').title, 'مراسلات الشركات');
    assert.equal(scopeLabel('admin_owner', 'requester', 'en').title, 'Message the owner');
    assert.equal(categoryLabel('approval'), 'طلب موافقة');
    assert.equal(categoryLabel('incident', 'en'), 'Incident or risk');
    for (const lang of ['ar', 'en']) {
        const t = strings(lang);
        for (const scope of SCOPES) for (const side of ['requester', 'responder']) assert.ok(t.scopes[scope][side].title, `${lang} ${scope} ${side}`);
        for (const cats of Object.values(CATEGORIES)) for (const c of cats) assert.ok(t.categories[c], `${lang} ${c}`);
    }
});

test('التحقق من محادثة جديدة', () => {
    let r = validateStart({ scope: 'company_platform', subject: 'ab', body: '', category: 'decision' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.subject && r.errors.body && r.errors.category, 'تصنيف داخلي مرفوض في نطاق الشركة');
    r = validateStart({ scope: 'company_platform', subject: '  مشكلة في الربط  ', body: 'نص', category: 'technical', priority: 'urgent' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.values, { subject: 'مشكلة في الربط', body: 'نص', category: 'technical', priority: 'urgent' });
    r = validateStart({ scope: 'customer_company', subject: 'طلبي', body: 'نص', category: 'technical', priority: 'bogus' });
    assert.equal(r.ok, true);
    assert.equal(r.values.category, null, 'لا تصنيف في customer_company');
    assert.equal(r.values.priority, 'normal');
    assert.match(validateStart({ scope: 'admin_owner' }, 'en').errors.subject, /3–200/);
});

test('الرد: نص أو مرفقات، وحد المرفقات', () => {
    assert.equal(validateReply({ body: '  ' }).ok, false);
    assert.equal(validateReply({ body: '', files: [{}] }).ok, true);
    assert.equal(validateReply({ body: 'x', files: new Array(6).fill({}) }).ok, false);
    assert.equal(validateReply({ body: 'x'.repeat(5001) }).ok, false);
});

test('الملفات: النوع والحجم', () => {
    assert.equal(checkFile({ type: 'application/pdf', size: 100 }).ok, true);
    assert.equal(checkFile({ type: 'image/png; charset=binary', size: 100 }).ok, true);
    assert.equal(checkFile({ type: 'application/x-msdownload', size: 100 }).ok, false);
    assert.equal(checkFile({ type: 'image/png', size: 11 * 1024 * 1024 }).ok, false);
    assert.equal(checkFile({ type: 'image/png', size: 0 }).ok, false);
    assert.equal(formatSize(500), '500 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});

test('رسائل الأخطاء بحسب الرمز', () => {
    assert.equal(errorMessage({ code: '0A000' }), 'هذه الميزة غير مفعّلة بعد.');
    assert.equal(errorMessage({ code: 'P0002', message: 'المحادثة غير موجودة' }, 'en'), strings('en').errors.notFound);
    assert.equal(errorMessage({ code: '54000' }), strings('ar').errors.rateLimit);
    assert.equal(errorMessage({ code: '22023', message: 'نوع الملف غير مسموح' }), 'نوع الملف غير مسموح');
    // رسالة SQL إنجليزية خام لا تصل المستخدم العربي
    assert.equal(errorMessage({ code: '42501', message: 'permission denied for table comm_threads' }), strings('ar').errors.forbidden);
    assert.equal(errorMessage({ code: 'XX000', message: 'boom' }), strings('ar').errors.generic);
    assert.equal(errorMessage(null), strings('ar').errors.generic);
});

test('وصف التذكرة المحوّلة: بلا ملاحظات داخلية، وبحد أقصى', () => {
    const th = {
        scope: 'company_platform', subject: 'الواتساب لا يرسل', counterpart_name: null,
        messages: [
            { mine: true, side: 'requester', body: 'متوقف منذ الصباح' },
            { mine: false, side: 'responder', body: 'نراجع الآن', is_internal: false },
            { mine: false, side: 'responder', body: 'سر داخلي', is_internal: true }
        ]
    };
    const d = ticketDescription(th);
    assert.match(d, /محوّلة من محادثة: الواتساب لا يرسل/);
    assert.match(d, /أنت: متوقف منذ الصباح/);
    assert.match(d, /إدارة مدعوم: نراجع الآن/);
    assert.doesNotMatch(d, /سر داخلي/);
    assert.ok(ticketDescription({ subject: 's', messages: [{ mine: true, body: 'x'.repeat(9000) }] }).length <= 4900);
    assert.equal(ticketCategoryFor('billing'), 'subscription');
    assert.equal(ticketCategoryFor('account'), 'login');
    assert.equal(ticketCategoryFor(null), 'other');
});

test('رابط الإشعار ?comm= يقبل النطاقات المعروفة وحدها', () => {
    assert.equal(scopeFromUrl('?comm=admin_owner'), 'admin_owner');
    assert.equal(scopeFromUrl('?x=1&comm=company_platform'), 'company_platform');
    assert.equal(scopeFromUrl('?comm=<script>'), null);
    assert.equal(scopeFromUrl(''), null);
});

test('الوقت النسبي', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    assert.equal(timeLabel('2026-11-05T11:59:30Z', 'ar', now), 'الآن');
    assert.equal(timeLabel('2026-11-05T11:50:00Z', 'en', now), '10m ago');
    assert.equal(timeLabel('2026-11-05T09:00:00Z', 'ar', now), 'منذ 3 س');
    assert.equal(timeLabel('bad', 'ar', now), '');
});
