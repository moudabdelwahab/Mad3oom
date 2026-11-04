// ownerPasswordLocked: تعذّر التحقق ⇒ null (الواجهة ترفض)، لا false (يبدو تغييرًا ناجحًا وتُنهى الجلسات).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerPasswordLocked } from '../assets/js/security/owner-lock.js';

const client = (answers) => ({
    calls: [],
    async rpc(name) {
        this.calls.push(name);
        const a = answers[name];
        if (a instanceof Error) throw a;
        return a ?? { data: null, error: { message: 'missing' } };
    }
});
const policy = (locked) => ({ data: { policy: { password_change_locked: locked } }, error: null });

test('غير المالك: false دون سؤال عن سياسة المالك', async () => {
    const c = client({ is_platform_owner: { data: false, error: null } });
    assert.equal(await ownerPasswordLocked(c), false);
    assert.deepEqual(c.calls, ['is_platform_owner']);
});

test('المالك: قيمة السياسة كما هي', async () => {
    assert.equal(await ownerPasswordLocked(client({ is_platform_owner: { data: true, error: null }, owner_security_status: policy(true) })), true);
    assert.equal(await ownerPasswordLocked(client({ is_platform_owner: { data: true, error: null }, owner_security_status: policy(false) })), false);
});

test('خطأ في أي استدعاء أو شكل غير متوقع ⇒ null (fail closed)', async () => {
    const err = { data: null, error: { message: 'boom' } };
    for (const answers of [
        { is_platform_owner: err },
        { is_platform_owner: { data: null, error: null } },
        { is_platform_owner: { data: true, error: null }, owner_security_status: err },
        { is_platform_owner: { data: true, error: null }, owner_security_status: { data: {}, error: null } },
        { is_platform_owner: new Error('network') },
        { is_platform_owner: { data: true, error: null }, owner_security_status: new Error('network') }
    ]) {
        assert.equal(await ownerPasswordLocked(client(answers)), null, JSON.stringify(answers));
    }
});
