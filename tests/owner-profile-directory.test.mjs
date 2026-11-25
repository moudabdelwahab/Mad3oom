/**
 * اختبارات دليل حسابات لوحة المالك (profile-directory.js) وربطه في
 * owner-dashboard.html.
 *
 * ما تحرسه هذه الاختبارات:
 *  • لا سحب لجدول profiles كاملًا عند الدخول: العدّادات عدّ دقيق
 *    head-count، والصفوف المجلبة فريق المنصة وحده (مالك/إداري/دعم).
 *  • الأسماء عند الحاجة فقط: دفعة .in('id', …) للغائبين، وبحث مقيّد
 *    (20 نتيجة، حرفان على الأقل) عند إضافة عضو للفريق.
 *  • مؤشر الاشتراكات: «اشتراكات المنصة الفعّالة» — من جدول اشتراكات
 *    المنصة الوحيد (whatsapp_subscriptions) بتعريف الفعالية نفسه
 *    (status='active' AND end_date > now())، فلا تُعدّ منتهية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    STAFF_ROLES, PROFILE_NAME_COLUMNS, USER_SEARCH_LIMIT,
    USER_SEARCH_MIN_LENGTH, isStaffRole, createProfileDirectory,
} from '../assets/js/owner/profile-directory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dashboardHtml = () => read('owner-dashboard.html');

/* ── محاكي supabase صغير: يسجّل الاستعلامات ويعيد صفوفًا مزروعة ── */

function mockSupabase(seedProfiles) {
    const calls = [];
    const table = (name) => {
        const state = { filters: [] };
        const api = {
            select(cols, opts) { state.cols = cols; state.opts = opts; return api; },
            eq(col, value) { state.filters.push(['eq', col, value]); return api; },
            in(col, values) { state.filters.push(['in', col, values]); return api; },
            or(expr) { state.filters.push(['or', null, expr]); return api; },
            order(col) { state.order = col; return api; },
            limit(n) { state.limit = n; return api; },
            then(resolve) {
                calls.push({ table: name, ...state });
                let rows = [...seedProfiles];
                for (const [kind, col, value] of state.filters) {
                    if (kind === 'eq') rows = rows.filter(r => String(r[col]) === String(value));
                    if (kind === 'in') rows = rows.filter(r => value.includes(r[col]));
                    // or('email.ilike.%q%,full_name.ilike.%q%'): مطابقة جزئية غير حساسة لحالة الأحرف.
                    if (kind === 'or') {
                        const term = String(value).match(/%([^%]+)%/)?.[1]?.toLowerCase() || '';
                        rows = rows.filter(r => String(r.email || '').toLowerCase().includes(term)
                            || String(r.full_name || '').toLowerCase().includes(term));
                    }
                }
                if (state.limit != null) rows = rows.slice(0, state.limit);
                resolve({ data: rows, error: null, count: rows.length });
                return undefined;
            },
        };
        return api;
    };
    return { from: table, calls };
}

const OWNER = { id: 'owner-1', email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner', pi_uid: 'pi-1' };
const ADMIN = { id: 'admin-1', email: 'admin@example.com', full_name: 'إداري', role: 'admin', pi_uid: null };
const SUPPORT = { id: 'support-1', email: 'support@example.com', full_name: 'دعم', role: 'support', pi_uid: null };
const CUSTOMER = { id: 'user-1', email: 'client@example.com', full_name: 'عميل', role: 'user', pi_uid: null };
const CUSTOMER_2 = { id: 'user-2', email: 'second@example.com', full_name: 'عميل ثانٍ', role: 'user', pi_uid: 'pi-2' };

/* ─────────────────── الثوابت ─────────────────── */

test('رتب الفريق: مالك وإداري ودعم فقط — لا عميل ولا شركة', () => {
    assert.deepEqual([...STAFF_ROLES], ['platform_owner', 'admin', 'support']);
    assert.equal(isStaffRole('platform_owner'), true);
    assert.equal(isStaffRole('admin'), true);
    assert.equal(isStaffRole('support'), true);
    assert.equal(isStaffRole('user'), false);
    assert.equal(isStaffRole('company_admin'), false);
    assert.equal(isStaffRole('company_user'), false);
});

test('حدود البحث: 20 نتيجة وحرفان على الأقل', () => {
    assert.equal(USER_SEARCH_LIMIT, 20);
    assert.equal(USER_SEARCH_MIN_LENGTH, 2);
});

/* ─────────────────── الدليل: ذاكرة وجلب عند الحاجة ─────────────────── */

test('الدليل: المزروعون يُقرأون بلا شبكة، والغائب null', () => {
    const supabase = mockSupabase([OWNER, ADMIN]);
    const dir = createProfileDirectory(supabase, [OWNER, ADMIN]);
    assert.deepEqual(dir.get('owner-1'), OWNER);
    assert.equal(dir.get('admin-1').full_name, 'إداري');
    assert.equal(dir.get('user-1'), null);
    assert.equal(supabase.calls.length, 0);
    assert.deepEqual(dir.staff().map(p => p.id), ['owner-1', 'admin-1']);
    assert.deepEqual(dir.all().map(p => p.id), ['owner-1', 'admin-1']);
});

test('الدليل: ensure يجلب الغائبين دفعة واحدة ولا يعيد جلب الموجودين', async () => {
    const supabase = mockSupabase([OWNER, ADMIN, CUSTOMER]);
    const dir = createProfileDirectory(supabase, [OWNER]);
    const rows = await dir.ensure(['owner-1', 'user-1', 'user-1', null, undefined]);
    assert.deepEqual(rows.map(r => r.id), ['user-1']);
    assert.equal(dir.get('user-1').full_name, 'عميل');
    assert.equal(supabase.calls.length, 1);
    assert.deepEqual(supabase.calls[0].filters, [['in', 'id', ['user-1']]]);
    assert.equal(supabase.calls[0].cols, PROFILE_NAME_COLUMNS);
    // مرة ثانية: لا شبكة — الكل في الذاكرة.
    await dir.ensure(['owner-1', 'user-1']);
    assert.equal(supabase.calls.length, 1);
});

test('الدليل: refresh يعيد جلب معروف بعد تغيير رتبته', async () => {
    const supabase = mockSupabase([OWNER, { ...CUSTOMER, role: 'support' }]);
    const dir = createProfileDirectory(supabase, [OWNER, CUSTOMER]);
    assert.equal(dir.get('user-1').role, 'user');
    await dir.refresh(['user-1']);
    assert.equal(dir.get('user-1').role, 'support');
    assert.equal(supabase.calls.length, 1);
});

test('الدليل: البحث مقيّد بدور user وبريد/اسم وبحد 20', async () => {
    const supabase = mockSupabase([CUSTOMER, CUSTOMER_2, ADMIN]);
    const dir = createProfileDirectory(supabase, [OWNER]);
    const rows = await dir.searchUsers('client');
    assert.deepEqual(rows.map(r => r.id), ['user-1']);
    const call = supabase.calls[0];
    assert.deepEqual(call.filters[0], ['eq', 'role', 'user']);
    assert.match(call.filters[1][2], /email\.ilike\.%client%/);
    assert.match(call.filters[1][2], /full_name\.ilike\.%client%/);
    assert.equal(call.limit, USER_SEARCH_LIMIT);
    // النتيجة تُزرع في الذاكرة للعرض اللاحق.
    assert.equal(dir.get('user-1').full_name, 'عميل');
});

test('الدليل: بحث أقل من حرفين لا يلمس الشبكة', async () => {
    const supabase = mockSupabase([CUSTOMER]);
    const dir = createProfileDirectory(supabase, [OWNER]);
    assert.deepEqual(await dir.searchUsers(''), []);
    assert.deepEqual(await dir.searchUsers('x'), []);
    assert.deepEqual(await dir.searchUsers('  '), []);
    assert.equal(supabase.calls.length, 0);
});

/* ─────────────────── الربط في لوحة المالك ─────────────────── */

test('اللوحة: لا سحب لكل profiles — فريق المنصة وحده برتب مرشّحة', () => {
    const html = dashboardHtml();
    assert.match(html, /\.from\('profiles'\)\.select\('id, email, full_name, role, pi_uid'\)\s*\n\s*\.in\('role', \['platform_owner', 'admin', 'support'\]\)/);
    assert.doesNotMatch(html, /\.from\('profiles'\)\.select\('id, email, full_name, role, pi_uid'\),/);
});

test('اللوحة: العدّادات head-count بلا صفوف — إجمالي وكل رتبة', () => {
    const html = dashboardHtml();
    for (const role of ['admin', 'company_admin', 'company_user']) {
        assert.match(html, new RegExp(`\\.from\\('profiles'\\)\\.select\\('id', \\{ count: 'exact', head: true \\}\\)\\.eq\\('role', '${role}'\\)`));
    }
    assert.match(html, /\.from\('profiles'\)\.select\('id', \{ count: 'exact', head: true \}\),\s*\n\s*supabase\.from\('profiles'\)/);
    assert.match(html, /\.not\('pi_uid', 'is', null\)/);
});

test('اللوحة: مؤشر الاشتراكات بتسمية المنصة وتعريف الفعالية نفسه', () => {
    const html = dashboardHtml();
    assert.match(html, /'اشتراكات المنصة الفعّالة'/);
    assert.doesNotMatch(html, /'اشتراكات فعّالة'/);
    assert.match(html, /\.from\('whatsapp_subscriptions'\)\.select\('id', \{ count: 'exact', head: true \}\)\s*\n\s*\.eq\('status', 'active'\)\.gt\('end_date', new Date\(\)\.toISOString\(\)\)/);
});

test('اللوحة: إضافة عضو للفريق بحث لا قائمة محمّلة', () => {
    const html = dashboardHtml();
    assert.match(html, /id="staffAddSearch"/);
    assert.match(html, /id="staffAddSearchBtn"/);
    assert.match(html, /ابحث عن حساب أولًا…/);
    assert.doesNotMatch(html, /rows\.filter\(p => p\.role === 'user'\)/);
    assert.match(html, /createProfileDirectory\(supabase, staffProfiles\.data \|\| \[\]\)/);
    assert.match(html, /initAuthorityCenter\(\{[^}]*directory,/);
    assert.match(html, /initPiIntegration\(\{[^}]*piLinkedCount:/);
});
