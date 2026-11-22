/**
 * company-integrations-ux — منطق نسخ السر المعروض مرة واحدة (copySecret).
 * تُحقن حافظة ومستند وهميان؛ لا DOM ولا شبكة هنا.
 * الاستيراد بنفس نمط tests/company-inbox.test.mjs: استبدال الواردات ببدائل ثم data: URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../assets/js/company/company-integrations.js', import.meta.url), 'utf8')
    .replace(/import \{[^}]*\} from '\/assets\/js\/company\/integrations-model\.js';/s,
        `const buildProviderCards = () => [], validateConnectForm = () => ({ ok: true }), errorMessage = (c) => String(c || ''),
               isSallaAuthorizeUrl = () => false, oauthResultFrom = () => null, oauthBindingKey = (id) => id,
               VIEW_ROLE_OPTIONS = [], PROVIDER_INFO = {};`)
    .replace(/import \{[^}]*\} from '\/assets\/js\/company\/integrations-data\.js';/s,
        `const fetchIntegrationsOverview = async () => ({ ok: false }), prepareConnection = async () => ({ ok: false }),
               disconnectConnection = async () => ({ ok: false }), setConnectionViewRole = async () => ({ ok: false }),
               fetchIntakeRequests = async () => ({ ok: false }), dismissIntake = async () => ({ ok: false }),
               convertIntake = async () => ({ ok: false }), fetchIntegrationAudit = async () => ({ ok: false }),
               invokeIntegrationsApi = async () => ({ ok: false });`)
    .replace(/import \{[^}]*\} from '\/assets\/js\/customer\/portal-ui\.js';/s,
        `const escapeHtml = String, formatDate = String, formatDateTime = String,
               renderState = () => {}, renderSkeletonLines = () => {};`)
    .replace("import { ui } from '/ui-service.js';",
        `const ui = { showToast: () => {}, showConfirm: async () => false };`);

const { copySecret } = await import('data:text/javascript,' + encodeURIComponent(src));

/** حافظة وهمية تسجّل ما كُتب فيها، وتنجح أو ترفض حسب الطلب. */
function fakeClipboard({ fail = false } = {}) {
    const written = [];
    return {
        written,
        async writeText(value) {
            if (fail) throw new Error('clipboard denied');
            written.push(value);
        }
    };
}

/** مستند وهمي للنسخة الاحتياطية: textarea تُلحق ثم تُزال، وexecCommand ينجح أو يفشل. */
function fakeDoc({ execResult = true } = {}) {
    const tas = [];
    return {
        created: tas,
        body: {
            appendChild(el) { el._attached = true; },
            removeChild(el) { el._attached = false; }
        },
        createElement(tag) {
            const el = {
                tag, value: '', style: {},
                setAttribute() {},
                select() { el._selected = true; }
            };
            tas.push(el);
            return el;
        },
        execCommand() {
            if (execResult instanceof Error) throw execResult;
            return execResult;
        }
    };
}

test('الحافظة: ينسخ السر كما هو ويرجع نجاحًا', async () => {
    const clipboard = fakeClipboard();
    const r = await copySecret('whsec_abc123', { clipboard });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(clipboard.written, ['whsec_abc123']);
});

test('رفض الحافظة: يلجأ للنسخة الاحتياطية وينجح بها', async () => {
    const clipboard = fakeClipboard({ fail: true });
    const doc = fakeDoc({ execResult: true });
    const r = await copySecret('pair-XYZ', { clipboard, doc });
    assert.deepEqual(r, { ok: true });
    assert.equal(doc.created.length, 1);
    assert.equal(doc.created[0].value, 'pair-XYZ');
    assert.equal(doc.created[0]._selected, true);
    assert.equal(doc.created[0]._attached, false, 'عنصر textarea المؤقت يُزال بعد النسخ');
});

test('غياب الحافظة: النسخة الاحتياطية وحدها تكفي', async () => {
    const doc = fakeDoc({ execResult: true });
    const r = await copySecret('whsec_no_clipboard', { clipboard: undefined, doc });
    assert.deepEqual(r, { ok: true });
    assert.equal(doc.created[0].value, 'whsec_no_clipboard');
});

test('حافظة بلا writeText: يُعامل كغيابها ويلجأ للنسخة الاحتياطية', async () => {
    const doc = fakeDoc({ execResult: true });
    const r = await copySecret('s', { clipboard: {}, doc });
    assert.deepEqual(r, { ok: true });
});

test('فشل النسخة الاحتياطية (execCommand يرجع false): يرجع فشلًا', async () => {
    const doc = fakeDoc({ execResult: false });
    const r = await copySecret('s', { clipboard: undefined, doc });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
});

test('فشل النسخة الاحتياطية (execCommand يرمي): يرجع فشلًا ولا يرمي', async () => {
    const doc = fakeDoc({ execResult: new Error('denied') });
    const r = await copySecret('s', { clipboard: undefined, doc });
    assert.equal(r.ok, false);
    assert.equal(doc.created[0]._attached, false, 'عنصر textarea المؤقت يُزال حتى عند الفشل');
});

test('لا حافظة ولا مستند: يرجع فشلًا ولا يرمي', async () => {
    const r = await copySecret('s', { clipboard: undefined, doc: undefined });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
});
