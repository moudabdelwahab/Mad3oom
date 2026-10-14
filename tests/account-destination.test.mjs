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

/* ── مالك المنصة: شاشة السياق، لا لوحة ─────────────────────────────────── */

test('مالك المنصة يذهب إلى شاشة اختيار السياق لا إلى لوحة الإدارة', () => {
    // إرساله مباشرةً إلى لوحة الإدارة كان سيعرض لوحة **فارغة**: صلاحياته في
    // القاعدة لا تُفعَّل إلا داخل سياق، فكل استعلام كان سيُردّ بلا تفسير.
    assert.equal(accountHomeFor({ role: 'platform_owner' }), DESTINATIONS.ownerContexts);
    assert.equal(accountHomeFor({ role: 'platform_owner', hasCompany: true }),
        DESTINATIONS.ownerContexts, 'ملكية الشركة لا تسحبه إلى لوحة الشركة');
});

test('وجهة بقية الحسابات لم تتغير', () => {
    assert.equal(accountHomeFor({ role: 'admin' }), DESTINATIONS.admin);
    assert.equal(accountHomeFor({ role: 'support' }), DESTINATIONS.admin);
    assert.equal(accountHomeFor({ role: 'company_admin', hasCompany: true }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'company_user', hasCompany: true }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'user' }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({}), DESTINATIONS.customer);
});

/* ── 095 (D8): نوع الحساب من الخادم — عميل الشركة إلى بوابة العملاء ────────── */

test('عميل الشركة يذهب لبوابة العملاء، وفريقها للوحة الشركة', () => {
    // كلاهما «له شركة» (hasCompany)؛ نوع الحساب من الخادم هو ما يفرّق بينهما.
    assert.equal(accountHomeFor({ role: 'company_user', kind: 'company_customer' }), DESTINATIONS.companyPortal);
    assert.equal(accountHomeFor({ role: 'company_user', kind: 'company_employee' }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'company_admin', kind: 'company_admin' }), DESTINATIONS.company);
    assert.equal(accountHomeFor({ role: 'user', kind: 'independent' }), DESTINATIONS.customer);
    assert.equal(DESTINATIONS.companyPortal, '/portal/');
});

test('نوع الحساب يحسم حتى لو قالت hasCompany غير ذلك', () => {
    assert.equal(accountHomeFor({ role: 'company_user', hasCompany: true, kind: 'company_customer' }),
        DESTINATIONS.companyPortal, 'العميل لا يُرسل للوحة الشركة الداخلية');
    assert.equal(accountHomeFor({ role: 'user', hasCompany: true, kind: 'independent' }), DESTINATIONS.customer);
});

test('رتبة المنصة تسبق نوع الحساب، والنوع المجهول يُتجاهل', () => {
    assert.equal(accountHomeFor({ role: 'admin', kind: 'company_customer' }), DESTINATIONS.admin);
    assert.equal(accountHomeFor({ role: 'platform_owner', kind: 'company_admin' }), DESTINATIONS.ownerContexts);
    assert.equal(accountHomeFor({ role: 'user', kind: 'platform_owner_please' }), DESTINATIONS.customer);
    assert.equal(accountHomeFor({ role: 'user', hasCompany: true, kind: 'bogus' }), DESTINATIONS.company);
});

test('resolveAccountHome يسأل الخادم عن النوع، ويرجع للقراءة القديمة قبل 095', async () => {
    const { resolveAccountHome } = await import('../assets/js/account-destination.js');
    const client = (kindResult, companyId) => ({
        async rpc(name) {
            if (name === 'my_account_kind') return kindResult;
            if (name === 'current_company_id') return { data: companyId, error: null };
            throw new Error('unexpected rpc ' + name);
        }
    });
    assert.equal(await resolveAccountHome(client({ data: 'company_customer', error: null }, 'c1'), { role: 'company_user' }),
        DESTINATIONS.companyPortal);
    assert.equal(await resolveAccountHome(client({ data: 'company_employee', error: null }, 'c1'), { role: 'company_user' }),
        DESTINATIONS.company);
    // قبل 095: الدالة غير موجودة → السلوك القديم كما هو
    const missing = { data: null, error: { code: 'PGRST202', message: 'not found' } };
    assert.equal(await resolveAccountHome(client(missing, 'c1'), { role: 'company_user' }), DESTINATIONS.company);
    assert.equal(await resolveAccountHome(client(missing, null), { role: 'user' }), DESTINATIONS.customer);
    // قيمة لا يعرفها النظام لا تُعتمد
    assert.equal(await resolveAccountHome(client({ data: 'owner', error: null }, null), { role: 'user' }), DESTINATIONS.customer);
});
