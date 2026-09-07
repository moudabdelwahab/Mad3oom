/**
 * اختبارات وحدات البوابة الجديدة، بلا متصفح ولا قاعدة بيانات:
 *   • service-status-model  — حالة النظام من منظور العميل ومفتاح نوبة العطل
 *   • help-article-model    — عرض المقال الآمن، والفهرس، وربط البحث بالأعطال
 *
 * أهم اختبار هنا هو تطابق episodeKeyFor مع ما يحسبه trigger في القاعدة:
 * أي انحراف بينهما يخلي الواجهة تعرض زر "إبلاغ" لعطل القاعدة شايفاه مُبلَّغًا
 * عنه بالفعل، فالعميل يضغط ويترفض.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SERVICE_STATUS, statusInfo, isImpaired, isCustomerService,
    incidentForService, episodeKeyFor, orderForCustomer,
    impairedForCustomer, entitlementsFrom
} from '../assets/js/customer/service-status-model.js';

import {
    parseArticleBody, renderArticleHtml, tableOfContents,
    incidentMatchingSearch, recommendedFor, openTicketMatching, escapeHtml
} from '../assets/js/customer/help-article-model.js';

/* ======================= حالة الخدمة ======================= */

test('الحالات الخمس كلها معرّفة بتسمية يفهمها العميل', () => {
    for (const key of ['operational', 'degraded', 'partial_outage', 'down', 'maintenance']) {
        assert.ok(SERVICE_STATUS[key], `الحالة ${key} غير معرّفة`);
        assert.ok(SERVICE_STATUS[key].label.length > 2);
    }
});

test('الحالة غير المعروفة تُعامَل كتشغيل طبيعي لا كعطل', () => {
    assert.equal(statusInfo({ status: 'something_new' }).key, 'operational');
    assert.equal(statusInfo({}).key, 'operational');
});

test('الصيانة المعلنة ليست عطلاً', () => {
    assert.equal(isImpaired({ status: 'maintenance' }), false);
    assert.equal(isImpaired({ status: 'operational' }), false);
    assert.equal(isImpaired({ status: 'degraded' }), true);
    assert.equal(isImpaired({ status: 'partial_outage' }), true);
    assert.equal(isImpaired({ status: 'down' }), true);
});

test('البنية التحتية تخص الجميع، وخدمة الاشتراك تخص من يملكها', () => {
    const core = { service_key: 'core' };
    const wa = { service_key: 'whatsapp' };

    assert.equal(isCustomerService(core, {}), true, 'البنية التحتية استُبعدت');
    assert.equal(isCustomerService(wa, {}), false, 'خدمة غير مملوكة اعتُبرت تخص العميل');
    assert.equal(isCustomerService(wa, { whatsapp: true }), true);

    // خدمة بلا مفتاح: نفترض إنها عامة بدل ما نخفيها عن الجميع
    assert.equal(isCustomerService({ service_key: null }, {}), true);
});

test('ربط الحادثة بالخدمة يقبل المعرّف والمفتاح والاسم', () => {
    const service = { id: 'svc-1', service_key: 'notifications', name: 'خدمة الإشعارات' };

    assert.ok(incidentForService(service, [{ id: 'i1', affected_services: ['svc-1'] }]));
    assert.ok(incidentForService(service, [{ id: 'i2', affected_services: ['notifications'] }]));
    assert.ok(incidentForService(service, [{ id: 'i3', affected_services: ['خدمة الإشعارات'] }]));
    assert.equal(incidentForService(service, [{ id: 'i4', affected_services: ['other'] }]), null);
    assert.equal(incidentForService(service, []), null);
});

test('مفتاح النوبة يطابق ما تحسبه القاعدة بالضبط', () => {
    const service = { id: 'svc-1', status_changed_at: '2026-09-05T08:00:00.000Z' };

    // مع حادثة: 'incident:' || id  — نفس صياغة set_service_report_episode
    assert.equal(episodeKeyFor(service, { id: 'inc-9' }), 'incident:inc-9');

    // بدونها: 'service:' || id || ':' || extract(epoch)::bigint
    const epoch = Math.floor(Date.parse('2026-09-05T08:00:00.000Z') / 1000);
    assert.equal(episodeKeyFor(service, null), `service:svc-1:${epoch}`);
});

test('نوبة جديدة بعد تعافي الخدمة تعطي مفتاحاً جديداً', () => {
    const before = { id: 'svc-1', status_changed_at: '2026-09-05T08:00:00Z' };
    const after = { id: 'svc-1', status_changed_at: '2026-09-06T10:00:00Z' };
    assert.notEqual(episodeKeyFor(before, null), episodeKeyFor(after, null));
});

test('الترتيب يقدّم الأسوأ، ثم خدمات العميل عند تساوي الشدّة', () => {
    const services = [
        { id: 'a', name: 'API', service_key: 'core', status: 'operational' },
        { id: 'b', name: 'واتساب', service_key: 'whatsapp', status: 'down' },
        { id: 'c', name: 'التخزين', service_key: 'storage', status: 'degraded' }
    ];
    const ordered = orderForCustomer(services, { whatsapp: true });
    assert.deepEqual(ordered.map(s => s.id), ['b', 'c', 'a']);
});

test('خدمة اشتراك لا يملكها العميل لا تُعرض له', () => {
    const services = [
        { id: 'a', name: 'API', service_key: 'core', status: 'operational' },
        { id: 'b', name: 'واتساب', service_key: 'whatsapp', status: 'down' }
    ];
    assert.deepEqual(orderForCustomer(services, {}).map(s => s.id), ['a']);
});

test('الأعطال التي تخص العميل تحمل وقت البداية وآخر تحديث', () => {
    const status = {
        services: [
            { id: 'b', name: 'واتساب', service_key: 'whatsapp', status: 'down',
              status_changed_at: '2026-09-05T08:00:00Z', last_checked: '2026-09-05T09:00:00Z' },
            { id: 'x', name: 'المحرك', service_key: 'sie', status: 'down',
              status_changed_at: '2026-09-05T08:00:00Z' }
        ],
        incidents: [{ id: 'inc-1', affected_services: ['b'], created_at: '2026-09-05T07:30:00Z', updated_at: '2026-09-05T09:30:00Z' }]
    };

    const mine = impairedForCustomer(status, { whatsapp: true, sie: false });
    assert.equal(mine.length, 1, 'ظهر عطل في خدمة لا يملكها العميل');
    assert.equal(mine[0].service.id, 'b');
    assert.equal(mine[0].incident.id, 'inc-1');
    // وقت الحادثة المعلنة أدقّ من وقت تغيّر حالة الخدمة، فهو الأولى
    assert.equal(mine[0].startedAt, '2026-09-05T07:30:00Z');
    assert.equal(mine[0].lastUpdate, '2026-09-05T09:30:00Z');
    assert.equal(mine[0].episodeKey, 'incident:inc-1');
});

test('بدون حادثة معلنة، بداية المشكلة هي لحظة تغيّر حالة الخدمة', () => {
    const status = {
        services: [{ id: 'b', name: 'واتساب', service_key: 'whatsapp', status: 'degraded', status_changed_at: '2026-09-05T08:00:00Z' }],
        incidents: []
    };
    const mine = impairedForCustomer(status, { whatsapp: true });
    assert.equal(mine[0].startedAt, '2026-09-05T08:00:00Z');
    assert.equal(mine[0].incident, null);
});

test('ما يملكه العميل يُشتق من اللقطة نفسها', () => {
    const snapshot = {
        account: { ok: true, data: { whatsapp_enabled: true, aqar_enabled: false } },
        sie: { ok: true, data: { is_enabled: true } },
        waSub: { ok: false, data: null }
    };
    assert.deepEqual(entitlementsFrom(snapshot), { whatsapp: true, sie: true, aqar: false });
    assert.deepEqual(entitlementsFrom({}), { whatsapp: false, sie: false, aqar: false });
});

/* ======================= مقالات المساعدة ======================= */

test('المتن يُفكّ إلى عناوين وفقرات وقوائم', () => {
    const { blocks, headings } = parseArticleBody(
        '## الخطوة الأولى\nافتح القسم.\n\n- عنصر أول\n- عنصر ثانٍ\n\n## الخطوة الثانية\nتم.');

    assert.equal(headings.length, 2);
    assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph', 'list', 'heading', 'paragraph']);
    assert.deepEqual(blocks[2].items, ['عنصر أول', 'عنصر ثانٍ']);
});

test('متن المقال لا يخرج منه أي HTML خام', () => {
    const html = renderArticleHtml('<img src=x onerror="alert(1)"> نص');
    assert.ok(!html.includes('<img'), 'وسم خرج من المتن كما هو');
    assert.ok(html.includes('&lt;img'), 'الوسم لم يُهرَّب');

    const heading = renderArticleHtml('## <script>bad</script>');
    assert.ok(!heading.includes('<script>'), 'سكربت خرج داخل عنوان');
});

test('الفهرس للمقالات الطويلة فقط', () => {
    assert.equal(tableOfContents('نص بلا عناوين').length, 0);
    assert.equal(tableOfContents('## واحد\nنص').length, 0, 'عنوان واحد لا يستحق فهرساً');
    assert.equal(tableOfContents('## واحد\n## اثنان').length, 2);
});

test('معرّفات الفهرس فريدة حتى مع تكرار العنوان', () => {
    const items = tableOfContents('## نفس العنوان\n## نفس العنوان');
    assert.equal(items.length, 2);
    assert.notEqual(items[0].id, items[1].id);
});

test('البحث عن مشكلة خدمة معطّلة يطابق العطل المعلن', () => {
    const impaired = [{ service: { name: 'خدمة الإشعارات', service_key: 'notifications' } }];

    assert.ok(incidentMatchingSearch('الإشعارات لا تعمل', impaired));
    assert.ok(incidentMatchingSearch('مشكلة في الاشعارات', impaired), 'التطبيع العربي لم يعمل');
    assert.equal(incidentMatchingSearch('كلمة المرور', impaired), null);
    assert.equal(incidentMatchingSearch('', impaired), null);
    assert.equal(incidentMatchingSearch('الإشعارات', []), null);
});

test('كلمات الوقف لا تُنتج مطابقات كاذبة', () => {
    const impaired = [{ service: { name: 'خدمة الإشعارات', service_key: 'notifications' } }];
    assert.equal(incidentMatchingSearch('في من على', impaired), null);
});

test('المقترح لك يعتمد على خدمات العميل لا على تخمين', () => {
    const articles = [
        { id: '1', title: 'شحن رصيد الواتساب', category: 'واتساب', excerpt: '' },
        { id: '2', title: 'تفعيل التحقق بخطوتين', category: 'الأمان', excerpt: '' },
        { id: '3', title: 'حصة المحرك الذكي', category: 'SIE', excerpt: '' }
    ];

    assert.deepEqual(recommendedFor(articles, { whatsapp: true }).map(a => a.id), ['1']);
    assert.deepEqual(recommendedFor(articles, { sie: true }).map(a => a.id), ['3']);
    assert.deepEqual(recommendedFor(articles, {}), [], 'اقتُرح محتوى بلا سبب');
});

test('التذكرة المفتوحة المشابهة تُقترح، والمغلقة لا', () => {
    const tickets = [
        { id: 't1', title: 'مشكلة في الإشعارات', status: 'open' },
        { id: 't2', title: 'مشكلة في الفواتير', status: 'closed' }
    ];
    const closed = t => t.status === 'closed';

    assert.equal(openTicketMatching('الإشعارات', tickets, closed)?.id, 't1');
    assert.equal(openTicketMatching('الفواتير', tickets, closed), null, 'اقتُرحت تذكرة مغلقة');
    assert.equal(openTicketMatching('موضوع آخر تماماً', tickets, closed), null);
});

test('escapeHtml يغطي كل المحارف الخطرة', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});
