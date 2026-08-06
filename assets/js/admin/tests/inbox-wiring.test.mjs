import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * ------------------------------------------------------------
 * ليه الاختبار ده موجود
 *
 * `document.getElementById` بيرجّع `null` مش بيرمي، فعنصر اتغيّر اسمه في
 * الـ HTML ونسيه الـ JS مابيفشلش وقت التحميل — بيفشل أول ما حد يضغط
 * الزرار، بـ TypeError وشاشة مش بتعمل حاجة.
 *
 * الاختبار ده بيقارن الملفين ببعض. مقصود إنه بدائي — فحص نصوص مش DOM —
 * لأن الغلطة اللي بيمنعها بدائية: اسم موجود في ناحية وناقص في التانية.
 *
 * شغّله بـ:  node --test assets/js/admin/tests/
 */

const root = (p) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p) => readFile(root(p), 'utf8');

const idsInHtml = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsUsedByJs = (js) => [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

test('كل عنصر بيستخدمه inbox.js موجود في inbox.html', async () => {
    const [html, js] = await Promise.all([read('admin/inbox.html'), read('assets/js/admin/inbox.js')]);
    const declared = idsInHtml(html);

    const missing = [...new Set(idsUsedByJs(js))].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], `عناصر بيتنده عليها ومش موجودة: ${missing.join(', ')}`);
});

test('كل حاجة inbox.js بيستوردها من inbox-data.js متصدّرة فعلاً', async () => {
    const [js, data] = await Promise.all([
        read('assets/js/admin/inbox.js'),
        read('assets/js/admin/inbox-data.js')
    ]);

    const block = js.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/inbox-data\.js'/);
    assert.ok(block, 'مالقيتش استيراد inbox-data');

    const wanted = block[1].split(',').map((s) => s.trim()).filter(Boolean);
    const exported = new Set([...data.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]));

    const missing = wanted.filter((name) => !exported.has(name));
    assert.deepEqual(missing, [], `مستورد ومش متصدّر: ${missing.join(', ')}`);
});

test('الصفحة مربوطة في القايمة الجانبية ومقفولة على الأدوار الصح', async () => {
    const [sidebarHtml, sidebarJs] = await Promise.all([
        read('assets/components/sidebar.html'),
        read('assets/js/admin/sidebar.js')
    ]);

    assert.ok(sidebarHtml.includes('id="inboxLink"'), 'اللينك مش موجود في القايمة');
    assert.ok(sidebarHtml.includes('/admin/inbox.html'), 'اللينك مش بيوصّل للصفحة');

    // مخفي افتراضيًا + بيتعرض بشرط = العضو العادي مايشوفهوش.
    assert.match(sidebarHtml, /id="inboxLink"[^>]*style="display:none;"/, 'اللينك مفروض يبدأ مخفي');
    assert.ok(sidebarJs.includes("showLink('inboxLink')"), 'مفيش شرط بيعرض اللينك');
});

test('الصفحة بتقول بوضوح إنها معاينة مش نظام شغال', async () => {
    // صفحة رسايل بتبان شغالة وهي مش بتبعت حاجة أسوأ من صفحة ناقصة:
    // حد هيفتكر إنه كلّم عميل وهو ما كلّمش.
    const html = await read('admin/inbox.html');
    assert.ok(html.includes('previewBanner'), 'مفيش بانر تنبيه');
    assert.ok(/مابتتبعتش|تجريبية/.test(html), 'البانر مش بيقول إن الرسايل مابتتبعتش');
});

test('طبقة البيانات بتفرّق بين الأدمن والسوبر يوزر', async () => {
    // ده الفرق الحقيقي بين الدورين. لو اتشال، السوبر يوزر هيشوف كل
    // أعضاء المنصة.
    const data = await read('assets/js/admin/inbox-data.js');
    assert.ok(/role === 'super_user'/.test(data), 'مفيش تفريق حسب الدور في listContacts');
    assert.ok(data.includes('ownerId'), 'مفيش ربط بين العضو وصاحبه');
});

test('طبقة البيانات مالهاش أي وصول لقاعدة البيانات', async () => {
    // الواجهة الأمامية بس دلوقتي. لو ظهر استيراد لـ supabase هنا، يبقى
    // حد بيكتب في الإنتاج من غير RLS مراجَعة.
    const data = await read('assets/js/admin/inbox-data.js');
    assert.ok(!/supabase|api-config/.test(data), 'فيه وصول لقاعدة البيانات في طبقة وهمية');
});

// ── سلوك حقيقي في طبقة البيانات ─────────────────────────────────────

test('محادثة فردية مع نفس الشخص مابتتكررش', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const before = data.listConversations().length;

    const first = data.openDirectConversation('u_5');
    const second = data.openDirectConversation('u_5');

    assert.equal(first.id, second.id, 'اتعملت محادثتين لنفس الشخص');
    assert.equal(data.listConversations().length, before + 1);
});

test('المجموعة لازم يكون ليها اسم وأعضاء', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));

    assert.ok(data.createGroup({ title: '', memberIds: ['u_1'] }).error, 'قبل مجموعة بدون اسم');
    assert.ok(data.createGroup({ title: 'فريق', memberIds: [] }).error, 'قبل مجموعة بدون أعضاء');

    const { conversation, error } = data.createGroup({ title: 'فريق', memberIds: ['u_1', 'u_2'] });
    assert.equal(error, null);
    assert.ok(conversation.memberIds.includes(data.getCurrentUser().id), 'اللي عمل المجموعة مش عضو فيها');
});

test('التحويل بينسخ ومابينقلش، وبيسيب أثر لمصدره', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));

    const source = data.listMessages('c_1');
    const original = source[0];
    const countBefore = data.listMessages('c_3').length;

    const copy = data.forwardMessage({ messageId: original.id, toConversationId: 'c_3' });

    assert.ok(copy, 'مااتحولتش');
    assert.equal(copy.body, original.body);
    assert.ok(copy.forwardedFrom, 'مفيش أثر للمصدر');
    assert.equal(data.listMessages('c_3').length, countBefore + 1);
    // الأصلية لازم تفضل مكانها.
    assert.ok(data.listMessages('c_1').some((m) => m.id === original.id), 'الأصلية اتشالت');
});

test('السوبر يوزر بيشوف أعضاءه هو بس', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));

    data.setPreviewRole('admin');
    const adminSees = data.listContacts().map((c) => c.id);

    data.setPreviewRole('super_user');
    const ownerSees = data.listContacts();

    assert.ok(adminSees.includes('u_1'), 'الأدمن مش شايف أعضاء المنصة');
    assert.ok(ownerSees.every((c) => c.ownerId === 'su_1' || c.role === 'support'),
        'السوبر يوزر شايف حد مش تبعه');
    assert.ok(ownerSees.length < adminSees.length);

    data.setPreviewRole('admin');
});
