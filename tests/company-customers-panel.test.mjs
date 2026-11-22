/**
 * لوحة عملاء الشركة — السلوك الجديد (المرحلة ب):
 *
 * 1) customersPanelView يعكس ردّ القاعدة فقط: ردّ غير null يعني أن القاعدة
 *    سمحت لهذا الناظر برؤية القائمة (096: المدير والمشرف؛ و098 مفعّل: ومن
 *    يملك customers.view) — فالمالك يرى القائمة، والموظف يراها إن مُنح
 *    الصلاحية وإلا فلا (null).
 * 2) buildCompanyDirectory يقرأ joined_at للعميل (ما ترجعه القاعدة)،
 *    مع احتياطي created_at.
 * 3) إجراءات الدعوات في القائمة الموحّدة لمن يدير فقط (canManage).
 * 4) isCompanyScopedTicket يبقى متساهلًا عمدًا: بلا company_id (قرار موثّق
 *    في company-model.js — تذكرة قديمة بلا scope لا تُخفى).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { customersPanelView, isCompanyScopedTicket } from '../assets/js/company/company-model.js';
import { buildCompanyDirectory, companyUserActions } from '../assets/js/company/company-users-model.js';

const payload = (o) => ({ company_id: 'c', customers: [], ...o });
const CUSTS = [{ id: 'u1', name: 'عميل أول', email: 'c1@x.test', phone: null, joined_at: '2026-09-01T10:00:00Z' }];

test('المالك يرى قائمة العملاء حتى بلا دعوة (المفتاح مطفأ أو بلا sub_users)', () => {
    const v = customersPanelView(payload({ can_manage: true, invitations_enabled: false, customers: [] }), 'admin');
    assert.equal(v.show, true);
    assert.equal(v.showList, true);
    assert.equal(v.canInvite, false);
    const noManage = customersPanelView(payload({ can_manage: false, invitations_enabled: true, customers: [] }), 'admin');
    assert.equal(noManage.show, true);
    assert.equal(noManage.showList, true);
    assert.equal(noManage.canInvite, false);
});

test('المالك يرى القائمة ونموذج الدعوة معًا حين تسمح القاعدة', () => {
    const v = customersPanelView(payload({ can_manage: true, invitations_enabled: true, customers: CUSTS }), 'admin');
    assert.equal(v.show && v.showList && v.canInvite, true);
    assert.deepEqual(v.customers, CUSTS);
});

test('المشرف يرى القائمة للقراءة بلا دعوة', () => {
    const v = customersPanelView(payload({ can_manage: false, invitations_enabled: true, customers: CUSTS }), 'supervisor');
    assert.equal(v.show && v.showList && !v.canInvite, true);
});

test('موظف الدعم: القائمة إن رجّعتها القاعدة (يملك customers.view) وإلا فلا', () => {
    // مع 098 مفعّلًا وبلا الصلاحية ترجع القاعدة null
    assert.equal(customersPanelView(null, 'agent').show, false);
    assert.equal(customersPanelView(null, 'agent').showList, false);
    // ومع الصلاحية ترجع القائمة — والواجهة تعرضها بلا إعادة حساب للدور
    const v = customersPanelView(payload({ can_manage: false, invitations_enabled: false, customers: CUSTS }), 'agent');
    assert.equal(v.show, true);
    assert.equal(v.showList, true);
    assert.equal(v.canInvite, false);
});

test('ردّ غير صالح أو غائب: لا لوحة ولا قائمة', () => {
    assert.equal(customersPanelView(null, 'admin').show, false);
    assert.equal(customersPanelView(undefined, 'supervisor').show, false);
    assert.equal(customersPanelView('x', 'admin').show, false);
});

test('تاريخ العميل في القائمة الموحّدة هو joined_at لا created_at', () => {
    const rows = buildCompanyDirectory({ members: [], staff: null, customers: CUSTS, invitations: [] });
    assert.equal(rows[0].created_at, '2026-09-01T10:00:00Z');
    // احتياطي: مصدر قديم بلا joined_at
    const legacy = buildCompanyDirectory({
        members: [], staff: null,
        customers: [{ id: 'u2', name: 'قديم', email: 'old@x.test', created_at: '2026-01-05T00:00:00Z' }],
        invitations: []
    });
    assert.equal(legacy[0].created_at, '2026-01-05T00:00:00Z');
});

test('إجراءات الدعوات في القائمة الموحّدة لمن يدير فقط', () => {
    const rows = buildCompanyDirectory({
        members: [], staff: null, customers: [],
        invitations: [
            { id: 'i1', email: 'new@client.test', status: 'pending', email_status: 'failed' },
            { id: 'i2', email: 'sent@client.test', status: 'pending', email_status: 'sent' }
        ]
    });
    const ids = (key, ctx) => companyUserActions(rows.find(r => r.key === key), ctx)
        .filter(a => a.id).map(a => a.id);
    assert.deepEqual(ids('invitation:i1', { canManage: true }), ['invite:retry', 'copyEmail', 'cancelInvite']);
    assert.deepEqual(ids('invitation:i2', { canManage: true }), ['invite:resend', 'copyEmail', 'cancelInvite']);
    // بلا إدارة: نسخ البريد فقط — لا إعادة إرسال ولا إلغاء
    assert.deepEqual(ids('invitation:i1', { canManage: false }), ['copyEmail']);
    assert.deepEqual(ids('invitation:i2', { canManage: false }), ['copyEmail']);
    assert.deepEqual(ids('invitation:i1', {}), ['copyEmail']);
});

test('isCompanyScopedTicket يبقى متساهلًا: قديمة بلا scope أو company بلا company_id تُعرض', () => {
    assert.equal(isCompanyScopedTicket({ id: 'قبل 097' }), true);
    assert.equal(isCompanyScopedTicket({ scope: 'company' }), true);
    assert.equal(isCompanyScopedTicket({ scope: 'company', company_id: 'c' }), true);
    assert.equal(isCompanyScopedTicket({ scope: 'mad3oom_support', company_id: null }), false);
    assert.equal(isCompanyScopedTicket(null), false);
});
