/**
 * muse-avatar.js — أفاتار Muse المتحرك في صفحة شات لوحة المالك.
 *
 * مكوّن مبني لهذه الصفحة فقط (SVG + حركة JS) — ليس صورة مولّدة ولا أفاتار
 * مدعوم/روبوت المنصة. الحركة عضوية لا حلقة ثابتة: كل دورة تنفس/طفو/ميلان
 * تأخذ مدة عشوائية جديدة عند اكتمالها، والرمش كل 3–7 ثوانٍ عشوائيًا،
 * بنفس انضباط شغل الأفاتار القطني (تنفس ~4.5 ث، تفكير 1 ث، كلام 0.55 ث،
 * انتباه 2.4 ث).
 *
 * الحالات مرتبطة بأحداث حقيقية في المحادثة:
 *  • idle — انتظار؛ تنفس وطفو وميلان هادئة.
 *  • thinking — من لحظة الإرسال حتى وصول الرد؛ تأرجح أسرع (1 ث) ونظرة
 *    تتنقل يمينًا ويسارًا، مع حلقة توهج حول الأفاتار.
 *  • speaking — لحظة وصول الرد؛ الفم ينبض 0.55 ث مدة محسوبة من طول الرد.
 *  • attention — عند تركيز حقل الإدخال؛ يقظة 2.4 ث ثم يعود للخمول وحده.
 *
 * التحكم حقيقي: زر إيقاف/تشغيل الحركة، وزر إيقاع هادئة/حيوية، ويُحفظ
 * التفضيل في localStorage؛ ويُحترم prefers-reduced-motion افتراضيًا.
 * لا حالة حضور مزيفة ولا مؤشر كتابة — لا شيء منهما حقيقي هنا.
 */
import {
    AVATAR_STATES, AVATAR_STATE_MS, AVATAR_PACE, BLINK_MS,
    nextBlinkDelayMs, nextCycleMs, breathWave, floatWave, tiltWave,
    speakingWave, bodyTransform, thinkingEyeOffset,
} from './muse-avatar-state.js';

export const AVATAR_STORAGE_MOTION = 'muse-avatar-motion';
export const AVATAR_STORAGE_PACE = 'muse-avatar-pace';

const $ = (sel, root) => root.querySelector(sel);

/**
 * الـ SVG نفسه — يُستخدم للأفاتار الكبير المتحرك وللعلامة الصغيرة الثابتة
 * بجانب رسائل المساعد. وجه مجرّد بألوان اللوحة، بلا ادعاء أنه أفاتار ميتا.
 */
export function museAvatarSvg() {
    return `
<svg class="muse-avatar-svg" viewBox="0 0 120 120" role="img" aria-label="Muse" focusable="false">
    <defs>
        <linearGradient id="museAvGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4DA3FF" />
            <stop offset="1" stop-color="#0077CC" />
        </linearGradient>
    </defs>
    <rect class="muse-avatar-body-shape" x="16" y="20" width="88" height="84" rx="32" fill="url(#museAvGrad)" />
    <g class="muse-avatar-thinking-dots" aria-hidden="true">
        <circle cx="48" cy="10" r="3.5" fill="#4DA3FF" />
        <circle cx="60" cy="7" r="3.5" fill="#4DA3FF" />
        <circle cx="72" cy="10" r="3.5" fill="#4DA3FF" />
    </g>
    <ellipse cx="44" cy="38" rx="20" ry="12" fill="#FFFFFF" opacity="0.18" />
    <g class="muse-avatar-eyes-glance">
        <g class="muse-avatar-eyes">
            <ellipse cx="45" cy="56" rx="7" ry="9.5" fill="#0B1B2E" />
            <ellipse cx="75" cy="56" rx="7" ry="9.5" fill="#0B1B2E" />
        </g>
    </g>
    <circle cx="34" cy="70" r="5" fill="#FF9DB1" opacity="0.35" />
    <circle cx="86" cy="70" r="5" fill="#FF9DB1" opacity="0.35" />
    <path class="muse-avatar-smile" d="M46 78 Q60 88 74 78" stroke="#0B1B2E" stroke-width="4" stroke-linecap="round" fill="none" />
    <ellipse class="muse-avatar-mouth" cx="60" cy="81" rx="7" ry="6" fill="#0B1B2E" />
</svg>`;
}

function readPref(key, fallback) {
    try {
        return window.localStorage.getItem(key) || fallback;
    } catch (e) {
        return fallback;
    }
}

function savePref(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch (e) { /* التفضيل رفاهية لا توقف الصفحة */ }
}

export function loadAvatarPrefs() {
    const storedMotion = readPref(AVATAR_STORAGE_MOTION, null);
    let enabled = storedMotion !== 'off';
    if (storedMotion === null) {
        try {
            enabled = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (e) { enabled = true; }
    }
    const pace = readPref(AVATAR_STORAGE_PACE, 'calm') === 'lively' ? 'lively' : 'calm';
    return { enabled, pace };
}

/**
 * يبني الأفاتار داخل root ويدير حركته وحالاته.
 * opts: { animBtn, paceBtn } — زرّا التحكم في الترويسة (اختياريان).
 */
export function createMuseAvatar(root, opts = {}) {
    if (!root) return null;
    const prefs = loadAvatarPrefs();
    root.innerHTML = `<div class="muse-avatar-body">${museAvatarSvg()}</div>`;
    const body = $('.muse-avatar-body', root) || root.firstElementChild;
    const eyesGlance = $('.muse-avatar-eyes-glance', root);
    const eyes = $('.muse-avatar-eyes', root);
    const mouth = $('.muse-avatar-mouth', root);

    let state = 'idle';
    let enabled = prefs.enabled;
    let pace = AVATAR_PACE[prefs.pace];
    let paceName = prefs.pace;
    let rafId = 0;
    let blinkTimer = 0;
    let attentionTimer = 0;
    let speakingUntil = 0;
    let speakingStartedAt = 0;
    let attentionStartedAt = 0;
    let cycles = {
        breath: { startedAt: 0, ms: nextCycleMs('breath') },
        float: { startedAt: 0, ms: nextCycleMs('float') },
        tilt: { startedAt: 0, ms: nextCycleMs('tilt') },
    };
    let lastFrameAt = 0;

    function applyPrefsToButtons() {
        if (opts.animBtn) {
            opts.animBtn.textContent = enabled ? 'إيقاف الحركة' : 'تشغيل الحركة';
            opts.animBtn.setAttribute('aria-pressed', String(enabled));
        }
        if (opts.paceBtn) {
            opts.paceBtn.textContent = paceName === 'lively' ? 'الإيقاع: حيوية' : 'الإيقاع: هادئة';
            opts.paceBtn.setAttribute('aria-pressed', String(paceName === 'lively'));
        }
    }

    function setRootState() {
        root.dataset.state = state;
        root.classList.toggle('muse-avatar--thinking', state === 'thinking');
        root.classList.toggle('muse-avatar--speaking', state === 'speaking');
        root.classList.toggle('muse-avatar--attention', state === 'attention');
        root.classList.toggle('muse-avatar--off', !enabled);
        root.classList.toggle('muse-avatar--lively', paceName === 'lively');
    }

    function setState(next, durationMs) {
        if (!AVATAR_STATES.includes(next)) return state;
        if (next === 'attention') {
            if (state !== 'idle') return state;
            clearTimeout(attentionTimer);
            attentionStartedAt = performance.now();
            attentionTimer = setTimeout(() => setState('idle'), AVATAR_STATE_MS.attention);
        }
        if (next === 'speaking') {
            // مدة الكلام من طول الرد الحقيقي (يمررها كود الصفحة) لا رقم ثابت.
            speakingStartedAt = performance.now();
            speakingUntil = speakingStartedAt
                + Math.min(6000, Math.max(1200, durationMs || 2500));
        }
        if (state === 'attention' && next !== 'attention') clearTimeout(attentionTimer);
        state = next;
        setRootState();
        return state;
    }

    function setEnabled(on) {
        enabled = !!on;
        savePref(AVATAR_STORAGE_MOTION, enabled ? 'on' : 'off');
        if (!enabled) {
            cancelAnimationFrame(rafId);
            rafId = 0;
            clearTimeout(blinkTimer);
            blinkTimer = 0;
            if (body) body.style.transform = '';
            if (eyesGlance) eyesGlance.style.transform = '';
            if (mouth) mouth.style.transform = '';
            root.classList.remove('is-blinking');
        } else {
            lastFrameAt = 0;
            scheduleBlink();
            tick(performance.now());
        }
        applyPrefsToButtons();
        setRootState();
        return enabled;
    }

    function setPace(next) {
        paceName = next === 'lively' ? 'lively' : 'calm';
        pace = AVATAR_PACE[paceName];
        savePref(AVATAR_STORAGE_PACE, paceName);
        applyPrefsToButtons();
        setRootState();
        return paceName;
    }

    function scheduleBlink() {
        clearTimeout(blinkTimer);
        if (!enabled) return;
        blinkTimer = setTimeout(() => {
            if (!enabled) return;
            root.classList.add('is-blinking');
            setTimeout(() => root.classList.remove('is-blinking'), BLINK_MS);
            scheduleBlink();
        }, nextBlinkDelayMs());
    }

    function phaseOf(cycle, now, speed) {
        const elapsed = (now - cycle.startedAt) * speed;
        if (elapsed >= cycle.ms) {
            cycle.startedAt = now;
            cycle.ms = nextCycleMs(
                cycle === cycles.breath ? 'breath' : cycle === cycles.float ? 'float' : 'tilt',
            );
            return 0;
        }
        return elapsed / cycle.ms;
    }

    function tick(now) {
        if (!enabled) return;
        const speed = state === 'thinking' ? pace.speed * 1.6 : pace.speed;
        if (!lastFrameAt) {
            cycles.breath.startedAt = now;
            cycles.float.startedAt = now;
            cycles.tilt.startedAt = now;
            lastFrameAt = now;
        }
        const breathPhase = phaseOf(cycles.breath, now, speed);
        const floatPhase = phaseOf(cycles.float, now, state === 'thinking' ? speed * 1.4 : speed);
        const tiltPhase = phaseOf(cycles.tilt, now, speed);
        const t = bodyTransform({ breathPhase, floatPhase, tiltPhase, pace });

        let scale = t.scale;
        let rotate = t.rotate;
        let floatY = t.translateY;
        if (state === 'thinking') {
            floatY = -2 + 2.5 * floatWave(floatPhase);
            // ميلان تأمل خفيف أثناء التفكير — رأس مائل قليلًا لا دوران.
            rotate -= 2;
        }
        if (state === 'attention') {
            // يقظة 2.4 ث: يرتفع ويميل قليلًا ثم يعود — مغلف جيبي بلا قفزة.
            const progress = Math.min(1, Math.max(0,
                (now - attentionStartedAt) / AVATAR_STATE_MS.attention));
            const env = Math.sin(Math.PI * progress);
            scale += 0.04 * env;
            rotate -= 2 * env;
        }
        if (body) {
            body.style.transform =
                `translateY(${floatY.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
        }
        if (eyesGlance) {
            // أثناء التفكير العينان مرفوعتان للأعلى وتتنقلان يمينًا ويسارًا؛
            // في غيره نظرة مستقيمة بلا إزاحة.
            const glance = state === 'thinking' ? thinkingEyeOffset(floatPhase) : { x: 0, y: 0 };
            eyesGlance.style.transform =
                `translate(${glance.x.toFixed(2)}px, ${glance.y.toFixed(2)}px)`;
        }
        if (mouth) {
            const open = state === 'speaking' ? speakingWave(now - speakingStartedAt) : 0;
            mouth.style.transform = `scaleY(${open.toFixed(3)})`;
            mouth.style.transformBox = 'fill-box';
            mouth.style.transformOrigin = 'center';
        }
        if (state === 'speaking' && now >= speakingUntil) setState('idle');
        lastFrameAt = now;
        rafId = requestAnimationFrame(tick);
    }

    function destroy() {
        cancelAnimationFrame(rafId);
        clearTimeout(blinkTimer);
        clearTimeout(attentionTimer);
        rafId = 0;
    }

    if (opts.animBtn) {
        opts.animBtn.addEventListener('click', () => setEnabled(!enabled));
    }
    if (opts.paceBtn) {
        opts.paceBtn.addEventListener('click', () => setPace(paceName === 'lively' ? 'calm' : 'lively'));
    }

    applyPrefsToButtons();
    setRootState();
    if (enabled) {
        scheduleBlink();
        rafId = requestAnimationFrame(tick);
    }

    return {
        setState,
        setEnabled,
        setPace,
        getState: () => state,
        isEnabled: () => enabled,
        getPace: () => paceName,
        destroy,
    };
}
