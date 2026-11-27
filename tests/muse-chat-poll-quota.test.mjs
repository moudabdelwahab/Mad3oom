/**
 * اختبارات سياسة الاستطلاع الاحتياطي وحداثة لقطة الكوتة في شات Muse
 * (muse-chat-state.js + الربط في assets/js/owner/pages/muse-chat.js).
 *
 * ما تحرسه هذه الاختبارات:
 *  • الاستطلاع شبكة أمان فقط: يتوقف مع Realtime السليم، ويعود عند
 *    انقطاعه بمهلة تتضاعف مع كل فشل متتالٍ حتى دقيقة.
 *  • الكوتة: لقطة الجسر في extensions.quota وحدها، بلا رقم مخترع؛
 *    غيابها رسالة صريحة (لا تلميح صامت)، وقدمها عن آخر رد مساعد
 *    تحذير صريح — فتوقف الجسر لا يختفي بصمت.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    POLL_MS, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_MAX_MS,
    pollRetryDelay, isRealtimeLive,
    quotaSnapshotState, quotaMissingText, QUOTA_STALE_TEXT, QUOTA_STALE_RESET_TEXT,
    parseQuota, formatQuota, parseAdditionalTokens, formatAdditionalTokens,
} from '../assets/js/owner/muse-chat-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chatJs = () => read('assets/js/owner/pages/muse-chat.js');
const bubbleJs = () => read('assets/js/muse-bubble.js');

/**
 * طابع ISO بتوقيت القاهرة — «YYYY-MM-DD HH:MM EET» كما يدمجه الجسر.
 * يُحسب ديناميكيًا لأن «حديثة» تُقاس مقابل الآن: تاريخ ثابت في
 * الماضي كان سيُصنَّف قديمًا بقاعدة مضي التجديد.
 */
const isoEET = (d) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} EET`;
};
const futureReset = () => isoEET(new Date(Date.now() + 7 * 86400e3));
const pastReset = () => isoEET(new Date(Date.now() - 86400e3));

/* ─────────────────── مهلة backoff ─────────────────── */

test('ثوابت الاستطلاع: القاعدة 5 ثوانٍ والحد الأقصى دقيقة', () => {
    assert.equal(POLL_MS, 5000);
    assert.equal(POLL_BACKOFF_BASE_MS, 5000);
    assert.equal(POLL_BACKOFF_MAX_MS, 60000);
});

test('مهلة الاستطلاع تتضاعف مع الفشل المتتالي حتى دقيقة', () => {
    assert.equal(pollRetryDelay(0), 5000);
    assert.equal(pollRetryDelay(1), 10000);
    assert.equal(pollRetryDelay(2), 20000);
    assert.equal(pollRetryDelay(3), 40000);
    assert.equal(pollRetryDelay(4), 60000);
    assert.equal(pollRetryDelay(10), 60000);
    assert.equal(pollRetryDelay(100), 60000);
});

test('مهلة الاستطلاع تحتمل السالب وغير الرقمي كصفر', () => {
    assert.equal(pollRetryDelay(-3), 5000);
    assert.equal(pollRetryDelay(null), 5000);
    assert.equal(pollRetryDelay(undefined), 5000);
    assert.equal(pollRetryDelay('x'), 5000);
});

/* ─────────────────── حياة Realtime ─────────────────── */

test('حياة Realtime: SUBSCRIBED وحدها حيّة', () => {
    assert.equal(isRealtimeLive('SUBSCRIBED'), true);
    for (const s of ['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT', 'JOINING', '', null, undefined]) {
        assert.equal(isRealtimeLive(s), false, String(s));
    }
});

/* ─────────────────── حداثة لقطة الكوتة ─────────────────── */

const freshQuota = {
    plan: 'free', used: '49%', remaining: '51%',
    reset: futureReset(), updated_at: '2026-11-25T10:00:00Z',
};

test('لقطة الكوتة: غائبة بلا لقطة أو بلا remaining', () => {
    assert.equal(quotaSnapshotState(null, null), 'missing');
    assert.equal(quotaSnapshotState(undefined, null), 'missing');
    assert.equal(quotaSnapshotState({}, null), 'missing');
    assert.equal(quotaSnapshotState({ remaining: '' }, null), 'missing');
    assert.equal(quotaSnapshotState({ remaining: null }, null), 'missing');
});

test('لقطة الكوتة: حديثة إن كان طابعها بعد آخر رد مساعد أو بلا رد بعد', () => {
    assert.equal(quotaSnapshotState(freshQuota, null), 'fresh');
    assert.equal(quotaSnapshotState(freshQuota, '2026-11-25T09:00:00Z'), 'fresh');
    assert.equal(quotaSnapshotState(freshQuota, '2026-11-25T10:00:00Z'), 'fresh');
});

test('لقطة الكوتة: قديمة إن كان آخر رد مساعد بعد طابعها', () => {
    assert.equal(quotaSnapshotState(freshQuota, '2026-11-25T10:00:01Z'), 'stale');
    assert.equal(quotaSnapshotState(freshQuota, '2026-11-25T12:00:00Z'), 'stale');
});

test('لقطة الكوتة: بلا طابع تحديث قديمة — لا يُفترض حداثتها', () => {
    const { updated_at, ...noStamp } = freshQuota;
    assert.equal(quotaSnapshotState(noStamp, null), 'stale');
    assert.equal(quotaSnapshotState({ ...freshQuota, updated_at: 'not-a-date' }, null), 'stale');
});

test('نص غياب الكوتة: صريح مع رد سابق، ومتوقع بلا رد بعد', () => {
    assert.match(quotaMissingText(true), /الجسر لم يتمكن من قراءة الاشتراك/);
    assert.match(quotaMissingText(false), /بعد أول رد من الوكيل/);
    assert.notEqual(quotaMissingText(true), quotaMissingText(false));
});

test('نص تحذير اللقطة القديمة صريح ولا يخفي الأرقام', () => {
    assert.match(QUOTA_STALE_TEXT, /قديمة/);
    assert.match(QUOTA_STALE_TEXT, /قبل آخر رد من الوكيل/);
    // الأرقام الأخيرة نفسها تُحلل كما قبل — التحذير إضافة لا بديل.
    assert.equal(parseQuota(freshQuota).remainingLabel, '51%');
});

/* ─────────────────── التوكنز الإضافية ─────────────────── */

test('التوكنز الإضافية: تُحلَّل نسبتها ومتبقيها من الشكل الحي', () => {
    const live = parseAdditionalTokens('2% used (13B tokens left)');
    assert.equal(live.usedPct, 2);
    assert.equal(live.leftover, '13B');
    const old = parseAdditionalTokens('4% used (6.7B tokens left)');
    assert.equal(old.usedPct, 4);
    assert.equal(old.leftover, '6.7B');
    const short = parseAdditionalTokens('2% used (979M left)');
    assert.equal(short.usedPct, 2);
    assert.equal(short.leftover, '979M');
});

test('التوكنز الإضافية: غائبة أو غير نصية ترجع null — بلا رقم مخترع', () => {
    assert.equal(parseAdditionalTokens(undefined), null);
    assert.equal(parseAdditionalTokens(null), null);
    assert.equal(parseAdditionalTokens(''), null);
    assert.equal(parseAdditionalTokens(120), null);
    assert.equal(parseQuota(freshQuota).additionalTokens, null);
});

test('التوكنز الإضافية: تُعرض بالعربية في نص الكوتة، وتُحذف بغيابها', () => {
    const withTokens = { ...freshQuota, additional_tokens: '2% used (13B tokens left)' };
    assert.equal(
        formatAdditionalTokens(parseAdditionalTokens('2% used (13B tokens left)')),
        '2% مستخدمة (متبقٍ 13B)');
    assert.match(formatQuota(withTokens), /توكنز إضافية: 2% مستخدمة \(متبقٍ 13B\)/);
    assert.doesNotMatch(formatQuota(freshQuota), /توكنز إضافية/);
});

/* ─────────────────── مضي تاريخ التجديد ─────────────────── */

test('لقطة الكوتة: قديمة إن مضى تاريخ تجديدها ولو لم يرد الوكيل بعدها', () => {
    const past = { ...freshQuota, reset: pastReset() };
    assert.equal(quotaSnapshotState(past, null), 'stale');
    assert.equal(quotaSnapshotState(past, '2026-11-25T09:00:00Z'), 'stale');
    assert.equal(parseQuota(past).resetPast, true);
    assert.equal(parseQuota(freshQuota).resetPast, false);
});

test('نص تحذير مضي التجديد يذكر الفترة المنتهية لا آخر رد', () => {
    assert.match(QUOTA_STALE_RESET_TEXT, /تاريخ تجديد/);
    assert.match(QUOTA_STALE_RESET_TEXT, /فترة/);
    assert.notEqual(QUOTA_STALE_RESET_TEXT, QUOTA_STALE_TEXT);
});

test('الصفحة الكاملة: بطاقة الكوتة تعرض التوكنز الإضافية وتحذير مضي التجديد', () => {
    const js = chatJs();
    assert.match(js, /muse-quota-tokens/);
    assert.match(js, /formatAdditionalTokens\(parsed\.additionalTokens\)/);
    assert.match(js, /QUOTA_STALE_RESET_TEXT/);
});

test('الفقاعة: نافذة الكوتة تعرض التوكنز الإضافية وتحذير مضي التجديد', () => {
    const js = bubbleJs();
    assert.match(js, /mb-qpop-tokens/);
    assert.match(js, /formatAdditionalTokens\(parsed\.additionalTokens\)/);
    assert.match(js, /QUOTA_STALE_RESET_TEXT/);
});

/* ─────────────────── الربط في الصفحة ─────────────────── */

test('الصفحة: SUBSCRIBED يوقف الاستطلاع، وأي حالة أخرى تعيده بـ backoff', () => {
    const js = chatJs();
    assert.match(js, /isRealtimeLive\(status\)/);
    assert.match(js, /realtimeLive = true;\s*stopPolling\(\);/);
    assert.match(js, /realtimeLive = false;\s*armPollTimer\(pollRetryDelay\(pollFailures\)\);/);
    assert.match(js, /armPollTimer\(POLL_MS\)/);
    assert.match(js, /pollTimeout = setTimeout\(pollCycle, delay\)/);
    assert.doesNotMatch(js, /setInterval\(pollMessages/);
});

test('الصفحة: لا تلميح صامت للكوتة بعد الآن', () => {
    const js = chatJs();
    assert.doesNotMatch(js, /الكوتة ستظهر هنا بعد أول رد من الوكيل\.<\/span>/);
    assert.match(js, /quotaMissingText\(!!lastAssistantAt\(\)\)/);
    assert.match(js, /muse-quota-stale/);
});
