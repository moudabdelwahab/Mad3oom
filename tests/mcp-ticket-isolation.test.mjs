/**
 * MCP بعد 097 — قرار رؤية التذكرة (supabase/functions/mcp/_shared/ticket-isolation.js).
 *
 * MCP يعمل بمفتاح الخدمة فلا تحرسه RLS. القرار هنا مطابق لسياسة tenant_isolation في القاعدة
 * (tests/sql/ticket-isolation.test.sql §⑤ تثبت السياسة نفسها، و§⑥ تثبت mcp_ticket_tenancy).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tenancyFromRpc, ticketVisibleUnderIsolation, statsColumns } from '../supabase/functions/mcp/_shared/ticket-isolation.js';

const CA = 'ca000000-0000-4000-8000-00000000000a';
const CB = 'cb000000-0000-4000-8000-00000000000b';
const admin = { id: 'ad', isAdmin: true, isMainAdmin: false };
const ownerA = { id: 'oa', isAdmin: false, isMainAdmin: false };
const customer = { id: 'a1', isAdmin: false, isMainAdmin: false };
const on = (ids = []) => ({ isolationOn: true, teamCompanyIds: ids });

const companyTicketA = { user_id: 'a1', scope: 'company', company_id: CA };
const supportTicketOfA1 = { user_id: 'a1', scope: 'mad3oom_support', company_id: null };

test('المفتاح مطفأ: لا تغيير؛ وأي خطأ في mcp_ticket_tenancy يفشل مغلقًا (107)', () => {
    const off = tenancyFromRpc({ isolation_on: false, team_company_ids: [] }, null);
    assert.deepEqual(off, { isolationOn: false, teamCompanyIds: [] });
    // خطأ أو رد فارغ ⇒ العزل مفعّل بلا شركات فريق: مالك الشركة لا يرى تذكرة عميله مع مدعوم
    for (const failed of [tenancyFromRpc(null, { code: 'PGRST202' }), tenancyFromRpc(null, { code: '57014' }), tenancyFromRpc(null, null)]) {
        assert.deepEqual(failed, { isolationOn: true, teamCompanyIds: [] });
        assert.equal(ticketVisibleUnderIsolation(ownerA, supportTicketOfA1, failed), false);
        assert.equal(ticketVisibleUnderIsolation(ownerA, companyTicketA, failed), false);
        assert.equal(ticketVisibleUnderIsolation(customer, supportTicketOfA1, failed), true);
    }
    assert.equal(ticketVisibleUnderIsolation(admin, companyTicketA, off), true);
    assert.equal(ticketVisibleUnderIsolation(admin, { user_id: 'x' }, tenancyFromRpc({ isolation_on: false }, null)), true);
    assert.equal(statsColumns(off), 'status');
});

test('العزل مفعّل: طاقم المنصة لا يرى تذكرة شركة، ويرى تذاكر مدعوم', () => {
    assert.equal(ticketVisibleUnderIsolation(admin, companyTicketA, on()), false);
    assert.equal(ticketVisibleUnderIsolation({ ...admin, isAdmin: false, isMainAdmin: true }, companyTicketA, on()), false);
    assert.equal(ticketVisibleUnderIsolation(admin, supportTicketOfA1, on()), true);
});

test('العزل مفعّل: فريق الشركة يرى تذاكر شركته فقط، لا تذاكر عملائه مع مدعوم', () => {
    const ctx = tenancyFromRpc({ isolation_on: true, team_company_ids: [CA] }, null);
    assert.equal(ticketVisibleUnderIsolation(ownerA, companyTicketA, ctx), true);
    assert.equal(ticketVisibleUnderIsolation(ownerA, { ...companyTicketA, company_id: CB }, ctx), false);
    assert.equal(ticketVisibleUnderIsolation(ownerA, supportTicketOfA1, ctx), false);
    assert.equal(statsColumns(ctx), 'status, user_id, scope, company_id');
});

test('صاحب التذكرة يراها دائمًا، والنطاق المجهول مرفوض', () => {
    assert.equal(ticketVisibleUnderIsolation(customer, companyTicketA, on()), true);
    assert.equal(ticketVisibleUnderIsolation(customer, supportTicketOfA1, on()), true);
    assert.equal(ticketVisibleUnderIsolation(admin, { user_id: 'z', scope: 'weird' }, on()), false);
    assert.equal(ticketVisibleUnderIsolation(admin, null, on()), false);
});

test('خدمة تذاكر MCP تطبّق القرار في القراءة والتعديل والإحصاءات، وطلب الاشتراك تذكرة فوترة', () => {
    const src = readFileSync(new URL('../supabase/functions/mcp/_shared/tickets-service.ts', import.meta.url), 'utf8');
    assert.equal((src.match(/ticketVisibleUnderIsolation\(/g) || []).length, 4, 'list + get + update + stats');
    assert.match(src, /rpc\("mcp_ticket_tenancy"/);
    const subs = readFileSync(new URL('../supabase/functions/mcp/_shared/subscriptions-service.ts', import.meta.url), 'utf8');
    assert.match(subs, /category: "subscription"/, 'طلب اشتراك MCP يُختم mad3oom_support لا شركة العميل');
});

// ── 107: اشتراكات MCP — صاحبها أو الإدارة فقط (نفس سياسات whatsapp_subscriptions) ──────────────
const { subscriptionVisibleTo, subscriptionListOwner } = await import('../supabase/functions/mcp/_shared/subscription-access.js');

test('اشتراك العميل الشخصي لا يقرؤه ولا يلغيه مالك شركته عبر super_user_id', () => {
    const companyOwner = { id: 'owner-a', isAdmin: false, isMainAdmin: false };
    const platformAdmin = { id: 'adm', isAdmin: true, isMainAdmin: false };
    assert.equal(subscriptionVisibleTo(companyOwner, 'customer-a1'), false, 'مالك الشركة لا يرى اشتراك عميله');
    assert.equal(subscriptionVisibleTo(companyOwner, 'owner-a'), true, 'اشتراك الشركة باسم مالكها');
    assert.equal(subscriptionVisibleTo(platformAdmin, 'customer-a1'), true);
    assert.equal(subscriptionVisibleTo(null, 'x'), false);
    assert.equal(subscriptionVisibleTo(companyOwner, null), false);
    assert.equal(subscriptionListOwner(companyOwner), 'owner-a');
    assert.equal(subscriptionListOwner(platformAdmin), null);
    assert.notEqual(subscriptionListOwner(null), null, 'بلا منادٍ لا قائمة كاملة');
});

test('خدمة اشتراكات MCP لا تعتمد على super_user_id ولا على getVisibleUserIds', () => {
    const subs = readFileSync(new URL('../supabase/functions/mcp/_shared/subscriptions-service.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(subs, /super_user_id|getVisibleUserIds|ownerSuperUserId/);
    assert.match(subs, /subscriptionListOwner\(actor\)/);
    assert.equal((subs.match(/canAccessSubscription\(actor, \(found\.sub as any\)\.user_id\)/g) || []).length, 2, 'get + cancel');
});
