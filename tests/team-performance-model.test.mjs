/**
 * اختبارات أداء الفريق (assets/js/admin/team-performance-model.js) — دوال خالصة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTeamPerformance, sortRows, formatHours, formatPercent, slaTone,
    periodStart, isOverdue, metSla, resolvedAt, dailyResolved, OPEN_STATUSES
} from '../assets/js/admin/team-performance-model.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const h = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString();
const SINCE = NOW - 7 * 86400000;

const agents = [
    { id: 'a1', full_name: 'يوسف ممدوح', email: 'y@x', role: 'support' },
    { id: 'a2', full_name: 'مريم حسن', email: 'm@x', role: 'support' },
    { id: 'a3', full_name: 'خالد إبراهيم', email: 'k@x', role: 'admin' }
];

const tickets = [
    // a1: two resolved in period (one inside SLA, one late), one open overdue
    { id: 't1', assigned_to: 'a1', status: 'resolved', created_at: h(50), first_response_at: h(49.5), resolved_at: h(46), sla_resolution_due_at: h(40) },
    { id: 't2', assigned_to: 'a1', status: 'resolved', created_at: h(30), first_response_at: h(29), resolved_at: h(20), sla_resolution_due_at: h(25) },
    { id: 't3', assigned_to: 'a1', status: 'in-progress', created_at: h(10), first_response_at: h(9.75), sla_resolution_due_at: h(1) },
    // a2: resolved long before the period (must not count), one open in time
    { id: 't4', assigned_to: 'a2', status: 'resolved', created_at: h(400), first_response_at: h(399), resolved_at: h(390) },
    { id: 't5', assigned_to: 'a2', status: 'open', created_at: h(2), first_response_at: null, sla_resolution_due_at: h(-5) },
    // confirmed counts as solved; legacy row without resolved_at falls back to last_updated_at
    { id: 't6', assigned_to: 'a3', status: 'confirmed', created_at: h(12), first_response_at: h(11), last_updated_at: h(8) },
    // unassigned open + a former staff member
    { id: 't7', assigned_to: null, status: 'open', created_at: h(3) },
    { id: 't8', assigned_to: 'gone', status: 'open', created_at: h(5) }
];
const replies = [
    { user_id: 'a1', is_internal: false, created_at: h(9) },
    { user_id: 'a1', is_internal: false, created_at: h(20) },
    { user_id: 'a1', is_internal: true, created_at: h(19) },
    { user_id: 'a1', is_internal: false, created_at: h(500) },      // outside period
    { user_id: 'customer-1', is_internal: false, created_at: h(9) }  // customers are not agents
];
const ratings = [
    { ticket_id: 't1', rating: 5, created_at: h(45) },
    { ticket_id: 't2', rating: 4, created_at: h(19) },
    { ticket_id: 't4', rating: 1, created_at: h(380) }               // outside period
];
const chatReplies = [{ sender_id: 'a2', created_at: h(1) }, { sender_id: 'a2', created_at: h(2) }, { sender_id: 'a1', created_at: h(900) }];

const perf = () => buildTeamPerformance({ agents, tickets, replies, ratings, chatReplies, since: SINCE, now: NOW });
const row = (id) => perf().rows.find(r => r.id === id);

test('الحالات المفتوحة هي قيم القاعدة الحقيقية (in-progress بشرطة)', () => {
    assert.deepEqual(OPEN_STATUSES, ['open', 'in-progress']);
});

test('الحِمل الحالي والتذاكر المتأخرة لكل موظف', () => {
    assert.equal(row('a1').openCount, 1);
    assert.equal(row('a1').inProgress, 1);
    assert.equal(row('a1').overdue, 1);
    assert.equal(row('a2').openCount, 1);
    assert.equal(row('a2').overdue, 0);
});

test('المحلولة داخل الفترة فقط، و confirmed محسوبة', () => {
    assert.equal(row('a1').resolved, 2);
    assert.equal(row('a2').resolved, 0, 'تذكرة اتحلت قبل الفترة ماتتحسبش');
    assert.equal(row('a3').resolved, 1);
});

test('متوسط أول رد وزمن الحل بالساعات', () => {
    assert.equal(row('a1').firstResponseHours, (0.5 + 1 + 0.25) / 3);
    assert.equal(row('a1').resolutionHours, (4 + 10) / 2);
    assert.equal(row('a2').firstResponseHours, null, 'تذكرة من غير رد مش بتنزّل المتوسط لصفر');
    assert.equal(row('a3').resolutionHours, 4, 'الصفوف القديمة بتستخدم last_updated_at');
});

test('الالتزام بالـ SLA من التذاكر المحلولة اللي ليها موعد', () => {
    assert.deepEqual(row('a1').sla, { met: 1, total: 2, rate: 0.5 });
    assert.equal(row('a3').sla.rate, null);
});

test('الردود للكاتب نفسه داخل الفترة، والملاحظات الداخلية منفصلة', () => {
    assert.equal(row('a1').replies, 2);
    assert.equal(row('a1').notes, 1);
    assert.equal(row('a2').chatReplies, 2);
    assert.equal(row('a1').chatReplies, 0);
});

test('التقييم ينسب للمسؤول عن التذكرة وداخل الفترة', () => {
    assert.deepEqual(row('a1').rating, { average: 4.5, count: 2 });
    assert.deepEqual(row('a2').rating, { average: null, count: 0 });
});

test('موظف خرج من الطاقم بيظهر كموظف سابق بدل ما تذاكره تختفي', () => {
    const former = row('gone');
    assert.ok(former);
    assert.equal(former.roleLabel, 'موظف سابق');
    assert.equal(former.openCount, 1);
});

test('أرقام الفريق', () => {
    const { team } = perf();
    assert.equal(team.unassigned, 1);
    assert.equal(team.resolved, 3);
    assert.equal(team.openCount, 4);
    assert.equal(team.rating.average, 4.5);
    assert.equal(team.replies, 2);
    assert.equal(team.chatReplies, 2);
});

test('الفرز: الأزمنة الأقل أولًا، والفاضي دايمًا تحت', () => {
    const rows = perf().rows;
    assert.deepEqual(sortRows(rows, 'resolved').slice(0, 2).map(r => r.id), ['a1', 'a3']);
    const fr = sortRows(rows, 'firstResponse').map(r => r.id);
    assert.equal(fr[0], 'a1');
    assert.ok(fr.indexOf('a2') > fr.indexOf('a3'), 'من غير بيانات تحت');
    assert.equal(sortRows(rows, 'firstResponse', 'desc').at(-1).firstResponseHours ?? null, null);
});

test('التنسيق', () => {
    assert.equal(formatHours(null), '—');
    assert.equal(formatHours(0.25), '15 د');
    assert.equal(formatHours(0.001), '1 د');
    assert.equal(formatHours(3.46), '3.5 س');
    assert.equal(formatHours(50), '2.1 يوم');
    assert.equal(formatPercent(0.876), '88%');
    assert.equal(formatPercent(null), '—');
    assert.equal(slaTone(0.95), 'ok');
    assert.equal(slaTone(0.75), 'warn');
    assert.equal(slaTone(0.2), 'bad');
    assert.equal(slaTone(null), 'none');
});

test('بداية الفترة', () => {
    const now = new Date(2026, 9, 5, 15, 30);
    assert.equal(periodStart('7d', now).getTime(), now.getTime() - 7 * 86400000);
    const today = periodStart('today', now);
    assert.equal(today.getHours(), 0);
    assert.equal(today.getDate(), 5);
    assert.equal(periodStart('غير موجود', now).getTime(), now.getTime() - 30 * 86400000);
});

test('مساعدات الحالة', () => {
    assert.equal(resolvedAt({ status: 'open', resolved_at: h(1) }), null);
    assert.equal(isOverdue({ status: 'resolved', sla_resolution_due_at: h(5) }, NOW), false);
    assert.equal(metSla({ status: 'resolved', resolved_at: h(1), sla_resolution_due_at: h(2) }), false);
    assert.equal(metSla({ status: 'resolved', resolved_at: h(2), sla_resolution_due_at: h(1) }), true);
});

test('المحلولة يوميًا لموظف', () => {
    const now = new Date(NOW);
    const days = dailyResolved(tickets, 'a1', { days: 3, now });
    assert.equal(days.length, 3);
    assert.equal(days.reduce((a, d) => a + d.count, 0), 2);
});
