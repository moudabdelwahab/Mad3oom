/**
 * بريد التذاكر — القالب (_shared/ticket-email.js)، ومنطق send-ticket-email (handler.js) بقاعدة ومزوّد بديلين،
 * وربط wf-executor بالقالب، ورجوع زر «عرض التذكرة» إلى التذكرة بعد الدخول (page-guard.js + login.html).
 *
 * يثبت: الحالات = قيد tickets_status_check كما هو؛ البيانات من صف التذكرة لا من الحمولة؛ لا رسالة لتذكرة
 * غير موجودة أو حالة تغيّرت بعد الحدث أو رد داخلي؛ كل نص من خارج القالب مهرَّب؛ الرابط = معرّف التذكرة
 * وحده على أصل الموقع المضبوط؛ القالب بجداول وCSS مضمّن بلا JavaScript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    ticketEmail, ticketUrl, statusEventKind, formatDateTime, TICKET_STATUSES, EMAIL_EVENTS, LOGO_PATH, esc, oneLine, htmlToText
} from '../supabase/functions/_shared/ticket-email.js';
import { handleTicketEmail, safeEqual, recipientName } from '../supabase/functions/send-ticket-email/handler.js';
import { ticketEmailData, TicketDataError } from '../supabase/functions/_shared/ticket-email-data.js';
import { emailConfig } from '../supabase/functions/_shared/email.js';

const plain = htmlToText;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const TID = '0b8c2f4e-1a2b-4c3d-8e9f-0123456789ab';
const OWNER = '11111111-2222-4333-8444-555555555555';
const STAFF = '99999999-2222-4333-8444-555555555555';
const RID = 'aaaaaaaa-2222-4333-8444-555555555555';

const TICKET = Object.freeze({
    id: TID, ticket_number: 1122, title: 'خطأ في إرسال رسالة', status: 'resolved', ticket_type: 'problem',
    category: 'whatsapp', created_at: '2026-10-23T16:54:00Z', last_updated_at: '2026-10-25T12:53:00Z',
    user_id: OWNER, scope: 'mad3oom_support', company_id: null
});

/* ── الحالات: مطابقة قيد القاعدة ──────────────────────────────────────────── */

test('الحالات المعتمدة = قيد tickets_status_check في لقطة الإنتاج، لكل منها اسم ولون', () => {
    const tables = read('tests/fixtures/prod-shape/20_constraints.sql');
    const m = tables.match(/tickets_status_check CHECK \(\(status = ANY \(ARRAY\[([^\]]+)\]/);
    assert.ok(m, 'قيد الحالة غير موجود في اللقطة');
    const db = [...m[1].matchAll(/'([^']+)'::text/g)].map(x => x[1]).sort();
    assert.deepEqual(Object.keys(TICKET_STATUSES).sort(), db);
    for (const [k, s] of Object.entries(TICKET_STATUSES)) {
        assert.ok(s.ar && s.en && /^#[0-9A-F]{6}$/.test(s.bg) && /^#[0-9A-F]{6}$/.test(s.fg), k);
    }
    // أسماء لوحة العميل نفسها (assets/js/customer/ticket-view-model.js)
    const vm = read('assets/js/customer/ticket-view-model.js');
    for (const k of ['open', 'in-progress', 'resolved', 'confirmed', 'rejected']) {
        assert.ok(vm.includes(`label: '${TICKET_STATUSES[k].ar}'`), `${k}: الاسم يختلف عن لوحة العميل`);
    }
});

test('نوع رسالة تغيّر الحالة من الحالتين الفعليتين', () => {
    assert.equal(statusEventKind('open', 'resolved'), 'resolved');
    assert.equal(statusEventKind('resolved', 'confirmed'), 'closed');
    assert.equal(statusEventKind('in-progress', 'closed'), 'closed');
    assert.equal(statusEventKind('resolved', 'open'), 'reopened');
    assert.equal(statusEventKind('rejected', 'in-progress'), 'reopened');
    assert.equal(statusEventKind('open', 'in-progress'), 'status');
    assert.equal(statusEventKind('open', 'rejected'), 'status');
    assert.equal(statusEventKind(null, 'open'), 'status');   // حمولة ما قبل 114
});

/* ── القالب ───────────────────────────────────────────────────────────────── */

test('تحديث الحالة: الرقم والحالة الفعلية والتفاصيل والزر والشعار، بلا قيم ثابتة', () => {
    const r = ticketEmail({ event: 'resolved', ticket: TICKET, recipientName: 'محمود عبدالوهاب', companyName: 'Al Bir Charity Association',
                            siteOrigin: 'https://mad3oom.com' });
    assert.equal(r.subject, 'تم حل التذكرة #1122');
    assert.equal(r.url, `https://mad3oom.com/customer-dashboard.html?ticket=${TID}`);
    const h = r.html;
    assert.ok(h.startsWith('<!doctype html>'));
    assert.match(h, /<html lang="ar" dir="rtl"/);
    assert.ok(h.includes('مرحبًا محمود عبدالوهاب،'));
    assert.ok(h.includes('#1122'));
    assert.ok(h.includes('تم الحل') && h.includes(TICKET_STATUSES.resolved.bg), 'بطاقة الحالة');
    assert.ok(h.includes('خطأ في إرسال رسالة'));
    assert.ok(h.includes('Al Bir Charity Association'));
    assert.ok(h.includes('واتساب') && h.includes('مشكلة'), 'القسم ونوع الطلب');
    assert.ok(plain(h).includes('23/10/2026 - 7:54 مساءً'), 'تاريخ الإنشاء بتوقيت القاهرة (صيفي، UTC+3)');
    assert.ok(plain(h).includes('25/10/2026 - 3:53 مساءً'), 'آخر تحديث');
    assert.ok(h.includes(`href="https://mad3oom.com/customer-dashboard.html?ticket=${TID}"`));
    assert.ok(h.includes('عرض التذكرة'));
    assert.ok(h.includes(`src="https://mad3oom.com${LOGO_PATH}"`));
    assert.ok(h.includes('فريق مدعوم'));
    // البديل النصي
    assert.ok(r.text.includes('#1122') && r.text.includes('تم الحل') && r.text.includes(r.url));
});

test('حقل غائب = لا صف له (لا قيم مضللة)', () => {
    const t = { ...TICKET, category: null, last_updated_at: null, ticket_type: undefined };
    const h = ticketEmail({ event: 'status', ticket: t, siteOrigin: 'https://mad3oom.com', now: new Date('2026-10-26T10:00:00Z') }).html;
    for (const label of ['اسم الشركة', 'القسم', 'نوع الطلب', 'آخر تحديث']) assert.ok(!h.includes(`>${label}<`), label);
    assert.ok(h.includes('مرحبًا،'), 'بلا اسم = تحية بلا اسم');
    assert.ok(plain(h).includes('26/10/2026 - 1:00 مساءً'), 'وقت التحديث = وقت الإرسال حين لا last_updated_at');
});

test('التهريب: عنوان التذكرة واسم العميل والشركة ونص الرد لا يُحقن منها HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = ticketEmail({ event: 'reply', ticket: { ...TICKET, title: `${evil}\nسطر` }, recipientName: evil, companyName: evil,
                            replyText: `أهلًا\n${evil}\n<script>x()</script>` });
    assert.ok(!r.html.includes('<img src=x') && !r.html.includes('<script>'), 'HTML محقون');
    assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(r.html.includes('أهلًا<br>'), 'أسطر الرد');
    assert.ok(!/\n/.test(r.subject), 'سطر جديد في الموضوع');
    assert.equal(oneLine('a\r\nBcc: x@y.z'), 'a Bcc: x@y.z');
});

test('الرابط: معرّف التذكرة وحده، https، والمعرّف غير الصالح بلا زر', () => {
    assert.equal(ticketUrl('https://preview.mad3oom.com/some/path', TID), `https://preview.mad3oom.com/customer-dashboard.html?ticket=${TID}`);
    assert.equal(ticketUrl('http://localhost:3000', TID), `https://mad3oom.com/customer-dashboard.html?ticket=${TID}`, 'لا http');
    assert.equal(ticketUrl('https://mad3oom.com', '1122'), null, 'رقم التذكرة ليس معرّفًا');
    assert.equal(ticketUrl('https://mad3oom.com', `${TID}&x=1`), null);
    const noNumber = ticketEmail({ event: 'status', ticket: { ...TICKET, ticket_number: null } });
    assert.ok(!noNumber.html.includes('<span dir="ltr" style="color:#0077CC;font-weight:800;">#</span>'), 'رقم فارغ مميَّز');
    assert.ok(!plain(noNumber.html).includes('رقم التذكرة#'), 'صف رقم فارغ');
    const r = ticketEmail({ event: 'status', ticket: { ...TICKET, id: 'nope' } });
    assert.equal(r.url, null);
    assert.ok(!r.html.includes('عرض التذكرة</a>'));
});

test('كل الأحداث: قالب واحد (رأس، تحية، تذييل) بجداول وCSS مضمّن، بلا JavaScript ولا Flex/Grid', () => {
    for (const event of EMAIL_EVENTS) {
        const r = ticketEmail({ event, ticket: TICKET, recipientName: 'سارة', replyText: 'رد', messageHtml: '<p>رسالة</p>', subject: 'موضوع' });
        const h = r.html;
        assert.ok(r.subject.trim(), event);
        assert.ok(h.includes('role="presentation"') && h.includes('max-width:600px'), `${event}: تخطيط الجداول`);
        assert.ok(h.includes('مدعوم') && h.includes('منصة دعم وإدارة العملاء') && h.includes('فريق مدعوم'), `${event}: الهوية`);
        assert.doesNotMatch(h, /<script|javascript:|\son\w+="/i, event);
        assert.doesNotMatch(h, /display:\s*(flex|grid)/i, event);
        assert.match(h, /@media only screen and \(max-width:620px\)/, `${event}: الشاشات الصغيرة`);
        assert.ok(h.includes('<!--[if mso]>'), `${event}: Outlook`);
    }
    // custom بلا تذكرة: لا بطاقة حالة ولا زر
    const custom = ticketEmail({ event: 'custom', ticket: TICKET, subject: 'إعلان', messageHtml: '<b>مرحبا</b>' });
    assert.equal(custom.url, null);
    assert.equal(custom.subject, 'إعلان');
    assert.ok(custom.html.includes('<b>مرحبا</b>') && !custom.html.includes('الحالة الحالية'));
});

test('الإنجليزية: LTR ونصوص إنجليزية، والعربية افتراضية', () => {
    const en = ticketEmail({ event: 'created', ticket: { ...TICKET, status: 'open' }, recipientName: 'Sara', locale: 'en-US' });
    assert.match(en.html, /<html lang="en" dir="ltr"/);
    assert.ok(en.subject.startsWith('Ticket #1122 received'));
    assert.ok(en.html.includes('View ticket') && en.html.includes('Open'));
    assert.match(ticketEmail({ event: 'created', ticket: TICKET, locale: 'fr' }).html, /dir="rtl"/);
    assert.equal(formatDateTime('not a date'), '');
    assert.equal(formatDateTime('2026-10-23T16:54:00Z', 'en'), '23/10/2026 - 7:54 PM');
    assert.equal(formatDateTime('2026-12-01T06:05:00Z'), '01/12/2026 - 8:05 صباحًا', 'شتاءً UTC+2');
});

/* ── المعالج: البيانات من القاعدة ─────────────────────────────────────────── */

function deps(over = {}) {
    const calls = { send: [], mailbox: [], log: [], reads: [] };
    const db = {
        tickets: { [TID]: { ...TICKET } },
        profiles: { [OWNER]: { email: 'owner@example.test', full_name: 'محمود عبدالوهاب' } },
        replies: { [RID]: { id: RID, ticket_id: TID, user_id: STAFF, message: 'تم إصلاح المشكلة', is_internal: false } },
        ...over.db
    };
    const d = {
        data: {
            getTicket: async (id) => { calls.reads.push(['ticket', id]); return db.tickets[id] || null; },
            getProfile: async (id) => db.profiles[id] || null,
            getCompanyName: async (t) => over.company !== undefined ? over.company : (t.scope === 'company' ? 'شركة العميل' : null),
            getReply: async (id) => db.replies[id] || null
        },
        mail: emailConfig((k) => ({ RESEND_API_KEY: 're_test_xxxxxxxxxxxxxxxxxxxx', EMAIL_SENDER_DOMAIN: 'mad3oom.com' })[k]),
        send: async (m) => { calls.send.push(m); return over.send ? over.send(m) : { ok: true, id: 'em_1', status: 200 }; },
        logMailbox: async (row) => { calls.mailbox.push(row); },
        siteOrigin: 'https://mad3oom.com',
        log: (e) => calls.log.push(e)
    };
    return { d, calls, db };
}

test('UPDATE: المستلم والحالة من صف التذكرة، لا من الحمولة', async () => {
    const { d, calls } = deps();
    const r = await handleTicketEmail({ event: 'UPDATE', ticket_id: TID, status: 'resolved', previous_status: 'in-progress',
                                        customer_email: 'attacker@evil.test', title: 'عنوان مزيف', ticket_number: 1 }, d);
    assert.deepEqual(r, { status: 200, body: { success: true, data: { id: 'em_1' } } });
    const m = calls.send[0];
    assert.equal(m.to, 'owner@example.test');
    assert.equal(m.from, 'info@mad3oom.com');
    assert.equal(m.subject, 'تم حل التذكرة #1122');
    assert.ok(m.html.includes('خطأ في إرسال رسالة') && !m.html.includes('عنوان مزيف'));
    assert.ok(m.text.includes('#1122'));
    assert.equal(calls.mailbox[0].status, 'sent');
    assert.equal(calls.mailbox[0].to_email, 'owner@example.test');
    assert.equal(calls.mailbox[0].related_user_id, OWNER);
});

test('UPDATE بعد تغيّر الحالة مرة أخرى (أو تذكرة لم تُحفظ) ⇒ لا رسالة', async () => {
    const { d, calls } = deps();
    assert.deepEqual((await handleTicketEmail({ event: 'UPDATE', ticket_id: TID, status: 'open' }, d)).body,
                     { success: true, skipped: 'stale_status' });
    const missing = '22222222-2222-4333-8444-555555555555';
    assert.deepEqual((await handleTicketEmail({ event: 'INSERT', ticket_id: missing, status: 'open' }, d)).body,
                     { success: true, skipped: 'ticket_not_found' });
    assert.equal(calls.send.length, 0);
    assert.equal(calls.mailbox.length, 0);
});

test('إعادة الفتح والإغلاق والإنشاء: نوع الرسالة الصحيح', async () => {
    const { d, calls, db } = deps();
    db.tickets[TID].status = 'open';
    await handleTicketEmail({ event: 'UPDATE', ticket_id: TID, status: 'open', previous_status: 'resolved' }, d);
    db.tickets[TID].status = 'confirmed';
    await handleTicketEmail({ event: 'UPDATE', ticket_id: TID, status: 'confirmed', previous_status: 'resolved' }, d);
    db.tickets[TID].status = 'open';
    await handleTicketEmail({ event: 'INSERT', ticket_id: TID, status: 'open' }, d);
    assert.deepEqual(calls.send.map(m => m.subject),
                     ['إعادة فتح التذكرة #1122', 'تم إغلاق التذكرة #1122', 'تم استلام تذكرتك #1122: خطأ في إرسال رسالة']);
    assert.equal(calls.send[2].idempotencyKey, `ticket-created/${TID}`);
});

test('REPLY: الرد يُقرأ بمعرّفه، والداخلي أو رد صاحب التذكرة أو رد تذكرة أخرى ⇒ لا رسالة', async () => {
    const { d, calls, db } = deps();
    await handleTicketEmail({ event: 'REPLY', ticket_id: TID, reply_id: RID, message: 'نص مزيف' }, d);
    assert.equal(calls.send.length, 1);
    assert.ok(calls.send[0].html.includes('تم إصلاح المشكلة') && !calls.send[0].html.includes('نص مزيف'));
    assert.equal(calls.send[0].idempotencyKey, `ticket-reply/${RID}`);
    assert.equal(calls.mailbox[0].text_body, 'تم إصلاح المشكلة');

    for (const patch of [{ is_internal: true }, { user_id: OWNER }, { ticket_id: '33333333-2222-4333-8444-555555555555' }]) {
        db.replies[RID] = { ...db.replies[RID], ...patch };
        const r = await handleTicketEmail({ event: 'REPLY', ticket_id: TID, reply_id: RID }, d);
        assert.equal(r.body.skipped, 'reply_not_public', JSON.stringify(patch));
        db.replies[RID] = { id: RID, ticket_id: TID, user_id: STAFF, message: 'تم إصلاح المشكلة', is_internal: false };
    }
    assert.equal(calls.send.length, 1);

    // محفّز ما قبل 114 (بلا reply_id): نص الحمولة مهرَّبًا
    await handleTicketEmail({ event: 'REPLY', ticket_id: TID, message: '<b>قديم</b>' }, d);
    assert.ok(calls.send[1].html.includes('&lt;b&gt;قديم&lt;/b&gt;'));
});

test('تذكرة شركة: اسم الشركة المختومة عليها، وصاحب بلا بريد ⇒ لا رسالة', async () => {
    const { d, calls, db } = deps();
    db.tickets[TID] = { ...TICKET, status: 'in-progress', scope: 'company', company_id: '44444444-2222-4333-8444-555555555555' };
    await handleTicketEmail({ event: 'UPDATE', ticket_id: TID, status: 'in-progress', previous_status: 'open' }, d);
    assert.ok(calls.send[0].html.includes('شركة العميل'));
    db.profiles[OWNER] = { email: null };
    assert.equal((await handleTicketEmail({ event: 'INSERT', ticket_id: TID }, d)).body.skipped, 'no_recipient');
});

test('CUSTOM: رسالة الطاقم داخل القالب، والمرسل من صناديق المنصة وحدها، وفشل المزوّد مسجَّل', async () => {
    const { d, calls } = deps({ send: () => ({ ok: false, code: 'rate_limited', status: 429, detail: '429' }) });
    const r = await handleTicketEmail({ event: 'CUSTOM', customer_email: 'c@example.test', customer_name: 'علي', subject: 'إعلان',
                                        message: '<p>محتوى</p>', from_email: 'support@mad3oom.online' }, d);
    assert.equal(r.status, 400);
    assert.equal(calls.send[0].from, 'support@mad3oom.com');
    assert.ok(calls.send[0].html.includes('<p>محتوى</p>') && calls.send[0].html.includes('مرحبًا علي،'));
    assert.equal(calls.mailbox[0].status, 'failed');
    assert.match(calls.mailbox[0].error_message, /rate_limited/);

    const bad = await handleTicketEmail({ event: 'CUSTOM', customer_email: 'c@example.test', from_email: 'ceo@mad3oom.com' }, d);
    assert.deepEqual(bad, { status: 400, body: { error: 'عنوان المرسل غير مسموح به' } });
    assert.equal((await handleTicketEmail({ event: 'DROP' }, d)).status, 400);
    assert.equal((await handleTicketEmail({ event: 'UPDATE', ticket_id: '1122' }, d)).body.error, 'ticket_id is missing');
});

test('أدوات صغيرة: مقارنة السر واسم المخاطبة', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), false);
    assert.equal(recipientName({ full_name: '  ' , first_name: 'سارة', last_name: 'أحمد' }), 'سارة أحمد');
    assert.equal(recipientName(null), '');
    assert.equal(esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

test('البديل النصي: لا وسم ينجو من التنظيف، ولو متداخلًا', () => {
    assert.equal(htmlToText('<scr<b>ipt>alert(1)</scr</b>ipt>'), 'alert(1)');
    assert.equal(htmlToText('<<b>script>x'), 'x');
    assert.equal(htmlToText('أ<br>ب</p>ج &amp; &quot;د&quot; &lt;b&gt;'), 'أ\nب\nج & "د" &lt;b&gt;');
    const r = ticketEmail({ event: 'workflow', ticket: TICKET, messageHtml: '<p>مرحبا</p><scr<b>ipt>x</script>' });
    assert.doesNotMatch(r.text, /[<>]/);
    assert.ok(r.text.includes('مرحبا'));
});

test('تعذّر قراءة القاعدة ⇒ 503 وسجل خطأ، لا «غير موجودة» صامتة', async () => {
    for (const failing of ['getTicket', 'getProfile', 'getReply']) {
        const { d, calls } = deps();
        d.data[failing] = async () => { throw new TicketDataError(failing, { code: '57014' }); };
        const r = await handleTicketEmail({ event: 'REPLY', ticket_id: TID, reply_id: RID }, d);
        assert.deepEqual(r, { status: 503, body: { error: 'تعذّرت قراءة بيانات التذكرة' } }, failing);
        assert.equal(calls.send.length, 0, failing);
        assert.equal(calls.log.at(-1).event, 'ticket_email_read_failed', failing);
        assert.equal(calls.log.at(-1).code, '57014', failing);
    }
    // اسم الشركة اختياري: تعذّر قراءته لا يوقف البريد
    const { d, calls } = deps();
    d.data.getCompanyName = async () => { throw new TicketDataError('companies', { code: '57014' }); };
    assert.equal((await handleTicketEmail({ event: 'INSERT', ticket_id: TID }, d)).status, 200);
    assert.equal(calls.send.length, 1);
});

/* ── مصدر البيانات الموحّد ────────────────────────────────────────────────── */

function fakeDb(rows) {
    const q = [];
    const db = {
        from(table) {
            const state = { table, filters: [], select: null };
            q.push(state);
            const chain = {
                select(cols) { state.select = cols; return chain; },
                eq(col, val) { state.filters.push([col, val]); return chain; },
                order() { return chain; },
                limit() { return chain; },
                async maybeSingle() {
                    if (rows.__error?.[table]) return { data: null, error: rows.__error[table] };
                    const r = (rows[table] || []).find(x => state.filters.every(([c, v]) => x[c] === v));
                    return { data: r || null, error: null };
                }
            };
            return chain;
        }
    };
    return { db, q };
}

test('ticketEmailData: الشركة المختومة لتذكرة الشركة، وشركة المالك لتذكرة المنصة، ولا وصف التذكرة', async () => {
    const { db, q } = fakeDb({
        tickets: [{ ...TICKET, description: 'سر' }],
        companies: [{ id: 'c1', user_id: 'x', company_name: 'شركة أ' }, { id: 'c2', user_id: OWNER, company_name: 'شركة المالك' }]
    });
    const data = ticketEmailData(db);
    await data.getTicket(TID);
    assert.doesNotMatch(q[0].select, /description/);
    assert.equal(await data.getCompanyName({ scope: 'company', company_id: 'c1', user_id: OWNER }), 'شركة أ');
    assert.equal(await data.getCompanyName({ scope: 'mad3oom_support', company_id: null, user_id: OWNER }), 'شركة المالك');
    assert.equal(await data.getCompanyName({ scope: 'mad3oom_support', company_id: null, user_id: 'nobody' }), null);
    // خطأ القراءة يُرمى ولا يُعاد null
    const broken = ticketEmailData(fakeDb({ __error: { tickets: { code: '57014', message: 'timeout' } } }).db);
    await assert.rejects(broken.getTicket(TID), (e) => e instanceof TicketDataError && e.table === 'tickets' && e.code === '57014');
    assert.equal(await ticketEmailData(fakeDb({}).db).getTicket(TID), null, 'غياب الصف ليس خطأ');
});

/* ── الربط ───────────────────────────────────────────────────────────────── */

test('send-ticket-email وخطوات بريد سير العمل تمر بالقالب ومصدر البيانات الموحّدين', () => {
    const fn = read('supabase/functions/send-ticket-email/index.ts');
    assert.match(fn, /from "\.\/handler\.js"/);
    assert.match(fn, /ticketEmailData\(db\)/);
    assert.match(fn, /safeEqual\(secretRow\.value, internalSecret\)/);
    assert.doesNotMatch(fn, /<div|<h2|statusMap/, 'HTML مضمَّن في الدالة');
    const wf = read('supabase/functions/wf-executor/index.ts');
    assert.match(wf, /from "\.\.\/_shared\/ticket-email\.js"/);
    for (const h of ['h_send_email', 'h_send_satisfaction_survey']) {
        const body = wf.slice(wf.indexOf(`async function ${h}(`), wf.indexOf('\n}\n', wf.indexOf(`async function ${h}(`)));
        assert.match(body, /workflowTicketEmail\(ctx\.db, cfg\.ticket_id/, h);
        assert.match(body, /body: content\.html/, h);
    }
});

test('114: المحفّزان يضيفان previous_status وreply_id فقط، والتراجع = نص الإنتاج حرفيًا', () => {
    const up = read('migrations/114_ticket_email_payload.sql');
    const down = read('migrations/_rollback/114_ticket_email_payload.down.sql');
    const prod = read('tests/fixtures/prod-shape/51_functions_b.sql');
    const prodText = prod.slice(prod.indexOf('CREATE OR REPLACE FUNCTION public.notify_ticket_event()'),
                                prod.indexOf('CREATE OR REPLACE FUNCTION public.otp_attempt_gate')).trim();
    assert.ok(down.includes(prodText), 'التراجع ليس نص الإنتاج');
    const body = up.slice(up.indexOf('CREATE OR REPLACE'));
    const normalized = body.replace("        'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,\n", '')
                           .replace("            'reply_id', NEW.id,\n", '').trim();
    assert.equal(normalized, prodText, '114 يغيّر أكثر من مفتاحَي الحمولة');
});

test('زر «عرض التذكرة» بلا جلسة ⇒ الدخول ⇒ التذكرة نفسها', async () => {
    const guard = read('assets/js/page-guard.js');
    assert.match(guard, /location\.replace\(LOGIN_PATH \+ returnQuery\(\)\)/);
    // returnQuery خالصة: تُقيَّم هنا بلا متصفح
    const src = guard.slice(guard.indexOf('export function returnQuery'), guard.indexOf('\n}\n', guard.indexOf('export function returnQuery')) + 2);
    const returnQuery = new Function('LOGIN_PATH', `${src.replace('export ', '')}; return returnQuery;`)('/login.html');
    assert.equal(returnQuery({ pathname: '/customer-dashboard.html', search: `?ticket=${TID}`, hash: '' }),
                 `?redirect=${encodeURIComponent(`/customer-dashboard.html?ticket=${TID}`)}`);
    assert.equal(returnQuery({ pathname: '/', search: '', hash: '' }), '');
    assert.equal(returnQuery({ pathname: '/login.html', search: '?x', hash: '' }), '');

    const login = read('login.html');
    const allowed = login.slice(login.indexOf('function isAllowedRedirectTarget'), login.indexOf('// Builds the final post-login destination'));
    assert.match(allowed, /u\.origin === window\.location\.origin\) return true/);
    assert.ok(allowed.indexOf("u.protocol !== 'https:'") < allowed.indexOf('u.origin === window.location.origin'),
              'فحص البروتوكول قبل قبول الأصل نفسه');
    // اللوحة تفتح ?ticket= بعد الحارس (والرؤية بعدها لـ RLS)
    const dash = read('customer-dashboard.js');
    assert.ok(dash.indexOf("params.get('ticket')") > dash.indexOf("await guardPage('user')"));
});

test('شعار البريد موجود في المستودع وصغير (يُخدم من أصل الموقع)', () => {
    const png = readFileSync(new URL(`..${LOGO_PATH}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.length < 40_000, `${png.length} بايت`);
});
