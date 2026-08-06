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
    const exported = new Set([...data.matchAll(/export\s+(?:async\s+function|function|const|let)\s+(\w+)/g)].map((m) => m[1]));

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

    const first = data.openDirectConversation('u_3');
    const second = data.openDirectConversation('u_3');

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

// ═════════════════════════════════════════════════════════════
// صندوق الدعم: الحالة والإسناد والملاحظات الداخلية
// ═════════════════════════════════════════════════════════════

test('الملاحظة الداخلية مابتحركش المحادثة ولا بتفتحها من تاني', async () => {
    // دي مذكرة للفريق، مش رد على العميل. لو حرّكت المحادثة لفوق أو
    // فتحتها، الفريق هيفتكر إن العميل رد.
    const data = await import(root('assets/js/admin/inbox-data.js'));
    data.setStatus('c_3', 'closed');
    const before = data.findConversation('c_3').lastMessageAt;

    data.sendMessage({ conversationId: 'c_3', body: 'ملاحظة للفريق', visibility: 'note' });

    assert.equal(data.findConversation('c_3').lastMessageAt, before, 'الملاحظة حرّكت المحادثة');
    assert.equal(data.findConversation('c_3').status, 'closed', 'الملاحظة فتحت محادثة مقفولة');
});

test('الرد على محادثة مقفولة بيفتحها من تاني', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    data.setStatus('c_3', 'closed');
    data.sendMessage({ conversationId: 'c_3', body: 'رد للعميل' });
    assert.equal(data.findConversation('c_3').status, 'open');
});

test('تحويل ملاحظة داخلية بيفضل ملاحظة', async () => {
    // تحويل ملاحظة فريق لمحادثة عميل هو بالظبط التسريب اللي الفصل ده
    // موجود عشانه.
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const note = data.listMessages('c_1').find((m) => m.visibility === 'note');
    assert.ok(note, 'مفيش ملاحظة في البيانات التجريبية');

    const copy = data.forwardMessage({ messageId: note.id, toConversationId: 'c_4' });
    assert.equal(copy.visibility, 'note', 'الملاحظة اتحوّلت كرد للعميل');
});

test('المحادثة المؤرشفة بتختفي من كل المشاهد غير الأرشيف', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    data.setArchived('c_4', true);

    const inAll = data.listConversations({ view: 'all' }).some((c) => c.id === 'c_4');
    const inArchive = data.listConversations({ view: 'archived' }).some((c) => c.id === 'c_4');

    assert.equal(inAll, false, 'المؤرشفة لسه بتبان في الكل');
    assert.equal(inArchive, true, 'المؤرشفة مش في الأرشيف');
    data.setArchived('c_4', false);
});

test('التعديل بيسيب أثر، ورسالة حد تاني مااتعدلش', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const mine = data.listMessages('c_1').find((m) => m.senderId === data.getCurrentUser().id);
    const theirs = data.listMessages('c_1').find((m) => m.senderId !== data.getCurrentUser().id);

    assert.equal(data.editMessage(mine.id, 'نص جديد').ok, true);
    assert.ok(data.findMessage(mine.id).editedAt, 'مفيش أثر للتعديل');
    assert.equal(data.editMessage(mine.id, '   ').ok, false, 'قبل رسالة فاضية');
    assert.equal(data.editMessage(theirs.id, 'اختراق').ok, false, 'عدّل رسالة حد تاني');
});

test('السحب بيسيب مكان الرسالة بدل ما يشيلها', async () => {
    // الرد اللي تحتها بيبقى مالوش معنى من غيرها، و«اتسحبت» معلومة في حد
    // ذاتها لأي حد كان شايفها.
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const mine = data.listMessages('c_3').find((m) => m.senderId === data.getCurrentUser().id && !m.deleted);
    const countBefore = data.listMessages('c_3').length;

    assert.equal(data.deleteMessage(mine.id).ok, true);
    assert.equal(data.listMessages('c_3').length, countBefore, 'الرسالة اتشالت خالص');
    assert.equal(data.findMessage(mine.id).deleted, true);
    assert.equal(data.findMessage(mine.id).attachments.length, 0, 'المرفقات فضلت بعد السحب');
});

test('التفاعل بيتشال لما تضغطه تاني', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const target = data.listMessages('c_2')[0];
    const me = data.getCurrentUser().id;

    data.toggleReaction(target.id, '🎉');
    assert.ok(data.findMessage(target.id).reactions['🎉'].includes(me));
    data.toggleReaction(target.id, '🎉');
    assert.equal(data.findMessage(target.id).reactions['🎉'], undefined, 'الرمز فضل بمصفوفة فاضية');
});

test('المنشن بيتحسب من أعضاء المحادثة بس', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const sent = data.sendMessage({ conversationId: 'c_2', body: '@هبة سمير ممكن تبصي؟ و@مالك الفريق مش هنا' });

    assert.ok(sent.mentions.includes('st_2'), 'عضو موجود مااتمنشنش');
    assert.ok(!sent.mentions.includes('su_1'), 'اتمنشن حد مش في المحادثة');
});

test('الرد الجاهز بيتملي باسم الطرف التاني', async () => {
    // رد جاهز بيوصل للعميل باسم حد تاني أسوأ من إنه يتكتب من الأول.
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const welcome = data.listCannedReplies().find((r) => r.body.includes('{{الاسم}}'));
    assert.ok(welcome, 'مفيش رد جاهز فيه متغير');

    const filled = data.fillCannedReply(welcome.body, 'c_1');
    assert.ok(!filled.includes('{{'), 'المتغير فضل مكانه');
    assert.ok(filled.includes('محمود عبدالوهاب'), 'مااتحطش اسم الطرف التاني');
});

test('عدّادات المشاهد بتطابق اللي بيترجع فعلاً', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const counts = data.viewCounts();
    for (const view of ['all', 'unread', 'mine', 'closed', 'archived']) {
        assert.equal(counts[view], data.listConversations({ view }).length, `عدّاد «${view}» غلط`);
    }
});

test('المسودة بتتحفظ لكل محادثة لوحدها', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    data.saveDraft('c_1', 'مسودة أولى');
    data.saveDraft('c_2', 'مسودة تانية');
    assert.equal(data.findConversation('c_1').draft, 'مسودة أولى');
    assert.equal(data.findConversation('c_2').draft, 'مسودة تانية');

    // الإرسال بيفضّي مسودة المحادثة دي بس.
    data.sendMessage({ conversationId: 'c_1', body: 'خلاص' });
    assert.equal(data.findConversation('c_1').draft, '');
    assert.equal(data.findConversation('c_2').draft, 'مسودة تانية');
});

test('الملاحظات بتتشال لما نسأل «العميل شاف إيه»', async () => {
    const data = await import(root('assets/js/admin/inbox-data.js'));
    const all = data.listMessages('c_1', { includeNotes: true });
    const seen = data.listMessages('c_1', { includeNotes: false });
    assert.ok(all.length > seen.length, 'الملاحظات مااتشالتش');
    assert.ok(seen.every((m) => m.visibility !== 'note'));
});

test('شريط الكتابة بياخد سطره لوحده على الموبايل', async () => {
    // ستة أزرار في سطر واحد بتسيب خانة الكتابة شريط رفيع بيعرض حرف في
    // كل سطر — ده حصل فعلاً.
    const html = await read('admin/inbox.html');
    assert.match(html, /\.ib-composer-row textarea \{ order: -1; flex: 1 1 100%/,
        'مفيش قاعدة بتدي الخانة سطرها على الموبايل');
});
