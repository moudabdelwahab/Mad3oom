/**
 * regenerate-api-token-secret: التجديد لصاحب المفتاح وحده (F7).
 * RLS على api_tokens يُظهر للأدمن مفاتيح كل الحسابات، والدالة تكتب بمفتاح الخدمة وتُرجع السر الجديد لمن طلبه،
 * فبلا هذا الشرط يحصل الأدمن على سر مفتاح غيره (مالك المنصة أو مالك شركة) ويعمل بهويته عبر الـ API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../supabase/functions/regenerate-api-token-secret/index.ts', import.meta.url), 'utf8');

test('شرط الملكية قبل إنشاء عميل الخدمة وقبل أي كتابة', () => {
    const owner = src.indexOf('if (existing.user_id !== userData.user.id)');
    assert.ok(owner > 0, 'لا يوجد شرط ملكية');
    assert.ok(src.indexOf('select("id, user_id, name, credential_type")') < owner, 'user_id غير مقروء قبل الشرط');
    for (const touch of ['createClient(supabaseUrl, serviceRoleKey)', '.update(']) {
        const at = src.indexOf(touch);
        assert.ok(at > owner, `${touch} قبل شرط الملكية`);
    }
    assert.match(src.slice(owner, owner + 300), /403\)/);
});

test('كل كتابة بمفتاح الخدمة على المفتاح نفسه بعد الشرط', () => {
    const owner = src.indexOf('if (existing.user_id !== userData.user.id)');
    const updates = [...src.matchAll(/\.update\(/g)].map((m) => m.index);
    assert.equal(updates.length, 2);
    for (const at of updates) {
        assert.ok(at > owner);
        assert.match(src.slice(at, at + 400), /\.eq\("id", tokenId\)/);
    }
});
