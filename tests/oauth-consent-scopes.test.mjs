/**
 * حراسة قاعدة منح الصلاحيات لتطبيق خارجي — fail-closed / least privilege.
 *
 * منطق القرار يعيش في supabase/functions/oauth-authorize-approve/_shared/
 * scope-grant.js، وهو JavaScript خالص بلا أنواع **عمدًا**: Deno يستورده من
 * index.ts، وهذا الملف يستورده مباشرة. فالقاعدة تُختبَر بالتنفيذ الحقيقي لا
 * بفحص نصّ المصدر، ولا يوجد مصدران يفترقان.
 *
 * ما تحرسه هذه الاختبارات، وهو كل الأمان في هذه النقطة:
 *
 *   • غياب granted_scopes **لا يمنح شيئًا** — لا كل المطلوب ولا الافتراضي.
 *   • العميل لا يستطيع توسيع الصلاحيات مهما أرسل.
 *
 * هذه منصّة MCP تُستخدم مع Claude و ChatGPT وأي عميل خارجي، فالافتراض أن
 * الطلب قد يكون مُلفَّقًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    decideGrantedScopes, defaultScopesFor, isPrivileged, PRIVILEGED_SCOPES,
} from '../supabase/functions/oauth-authorize-approve/_shared/scope-grant.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPROVE = readFileSync(
    path.join(ROOT, 'supabase/functions/oauth-authorize-approve/index.ts'), 'utf8');
const CONSENT = readFileSync(path.join(ROOT, 'admin/oauth-consent.html'), 'utf8');

/** ما طلبه تطبيق خارجي فعلًا (Claude يطلب كل شيء). */
const VALID = [
    'tickets:read', 'tickets:write', 'tickets:delete',
    'customers:read', 'admin:full', 'settings:manage', 'oauth:manage',
];

/* ══════════ 1. غياب الاختيار لا يمنح شيئًا ══════════ */

test('غياب granted_scopes يُرفض ولا يمنح أي صلاحية', () => {
    for (const absent of [undefined, null]) {
        const r = decideGrantedScopes(VALID, absent);
        assert.equal(r.ok, false, 'يجب الرفض عند غياب الاختيار');
        assert.equal(r.reason, 'missing_granted_scopes');
        assert.equal(r.scopes, undefined, 'لا يجوز أن تُعاد أي صلاحية مع الرفض');
    }
});

test('غياب granted_scopes لا يعني «امنح كل ما طُلب»', () => {
    // هذا هو الانحراف الذي أُغلق: كان الغياب يمنح VALID كاملة ومنها admin:full.
    const r = decideGrantedScopes(VALID, undefined);
    assert.equal(r.ok, false);
    assert.notDeepEqual(r.scopes, VALID);
});

test('غياب granted_scopes لا يعني «امنح الافتراضي» أيضًا', () => {
    // fail-closed لا fail-reduced: حتى المجموعة الآمنة لا تُمنَح بلا اختيار.
    const r = decideGrantedScopes(VALID, undefined);
    assert.equal(r.ok, false);
    assert.notDeepEqual(r.scopes, defaultScopesFor(VALID));
});

test('نوع خاطئ مكان المصفوفة يُرفض ولا يُفسَّر تساهلًا', () => {
    for (const bad of ['admin:full', 42, {}, true, 'tickets:read tickets:write']) {
        const r = decideGrantedScopes(VALID, bad);
        assert.equal(r.ok, false, `يجب رفض ${JSON.stringify(bad)}`);
        assert.equal(r.reason, 'missing_granted_scopes');
    }
});

/* ══════════ 2. العميل لا يستطيع التوسيع ══════════ */

test('صلاحية لم يطلبها التطبيق تُسقَط', () => {
    const r = decideGrantedScopes(['tickets:read'], ['tickets:read', 'admin:full']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read'], 'admin:full لم تكن مطلوبة فتُسقَط');
});

test('صلاحية مخترَعة بالكامل تُسقَط', () => {
    const r = decideGrantedScopes(['tickets:read'], ['tickets:read', 'root:everything', '*']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read']);
});

test('اختيار كله خارج المطلوب يُرفض ولا يمنح شيئًا', () => {
    const r = decideGrantedScopes(['tickets:read'], ['admin:full', 'settings:manage']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_selection');
    assert.equal(r.scopes, undefined);
});

test('النتيجة لا تتجاوز المطلوب مهما كان حجم الاختيار', () => {
    const everything = [...VALID, 'a:b', 'c:d', 'admin:full', 'admin:full'];
    const r = decideGrantedScopes(['tickets:read', 'customers:read'], everything);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read', 'customers:read']);
    for (const s of r.scopes) {
        assert.ok(['tickets:read', 'customers:read'].includes(s));
    }
});

test('التكرار في الاختيار لا يُكرِّر المنح', () => {
    const r = decideGrantedScopes(['tickets:read'], ['tickets:read', 'tickets:read', 'tickets:read']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read']);
});

test('قيم غير نصّية داخل الاختيار تُتجاهَل بلا انهيار', () => {
    const r = decideGrantedScopes(['tickets:read'], [null, 42, {}, 'tickets:read', undefined]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read']);
});

/* ══════════ 3. الاختيار الصحيح يعمل ══════════ */

test('التضييق مسموح: يُمنَح ما اختير فقط', () => {
    const r = decideGrantedScopes(VALID, ['tickets:read', 'customers:read']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ['tickets:read', 'customers:read']);
});

test('admin:full تُمنَح فقط باختيار صريح', () => {
    const without = decideGrantedScopes(VALID, ['tickets:read']);
    assert.equal(without.scopes.includes('admin:full'), false);

    const withIt = decideGrantedScopes(VALID, ['tickets:read', 'admin:full']);
    assert.equal(withIt.scopes.includes('admin:full'), true, 'الاختيار الصريح يجب أن يعمل');
});

test('اختيار فارغ يُرفض', () => {
    const r = decideGrantedScopes(VALID, []);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_selection');
});

/* ══════════ 4. الافتراضي المُعلَن ══════════ */

test('default_scopes لا تحتوي أي صلاحية مرتفعة', () => {
    const d = defaultScopesFor(VALID);
    for (const p of PRIVILEGED_SCOPES) {
        assert.equal(d.includes(p), false, `${p} يجب ألا تكون في الافتراضي`);
    }
    assert.deepEqual(d, ['tickets:read', 'tickets:write', 'tickets:delete', 'customers:read']);
});

test('isPrivileged يغطّي الثلاث ولا يتجاوزها', () => {
    assert.deepEqual(PRIVILEGED_SCOPES, ['admin:full', 'settings:manage', 'oauth:manage']);
    assert.equal(isPrivileged('admin:full'), true);
    assert.equal(isPrivileged('tickets:read'), false);
});

/* ══════════ 5. الدالة المنشورة تستعمل هذا المنطق فعلًا ══════════ */

test('index.ts يستدعي decideGrantedScopes ولا يحتفظ بمسار بديل', () => {
    assert.match(APPROVE, /decideGrantedScopes\(validScopes, granted_scopes\)/,
        'يجب تمرير validScopes و granted_scopes بهذا الترتيب');
    assert.match(APPROVE, /if \(!decision\.ok\) return json\(/,
        'الرفض يجب أن يُنهي الطلب');
    // أي عودة إلى المسار المتساهل القديم تسقط هنا.
    assert.doesNotMatch(APPROVE, /let grantedScopes = validScopes;/,
        'لا يجوز وجود افتراضي متساهل');
    assert.doesNotMatch(APPROVE, /scope:\s*validScopes\.join/,
        'يجب حفظ المختار لا كل المطلوب');
    assert.match(APPROVE, /scope:\s*grantedScopes\.join\(" "\)/);
});

test('الواجهة ترسل granted_scopes دائمًا', () => {
    assert.match(CONSENT, /granted_scopes: granted/);
    assert.match(CONSENT, /\.oc-cb:checked/);
});
