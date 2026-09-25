import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * ------------------------------------------------------------
 * ليه الاختبار ده موجود
 *
 * `document.getElementById` بيرجّع `null` مش بيرمي، فعنصر اتغيّر اسمه في
 * الـ HTML ونسيه الـ JS مابيفشلش وقت التحميل — بيفشل أول ما حد يضغط
 * الزرار. فبنقارن الملفات ببعض (فحص نصوص مش DOM).
 *
 * وصندوق الرسائل بقى واجهة الإدارة الوحيدة لشات العملاء بعد ما
 * chat-admin.html اتشالت، فبنثبّت كمان: مفيش بيانات تجريبية، ورد الدعم
 * بيتكتب بالشكل اللي ويدجت العميل مستنيه، ومفيش رابط مكسور للصفحة القديمة.
 *
 * شغّله بـ:  node --test assets/js/admin/tests/*.mjs
 */

const root = (p) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p) => readFile(root(p), 'utf8');
const exists = (p) => access(root(p)).then(() => true, () => false);

const idsInHtml = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsUsedByJs = (js) => [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const exportsOf = (src) => new Set([...src.matchAll(/export\s+(?:async\s+function|function|const|let)\s+(\w+)/g)].map((m) => m[1]));

function importedNames(js, file) {
    const block = js.match(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*'\\./${file.replace('.', '\\.')}'`));
    assert.ok(block, `مالقيتش استيراد ${file}`);
    return block[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// ═════════════════════════════════════════════════════════════
// الربط بين الملفات
// ═════════════════════════════════════════════════════════════

test('كل عنصر بيستخدمه inbox.js موجود في inbox.html', async () => {
    const [html, js] = await Promise.all([read('admin/inbox.html'), read('assets/js/admin/inbox.js')]);
    const declared = idsInHtml(html);
    // عناصر بيرسمها inbox.js بنفسه جوه innerHTML (مش في الـ HTML الثابت).
    const dynamic = new Set(['retryLoad', 'manageTeamsBtn', 'newTagName', 'createTagBtn', 'removeAttachBtn']);
    const missing = [...new Set(idsUsedByJs(js))].filter((id) => !declared.has(id) && !dynamic.has(id));
    assert.deepEqual(missing, [], `عناصر بيتنده عليها ومش موجودة: ${missing.join(', ')}`);
});

test('كل حاجة inbox.js بيستوردها من طبقة البيانات والموديل متصدّرة فعلاً', async () => {
    const [js, data, model] = await Promise.all([
        read('assets/js/admin/inbox.js'),
        read('assets/js/admin/inbox-data.js'),
        read('assets/js/admin/inbox-model.js')
    ]);
    for (const [file, src] of [['inbox-data.js', data], ['inbox-model.js', model]]) {
        const exported = exportsOf(src);
        const missing = importedNames(js, file).filter((name) => !exported.has(name));
        assert.deepEqual(missing, [], `مستورد من ${file} ومش متصدّر: ${missing.join(', ')}`);
    }
});

test('الصفحة محروسة للطاقم زي باقي صفحات الإدارة', async () => {
    const js = await read('assets/js/admin/inbox.js');
    assert.match(js, /checkAdminAuth\(\)/, 'الصفحة مش بتمر على حارس الإدارة');
});

test('الرابط في القايمة الجانبية للطاقم بس، ورابط chat-admin اتشال', async () => {
    const [sidebarHtml, sidebarJs] = await Promise.all([
        read('assets/components/sidebar.html'),
        read('assets/js/admin/sidebar.js')
    ]);

    assert.match(sidebarHtml, /id="inboxLink"[^>]*style="display:none;"/, 'اللينك مفروض يبدأ مخفي');
    assert.ok(sidebarHtml.includes('/admin/inbox.html'));
    assert.ok(!sidebarHtml.includes('chatAdminLink'), 'رابط chat-admin لسه في القايمة');
    assert.ok(!sidebarJs.includes('chatAdminLink'));

    // الصفحة محروسة بـ guardPage('admin') والـ RLS بترجّع للسوبر يوزر
    // جلساته هو بس — عرض الرابط له كان هيوديه لصفحة رفض.
    const block = sidebarJs.slice(sidebarJs.indexOf("showLink('inboxLink')") - 120, sidebarJs.indexOf("showLink('inboxLink')"));
    assert.match(block, /if \(isAdmin \|\| isSupport\)/, 'شرط عرض الرابط اتغير');
});

// ═════════════════════════════════════════════════════════════
// مفيش بيانات تجريبية
// ═════════════════════════════════════════════════════════════

test('مفيش بيانات تجريبية ولا بانر معاينة', async () => {
    const [html, js, data] = await Promise.all([
        read('admin/inbox.html'), read('assets/js/admin/inbox.js'), read('assets/js/admin/inbox-data.js')
    ]);
    assert.ok(!html.includes('previewBanner'), 'بانر المعاينة لسه موجود');
    assert.ok(!/تجريبية|وهمية/.test(html + js), 'فيه كلام عن بيانات تجريبية');
    assert.ok(!/example\.com|setPreviewRole|const CONTACTS|let conversations\s*=/.test(data + js), 'فيه بيانات مكتوبة في الكود');
    assert.match(data, /from '\/api-config\.js'/, 'طبقة البيانات مش متوصلة بـ Supabase');
});

test('الصندوق بيقرا من جداول الشات وجداول 055/056 والجداول الموجودة بس', async () => {
    const data = await read('assets/js/admin/inbox-data.js');
    const tables = new Set([...data.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1]));
    assert.deepEqual([...tables].sort(), [
        'chat_message_revisions', 'chat_sessions', 'customer_notes', 'inbox_conversation_tags', 'inbox_conversations',
        'inbox_events', 'inbox_notes', 'inbox_reactions', 'inbox_team_members', 'inbox_teams', 'tickets'
    ]);
    // الأدمن غير المرتفع مالوش SELECT على ملفات الآخرين: الأسماء من RPC مش embed.
    assert.ok(!/from\('profiles'\)|profiles:user_id/.test(data), 'قراءة مباشرة من profiles');
});

test('كل كتابة عبر RPC — مفيش insert/update/delete مباشر', async () => {
    const [data, js] = await Promise.all([read('assets/js/admin/inbox-data.js'), read('assets/js/admin/inbox.js')]);
    assert.ok(!/\.from\('[^']+'\)[\s\S]{0,120}?\.(insert|update|delete|upsert)\(/.test(data + js), 'كتابة مباشرة على جدول');

    // كل ترحيلات الصندوق من 055 وطالع — كل مرحلة بتضيف RPC.
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(root('migrations'))).filter((f) => /^0(5[5-9]|[6-9]\d)_inbox_/.test(f));
    assert.ok(files.length >= 3, `ترحيلات الصندوق: ${files}`);
    const migrations = (await Promise.all(files.map((f) => read(`migrations/${f}`)))).join('\n');
    const called = [...data.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    const missing = called.filter((name) => !new RegExp(`create or replace function public\\.${name}\\(`).test(migrations));
    assert.deepEqual(missing, [], `RPC مش موجود في ترحيلات الصندوق: ${missing.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════
// العقد مع ويدجت العميل و SIE
// ═════════════════════════════════════════════════════════════

test('رد الدعم بيوقّف البوت وبيتكتب كرد أدمن — نفس اللي الويدجت مستنيه', async () => {
    // 056 استبدلت inbox_send_reply (ضافت المرفق)، فالعقد بيتفحص على آخر تعريف.
    const [data, migration, widget] = await Promise.all([
        read('assets/js/admin/inbox-data.js'), read('migrations/056_inbox_attachments_reactions_edits.sql'), read('chat-widget.js')]);
    assert.match(data, /rpc\('inbox_send_reply'/, 'الرد مش بيعدي على inbox_send_reply');

    const fn = migration.slice(migration.indexOf('function public.inbox_send_reply'), migration.indexOf('function public._inbox_own_reply'));
    assert.ok(fn.length > 200, 'مالقيتش inbox_send_reply في 056');
    assert.match(fn, /set is_manual_mode = true/, 'الرد مش بيوقّف البوت');
    assert.match(fn, /is_admin_reply,[\s\S]{0,80}\)\s*values \(p_session, auth\.uid\(\), v_body, true,/, 'الرد مش متعلّم كرد أدمن');
    assert.ok(fn.indexOf('set is_manual_mode = true') < fn.indexOf('insert into public.chat_messages'),
        'البوت لازم يقف قبل ما الرد يتكتب، وإلا ممكن يرد على نفس الرسالة');

    // الناحية التانية من العقد: الويدجت لسه بيسمع الاتنين.
    assert.match(widget, /is_manual_mode/);
    assert.match(widget, /msg\.is_admin_reply/);
});

test('الصندوق مابيولّدش ردود بوت ولا بينادي SIE', async () => {
    const [js, data] = await Promise.all([read('assets/js/admin/inbox.js'), read('assets/js/admin/inbox-data.js')]);
    assert.ok(!/sie-client|getSieReply|chatbot-engine|getBotReply|is_bot_reply:\s*true/.test(js + data));
});

test('chat-logic.js بقى لصفحة العميل بس، ومسار SIE فيه زي ما هو', async () => {
    const src = await read('assets/js/chat-logic.js');
    assert.ok(!/loadAllChats|renderChatsList|selectChat\(/.test(src), 'منطق chat-admin لسه موجود');
    assert.match(src, /if \(!window\.isCustomerChat\) return;/);
    // SIE هو محرك الرد الوحيد في صفحة العميل (PR #90) — الصندوق مالوش دعوة بيه.
    assert.match(src, /import \{ getSieReply \} from '\/assets\/js\/sie-client\.js'/);
    assert.match(src, /await getSieReply\(/);
    assert.match(src, /fetchEntitlement\(supabase\)/);
});

// ═════════════════════════════════════════════════════════════
// مفيش روابط مكسورة للصفحة القديمة
// ═════════════════════════════════════════════════════════════

test('chat-admin.html اتشالت ومفيش صفحة بتشاور عليها', async () => {
    assert.equal(await exists('chat-admin.html'), false);
    const files = ['tickets.html', 'admin-dashboard.html', 'api-management.html', 'customer-history.js',
        'assets/components/sidebar.html', 'assets/js/admin/sidebar.js', 'assets/js/chat-logic.js'];
    for (const f of files) {
        assert.ok(!/chat-admin\.html/.test(await read(f)), `${f} لسه بيشاور على chat-admin.html`);
    }
});

test('روابط الإشعارات القديمة (chat-admin.html?session=) بتتحوّل للصندوق', async () => {
    // دالتين في القاعدة (notify_admin_on_new_chat و handle_new_chat_message)
    // لسه بيكتبوا الرابط القديم — واحدة منهم من غير / في الأول، فبيتفتح
    // نسبةً للصفحة (/admin/chat-admin.html من صفحة الإشعارات).
    const vercel = JSON.parse(await read('vercel.json'));
    const map = Object.fromEntries((vercel.redirects || []).map((r) => [r.source, r.destination]));
    assert.equal(map['/chat-admin.html'], '/admin/inbox.html');
    assert.equal(map['/admin/chat-admin.html'], '/admin/inbox.html');
});

test('شريط الكتابة بياخد سطره لوحده على الموبايل', async () => {
    const html = await read('admin/inbox.html');
    assert.match(html, /\.ib-composer-row textarea \{ order: -1; flex: 1 1 100%/);
});

// ═════════════════════════════════════════════════════════════
// الموديل: سلوك حقيقي على بيانات بشكل الجداول
// ═════════════════════════════════════════════════════════════

const model = await import(root('assets/js/admin/inbox-model.js'));

const at = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
const customerMsg = (id, min, text = 'سؤال') => ({ id, sender_id: 'u1', message_text: text, is_admin_reply: false, is_bot_reply: false, created_at: at(min) });
const botMsg = (id, min, text = 'رد آلي') => ({ id, sender_id: null, message_text: text, is_admin_reply: false, is_bot_reply: true, created_at: at(min) });
const agentMsg = (id, min, text = 'رد الدعم') => ({ id, sender_id: 'staff1', message_text: text, is_admin_reply: true, is_bot_reply: false, created_at: at(min) });
const session = (over = {}) => ({
    id: 's', user_id: 'u1', status: 'active', is_manual_mode: false,
    created_at: at(0), updated_at: at(0), customer: { full_name: 'عميل', email: 'c@x.test', role: 'customer' },
    messages: [], ...over
});

test('مين كتب الرسالة', () => {
    assert.equal(model.senderKind(customerMsg('1', 1)), 'customer');
    assert.equal(model.senderKind(botMsg('2', 2)), 'bot');
    assert.equal(model.senderKind(agentMsg('3', 3)), 'agent');
    // رسالة من غير مُرسِل ومن غير علامة = بوت (رسايل النظام في chat-logic/الويدجت)
    assert.equal(model.senderKind({ sender_id: null, message_text: 'x' }), 'bot');
});

test('«بانتظار رد»: البوت شغال', () => {
    assert.equal(model.isAwaitingReply(session({ messages: [botMsg('1', 1), customerMsg('2', 2)] })), true,
        'آخر رسالة من العميل والبوت مارديش');
    assert.equal(model.isAwaitingReply(session({ messages: [customerMsg('1', 1), botMsg('2', 2)] })), false,
        'البوت رد — مش مستنية الدعم');
});

test('«بانتظار رد»: الدعم ماسك المحادثة', () => {
    const manual = { is_manual_mode: true };
    assert.equal(model.isAwaitingReply(session({ ...manual, messages: [agentMsg('1', 1), customerMsg('2', 2), botMsg('3', 3)] })), true,
        'رسالة نظام بعد رسالة العميل مش رد عليه');
    assert.equal(model.isAwaitingReply(session({ ...manual, messages: [customerMsg('1', 1), agentMsg('2', 2)] })), false);
    assert.equal(model.isAwaitingReply(session({ status: 'closed', messages: [customerMsg('1', 1)] })), false,
        'المقفولة مش مستنية رد');
});

test('محادثات الفريق فوق، وبعدين الأحدث', () => {
    const old = session({ id: 'old', messages: [customerMsg('1', 1)] });
    const recent = session({ id: 'recent', messages: [customerMsg('2', 30)] });
    const staff = session({ id: 'staff', customer: { full_name: 'موظف', role: 'support' }, messages: [customerMsg('3', 0)] });
    assert.deepEqual(model.filterSessions([old, recent, staff]).map((s) => s.id), ['staff', 'recent', 'old']);
});

test('البحث بيدوّر في نص الرسايل مش في الاسم بس', () => {
    const s = session({ messages: [customerMsg('1', 1, 'مشكلة في ربط الواتساب')] });
    assert.equal(model.matchesQuery(s, 'الواتساب'), true);
    assert.equal(model.matchesQuery(s, 'c@x.test'), true);
    assert.equal(model.matchesQuery(s, 'فاتورة'), false);
});

test('عدّادات المشاهد بتطابق اللي بيترجع فعلاً', () => {
    const list = [
        session({ id: 'a', messages: [customerMsg('1', 1)] }),
        session({ id: 'b', is_manual_mode: true, messages: [agentMsg('2', 2)] }),
        session({ id: 'c', status: 'closed' })
    ];
    const counts = model.viewCounts(list);
    for (const view of model.VIEWS) {
        assert.equal(counts[view], model.filterSessions(list, { view }).length, `عدّاد «${view}» غلط`);
    }
    assert.equal(counts.manual, 1);
    assert.equal(counts.bot, 1);
    assert.equal(counts.closed, 1);
});

test('الزائر ليه اسم واضح', () => {
    assert.equal(model.displayName(session({ user_id: null, customer: null })), 'زائر');
    assert.equal(model.displayName(session({ customer: { email: 'only@mail.test' } })), 'only@mail.test');
});

test('الرد الجاهز بيتملي باسم العميل', () => {
    const filled = model.fillCannedReply('أهلاً {{الاسم}} و {{ name }}', session({ customer: { full_name: 'سارة' } }));
    assert.equal(filled, 'أهلاً سارة و سارة');
});

test('الرابط المباشر بيقبل الشكلين القديم والجديد', () => {
    assert.equal(model.sessionIdFromSearch('?session=abc'), 'abc');
    assert.equal(model.sessionIdFromSearch('?session_id=xyz'), 'xyz');
    assert.equal(model.sessionIdFromSearch(''), null);
});

test('الرسايل بتترتب زمنيًا حتى لو الـ embed رجّعها بترتيب تاني', () => {
    const sorted = model.sortMessages([customerMsg('b', 5), botMsg('a', 1)]);
    assert.deepEqual(sorted.map((m) => m.id), ['a', 'b']);
    assert.equal(model.lastMessageOf(session({ messages: sorted })).id, 'b');
});

// ═════════════════════════════════════════════════════════════
// الموديل: طبقة الـ helpdesk
// ═════════════════════════════════════════════════════════════

test('الأرشفة بتتلغي من نفسها لو العميل كتب بعدها', () => {
    const archived = session({ meta: { archived_at: at(5) }, messages: [customerMsg('1', 1), agentMsg('2', 3)] });
    assert.equal(model.isArchived(archived), true);
    assert.equal(model.matchesView(archived, 'all'), false, 'المؤرشفة ظاهرة في الكل');
    assert.equal(model.matchesView(archived, 'archived'), true);

    const revived = session({ meta: { archived_at: at(5) }, messages: [customerMsg('1', 1), customerMsg('3', 9)] });
    assert.equal(model.isArchived(revived), false, 'العميل كتب بعد الأرشفة والمحادثة لسه مخفية');
    // رد البوت بعد الأرشفة مش سبب يرجّعها
    const botAfter = session({ meta: { archived_at: at(5) }, messages: [customerMsg('1', 1), botMsg('2', 9)] });
    assert.equal(model.isArchived(botAfter), true);
});

test('مشاهد المسندة لي وفرقي ومن غير مسؤول', () => {
    const ctx = { meId: 'me', myTeamIds: ['t1'] };
    const mine = session({ id: 'm', meta: { assignee_id: 'me' } });
    const team = session({ id: 't', meta: { team_id: 't1' } });
    const other = session({ id: 'o', meta: { assignee_id: 'x' } });
    const free = session({ id: 'f' });
    const list = [mine, team, other, free];
    assert.deepEqual(model.filterSessions(list, { view: 'mine', ctx }).map((s) => s.id), ['m']);
    assert.deepEqual(model.filterSessions(list, { view: 'team', ctx }).map((s) => s.id), ['t']);
    assert.deepEqual(model.filterSessions(list, { view: 'unassigned', ctx }).map((s) => s.id), ['f']);
    const counts = model.viewCounts(list, ctx);
    for (const view of model.VIEWS) {
        assert.equal(counts[view], model.filterSessions(list, { view, ctx }).length, `عدّاد «${view}» غلط`);
    }
});

test('البحث بيلاقي المحادثة باسم الوسم', () => {
    const s = session({ tagIds: ['tg'] });
    assert.equal(model.matchesQuery(s, 'فوترة', { tg: 'فوترة' }), true);
    assert.equal(model.matchesQuery(s, 'فوترة', {}), false);
});

test('الخط الزمني بيدمج الرسايل والملاحظات والأحداث بالترتيب', () => {
    const tl = model.buildTimeline(
        [customerMsg('m1', 1), agentMsg('m2', 5)],
        [{ id: 'n1', body: 'ملاحظة', created_at: at(3) }],
        [{ id: 1, kind: 'assigned', payload: {}, created_at: at(2) },
         { id: 2, kind: 'note_added', payload: {}, created_at: at(3) }]);
    assert.deepEqual(tl.map((e) => `${e.type}:${e.item.id}`), ['message:m1', 'event:1', 'note:n1', 'message:m2'],
        'حدث note_added مفروض مايتكررش جنب الملاحظة نفسها');
});

test('وصف الأحداث بالعربي بأسماء حقيقية', () => {
    const names = { actor: () => 'هبة', agent: (id) => ({ u1: 'كريم' }[id]), team: (id) => ({ t1: 'الفوترة' }[id]) };
    assert.equal(model.describeEvent({ kind: 'transferred', payload: { to_team: 't1', reason: 'فاتورة' } }, names),
        'هبة حوّل المحادثة لـ فريق الفوترة — فاتورة');
    assert.equal(model.describeEvent({ kind: 'assigned', payload: { to_user: 'u1' } }, names), 'هبة أسند المحادثة لـ كريم');
    assert.equal(model.describeEvent({ kind: 'unarchived', payload: { reason: 'reply' } }, names), 'المحادثة رجعت من الأرشيف بالرد');
});

test('المنشن بالاسم الكامل بس', () => {
    const agents = [{ id: 'a', full_name: 'أحمد علي' }, { id: 'b', full_name: 'أحمد' }, { id: 'c', full_name: null }];
    assert.deepEqual(model.extractMentions('يا @أحمد علي بص', agents), ['a'], '«@أحمد» اتلقطت جوه «@أحمد علي»');
    assert.deepEqual(model.extractMentions('@أحمد و @أحمد علي', agents).sort(), ['a', 'b']);
    assert.deepEqual(model.extractMentions('@أحمدين', agents), [], 'اسم ناقص اتحسب منشن');
    assert.deepEqual(model.extractMentions('من غير منشن', agents), []);
});

// ═════════════════════════════════════════════════════════════
// المرحلة 2 (056)
// ═════════════════════════════════════════════════════════════

test('رموز التفاعل في الواجهة هي نفس القايمة المقفولة في القاعدة', async () => {
    const [{ REACTION_EMOJI }, migration] = await Promise.all([
        import('../inbox-model.js'), read('migrations/056_inbox_attachments_reactions_edits.sql')]);
    const sql = migration.match(/p_emoji = any \(array\[([^\]]+)\]\)/);
    assert.ok(sql, 'مالقيتش قايمة الرموز في inbox_toggle_reaction');
    const allowed = [...sql[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // رمز في الواجهة مش في القاعدة = زرار بيرجع خطأ دايمًا.
    assert.deepEqual([...REACTION_EMOJI], allowed);
});

test('تعديل/حذف في الواجهة بنفس شروط القاعدة: رد دعم بس، والتعديل لصاحبه', async () => {
    const { canEditMessage, canDeleteMessage } = await import('../inbox-model.js');
    const reply = { id: 'm', is_admin_reply: true, sender_id: 'me', deleted_at: null };
    assert.equal(canEditMessage(reply, 'me'), true);
    assert.equal(canEditMessage(reply, 'other'), false, 'تعديل رد زميل');
    assert.equal(canDeleteMessage(reply, 'other', false), false);
    assert.equal(canDeleteMessage(reply, 'other', true), true, 'المرتفع يحذف');
    for (const m of [{ ...reply, is_admin_reply: false }, { ...reply, is_admin_reply: false, is_bot_reply: true }, { ...reply, deleted_at: 'x' }]) {
        assert.equal(canEditMessage(m, 'me'), false);
        assert.equal(canDeleteMessage(m, 'me', true), false);
    }
});

test('canActOn بنفس قرار inbox_can_access: المشرف الكل، وغيره المسند له أو لفريقه', async () => {
    const { canActOn } = await import('../inbox-model.js');
    const ctx = { meId: 'me', myTeamIds: ['t1'], supervisor: false };
    assert.equal(canActOn({ meta: { assignee_id: 'me' } }, ctx), true);
    assert.equal(canActOn({ meta: { assignee_id: 'x', team_id: 't1' } }, ctx), true);
    assert.equal(canActOn({ meta: { assignee_id: 'x', team_id: 't2' } }, ctx), false);
    // محادثتي كعميل (سياسة «جلساتي») من غير إسناد — مش للصندوق
    assert.equal(canActOn({ user_id: 'me', meta: null }, ctx), false);
    assert.equal(canActOn({ user_id: 'me', meta: null }, { ...ctx, supervisor: true }), true);
    assert.equal(canActOn({ meta: { assignee_id: null, team_id: null } }, { meId: 'me' }), false);
});
