/**
 * اختبارات الوحدات الخالصة في بوابة العميل.
 *
 * الوحدات دي بتحدد سلوك أمني وسلوك منتج مهم (إيه اللي العميل يشوفه، وفين
 * بيروح الإشعار)، فبتتّختبر هنا بمعزل عن المتصفح — سريعة وبتشتغل في أي بيئة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    statusInfo, isClosed, needsCustomerReply, applyTicketView,
    countByView, canReopen, availableActions, TICKET_VIEWS
} = await import('../assets/js/customer/ticket-view-model.js');

const { toTimeline, isCustomerVisible } = await import('../assets/js/customer/activity-model.js');
const { assessAccountHealth } = await import('../assets/js/customer/account-health.js');

const ME = 'user-1';
const STAFF = 'staff-1';

function ticket(over = {}) {
    return {
        id: 't', ticket_number: 1, title: 'مشكلة', description: 'وصف',
        status: 'open', priority: 'medium', created_at: '2026-01-01T00:00:00Z',
        last_updated_by: null, ...over
    };
}

/* ── نموذج التذاكر ──────────────────────────────────────────────────────── */

test('كل الحالات الخمس المخزّنة في قاعدة البيانات لها تسمية للعميل', () => {
    for (const status of ['open', 'in-progress', 'resolved', 'confirmed', 'rejected']) {
        const info = statusInfo(status);
        assert.ok(info.label && info.label !== 'غير محددة', `الحالة ${status} بلا تسمية`);
        assert.ok(info.pill, `الحالة ${status} بلا شكل`);
    }
});

test('الحالة غير المعروفة لا تُعرض كنص خام', () => {
    assert.equal(statusInfo('some_internal_state').label, 'غير محددة');
});

test('confirmed و rejected تُحسبان مغلقتين (كانتا غير مرئيتين في العدّادات القديمة)', () => {
    assert.equal(isClosed(ticket({ status: 'confirmed' })), true);
    assert.equal(isClosed(ticket({ status: 'rejected' })), true);
    assert.equal(isClosed(ticket({ status: 'open' })), false);
});

test('"بانتظار ردّك" تعتمد على آخر مَن حدّث التذكرة', () => {
    assert.equal(needsCustomerReply(ticket({ last_updated_by: STAFF }), ME), true);
    assert.equal(needsCustomerReply(ticket({ last_updated_by: ME }), ME), false);
    assert.equal(needsCustomerReply(ticket({ last_updated_by: null }), ME), false);
    // تذكرة مغلقة لا تنتظر ردًا مهما كان آخر مُحدِّث
    assert.equal(needsCustomerReply(ticket({ status: 'resolved', last_updated_by: STAFF }), ME), false);
});

test('عدد كل مجموعة يساوي بالضبط عدد ما تعرضه', () => {
    const tickets = [
        ticket({ id: 'a', status: 'open', last_updated_by: STAFF }),
        ticket({ id: 'b', status: 'in-progress', last_updated_by: ME }),
        ticket({ id: 'c', status: 'resolved' }),
        ticket({ id: 'd', status: 'rejected' }),
        ticket({ id: 'e', status: 'confirmed' })
    ];
    const counts = countByView(tickets, ME);
    assert.equal(counts.all, 5);
    assert.equal(counts.open, 2);
    assert.equal(counts.awaiting, 1);
    assert.equal(counts.closed, 3);

    for (const view of TICKET_VIEWS) {
        const shown = applyTicketView(tickets, { view: view.key, userId: ME });
        assert.equal(shown.length, counts[view.key], `المجموعة ${view.key}: العدد لا يطابق المعروض`);
    }
});

test('البحث يشمل العنوان والوصف ورقم التذكرة', () => {
    const tickets = [
        ticket({ id: 'a', ticket_number: 101, title: 'مشكلة في الواتساب' }),
        ticket({ id: 'b', ticket_number: 202, title: 'استفسار', description: 'عن الفاتورة' })
    ];
    assert.equal(applyTicketView(tickets, { search: 'واتساب', userId: ME }).length, 1);
    assert.equal(applyTicketView(tickets, { search: '202', userId: ME })[0].id, 'b');
    assert.equal(applyTicketView(tickets, { search: 'الفاتورة', userId: ME })[0].id, 'b');
});

test('إعادة الفتح متاحة على المحلولة فقط — نفس حد الـtrigger في القاعدة', () => {
    assert.equal(canReopen(ticket({ status: 'resolved' })), true);
    assert.equal(canReopen(ticket({ status: 'confirmed' })), false);
    assert.equal(canReopen(ticket({ status: 'rejected' })), false);
    assert.equal(canReopen(ticket({ status: 'open' })), false);
});

test('الإجراءات المتاحة تتبع حالة التذكرة', () => {
    // القرار الجديد (الترحيل 034): الردّ فعل، وإعادة الفتح فعل آخر. الردّ
    // متاح على أي حالة **ولا يغيّرها**، وتغيير الحالة بزرّين صريحين.
    const open = availableActions(ticket({ status: 'open' }), { userId: ME });
    assert.equal(open.canReply, true);
    assert.equal(open.canReopen, false, 'المفتوحة لا تُعاد فتحها');
    assert.equal(open.canClose, true, 'المفتوحة تُغلق');
    assert.equal(open.canRate, false);

    const inProgress = availableActions(ticket({ status: 'in-progress' }), { userId: ME });
    assert.equal(inProgress.canClose, true);
    assert.equal(inProgress.canReopen, false);

    const resolved = availableActions(ticket({ status: 'resolved' }), { userId: ME });
    assert.equal(resolved.canReply, true, 'الردّ على المغلقة مسموح ولا يفتحها');
    assert.equal(resolved.canReopen, true, 'زرّ إعادة الفتح وحده يفتحها');
    assert.equal(resolved.canClose, false, 'المغلقة لا تُغلق مرة أخرى');
    assert.equal(resolved.canRate, true);

    // قرارات نهائية: يُسمح بالردّ عليها، ولا تُنقَض بضغطة — نفس حدّ الدالة
    // reopen_ticket_in_my_scope في القاعدة حرفيًا.
    for (const status of ['rejected', 'confirmed']) {
        const decided = availableActions(ticket({ status }), { userId: ME });
        assert.equal(decided.canReply, true, `الردّ على ${status} مسموح`);
        assert.equal(decided.canReopen, false, `${status} لا تُعاد فتحها`);
        assert.equal(decided.canClose, false, `${status} مغلقة أصلًا`);
    }
});

test('حدّ الواجهة لإعادة الفتح والإغلاق مطابق لحدّ القاعدة حرفيًا', async () => {
    // لو انفصل الاثنان لعرضت الواجهة إجراءً ترفضه القاعدة (أو أخفت مسموحًا).
    const fs = await import('node:fs/promises');
    const sql = await fs.readFile(
        new URL('../migrations/034_explicit_ticket_reopen_and_close.sql', import.meta.url), 'utf8');

    assert.match(sql, /v_status <> 'resolved'/,
        'دالة إعادة الفتح لم تعد تشترط resolved — راجع canReopen');
    assert.match(sql, /v_status not in \('open', 'in-progress'\)/,
        'دالة الإغلاق لم تعد تشترط open/in-progress — راجع canClose');
});

test('إطفاء التقييم من لوحة الإدارة يمنع إجراء التقييم', () => {
    const actions = availableActions(ticket({ status: 'resolved' }), { userId: ME, ratingAllowed: false });
    assert.equal(actions.canRate, false);
});

/* ── سجل النشاط: allow-list ─────────────────────────────────────────────── */

test('أحداث الإدارة لا تظهر للعميل مهما وصلت في صفوفه', () => {
    const adminActions = [
        'impersonate', 'update_settings', 'admin_updated_role', 'waitlist_review',
        'ticket_assignee_update', 'ticket_bulk_status_update', 'ticket_bulk_assignee_update',
        'canned_response_create', 'ticket_priority_update'
    ];
    for (const action of adminActions) {
        assert.equal(isCustomerVisible(action), false, `الحدث الإداري ${action} مرئي للعميل`);
    }
    const rows = adminActions.map((action, i) => ({ id: i, action, created_at: '2026-01-01T00:00:00Z' }));
    assert.equal(toTimeline(rows).length, 0);
});

test('أحداث العميل المعروفة تظهر بصياغة مفهومة، والمجهولة تُسقَط', () => {
    const rows = [
        { id: 1, action: 'login', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, action: 'ticket_create', created_at: '2026-01-01T00:00:00Z' },
        { id: 3, action: 'some_future_internal_action', created_at: '2026-01-01T00:00:00Z' }
    ];
    const items = toTimeline(rows);
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.label && !i.label.includes('_')), 'ظهر اسم حدث خام');
});

test('تفاصيل الحدث (details) لا تُمرَّر للعرض إطلاقاً', () => {
    const items = toTimeline([{
        id: 1, action: 'login', created_at: '2026-01-01T00:00:00Z',
        details: { internal_note: 'سر', admin_id: 'x' }, ip_address: '1.2.3.4'
    }]);
    assert.equal(items.length, 1);
    assert.equal('details' in items[0], false);
    assert.equal('ip_address' in items[0], false);
});

/* ── حالة الحساب ────────────────────────────────────────────────────────── */

function snapshot(over = {}) {
    return {
        account: { ok: true, data: { ban_status: 'active', phone: '0100', two_factor_enabled: true } },
        tickets: [],
        planSubs: { ok: true, data: [] },
        waSub: { ok: true, data: { hasActiveSubscription: false, isExpiringSoon: false } },
        wallet: { ok: true, data: null },
        sie: { ok: true, data: null },
        systemStatus: { ok: true, data: { services: [], incidents: [], degraded: [], allOperational: true } },
        ...over
    };
}

test('حساب سليم بلا مشاكل يعطي حالة "سليم" بدون تنبيهات مخترعة', () => {
    const health = assessAccountHealth(snapshot(), { userId: ME });
    assert.equal(health.status, 'healthy');
    assert.equal(health.items.length, 0);
    assert.match(health.headline, /بحالة جيدة/);
});

test('الحساب المقيّد يعطي حالة حرجة ويسبق كل شيء', () => {
    const health = assessAccountHealth(snapshot({
        account: { ok: true, data: { ban_status: 'banned', ban_reason: 'مخالفة', phone: '1', two_factor_enabled: true } }
    }), { userId: ME });
    assert.equal(health.status, 'critical');
    assert.match(health.items[0].title, /مقيّد/);
});

test('التذاكر التي تنتظر ردّ العميل تُحسب بندًا يحتاج إجراء', () => {
    const health = assessAccountHealth(snapshot({
        tickets: [ticket({ id: 'a', last_updated_by: STAFF }), ticket({ id: 'b', last_updated_by: STAFF })]
    }), { userId: ME });
    assert.equal(health.status, 'attention');
    assert.ok(health.items.some(i => /تنتظر ردّك/.test(i.title)));
    assert.match(health.headline, /بنود تحتاج انتباهك|بند يحتاج/);
});

test('رصيد منخفض وحصة شبه منتهية يظهران كبنود مستقلة', () => {
    const health = assessAccountHealth(snapshot({
        wallet: { ok: true, data: { isLow: true, balance: 5, currency: 'EGP' } },
        sie: { ok: true, data: { is_enabled: true, usedPercent: 95, used: 95, quota: 100, isExpired: false } }
    }), { userId: ME });
    assert.ok(health.items.some(i => /رصيد الواتساب منخفض/.test(i.title)));
    assert.ok(health.items.some(i => /حصة المحرك الذكي/.test(i.title)));
});

test('العطل المعلن يظهر كمعلومة لا كإجراء عاجل', () => {
    const health = assessAccountHealth(snapshot({
        systemStatus: { ok: true, data: { services: [{}], incidents: [{ title: 'عطل في الإشعارات' }], degraded: [], allOperational: false } }
    }), { userId: ME });
    const incident = health.items.find(i => /عُطل معلن/.test(i.title));
    assert.ok(incident);
    assert.equal(incident.severity, 'info');
    // معلومة فقط ⇒ الحساب يفضل "سليم"
    assert.equal(health.status, 'healthy');
});

test('كل بند فيه إجراء له وجهة صالحة', () => {
    const health = assessAccountHealth(snapshot({
        tickets: [ticket({ last_updated_by: STAFF })],
        wallet: { ok: true, data: { isLow: true, balance: 0, currency: 'EGP' } },
        account: { ok: true, data: { ban_status: 'active', phone: null, two_factor_enabled: false } }
    }), { userId: ME });
    const known = new Set(['overview', 'support', 'tickets', 'notifications', 'usage', 'activity', 'security', 'profile', 'rewards', 'badges']);
    for (const item of health.items) {
        if (!item.action) continue;
        assert.ok(item.action.label, 'إجراء بلا نص');
        if (item.action.section) {
            assert.ok(known.has(item.action.section), `وجهة غير معروفة: ${item.action.section}`);
        } else {
            assert.match(item.action.href, /^\//, 'الوجهة يجب أن تكون مسارًا داخليًا');
        }
    }
});

test('البنود مرتبة بالأهم أولاً', () => {
    const health = assessAccountHealth(snapshot({
        tickets: [ticket({ last_updated_by: STAFF })],
        account: { ok: true, data: { ban_status: 'banned', phone: null, two_factor_enabled: false } },
        systemStatus: { ok: true, data: { services: [{}], incidents: [{ title: 'عطل' }], degraded: [], allOperational: false } }
    }), { userId: ME });
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < health.items.length; i++) {
        assert.ok(rank[health.items[i - 1].severity] <= rank[health.items[i].severity], 'الترتيب غير صحيح');
    }
});
