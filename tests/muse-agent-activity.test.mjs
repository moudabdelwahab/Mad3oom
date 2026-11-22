/**
 * اختبارات صفحتي الوكيل الداخلي في لوحة المالك:
 * سجل نشاط الوكيل (owner/muse-activity-log.html) وصفحة تفعيل الوكيل
 * لحسابات تانية (owner/muse-activations.html).
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • السجل: الصفحة تقرأ agent_activity_log وحدها — لا ai_sessions ولا
 *    ai_session_messages ولا أي جدول شات عملاء أو SIE؛ والصفوف تُرسم كما
 *    سُجّلت (تسمية الحدث، والنموذج، ومعرّف الجلسة المختصر، والحمولة نصًا).
 *  • التفعيل: غياب سجل التفعيل = غير مفعّل — لا افتراض تفعيل أبدًا؛
 *    حمولة التشغيل upsert على owner_id، وحمولة الإيقاف تحديث بلا حذف؛
 *    وفشل الكتابة يعيد المبدّل إلى حالته السابقة.
 *  • البنية: كل id يقرأه الـ JS موجود فعلًا في الـ HTML، وروابط القائمة
 *    الجانبية تطابق data-page والملفات.
 *  • لا مزايا مخترعة: لا صفوف سجل مولّدة، ولا تفعيل تلقائي لأي حساب.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    LOG_COLUMNS, ACTIVATION_COLUMNS, LOG_PAGE_SIZE, ACCOUNTS_PAGE_SIZE,
    ACTION_LABELS, actionLabel, modelLabel, shortId, formatDetails,
    buildActivationMap, isAccountActive, activationSummary,
    activationUpsertPayload, activationDeactivatePayload, logRowForToggle, revertToggleState,
} from '../assets/js/owner/muse-agent-activity-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const logHtml = () => read('owner/muse-activity-log.html');
const logJs = () => read('assets/js/owner/pages/muse-activity-log.js');
const actHtml = () => read('owner/muse-activations.html');
const actJs = () => read('assets/js/owner/pages/muse-activations.js');
const sidebarHtml = () => read('assets/components/owner-sidebar.html');

/** كل id يقرأه الـ JS عبر ‎$(...)‎ موجود في الـ HTML. */
function assertIdsExist(js, html, label) {
    const ids = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
    assert.ok(ids.length > 0, `${label}: لم يُعثر على أي id في الـ JS`);
    for (const id of ids) {
        assert.ok(html.includes(`id="${id}"`), `${label}: الـ id «${id}» غير موجود في الـ HTML`);
    }
}

/* ─────────────────── تسميات السجل ─────────────────── */

test('تسمية الحدث: المعروف عربي، وغير المعروف يُعرض بنصه كما سُجّل', () => {
    assert.equal(actionLabel('muse_trial_setup'), 'إعداد تجربة الوكيل');
    assert.equal(actionLabel('muse_activation_changed'), 'تغيير تفعيل حساب');
    assert.equal(actionLabel('reply_sent'), 'إرسال رد');
    assert.equal(actionLabel('some_future_action'), 'some_future_action');
    assert.equal(actionLabel(''), '—');
    assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [
        'bridge_run', 'briefing_sent', 'draft_created', 'muse_activation_changed',
        'muse_trial_setup', 'page_built', 'quota_checked', 'reply_sent', 'session_started',
    ]);
});

test('تسمية النموذج: Muse والمساعد العام، وغير المعروف بنصه', () => {
    assert.equal(modelLabel('muse'), 'Muse');
    assert.equal(modelLabel('muse-assistant'), 'المساعد العام');
    assert.equal(modelLabel('other-model'), 'other-model');
    assert.equal(modelLabel(null), '—');
});

test('معرّف الجلسة المختصر: أول 8 أحرف، و«—» عند غيابه', () => {
    assert.equal(shortId('9f325cc5-f1ac-4d42-af6c-432d99aebcc5'), '9f325cc5');
    assert.equal(shortId(null), '—');
    assert.equal(shortId(undefined), '—');
});

test('تفاصيل الصف: JSON منسّق كما سُجّل، و«—» عند الفراغ', () => {
    const details = {
        note: 'إنشاء جدولي سجل نشاط الوكيل وتفعيل الحسابات',
        seeded_owner: 'mahmoud@mad3oom.com',
        tables_created: ['agent_activity_log', 'muse_account_activations'],
    };
    const out = formatDetails(details);
    assert.match(out, /mahmoud@mad3oom\.com/);
    assert.match(out, /agent_activity_log/);
    assert.equal(JSON.parse(out).seeded_owner, 'mahmoud@mad3oom.com');
    assert.equal(formatDetails({}), '—');
    assert.equal(formatDetails(null), '—');
    assert.equal(formatDetails('نص حر'), 'نص حر');
});

/* ─────────────────── التفعيل: الحالة والحمولات ─────────────────── */

const MAHMOUD = { id: '44d55aef-fa14-4cc7-a5bc-bc2356fff108', email: 'mahmoud@mad3oom.com' };
const OTHER = { id: '00000000-0000-0000-0000-000000000001', email: 'other@example.com' };

test('غياب سجل التفعيل = غير مفعّل؛ سجل واحد نشط لمحمود وحده', () => {
    const map = buildActivationMap([
        { owner_id: MAHMOUD.id, email: MAHMOUD.email, active: true, activated_at: '2026-11-22T14:56:35Z' },
    ]);
    assert.equal(isAccountActive(map, MAHMOUD.id), true);
    assert.equal(isAccountActive(map, OTHER.id), false);
    assert.equal(isAccountActive(new Map(), MAHMOUD.id), false);
    assert.equal(isAccountActive(null, MAHMOUD.id), false);
});

test('ملخص التفعيل: من الصفوف المقروءة فعلًا — مفعّل واحد من حسابين', () => {
    const map = buildActivationMap([
        { owner_id: MAHMOUD.id, email: MAHMOUD.email, active: true },
    ]);
    const summary = activationSummary([MAHMOUD, OTHER], map);
    assert.deepEqual(summary, { total: 2, active: 1, inactive: 1 });
    assert.deepEqual(activationSummary([], new Map()), { total: 0, active: 0, inactive: 0 });
});

test('حمولة التشغيل: upsert كامل على owner_id مع لحظة التفعيل والمفعِّل', () => {
    const now = '2026-11-22T17:00:00.000Z';
    const payload = activationUpsertPayload({ owner: OTHER, byUserId: MAHMOUD.id, now });
    assert.deepEqual(payload, {
        owner_id: OTHER.id,
        email: OTHER.email,
        active: true,
        activated_at: now,
        activated_by: MAHMOUD.id,
        updated_at: now,
    });
});

test('حمولة الإيقاف: تحديث بلا حذف — active=false وactivated_at=null', () => {
    const now = '2026-11-22T17:05:00.000Z';
    const payload = activationDeactivatePayload({ byUserId: MAHMOUD.id, now });
    assert.deepEqual(payload, {
        active: false,
        activated_at: null,
        activated_by: MAHMOUD.id,
        updated_at: now,
    });
    assert.ok(!('owner_id' in payload), 'الإيقاف لا يعيد كتابة owner_id');
    assert.ok(!('email' in payload), 'الإيقاف لا يعيد كتابة البريد');
});

test('صف سجل التفعيل: فعل حقيقي بمبدّل الصفحة، بجلسة null ونموذج muse', () => {
    const row = logRowForToggle({ owner: OTHER, active: true, byUserId: MAHMOUD.id });
    assert.equal(row.action, 'muse_activation_changed');
    assert.equal(row.model_id, 'muse');
    assert.equal(row.session_id, null);
    assert.deepEqual(row.details, {
        owner_id: OTHER.id, email: OTHER.email, active: true, changed_by: MAHMOUD.id,
    });
});

test('فشل الكتابة يعيد المبدّل إلى حالته السابقة ولا يعرض حالة لم تحدث', () => {
    assert.equal(revertToggleState(true), true);
    assert.equal(revertToggleState(false), false);
});

/* ─────────────────── صفحة السجل: البنية والنطاق ─────────────────── */

test('صفحة السجل: كل id يقرأه الـ JS موجود في الـ HTML', () => {
    assertIdsExist(logJs(), logHtml(), 'muse-activity-log');
});

test('صفحة السجل: تقرأ agent_activity_log وحدها، الأحدث أولًا، بترقيم 50', () => {
    const js = logJs();
    assert.match(js, /from\('agent_activity_log'\)/);
    assert.match(js, /select\(LOG_COLUMNS/);
    assert.match(js, /\.order\('created_at', \{ ascending: false \}\)/);
    assert.equal(LOG_COLUMNS, 'id, action, details, session_id, model_id, created_at');
    assert.equal(LOG_PAGE_SIZE, 50);
    for (const forbidden of ['ai_sessions', 'ai_session_messages', 'chat_sessions', 'chat_messages', 'chat-customer', 'SIE', 'profiles']) {
        assert.ok(!js.includes(forbidden), `صفحة السجل لا تلمس «${forbidden}»`);
    }
    assert.match(logHtml(), /data-owner-page="muse-activity-log"/);
    assert.match(logHtml(), /src="\/assets\/js\/owner\/pages\/muse-activity-log\.js"/);
    assert.match(logHtml(), /سجل نشاط الوكيل/);
    assert.match(logJs(), /لا أحداث مسجّلة بعد/);
});

test('صفحة السجل: الحمولة تُعرض نصًا مهرَّبًا داخل details لا HTML', () => {
    const js = logJs();
    assert.match(js, /esc\(details\)/);
    assert.match(js, /<details class="muse-log-details">/);
});

/* ─────────────────── صفحة التفعيل: البنية والنطاق ─────────────────── */

test('صفحة التفعيل: كل id يقرأه الـ JS موجود في الـ HTML', () => {
    assertIdsExist(actJs(), actHtml(), 'muse-activations');
});

test('صفحة التفعيل: تقرأ profiles و muse_account_activations فقط، بترقيم 50', () => {
    const js = actJs();
    assert.match(js, /from\('profiles'\)/);
    assert.match(js, /from\('muse_account_activations'\)/);
    assert.match(js, /select\(ACTIVATION_COLUMNS\)/);
    assert.equal(ACTIVATION_COLUMNS, 'id, owner_id, email, active, activated_at, activated_by, created_at, updated_at');
    assert.equal(ACCOUNTS_PAGE_SIZE, 50);
    for (const forbidden of ['ai_sessions', 'ai_session_messages', 'chat_sessions', 'chat_messages', 'chat-customer', 'SIE', 'tickets', 'whatsapp']) {
        assert.ok(!js.includes(forbidden), `صفحة التفعيل لا تلمس «${forbidden}»`);
    }
    assert.match(actHtml(), /data-owner-page="muse-activations"/);
    assert.match(actHtml(), /src="\/assets\/js\/owner\/pages\/muse-activations\.js"/);
    assert.match(actHtml(), /تفعيل الوكيل لحسابات تانية/);
    assert.match(actHtml(), /غير مفعّل/);
});

test('صفحة التفعيل: المبدّل هو آلية التفعيل الوحيدة، وفشله يرجع حالته', () => {
    const js = actJs();
    assert.match(js, /\.upsert\(activationUpsertPayload/);
    assert.match(js, /onConflict: 'owner_id'/);
    assert.match(js, /\.update\(activationDeactivatePayload/);
    assert.match(js, /\.eq\('owner_id', owner\.id\)/);
    assert.match(js, /writeResult\(result/);
    assert.match(js, /input\.checked = wasActive/);
    assert.ok(!/\.delete\(\)/.test(js), 'لا حذف لصفوف التفعيل أبدًا');
    assert.match(js, /logRowForToggle/);
});

/* ─────────────────── القائمة الجانبية والأنماط ─────────────────── */

test('القائمة الجانبية: رابطا الصفحتين بعد شات Muse، وdata-page يطابق الملف', () => {
    const html = sidebarHtml();
    for (const [href, dataPage] of [
        ['/owner/muse-activity-log.html', 'muse-activity-log'],
        ['/owner/muse-activations.html', 'muse-activations'],
    ]) {
        assert.ok(html.includes(`href="${href}"`), `الرابط «${href}» غير موجود`);
        assert.ok(html.includes(`data-page="${dataPage}"`), `data-page «${dataPage}» غير موجود`);
        assert.ok(fs.existsSync(path.join(ROOT, href.replace(/^\//, ''))), `الصفحة غير موجودة: ${href}`);
        assert.ok(fs.existsSync(path.join(ROOT, `assets/js/owner/pages/${dataPage}.js`)), `وحدة الصفحة غير موجودة: ${dataPage}`);
    }
    const chatPos = html.indexOf('/owner/muse-chat.html');
    const logPos = html.indexOf('/owner/muse-activity-log.html');
    const actPos = html.indexOf('/owner/muse-activations.html');
    assert.ok(chatPos > 0 && logPos > chatPos && actPos > logPos, 'الصفحتان بعد شات Muse في مجموعة المنصة');
});

test('أنماط الصفحتين: مبدّل التفعيل وشارات الحالة موجودة', () => {
    const css = read('assets/css/owner-muse-agent-pages.css');
    for (const sel of ['.muse-toggle', '.muse-toggle-track', '.muse-toggle-thumb', '.pill--active', '.pill--inactive']) {
        assert.ok(css.includes(sel), `المحدد «${sel}» غير موجود في CSS`);
    }
    assert.ok(logHtml().includes('/assets/css/owner-muse-agent-pages.css'));
    assert.ok(actHtml().includes('/assets/css/owner-muse-agent-pages.css'));
});
