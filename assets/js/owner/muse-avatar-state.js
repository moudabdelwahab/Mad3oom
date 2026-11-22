/**
 * muse-avatar-state.js — منطق نقي بلا DOM لأفاتار Muse المتحرك في صفحة الشات
 * (owner/muse-chat.html).
 *
 * الأفاتار نفسه في assets/js/owner/muse-avatar.js (يبني الـ SVG ويحرّكها)؛
 * هذا الملف يحمل الثوابت والرياضيات فقط حتى تُختبَر بلا متصفح، بنفس نمط
 * muse-chat-state.js و agent-connection-state.js.
 *
 * قاعدة الحركة (من شغل الأفاتار القطني): لا حلقة ثابتة ميكانيكية أبدًا —
 * كل دورة تنفس/طفو/ميلان لها مدة عشوائية جديدة، والرمش كل 3–7 ثوانٍ
 * عشوائيًا. مدة الحالات: خمول 4.5 ثوانٍ، تفكير 1 ثانية، كلام 0.55 ثانية،
 * انتباه 2.4 ثانية.
 */

/** حالات الأفاتار الأربع — مرتبطة بأحداث حقيقية في المحادثة لا بشيء مخترع. */
export const AVATAR_STATES = Object.freeze(['idle', 'thinking', 'speaking', 'attention']);

/** مدة دورة كل حالة بالمللي ثانية. */
export const AVATAR_STATE_MS = Object.freeze({
    idle: 4500,
    thinking: 1000,
    speaking: 550,
    attention: 2400,
});

/** نطاقات المدة العشوائية لكل دورة حركة (مللي ثانية). */
export const AVATAR_CYCLE_MS = Object.freeze({
    breath: [4200, 5200],
    float: [3000, 5000],
    tilt: [2400, 5200],
    blink: [3000, 7000],
});

/** مدة الرمشة نفسها بالمللي ثانية. */
export const BLINK_MS = 140;

/** حدود سعة الحركة — صغيرة عمدًا حتى يبقى الأفاتار هادئًا لا راقصًا. */
export const AVATAR_AMPLITUDE = Object.freeze({
    breathScale: 0.03,
    floatPx: 3,
    tiltDeg: 2,
    glancePx: 3,
});

/** معامل إيقاع الحركة: هادئة أبطأ وأخف، حيوية أسرع وأوضح. */
export const AVATAR_PACE = Object.freeze({
    calm: { speed: 0.75, amp: 0.7 },
    lively: { speed: 1.3, amp: 1.25 },
});

/**
 * رقم عشوائي بين حدين — يقبل دالة عشوائية قابلة للحقن حتى تُختبَر
 * الحدود بلا عشوائية حقيقية.
 */
export function randomIn(min, max, random = Math.random) {
    return min + random() * (max - min);
}

/** مدة الرمشة التالية: عشوائية بين 3 و 7 ثوانٍ. */
export function nextBlinkDelayMs(random = Math.random) {
    return Math.round(randomIn(AVATAR_CYCLE_MS.blink[0], AVATAR_CYCLE_MS.blink[1], random));
}

/** مدة عشوائية جديدة لدورة تنفس/طفو/ميلان — تُعاد عند كل دورة. */
export function nextCycleMs(kind, random = Math.random) {
    const [min, max] = AVATAR_CYCLE_MS[kind];
    return Math.round(randomIn(min, max, random));
}

/**
 * موجة تنفس 0..1 من طور 0..1 — جيبية ناعمة: 0 عند البداية والنهاية،
 * و1 في منتصف الشهيق.
 */
export function breathWave(phase) {
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * ((phase % 1 + 1) % 1));
}

/** طفو 1-..1 من طور 0..1 — صعود وهبوط ناعمان بلا قفزات. */
export function floatWave(phase) {
    return Math.sin(2 * Math.PI * ((phase % 1 + 1) % 1));
}

/** ميلان 1-..1 من طور 0..1 — يتأرجح يمينًا ويسارًا حول الصفر. */
export function tiltWave(phase) {
    return Math.sin(2 * Math.PI * ((phase % 1 + 1) % 1));
}

/**
 * مقدار فتح الفم أثناء الكلام 0..1 — نبضة 0.55 ثانية تتكرر ما دامت
 * حالة الكلام؛ الصفر عند حدود النبضة حتى لا يقفز الفم.
 */
export function speakingWave(elapsedMs) {
    const phase = ((elapsedMs % AVATAR_STATE_MS.speaking) + AVATAR_STATE_MS.speaking)
        % AVATAR_STATE_MS.speaking / AVATAR_STATE_MS.speaking;
    return Math.sin(Math.PI * phase);
}

/**
 * تحويلات الجسم في إطار واحد: مقياس تنفس، إزاحة طفو، زاوية ميلان.
 * كلها داخل الحدود المعلنة، وتُضرب في معامل الإيقاع.
 */
export function bodyTransform({ breathPhase, floatPhase, tiltPhase, pace = AVATAR_PACE.calm }) {
    const breath = 1 + AVATAR_AMPLITUDE.breathScale * pace.amp * breathWave(breathPhase);
    const floatY = AVATAR_AMPLITUDE.floatPx * pace.amp * floatWave(floatPhase);
    const tilt = AVATAR_AMPLITUDE.tiltDeg * pace.amp * tiltWave(tiltPhase);
    return { scale: breath, translateY: floatY, rotate: tilt };
}
