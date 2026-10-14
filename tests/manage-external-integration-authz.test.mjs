/**
 * manage-external-integration — قرار الصلاحية (supabase/functions/manage-external-integration/authz.js).
 *
 * الدالة تكتب بمفتاح الخدمة، فـ RLS لا تحرس كتابتها. هذه الاختبارات تثبت القرار
 * الصريح: تكامل المنصة للإداري وحده، والتكامل الشخصي لصاحبه وحده، ولا إنشاء باسم
 * حساب آخر. (الإصدار المنشور 22 كان يسمح لأي حساب بحذف تكامل المنصة أو تعديله.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canModify, decideCreate, PLATFORM } from '../supabase/functions/manage-external-integration/authz.js';

const ME = '0a000000-0000-4000-8000-000000000011';
const OTHER = '0a000000-0000-4000-8000-000000000001';

test('الإنشاء: الشخصي لصاحب الطلب دائمًا، مهما أُرسل', () => {
    assert.deepEqual(decideCreate({ isAdmin: false, callerId: ME, requestedScope: 'user' }),
        { ok: true, ownerId: ME, ownerScope: 'user' });
    // نطاق قديم (super_user) أو مجهول = شخصي لصاحب الطلب
    assert.deepEqual(decideCreate({ isAdmin: false, callerId: ME, requestedScope: 'super_user' }),
        { ok: true, ownerId: ME, ownerScope: 'user' });
    // الإداري لا يُنشئ تكاملًا شخصيًا لغيره أيضًا
    assert.deepEqual(decideCreate({ isAdmin: true, callerId: ME, requestedScope: 'user' }),
        { ok: true, ownerId: ME, ownerScope: 'user' });
});

test('الإنشاء: تكامل المنصة للإداري وحده', () => {
    assert.deepEqual(decideCreate({ isAdmin: true, callerId: ME, requestedScope: PLATFORM }),
        { ok: true, ownerId: null, ownerScope: PLATFORM });
    const denied = decideCreate({ isAdmin: false, callerId: ME, requestedScope: PLATFORM });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
});

test('الإنشاء بلا هوية مرفوض', () => {
    assert.equal(decideCreate({ isAdmin: true, callerId: null, requestedScope: PLATFORM }).ok, false);
});

test('التعديل والحذف: تكامل المنصة للإداري وحده (الثغرة المغلقة)', () => {
    const platformRow = { owner_id: null, owner_scope: PLATFORM };
    assert.equal(canModify({ isAdmin: false, callerId: ME, row: platformRow }), false);
    assert.equal(canModify({ isAdmin: true, callerId: ME, row: platformRow }), true);
    // isAdmin لا يُقبل إلا قيمة true صريحة
    assert.equal(canModify({ isAdmin: 'true', callerId: ME, row: platformRow }), false);
});

test('التعديل والحذف: الشخصي لصاحبه وحده — لا مالك الشركة ولا الإداري', () => {
    const mine = { owner_id: ME, owner_scope: 'user' };
    const theirs = { owner_id: OTHER, owner_scope: 'user' };
    assert.equal(canModify({ isAdmin: false, callerId: ME, row: mine }), true);
    assert.equal(canModify({ isAdmin: false, callerId: ME, row: theirs }), false);
    assert.equal(canModify({ isAdmin: true, callerId: ME, row: theirs }), false);
    assert.equal(canModify({ isAdmin: false, callerId: ME, row: { owner_id: null, owner_scope: 'user' } }), false);
    assert.equal(canModify({ isAdmin: false, callerId: ME, row: null }), false);
    assert.equal(canModify({ isAdmin: false, callerId: null, row: mine }), false);
});
