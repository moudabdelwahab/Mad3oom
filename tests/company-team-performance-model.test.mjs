/**
 * tests/company-team-performance-model.test.mjs — أداء فريق الشركة:
 * تكييف حزمة company_team_performance (146) مع صفوف نموذج الأداء المشترك.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    teamPerformanceRows, teamPerformanceTotals, presetWindow, validateWindow, toISODate
} from '../assets/js/company/company-team-performance-model.js';
import { sortRows, formatHours } from '../assets/js/admin/team-performance-model.js';

const payload = {
    company_id: 'co1', from: '2026-10-27', to: '2026-11-26', generated_at: '2026-11-26T12:00:00Z',
    members: [
        { id: 'm1', name: 'أحمد', role: 'supervisor', tickets_created: 5, tickets_resolved: 4,
          replies_total: 10, replies_public: 8, replies_internal: 2,
          avg_first_response_seconds: 3600, avg_resolution_seconds: 7200 },
        { id: 'm2', name: 'سارة', role: 'agent', tickets_created: 3, tickets_resolved: 1,
          replies_total: 4, replies_public: 4, replies_internal: 0,
          avg_first_response_seconds: null, avg_resolution_seconds: null },
        { id: 'm3', name: 'المالك', role: 'admin', tickets_created: 0, tickets_resolved: 0,
          replies_total: 0, replies_public: 0, replies_internal: 0,
          avg_first_response_seconds: null, avg_resolution_seconds: null }
    ],
    totals: {
        tickets_created: 8, tickets_resolved: 5, tickets_open_now: 2,
        avg_first_response_seconds: 3600, avg_resolution_seconds: 7200,
        ratings: { count: 6, avg: 4.5 }, chat: { sessions: 9, messages: 40 }
    }
};

test('teamPerformanceRows: تحويل الثواني إلى ساعات، و null حيث لا إسناد صادق', () => {
    const rows = teamPerformanceRows(payload);
    assert.equal(rows.length, 3);
    const ahmed = rows[0];
    assert.equal(ahmed.name, 'أحمد');
    assert.equal(ahmed.roleLabel, 'مشرف');
    assert.equal(ahmed.resolved, 4);
    assert.equal(ahmed.ticketsCreated, 5);
    assert.equal(ahmed.firstResponseHours, 1);
    assert.equal(ahmed.resolutionHours, 2);
    assert.equal(ahmed.replies, 8);
    assert.equal(ahmed.notes, 2);
    // لا اختلاق: التقييم والشات والمفتوحة لكل عضو غير موجودة في الحزمة
    assert.deepEqual(ahmed.rating, { average: null, count: 0 });
    assert.equal(ahmed.chatReplies, null);
    assert.equal(ahmed.openCount, null);
    assert.equal(ahmed.inProgress, null);
    assert.equal(ahmed.overdue, null);
    assert.deepEqual(ahmed.sla, { met: 0, total: 0, rate: null });
    const sara = rows[1];
    assert.equal(sara.roleLabel, 'دعم فني');
    assert.equal(sara.firstResponseHours, null, 'بلا عينة يبقى null لا صفرًا');
    assert.equal(sara.resolutionHours, null);
    assert.equal(rows[2].roleLabel, 'أدمن');
    assert.deepEqual(teamPerformanceRows(null), []);
    assert.deepEqual(teamPerformanceRows({}), []);
});

test('teamPerformanceTotals: إجماليات الشركة بما فيها التقييمات والشات', () => {
    const t = teamPerformanceTotals(payload);
    assert.equal(t.ticketsCreated, 8);
    assert.equal(t.ticketsResolved, 5);
    assert.equal(t.ticketsOpenNow, 2);
    assert.equal(t.avgFirstResponseHours, 1);
    assert.equal(t.avgResolutionHours, 2);
    assert.deepEqual(t.ratings, { count: 6, avg: 4.5 });
    assert.deepEqual(t.chat, { sessions: 9, messages: 40 });
    assert.equal(t.from, '2026-10-27');
    assert.equal(teamPerformanceTotals({}).ratings.avg, null);
    assert.deepEqual(teamPerformanceTotals({}).chat, { sessions: 0, messages: 0 });
});

test('فرز النموذج المشترك يعمل على الصفوف المكيّفة، والقيم الفارغة في الأسفل', () => {
    const rows = teamPerformanceRows(payload);
    const byResolved = sortRows(rows, 'resolved', 'desc');
    assert.deepEqual(byResolved.map(r => r.name), ['أحمد', 'سارة', 'المالك']);
    const byFirst = sortRows(rows, 'firstResponse', 'asc');
    assert.equal(byFirst[0].name, 'أحمد', 'الأسرع أولًا');
    assert.deepEqual(new Set(byFirst.slice(1).map(r => r.name)), new Set(['سارة', 'المالك']),
        'بلا بيانات في الأسفل مهما كان الاتجاه');
    const byFirstDesc = sortRows(rows, 'firstResponse', 'desc');
    assert.equal(byFirstDesc[0].name, 'أحمد');
    assert.deepEqual(new Set(byFirstDesc.slice(1).map(r => r.name)), new Set(['سارة', 'المالك']));
    // formatHours من النموذج نفسه يعرض الساعات المكيّفة
    assert.equal(formatHours(rows[0].firstResponseHours), '1 س');
    assert.equal(formatHours(null), '—');
});

test('presetWindow: آخر N يومًا شاملة اليوم', () => {
    const now = new Date(2026, 10, 26, 12, 0, 0); // 26 نوفمبر 2026
    assert.deepEqual(presetWindow(30, now), { from: '2026-10-28', to: '2026-11-26' });
    assert.deepEqual(presetWindow(7, now), { from: '2026-11-20', to: '2026-11-26' });
    assert.deepEqual(presetWindow(1, now), { from: '2026-11-26', to: '2026-11-26' });
    assert.equal(toISODate(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(toISODate('not-a-date'), null);
});

test('validateWindow: المعكوسة والممتدة تُرفضان كما في القاعدة', () => {
    assert.equal(validateWindow('2026-11-26', '2026-11-01').ok, false);
    assert.equal(validateWindow('2025-01-01', '2026-11-26').ok, false, 'أطول من 366 يومًا');
    assert.equal(validateWindow('2026-11-01', '2026-11-26').ok, true);
    assert.equal(validateWindow('', '').ok, false);
    assert.equal(validateWindow('2026-11-01', '2026-11-01').ok, true, 'يوم واحد مسموح');
});
