/**
 * نافذة السجل المستقلة (admin/continuity-record.html?id=<uuid>): الرابط لا يحمل إلا معرّف
 * السجل ولا يمنح أي وصول. السلوك في المتصفح مقيس في tests/continuity-phase-c.render.test.mjs
 * («standalone»)؛ هنا: بناء الرابط والتحقق منه، وثوابت الصفحة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecordId, standaloneRecordUrl } from '../assets/js/continuity/continuity-model.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ID = 'cccccccc-0000-4000-8000-000000000001';

test('isRecordId: UUID فقط', () => {
    assert.equal(isRecordId(ID), true);
    assert.equal(isRecordId(ID.toUpperCase()), true);
    for (const bad of ['', ' ', `${ID} `, `${ID}x`, ID.slice(1), '../x', `${ID}&x=1`, null, undefined, 42, {}]) {
        assert.equal(isRecordId(bad), false, String(bad));
    }
});

test('standaloneRecordUrl: مسار ثابت ومعرّف فقط، ويرفض غير ذلك', () => {
    assert.equal(standaloneRecordUrl(ID), `/admin/continuity-record.html?id=${ID}`);
    assert.equal(standaloneRecordUrl(ID.toUpperCase()), `/admin/continuity-record.html?id=${ID}`);
    for (const bad of ['javascript:alert(1)', '//evil.example', `${ID}&next=//evil`, '']) {
        assert.throws(() => standaloneRecordUrl(bad), TypeError);
    }
});

test('الصفحة المستقلة: وضعها معلن، بلا شريط جانبي ولا قائمة، وعنوانها ثابت بلا عنوان السجل', async () => {
    const html = await read('admin/continuity-record.html');
    assert.match(html, /<body data-ct-mode="standalone">/);
    assert.match(html, /<title>سجل الاستمرارية - لوحة الإدارة<\/title>/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    // السياسة قبل أي مورد يُطلب (سكربت، رابط، صورة): وإلا يخرج ?id= في Referer لأول طلب
    const head = html.slice(0, html.indexOf('</head>'));
    const policyAt = head.indexOf('<meta name="referrer"');
    for (const tag of ['<script', '<link', '<img']) {
        const at = head.indexOf(tag);
        assert.ok(at === -1 || policyAt < at, `referrer policy must precede the first ${tag}`);
    }
    for (const id of ['sidebar-container', 'ctList', 'ctTrash', 'ctAssigners', 'ctPolicies']) {
        assert.ok(!html.includes(`id="${id}"`), `${id} في الصفحة المستقلة`);
    }
    assert.match(html, /<script type="module" src="\/assets\/js\/continuity\/continuity-page\.js"><\/script>/, 'نفس الكود');
});

test('رابط «فتح السجل في نافذة مستقلة» بلا opener ولا referrer، ولا يُبنى إلا من معرّف صالح', async () => {
    const page = await read('assets/js/continuity/continuity-page.js');
    const line = page.split('\n').find((l) => l.includes('id="ctOpenStandalone"'));
    assert.ok(line, 'الرابط موجود');
    assert.match(line, /isRecordId\(r\.id\) \?/);
    assert.match(line, /href="\$\{esc\(standaloneRecordUrl\(r\.id\)\)\}"/);
    assert.match(line, /target="_blank" rel="noopener noreferrer"/);
    assert.match(line, />فتح السجل في نافذة مستقلة</);
    // الوضع المستقل لا يقرأ معرّفًا غير صالح ولا ينادي الخادم به
    assert.match(page, /if \(STANDALONE && !isRecordId\(standaloneId\)\) \{/);
    const boot = page.slice(page.indexOf('async function boot'));
    assert.ok(boot.indexOf('isRecordId(standaloneId)') < boot.indexOf('loadContinuityAccess()'), 'التحقق قبل أي نداء');
});
