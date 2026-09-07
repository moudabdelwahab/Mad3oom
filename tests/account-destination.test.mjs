/**
 * اختبارات قاعدة "أين يذهب المستخدم بعد الدخول".
 *
 * القاعدة دي كانت مكررة في أربعة أماكن بنفس السطر، وكانت بتعامل super_user
 * كرتبة إدارية — وهي رتبة بتتمنح تلقائيًا لأي عميل يشتري باقة الدعم أو
 * الباقة الشاملة، فالعميل الدافع كان بينتهي في لوحة الإدارة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { accountHomeFor, DESTINATIONS } = await import('../assets/js/account-destination.js');

test('فريق المنصة وحده يذهب للوحة الإدارة', () => {
    assert.equal(accountHomeFor({ role: 'admin' }), DESTINATIONS.admin);
    assert.equal(accountHomeFor({ role: 'support' }), DESTINATIONS.admin);
});

test('super_user ليست رتبة إدارية — العميل الدافع لا يُرسل للوحة الإدارة', () => {
    // ده كان الخلل: شراء باقة الدعم/الشاملة يمنح super_user تلقائيًا،
    // فكان العميل يُحوَّل للوحة إدارة لا يملك بياناتها أصلًا.
    assert.notEqual(accountHomeFor({ role: 'super_user' }), DESTINATIONS.admin);
    assert.equal(accountHomeFor({ role: 'super_user', hasCompany: false }), DESTINATIONS.customer);
});

test('صاحب الشركة يذهب للوحة الشركة', () => {
    assert.equal(accountHomeFor({ role: 'super_user', hasCompany: true }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'user', hasCompany: true }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'customer', hasCompany: true }), DESTINATIONS.company);
});

test('العميل الفرد يذهب للوحة العميل', () => {
    assert.equal(accountHomeFor({ role: 'user' }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({ role: 'customer', hasCompany: false }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({}), DESTINATIONS.customer);
});

test('رتبة الإدارة تسبق وجود الشركة', () => {
    // أدمن يملك شركة يظل ذاهبًا للوحة الإدارة — هي مكان عمله
    assert.equal(accountHomeFor({ role: 'admin', hasCompany: true }), DESTINATIONS.admin);
});

test('القرار لا يعتمد على أي قيمة قابلة للتلاعب من الرابط', () => {
    // الدالة لا تقبل إلا حالة الحساب؛ أي حقول إضافية تُتجاهل
    assert.equal(
        accountHomeFor({ role: 'user', hasCompany: false, redirect: '/admin-dashboard.html', isAdmin: true }),
        DESTINATIONS.customer
    );
});

test('hasCompany يجب أن تكون true صراحةً — لا قيم رخوة', () => {
    assert.equal(accountHomeFor({ role: 'user', hasCompany: 'yes' }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({ role: 'user', hasCompany: 1 }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({ role: 'user', hasCompany: null }), DESTINATIONS.customer);
});
