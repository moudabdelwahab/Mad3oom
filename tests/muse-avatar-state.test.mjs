/**
 * اختبارات أفاتار Muse المتحرك وتوقيت الرد بالثانية في صفحة الشات
 * (owner/muse-chat.html).
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • الحركة عضوية لا حلقة ثابتة: كل دورة تنفس/طفو/ميلان لها مدة عشوائية
 *    جديدة، والرمش كل 3–7 ثوانٍ عشوائيًا — والحدود تُختبَر بدالة عشوائية
 *    محقونة حتى لا تعتمد على الصدفة.
 *  • مدة الحالات: خمول 4.5 ث، تفكير 1 ث، كلام 0.55 ث، انتباه 2.4 ث.
 *  • تحويلات الجسم داخل الحدود المعلنة، والإيقاع الحيوي أوسع من الهادئة.
 *  • توقيت الرد حقيقي: عدّاد الانتظار ثوانٍ منصرمة منذ الإرسال، ومدة
 *    الرد من طابعي الإرسال والرد، وكشف الانتظار حتى بعد إعادة التحميل.
 *  • الأفاتار SVG مبني للصفحة — بلا صور خارجية وبلا ادعاء أنه أفاتار ميتا.
 *  • المتحكم يستخدم requestAnimationFrame لا setInterval للحركة، ويحترم
 *    prefers-reduced-motion، ويحفظ تفضيل الحركة والإيقاع.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AVATAR_STATES, AVATAR_STATE_MS, AVATAR_CYCLE_MS, BLINK_MS,
    AVATAR_AMPLITUDE, AVATAR_PACE,
    randomIn, nextBlinkDelayMs, nextCycleMs,
    breathWave, floatWave, tiltWave, speakingWave, bodyTransform,
} from '../assets/js/owner/muse-avatar-state.js';
import {
    formatWaitSeconds, formatReplyTook, secondsBetween, waitingSince,
} from '../assets/js/owner/muse-chat-state.js';
import { museAvatarSvg } from '../assets/js/owner/muse-avatar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const avatarJs = () => read('assets/js/owner/muse-avatar.js');

/* ─────────────────── مدة الحالات ─────────────────── */

test('مدة الحالات: خمول 4.5 ث، تفكير 1 ث، كلام 0.55 ث، انتباه 2.4 ث', () => {
    assert.deepEqual([...AVATAR_STATES], ['idle', 'thinking', 'speaking', 'attention']);
    assert.equal(AVATAR_STATE_MS.idle, 4500);
    assert.equal(AVATAR_STATE_MS.thinking, 1000);
    assert.equal(AVATAR_STATE_MS.speaking, 550);
    assert.equal(AVATAR_STATE_MS.attention, 2400);
    assert.equal(BLINK_MS, 140);
});

/* ─────────────────── عشوائية بلا حلقة ثابتة ─────────────────── */

test('الرمش عشوائي بين 3 و 7 ثوانٍ — حدوده تُختبَر بعشوائية محقونة', () => {
    assert.equal(nextBlinkDelayMs(() => 0), 3000);
    assert.equal(nextBlinkDelayMs(() => 1), 7000);
    assert.equal(nextBlinkDelayMs(() => 0.5), 5000);
    assert.deepEqual(AVATAR_CYCLE_MS.blink, [3000, 7000]);
});

test('كل دورة حركة تأخذ مدة عشوائية جديدة داخل نطاقها', () => {
    assert.equal(nextCycleMs('breath', () => 0), 4200);
    assert.equal(nextCycleMs('breath', () => 1), 5200);
    assert.equal(nextCycleMs('float', () => 0), 3000);
    assert.equal(nextCycleMs('float', () => 1), 5000);
    assert.equal(nextCycleMs('tilt', () => 0), 2400);
    assert.equal(nextCycleMs('tilt', () => 1), 5200);
    assert.ok(randomIn(10, 20, () => 0.25) === 12.5);
});

/* ─────────────────── رياضيات الحركة ─────────────────── */

test('موجة التنفس 0 عند الطرفين و1 في المنتصف', () => {
    assert.ok(Math.abs(breathWave(0) - 0) < 1e-9);
    assert.ok(Math.abs(breathWave(0.5) - 1) < 1e-9);
    assert.ok(Math.abs(breathWave(1) - 0) < 1e-9);
    assert.ok(breathWave(0.25) > 0 && breathWave(0.25) < 1);
});

test('موجتا الطفو والميلان تتأرجحان بين -1 و 1 بلا قفزات', () => {
    assert.ok(Math.abs(floatWave(0)) < 1e-9);
    assert.ok(Math.abs(floatWave(0.25) - 1) < 1e-9);
    assert.ok(Math.abs(floatWave(0.75) + 1) < 1e-9);
    assert.ok(Math.abs(tiltWave(0.5)) < 1e-9);
    assert.ok(tiltWave(0.25) > 0.9 && tiltWave(0.75) < -0.9);
});

test('نبضة الكلام 0 عند حدود 0.55 ث و1 في منتصفها', () => {
    assert.ok(Math.abs(speakingWave(0)) < 1e-9);
    assert.ok(Math.abs(speakingWave(275) - 1) < 1e-9);
    assert.ok(Math.abs(speakingWave(550)) < 1e-9);
    assert.ok(speakingWave(137) > 0 && speakingWave(137) < 1);
});

test('تحويلات الجسم داخل الحدود المعلنة في كل الأطوار', () => {
    for (const phase of [0, 0.13, 0.25, 0.5, 0.77, 0.99]) {
        const t = bodyTransform({ breathPhase: phase, floatPhase: phase, tiltPhase: phase });
        assert.ok(t.scale >= 1 && t.scale <= 1 + AVATAR_AMPLITUDE.breathScale + 1e-9);
        assert.ok(Math.abs(t.translateY) <= AVATAR_AMPLITUDE.floatPx + 1e-9);
        assert.ok(Math.abs(t.rotate) <= AVATAR_AMPLITUDE.tiltDeg + 1e-9);
    }
});

test('الإيقاع الحيوي أوسع وأسرع من الهادئة', () => {
    assert.ok(AVATAR_PACE.lively.speed > AVATAR_PACE.calm.speed);
    assert.ok(AVATAR_PACE.lively.amp > AVATAR_PACE.calm.amp);
    const calm = bodyTransform({
        breathPhase: 0.5, floatPhase: 0.25, tiltPhase: 0.25, pace: AVATAR_PACE.calm,
    });
    const lively = bodyTransform({
        breathPhase: 0.5, floatPhase: 0.25, tiltPhase: 0.25, pace: AVATAR_PACE.lively,
    });
    assert.ok(lively.translateY > calm.translateY);
    assert.ok(lively.rotate > calm.rotate);
});

/* ─────────────────── الـ SVG ─────────────────── */

test('الأفاتار SVG مبني للصفحة: عينان وابتسامة وفم، بلا صور خارجية', () => {
    const svg = museAvatarSvg();
    assert.match(svg, /<svg[^>]*viewBox="0 0 120 120"/);
    assert.match(svg, /muse-avatar-eyes/);
    assert.match(svg, /muse-avatar-smile/);
    assert.match(svg, /muse-avatar-mouth/);
    assert.match(svg, /#4DA3FF/);
    assert.match(svg, /#0077CC/);
    assert.doesNotMatch(svg, /<img|http/);
});

/* ─────────────────── المتحكم: بلا حلقة ثابتة وبلا حالة مزيفة ─────────────────── */

test('المتحكم يحرّك بـ requestAnimationFrame لا setInterval، ويحترم تقليل الحركة', () => {
    const js = avatarJs();
    assert.match(js, /requestAnimationFrame/);
    assert.doesNotMatch(js, /setInterval/);
    assert.match(js, /prefers-reduced-motion/);
    assert.match(js, /muse-avatar-motion/);
    assert.match(js, /muse-avatar-pace/);
    assert.match(js, /AVATAR_STATE_MS\.attention/);
    assert.doesNotMatch(js, /متصل|online|يكتب الآن|جارٍ الكتابة/);
});

test('الحالات الأربع موصولة بأحداث المحادثة لا بمؤقت ثابت', () => {
    const js = avatarJs();
    assert.match(js, /state === 'thinking'/);
    assert.match(js, /state === 'speaking'/);
    assert.match(js, /state === 'attention'/);
    assert.match(js, /scheduleBlink/);
    assert.match(js, /nextBlinkDelayMs\(\)/);
    assert.match(js, /speakingWave\(/);
});

/* ─────────────────── توقيت الرد بالثانية ─────────────────── */

test('عدّاد الانتظار يعرض ثوانٍ حقيقية منصرمة', () => {
    assert.equal(formatWaitSeconds(0), 'بانتظار الرد… 0 ث');
    assert.equal(formatWaitSeconds(23), 'بانتظار الرد… 23 ث');
    assert.equal(formatWaitSeconds(61.8), 'بانتظار الرد… 61 ث');
    assert.equal(formatWaitSeconds(-5), 'بانتظار الرد… 0 ث');
});

test('مدة الرد من طابعي الإرسال والرد — سالبة تُقصّ إلى صفر', () => {
    assert.equal(formatReplyTook(47), 'وصل الرد في 47 ثانية');
    assert.equal(formatReplyTook(47.6), 'وصل الرد في 48 ثانية');
    assert.equal(
        secondsBetween('2026-11-22T14:10:42Z', '2026-11-22T14:11:29Z'), 47);
    assert.equal(
        secondsBetween('2026-11-22T14:11:29Z', '2026-11-22T14:10:42Z'), 0);
});

test('كشف الانتظار: آخر رسالة مستخدم بلا رد بعدها حتى بعد إعادة التحميل', () => {
    const user = { id: '1', role: 'user', created_at: '2026-11-22T14:10:42Z' };
    const asst = { id: '2', role: 'assistant', created_at: '2026-11-22T14:11:29Z' };
    const laterUser = { id: '3', role: 'user', created_at: '2026-11-22T14:12:00Z' };
    assert.equal(waitingSince([user]), '2026-11-22T14:10:42Z');
    // مدخلات بلا ترتيب: المستخدم الأحدث زمنيًا هو الأخير فعلًا فينتظر ردًا.
    assert.equal(waitingSince([asst, laterUser]), '2026-11-22T14:12:00Z');
    assert.equal(waitingSince([user, asst]), null);
    assert.equal(waitingSince([asst]), null);
    assert.equal(waitingSince([]), null);
    assert.equal(waitingSince(null), null);
});
