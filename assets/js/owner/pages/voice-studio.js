/**
 * voice-studio.js — ربط صفحة الاستوديو الصوتي (مدعوم) في لوحة المالك.
 *
 * إعادة بناء أصلية بأسلوب Mad3oom لصفحة واحدة من مشروع الاستوديو
 * الصوتي (React + Express): تبويبات داخلية للأوضاع الأربعة — تعليق
 * صوتي، وكتب صوتية (6 خطوات)، وبودكاست، وتفريغ نصي — وكل النداءات
 * تمر عبر Edge Function «voice-studio» (بلا خادم Express وبلا React).
 *
 * البوابة: bootOwnerPage من owner-page.js (مالك المنصة وحده، لا SIE،
 * ولا تفعيل حسابات أخرى). المفتاح الشخصي للمالك اختياري ويُحفظ في
 * localStorage ويُرسل كهيدر x-gemini-api-key فقط.
 */
import { supabase, bootOwnerPage, esc, announce } from '/assets/js/owner/owner-page.js';
import {
    DIALECTS, VOICE_TYPES, VOICE_FIELDS, STUDIO_CONTROLS, CATEGORY_STYLES,
    PREVIEW_SCRIPTS, PREVIEW_FALLBACK_TEXT, WORKFLOW_STEPS, VOICE_PURPOSES,
    VOICE_STUDIO_FUNCTION, GEMINI_KEY_STORAGE, INTRO_STORAGE, HISTORY_STORAGE,
    AUDIOBOOK_STORAGE, HISTORY_LIMIT, getBaseVoiceForType,
} from '/assets/js/owner/voice-studio-data.js';
import {
    formatTime, mergeDecodedAudio, splitTextByParagraphs,
    mapRoleToVoice, smartDistributeSpeakers, buildSrt, buildDocxHtml,
    transcriptFileName, audioFileName, resolveEdgeVoice,
} from '/assets/js/owner/voice-studio-state.js';

const $ = (id) => document.getElementById(id);
const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js';

/* ───────────────────────── خدمة الاستوديو ───────────────────────── */

class Mad3oomVoiceService {
    setUserApiKey(key) {
        try {
            if (key && key.trim()) localStorage.setItem(GEMINI_KEY_STORAGE, key.trim());
            else localStorage.removeItem(GEMINI_KEY_STORAGE);
        } catch (e) { /* التخزين غير متاح */ }
    }

    getUserApiKey() {
        try {
            return localStorage.getItem(GEMINI_KEY_STORAGE) || '';
        } catch (e) {
            return '';
        }
    }

    headers() {
        const key = this.getUserApiKey();
        return key && key.trim().length > 10 ? { 'x-gemini-api-key': key.trim() } : {};
    }

    async call(action, payload = {}) {
        const { data, error } = await supabase.functions.invoke(VOICE_STUDIO_FUNCTION, {
            body: { action, ...payload },
            headers: this.headers(),
        });
        if (error) throw new Error(error.message || 'تعذّر الاتصال بالاستوديو الصوتي.');
        if (data && data.error) throw new Error(data.error);
        return data || {};
    }

    preprocessText(text, options) {
        return this.call('preprocess-text', { text, options }).then((d) => d.text ?? text);
    }

    identifyKeySentences(text) {
        if (!text || text.length < 20) return Promise.resolve([]);
        return this.call('identify-key-sentences', { text }).then((d) => d.sentences || []);
    }

    analyzeAndSegmentText(text) {
        return this.call('analyze-and-segment', { text })
            .then((d) => d.segments || [{ label: 'مقطع افتراضي', role: 'الراوي', text }])
            .catch(() => [{ label: 'مقطع افتراضي', role: 'الراوي', text }]);
    }

    async transcribeMedia(base64, mimeType, includeTimestamps, language = 'Auto') {
        const data = await this.call('transcribe-media', { base64, mimeType, includeTimestamps, language });
        return data.text || '';
    }

    async extractTextFromFile(base64, mimeType) {
        const data = await this.call('extract-text', { base64, mimeType });
        if (!data.text || !data.text.trim()) throw new Error('تعذر تحليل المحتوى.');
        return data.text;
    }

    generatePodcastScript(content, dialect, dialectId, existingSpeakers = []) {
        return this.call('generate-podcast-script', { content, dialect, dialectId, existingSpeakers });
    }

    async generateVoiceOver(text, voiceName, profile, controls, performanceNote, dialectId, engine = 'edge') {
        // محرك edge يحلّ الصوت المسمّى إلى اسم Edge الحقيقي حسب اللهجة
        // والجنس؛ محرك gemini يستخدم اسم صوت Gemini الممرر كما هو.
        const resolvedVoice = engine === 'edge'
            ? resolveEdgeVoice(profile, dialectId).voice
            : voiceName;
        const data = await this.call('tts', {
            text, voiceName: resolvedVoice, profile, controls, performanceNote, dialectId, engine,
        });
        if (!data.audioBase64) throw new Error('لم يتم استلام بيانات الصوت من الخادم.');
        const binary = atob(data.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const mimeType = data.mimeType || (engine === 'edge' ? 'audio/mpeg' : 'audio/wav');
        const blob = new Blob([bytes], { type: mimeType });
        return {
            url: URL.createObjectURL(blob),
            engine: data.engine || engine,
            mimeType,
            fallbackFrom: data.fallbackFrom || null,
        };
    }

    // بث نصي (SSE) — غير مستخدم في واجهة الأوضاع الأربعة؛ متاح للاستخدام
    // البرمجي. يقرأ عنوان الدالة من عميل Supabase مباشرة.
    async streamText(prompt, onChunk, systemInstruction) {
        const base = supabase?.supabaseUrl;
        const anonKey = supabase?.supabaseKey;
        if (!base || !anonKey) throw new Error('البث المباشر غير متاح من هذه الصفحة.');
        const response = await fetch(`${base}/functions/v1/${VOICE_STUDIO_FUNCTION}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
                ...this.headers(),
            },
            body: JSON.stringify({ action: 'generate-stream', prompt, systemInstruction }),
        });
        if (!response.ok || !response.body) throw new Error('فشل بدء البث المباشر.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') break;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed.text) {
                        fullText += parsed.text;
                        onChunk?.(parsed.text);
                    }
                } catch (e) { /* سطر غير JSON */ }
            }
        }
        return fullText;
    }
}

export const voiceService = new Mad3oomVoiceService();

/* ───────────────────────── الحالة ───────────────────────── */

const state = {
    mode: 'voice',
    engine: 'edge',
    lastEngineUsed: null,
    lastFallbackFrom: null,
    dialectId: DIALECTS[0].id,
    type: VOICE_TYPES[0],
    gender: 'ذكر',
    fieldId: VOICE_FIELDS[0].id,
    voiceName: '',
    controls: { temp: 'متوازن', emotion: 'متوسط', speed: 'متوسطة', depth: 'متوسطة', pitch: 'متوسطة', drama: 'متوسط', purpose: '' },
    locked: false,
    generating: false,
    fingerprint: { name: '', style: 'رسمي', rhythm: 'متوسط', narrative: 'مباشر', isActive: false },
    history: [],
    project: null,
    bookMode: 'none',
    importTextBuffer: '',
    pilotLoadingId: null,
    productionPhase: 'idle',
    productionProgress: 0,
    masterAudioUrl: null,
    podcast: {
        source: 'manual',
        dialectId: 'egyptian',
        text: '',
        script: null,
        speakers: [],
        voiceMap: {},
        distMode: 'smart',
        distributed: false,
        audioUrl: null,
        generated: false,
        progress: 0,
    },
    transcript: { file: null, status: 'idle', result: '', useTimestamps: false, format: 'txt' },
};

const previewAudio = new Audio();
let activePreviewId = null;
let previewLoading = false;
let errorTimer = null;

function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_STORAGE);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
    } catch (e) {
        return [];
    }
}

function saveHistory() {
    try {
        localStorage.setItem(HISTORY_STORAGE, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
    } catch (e) { /* التخزين غير متاح */ }
}

function loadProject() {
    try {
        const raw = localStorage.getItem(AUDIOBOOK_STORAGE);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function saveProject() {
    try {
        if (state.project) localStorage.setItem(AUDIOBOOK_STORAGE, JSON.stringify(state.project));
        else localStorage.removeItem(AUDIOBOOK_STORAGE);
    } catch (e) { /* التخزين غير متاح */ }
}

/* ───────────────────────── أدوات عامة ───────────────────────── */

function showError(message) {
    const box = $('vsError');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { box.hidden = true; }, 8000);
}

function announceOk(message) {
    announce($('pageStatus'), message, 'success');
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = (err) => reject(err);
    });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsText(file);
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = (err) => reject(err);
    });
}

function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MAMMOTH_CDN;
        script.onload = () => resolve(window.mammoth);
        script.onerror = () => reject(new Error('تعذّر تحميل قارئ مستندات Word.'));
        document.head.appendChild(script);
    });
}

async function extractFileText(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.txt')) return readFileAsText(file);
    if (name.endsWith('.docx')) {
        try {
            const mammoth = await loadMammoth();
            const arrayBuffer = await file.arrayBuffer();
            const result = await mammoth.extractRawText({ arrayBuffer });
            if (result.value && result.value.trim()) return result.value;
        } catch (e) {
            // يسقط لاستخراج الخادم عند فشل mammoth
        }
    }
    const base64 = await fileToBase64(file);
    return voiceService.extractTextFromFile(base64, file.type || 'application/octet-stream');
}

function playCompletionSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.05, audioCtx.currentTime + 0.05);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) { /* الصوت محظور في المتصفح */ }
}

/**
 * يدمج مقاطع صوتية (MP3 من Edge أو WAV من Gemini) في ملف WAV واحد:
 * كل مقطع يُفك تشفيره عبر Web Audio أولًا، ثم تُلصق قنوات PCM
 * وتُعاد كتابتها WAV. فك التشفير يعيد أخذ العينات لمعدل سياق
 * الصوت نفسه، فكل المقاطع بنفس المعدل.
 */
async function mergeAudioUrls(audioUrls) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const segments = [];
        for (const url of audioUrls) {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const decoded = await ctx.decodeAudioData(arrayBuffer);
            const channels = [];
            for (let c = 0; c < decoded.numberOfChannels; c++) {
                channels.push(decoded.getChannelData(c));
            }
            segments.push({ sampleRate: decoded.sampleRate, channels });
        }
        const wav = mergeDecodedAudio(segments);
        const blob = new Blob([wav], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
    } finally {
        try { await ctx.close(); } catch (e) { /* تجاهل */ }
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ───────────────────────── المشغّل الموحّد ───────────────────────── */

function createPlayer({ url, title = '', subtitle = '', showShare = false, ext = 'wav' }) {
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const wrap = document.createElement('div');
    wrap.className = 'vs-player';
    wrap.innerHTML = `
        <div class="vs-player-head">
            <div>
                <h4 class="vs-player-title"></h4>
                <p class="vs-player-sub"></p>
            </div>
            <div class="vs-player-actions">
                <button type="button" class="vs-player-btn vs-player-replay" title="إعادة التشغيل" aria-label="إعادة التشغيل">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
                <button type="button" class="vs-player-btn vs-player-download" title="تحميل الملف" aria-label="تحميل الملف">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                </button>
            </div>
        </div>
        <div class="vs-player-body">
            <button type="button" class="vs-play-btn" aria-label="تشغيل أو إيقاف">
                <svg class="vs-icon-play" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                <svg class="vs-icon-pause" fill="currentColor" viewBox="0 0 24 24" hidden><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
            </button>
            <div class="vs-seek-wrap">
                <div class="vs-time"><span class="vs-time-current">0:00</span><span class="vs-time-total">0:00</span></div>
                <input type="range" class="vs-seek" min="0" max="0" step="0.01" value="0" aria-label="التنقل في المقطع">
            </div>
            <div class="vs-volume-wrap">
                <input type="range" class="vs-volume" min="0" max="1" step="0.01" value="1" aria-label="مستوى الصوت">
            </div>
        </div>`;
    wrap.querySelector('.vs-player-title').textContent = title;
    wrap.querySelector('.vs-player-sub').textContent = subtitle;
    if (!title) wrap.querySelector('.vs-player-title').remove();
    if (!subtitle) wrap.querySelector('.vs-player-sub').remove();
    if (showShare) {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'vs-player-btn vs-player-share';
        shareBtn.title = 'مشاركة عبر واتساب';
        shareBtn.setAttribute('aria-label', 'مشاركة عبر واتساب');
        shareBtn.innerHTML = '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>';
        shareBtn.addEventListener('click', async () => {
            try {
                const response = await fetch(url);
                const blob = await response.blob();
                const file = new File([blob], audioFileName(title, ext), { type: mimeType });
                if (navigator.share && navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: title || 'الاستوديو الصوتي',
                        text: 'استمع إلى التعليق الصوتي المولد عبر مدعوم',
                    });
                } else {
                    const text = encodeURIComponent(`استمع إلى التعليق الصوتي: ${window.location.href}`);
                    window.open(`https://wa.me/?text=${text}`, '_blank');
                }
            } catch (err) {
                showError('تعذّرت المشاركة.');
            }
        });
        wrap.querySelector('.vs-player-actions').appendChild(shareBtn);
    }

    const audio = new Audio(url);
    const playBtn = wrap.querySelector('.vs-play-btn');
    const iconPlay = wrap.querySelector('.vs-icon-play');
    const iconPause = wrap.querySelector('.vs-icon-pause');
    const seek = wrap.querySelector('.vs-seek');
    const currentEl = wrap.querySelector('.vs-time-current');
    const totalEl = wrap.querySelector('.vs-time-total');
    const volume = wrap.querySelector('.vs-volume');

    const setPlaying = (playing) => {
        iconPlay.hidden = playing;
        iconPause.hidden = !playing;
    };
    playBtn.addEventListener('click', () => {
        if (audio.paused) audio.play();
        else audio.pause();
    });
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => setPlaying(false));
    audio.addEventListener('timeupdate', () => {
        currentEl.textContent = formatTime(audio.currentTime);
        if (Number.isFinite(audio.duration)) seek.value = String(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', () => {
        totalEl.textContent = formatTime(audio.duration);
        seek.max = String(audio.duration || 0);
    });
    seek.addEventListener('input', () => {
        audio.currentTime = Number(seek.value) || 0;
        currentEl.textContent = formatTime(audio.currentTime);
    });
    volume.addEventListener('input', () => {
        audio.volume = Number(volume.value);
    });
    wrap.querySelector('.vs-player-replay').addEventListener('click', () => {
        audio.currentTime = 0;
        audio.play();
    });
    wrap.querySelector('.vs-player-download').addEventListener('click', async () => {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            downloadBlob(blob, audioFileName(title, ext));
        } catch (e) {
            showError('تعذّر تحميل الملف.');
        }
    });
    return wrap;
}

/* ───────────────────────── تبويبات الأوضاع والتلميح والمفتاح ───────────────────────── */

function switchMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#vsModeTabs .vs-mode-tab').forEach((btn) => {
        const active = btn.dataset.vsMode === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    $('vsSectionVoice').hidden = mode !== 'voice';
    $('vsSectionAudiobook').hidden = mode !== 'audiobook';
    $('vsSectionPodcast').hidden = mode !== 'podcast';
    $('vsSectionTranscript').hidden = mode !== 'transcript';
}

function initIntro() {
    let played = false;
    try {
        played = sessionStorage.getItem(INTRO_STORAGE) === 'true';
    } catch (e) { /* التخزين غير متاح */ }
    if (!played) {
        $('vsIntro').hidden = false;
        $('vsIntroClose').addEventListener('click', () => {
            try {
                sessionStorage.setItem(INTRO_STORAGE, 'true');
            } catch (e) { /* التخزين غير متاح */ }
            $('vsIntro').hidden = true;
        });
    }
}

function initGeminiKey() {
    const input = $('vsGeminiKey');
    const status = $('vsKeyStatus');
    const saved = voiceService.getUserApiKey();
    if (saved) {
        input.value = saved;
        status.textContent = 'مفتاح شخصي محفوظ — محرك Gemini متاح كخيار بديل، ووظائف النص مفعّلة.';
        status.classList.add('is-saved');
    }
    $('vsSaveKeyBtn').addEventListener('click', () => {
        voiceService.setUserApiKey(input.value);
        if (input.value.trim()) {
            status.textContent = 'مفتاح شخصي محفوظ — محرك Gemini متاح كخيار بديل، ووظائف النص مفعّلة.';
            status.classList.add('is-saved');
        } else {
            status.textContent = 'بلا مفتاح شخصي — التوليد الصوتي يعمل عبر Edge TTS المجاني؛ وظائف النص (تحسين، تفريغ…) تحتاج مفتاح Gemini.';
            status.classList.remove('is-saved');
        }
        updateEnginePills();
        announceOk('تم حفظ إعداد المفتاح.');
    });
}

/* ── شارة المحرك واختياره ────────────────────────────────────────────
   الافتراضي Edge TTS (مجاني، بلا مفتاح). زر Gemini معطّل بلا مفتاح
   شخصي محفوظ، ويُفعّل بحفظه. الشارة تعرض المحرك المستخدم فعلًا في
   آخر توليد، بما فيه السقوط الصريح على Gemini بعد تعذّر Edge. */

function updateEngineBadge() {
    const badge = $('vsEngineBadge');
    if (!badge) return;
    if (state.lastFallbackFrom) {
        badge.textContent = 'آخر توليد: Gemini (بديل بعد تعذّر Edge)';
        return;
    }
    if (state.lastEngineUsed === 'gemini') {
        badge.textContent = 'آخر توليد: Gemini — بمفتاحك الشخصي';
        return;
    }
    if (state.lastEngineUsed === 'edge') {
        badge.textContent = 'آخر توليد: Edge TTS — مجاني، بلا مفتاح';
        return;
    }
    badge.textContent = state.engine === 'gemini'
        ? 'المحرك: Gemini — بمفتاحك الشخصي'
        : 'المحرك: Edge TTS — مجاني، بلا مفتاح';
}

function updateEnginePills() {
    const hasKey = !!voiceService.getUserApiKey();
    const geminiBtn = $('vsEngineGemini');
    if (geminiBtn) {
        geminiBtn.disabled = !hasKey;
        geminiBtn.title = hasKey ? '' : 'يحتاج مفتاح Gemini شخصيًا';
    }
    document.querySelectorAll('[data-vs-engine]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.vsEngine === state.engine);
    });
    if (!hasKey && state.engine === 'gemini') state.engine = 'edge';
    updateEngineBadge();
}

function initEngine() {
    document.querySelectorAll('[data-vs-engine]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            state.engine = btn.dataset.vsEngine;
            state.lastEngineUsed = null;
            state.lastFallbackFrom = null;
            updateEnginePills();
        });
    });
    updateEnginePills();
}

function noteEngineUsed(result) {
    state.lastEngineUsed = result.engine || state.engine;
    state.lastFallbackFrom = result.fallbackFrom || null;
    updateEngineBadge();
}

/* ───────────────────────── وضع التعليق الصوتي ───────────────────────── */

const selectedDialect = () => DIALECTS.find((d) => d.id === state.dialectId) || DIALECTS[0];
const selectedField = () => VOICE_FIELDS.find((f) => f.id === state.fieldId) || VOICE_FIELDS[0];
const allVoicesFlattened = () => DIALECTS.flatMap((d) => d.profiles);

function filteredProfiles() {
    const source = state.type === 'كبار السن' ? allVoicesFlattened() : selectedDialect().profiles;
    const seen = new Set();
    return source.filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return p.voiceType === state.type && p.gender === (state.gender === 'ذكر' ? 'male' : 'female');
    });
}

function setControlsDisabled(disabled) {
    document.querySelectorAll('#vsSectionVoice button, #vsSectionVoice select, #vsSectionVoice textarea, #vsSectionVoice input')
        .forEach((el) => {
            if (el.id === 'vsGenerateBtn' || el.closest('.vs-result')) return;
            el.disabled = disabled;
        });
}

function renderDialects() {
    const box = $('vsDialects');
    box.innerHTML = '';
    for (const dialect of DIALECTS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `vs-dialect${state.dialectId === dialect.id ? ' is-active' : ''}`;
        btn.disabled = state.locked || state.generating;
        btn.innerHTML = `
            <span class="vs-dialect-head">
                <span class="vs-dialect-title"></span>
                <span class="vs-dialect-check" aria-hidden="true">✓</span>
            </span>
            <span class="vs-dialect-desc"></span>`;
        btn.querySelector('.vs-dialect-title').textContent = dialect.title;
        btn.querySelector('.vs-dialect-desc').textContent = dialect.description;
        btn.addEventListener('click', () => {
            if (state.locked || state.generating) return;
            state.dialectId = dialect.id;
            renderDialects();
            renderGallery();
        });
        box.appendChild(btn);
    }
    const note = $('vsDialectNote');
    if (note) note.hidden = state.dialectId !== 'sudanese';
}

function renderTypeGenderField() {
    const typesBox = $('vsTypes');
    typesBox.innerHTML = '';
    for (const type of VOICE_TYPES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `vs-pill${state.type === type ? ' is-active' : ''}`;
        btn.disabled = state.locked || state.generating;
        btn.textContent = type;
        btn.addEventListener('click', () => {
            if (state.locked || state.generating) return;
            state.type = type;
            renderTypeGenderField();
            renderGallery();
        });
        typesBox.appendChild(btn);
    }
    document.querySelectorAll('#vsGenders .vs-pill').forEach((btn) => {
        const active = btn.dataset.vsGender === state.gender;
        btn.classList.toggle('is-active', active);
        btn.disabled = state.locked || state.generating;
    });
    const fieldSelect = $('vsField');
    fieldSelect.innerHTML = '';
    for (const field of VOICE_FIELDS) {
        const opt = document.createElement('option');
        opt.value = field.id;
        opt.textContent = field.title;
        fieldSelect.appendChild(opt);
    }
    fieldSelect.value = state.fieldId;
    fieldSelect.disabled = state.locked || state.generating;
}

function categoryIcon(type) {
    const paths = {
        'mic-documentary': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />',
        'mic-ads': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />',
        'mic-kids': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />',
        'mic-podcast': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />',
        'mic-book': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.247 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />',
        'mic-youtube': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />',
    };
    const inner = paths[type] || paths['mic-documentary'];
    return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">${inner}</svg>`;
}

function renderGallery() {
    const box = $('vsGallery');
    const profiles = filteredProfiles();
    box.innerHTML = '';
    $('vsGalleryEmpty').hidden = profiles.length > 0;
    for (const profile of profiles) {
        const style = CATEGORY_STYLES[profile.categoryKey] || CATEGORY_STYLES.doc;
        const isActive = state.voiceName === profile.name;
        const isPreviewing = activePreviewId === profile.id;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `vs-voice-card${isActive ? ' is-active' : ''}`;
        card.disabled = state.locked || state.generating;
        card.innerHTML = `
            <span class="vs-voice-icon ${esc(style.tone)}">${categoryIcon(style.icon)}</span>
            <span class="vs-voice-name"></span>
            <span class="vs-voice-cat"></span>
            <span class="vs-voice-desc"></span>
            <span class="vs-voice-preview${isPreviewing ? ' is-playing' : ''}">${isPreviewing ? 'إيقاف' : 'استعراض الصوت'}</span>`;
        card.querySelector('.vs-voice-name').textContent = profile.name;
        card.querySelector('.vs-voice-cat').textContent = profile.category;
        card.querySelector('.vs-voice-desc').textContent = profile.description;
        card.addEventListener('click', () => {
            if (state.locked || state.generating) return;
            state.voiceName = profile.name;
            renderGallery();
        });
        card.querySelector('.vs-voice-preview').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.generating) handleVoicePreview(profile);
        });
        box.appendChild(card);
    }
}

async function handleVoicePreview(profile) {
    if (activePreviewId === profile.id) {
        previewAudio.pause();
        activePreviewId = null;
        renderGallery();
        renderPodcastSpeakers();
        return;
    }
    previewAudio.pause();
    previewLoading = true;
    activePreviewId = profile.id;
    renderGallery();
    renderPodcastSpeakers();
    try {
        const previewText = PREVIEW_SCRIPTS[profile.categoryKey] || PREVIEW_FALLBACK_TEXT;
        const baseVoice = getBaseVoiceForType(profile.voiceType, profile.gender);
        const result = await voiceService.generateVoiceOver(
            previewText, baseVoice, profile, state.controls, 'Identity Preview',
            state.project?.dialectId || state.podcast.dialectId, state.engine,
        );
        noteEngineUsed(result);
        previewAudio.src = result.url;
        await previewAudio.play();
    } catch (e) {
        activePreviewId = null;
        showError('الصوت المختار غير متاح حاليًا.');
    } finally {
        previewLoading = false;
        renderGallery();
        renderPodcastSpeakers();
    }
}

previewAudio.addEventListener('ended', () => {
    activePreviewId = null;
    renderGallery();
    renderPodcastSpeakers();
});

function renderControls() {
    const box = $('vsControls');
    box.innerHTML = '';
    for (const [key, control] of Object.entries(STUDIO_CONTROLS)) {
        const group = document.createElement('div');
        group.className = 'vs-control-group';
        const title = document.createElement('span');
        title.className = 'vs-control-title';
        title.textContent = control.title;
        group.appendChild(title);
        const opts = document.createElement('div');
        opts.className = 'vs-control-opts';
        for (const opt of control.options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `vs-control-opt${state.controls[key] === opt.label ? ' is-active' : ''}`;
            btn.disabled = state.locked || state.generating;
            btn.innerHTML = '<span class="vs-control-opt-label"></span><span class="vs-control-opt-desc"></span>';
            btn.querySelector('.vs-control-opt-label').textContent = opt.label;
            btn.querySelector('.vs-control-opt-desc').textContent = opt.desc;
            btn.addEventListener('click', () => {
                if (state.locked || state.generating) return;
                state.controls[key] = opt.label;
                renderControls();
            });
            opts.appendChild(btn);
        }
        group.appendChild(opts);
        box.appendChild(group);
    }

    const purposeBox = $('vsPurpose');
    purposeBox.innerHTML = '';
    for (const purpose of VOICE_PURPOSES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `vs-pill${state.controls.purpose === purpose ? ' is-active' : ''}`;
        btn.disabled = state.locked || state.generating;
        btn.textContent = purpose;
        btn.addEventListener('click', () => {
            if (state.locked || state.generating) return;
            state.controls.purpose = state.controls.purpose === purpose ? '' : purpose;
            renderControls();
        });
        purposeBox.appendChild(btn);
    }
    const note = $('vsPurposeNote');
    if (state.controls.purpose) {
        const descriptions = {
            'إعلان': 'سيتم ضبط الأداء ليكون حماسياً وجذاباً',
            'قصصي': 'سيتم ضبط الأداء ليكون دافئاً ومعبراً',
            'توعوي': 'سيتم ضبط الأداء ليكون هادئاً ومطمئناً',
            'إخباري': 'سيتم ضبط الأداء ليكون رسمياً ومباشراً',
            'تعليمي': 'سيتم ضبط الأداء ليكون واضحاً وتفسيرياً',
        };
        note.textContent = descriptions[state.controls.purpose] || '';
        note.hidden = false;
    } else {
        note.hidden = true;
    }
}

function renderLockFingerprint() {
    const lockBtn = $('vsLockBtn');
    lockBtn.textContent = state.locked ? 'الصوت مثبت ✓' : 'تثبيت الصوت';
    const fpBtn = $('vsFingerprintBtn');
    fpBtn.textContent = state.fingerprint.isActive ? 'بصمة الصوت ✓' : 'بصمة الصوت';
    $('vsFpDeactivate').hidden = !state.fingerprint.isActive;
    $('vsFpName').value = state.fingerprint.name;
    const fillGroup = (id, values, current, key) => {
        const box = $(id);
        box.innerHTML = '';
        for (const value of values) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `vs-fp-opt${current === value ? ' is-active' : ''}`;
            btn.textContent = value;
            btn.addEventListener('click', () => {
                state.fingerprint[key] = value;
                renderLockFingerprint();
            });
            box.appendChild(btn);
        }
    };
    fillGroup('vsFpStyle', ['رسمي', 'ودود', 'حماسي'], state.fingerprint.style, 'style');
    fillGroup('vsFpRhythm', ['هادئ', 'متوسط', 'نشيط'], state.fingerprint.rhythm, 'rhythm');
    fillGroup('vsFpNarrative', ['مباشر', 'قصصي'], state.fingerprint.narrative, 'narrative');
}

function initVoiceSection() {
    renderDialects();
    renderTypeGenderField();
    renderGallery();
    renderControls();
    renderLockFingerprint();
    renderHistory();

    document.querySelectorAll('#vsGenders .vs-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (state.locked || state.generating) return;
            state.gender = btn.dataset.vsGender;
            renderTypeGenderField();
            renderGallery();
        });
    });
    $('vsField').addEventListener('change', (e) => {
        state.fieldId = e.target.value;
    });

    $('vsLockBtn').addEventListener('click', () => {
        if (state.generating) return;
        state.locked = !state.locked;
        renderLockFingerprint();
        renderDialects();
        renderTypeGenderField();
        renderGallery();
        renderControls();
        setControlsDisabled(state.locked);
        if (!state.locked) setControlsDisabled(false);
    });

    $('vsFingerprintBtn').addEventListener('click', () => {
        if (state.generating) return;
        $('vsFingerprintPanel').hidden = !$('vsFingerprintPanel').hidden;
    });
    $('vsFpCancel').addEventListener('click', () => {
        $('vsFingerprintPanel').hidden = true;
    });
    $('vsFpName').addEventListener('input', (e) => {
        state.fingerprint.name = e.target.value;
    });
    $('vsFpSave').addEventListener('click', () => {
        state.fingerprint.isActive = true;
        $('vsFpConfirm').hidden = false;
        renderLockFingerprint();
        setTimeout(() => {
            $('vsFpConfirm').hidden = true;
            $('vsFingerprintPanel').hidden = true;
        }, 2000);
    });
    $('vsFpDeactivate').addEventListener('click', () => {
        state.fingerprint.isActive = false;
        $('vsFingerprintPanel').hidden = true;
        renderLockFingerprint();
    });

    $('vsImportTextBtn').addEventListener('click', () => $('vsImportFile').click());
    $('vsImportFile').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        $('vsImportName').hidden = false;
        $('vsImportName').textContent = `جارٍ قراءة ${file.name}…`;
        try {
            const text = await extractFileText(file);
            $('vsInputText').value = text;
            $('vsImportName').textContent = `تم استيراد: ${file.name}`;
        } catch (err) {
            showError(err.message || 'فشل استخراج النص.');
            $('vsImportName').hidden = true;
        } finally {
            e.target.value = '';
        }
    });

    $('vsPreprocessBtn').addEventListener('click', async () => {
        const text = $('vsInputText').value;
        if (!text.trim()) return;
        const btn = $('vsPreprocessBtn');
        btn.disabled = true;
        btn.textContent = 'جاري التحسين…';
        try {
            const processed = await voiceService.preprocessText(text, {
                dialect: selectedDialect().title,
                field: selectedField().title,
                personality: state.voiceName,
                controls: state.controls,
            });
            $('vsProcessedText').value = processed;
        } catch (err) {
            showError(err.message || 'تعذّر تحسين النص.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'تحسين النص ذكياً';
        }
    });

    $('vsKeySentencesBtn').addEventListener('click', async () => {
        const text = ($('vsProcessedText').value.trim() || $('vsInputText').value.trim());
        if (!text) return;
        const btn = $('vsKeySentencesBtn');
        btn.disabled = true;
        try {
            const sentences = await voiceService.identifyKeySentences(text);
            const box = $('vsKeySentences');
            const list = $('vsKeySentencesList');
            list.innerHTML = '';
            if (sentences.length) {
                for (const sentence of sentences) {
                    const p = document.createElement('p');
                    p.className = 'vs-key-sentence';
                    p.textContent = sentence;
                    list.appendChild(p);
                }
                box.hidden = false;
            } else {
                box.hidden = true;
            }
        } catch (err) {
            showError(err.message || 'تعذّر تحليل الجمل المحورية.');
        } finally {
            btn.disabled = false;
        }
    });

    $('vsGenerateBtn').addEventListener('click', handleStartTTSSynthesis);
}

function setProgress(percent, label) {
    $('vsProgress').hidden = false;
    $('vsProgressBar').style.width = `${percent}%`;
    $('vsProgressPct').textContent = `${percent}%`;
    if (label) $('vsProgressLabel').textContent = label;
}

async function handleStartTTSSynthesis() {
    if (state.generating) return;
    $('vsKeySentences').hidden = true;
    const targetText = ($('vsProcessedText').value.trim() || $('vsInputText').value.trim());
    const activeVoice = filteredProfiles().find((p) => p.name === state.voiceName);
    if (!targetText) {
        showError('يرجى إدخال النص أولاً لبدء الإنتاج.');
        return;
    }
    if (!activeVoice) {
        showError('يرجى اختيار صوت أولاً من المعرض وتثبيته.');
        return;
    }
    state.generating = true;
    setProgress(5, 'جاري تهيئة المحرك…');
    $('vsGenerateBtn').disabled = true;
    setControlsDisabled(true);

    const frozenText = targetText;
    const frozenVoiceProfile = { ...activeVoice };
    const frozenControls = { ...state.controls };
    const frozenDialectId = state.dialectId;
    const frozenVoiceType = state.type;
    const frozenBaseVoice = getBaseVoiceForType(frozenVoiceType, frozenVoiceProfile.gender);
    let performanceNote = 'Manual Studio Session (Synthesis Mode)';
    if (state.fingerprint.isActive) {
        performanceNote += ` [FINGERPRINT: Style=${state.fingerprint.style}, Rhythm=${state.fingerprint.rhythm}]`;
    }

    const stepTimers = [
        setTimeout(() => setProgress(25, 'جاري تحليل خصائص النص…'), 1000),
        setTimeout(() => setProgress(45, 'جاري توليد الصوت النهائي…'), 2500),
    ];
    try {
        const result = await voiceService.generateVoiceOver(
            frozenText, frozenBaseVoice, frozenVoiceProfile, frozenControls,
            performanceNote, frozenDialectId, state.engine,
        );
        noteEngineUsed(result);
        const url = result.url;
        const ext = result.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
        setProgress(100, 'اكتمل الإنتاج بنجاح!');
        playCompletionSound();
        const resultId = Math.random().toString(36).slice(2, 11);
        const resultData = {
            id: resultId,
            text: frozenText,
            selection: {
                dialect: selectedDialect().title,
                type: frozenVoiceType,
                field: selectedField().title,
                controls: frozenControls,
                fingerprint: state.fingerprint.isActive ? { ...state.fingerprint } : undefined,
            },
            timestamp: Date.now(),
            audioBlobUrl: url,
        };
        const resultBox = $('vsResult');
        resultBox.innerHTML = '';
        const heading = document.createElement('h3');
        heading.className = 'vs-step-title';
        heading.textContent = 'النتيجة الحالية';
        resultBox.appendChild(heading);
        resultBox.appendChild(createPlayer({
            url,
            title: `جلسة: ${resultData.selection.dialect}`,
            subtitle: resultData.selection.type,
            showShare: true,
            ext,
        }));
        resultBox.hidden = false;
        state.history = [
            {
                id: resultId,
                voiceName: frozenVoiceProfile.name,
                dialect: selectedDialect().title,
                category: frozenVoiceProfile.category,
                timestamp: Date.now(),
                url,
            },
            ...state.history,
        ].slice(0, HISTORY_LIMIT);
        saveHistory();
        renderHistory();
        setTimeout(() => {
            $('vsProgress').hidden = true;
            $('vsGenerateBtn').disabled = false;
            setControlsDisabled(state.locked);
            state.generating = false;
        }, 1200);
    } catch (err) {
        stepTimers.forEach(clearTimeout);
        showError(`فشل الإنتاج الصوتي: ${err.message || 'خطأ غير متوقع'}`);
        $('vsProgress').hidden = true;
        $('vsGenerateBtn').disabled = false;
        setControlsDisabled(state.locked);
        state.generating = false;
    }
}

function renderHistory() {
    const panel = $('vsHistoryPanel');
    const box = $('vsHistory');
    box.innerHTML = '';
    if (!state.history.length) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    for (const item of state.history) {
        const row = document.createElement('div');
        row.className = 'vs-history-item';
        row.innerHTML = `
            <div>
                <p class="vs-history-name"></p>
                <p class="vs-history-time"></p>
            </div>
            <button type="button" class="btn btn-outline btn-sm vs-history-play">تشغيل</button>`;
        row.querySelector('.vs-history-name').textContent = `${item.voiceName} - ${item.dialect}`;
        row.querySelector('.vs-history-time').textContent =
            new Date(item.timestamp).toLocaleTimeString('ar-EG');
        row.querySelector('.vs-history-play').addEventListener('click', () => {
            if (activePreviewId === item.id) {
                previewAudio.pause();
                activePreviewId = null;
                return;
            }
            previewAudio.pause();
            activePreviewId = item.id;
            previewAudio.src = item.url;
            previewAudio.play();
        });
        box.appendChild(row);
    }
}

/* ───────────────────────── وضع الكتب الصوتية ───────────────────────── */

function initializeNewProject(content = '') {
    state.project = {
        id: Math.random().toString(36).slice(2, 11),
        name: '',
        dialectId: state.dialectId,
        status: 'مسودة',
        createdAt: Date.now(),
        lastEdited: Date.now(),
        content,
        enhancedContent: '',
        segments: [{ id: 1, label: 'مقدمة الراوي', role: 'الراوي', selectedVoice: '', content: '' }],
    };
    state.bookMode = 'new';
    state.productionPhase = 'idle';
    state.productionProgress = 0;
    state.masterAudioUrl = null;
    saveProject();
}

function updateActiveProject(updates) {
    if (!state.project) return;
    Object.assign(state.project, updates, { lastEdited: Date.now() });
    saveProject();
}

function renderBookSteps() {
    const box = $('vsBookSteps');
    box.innerHTML = '';
    const currentIdx = WORKFLOW_STEPS.findIndex((s) => s.id === state.bookMode);
    WORKFLOW_STEPS.forEach((step, idx) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vs-book-step'
            + (step.id === state.bookMode ? ' is-active' : '')
            + (currentIdx > idx ? ' is-done' : '');
        btn.disabled = !state.project || state.productionPhase !== 'idle';
        btn.innerHTML = `
            <span class="vs-book-step-dot">${currentIdx > idx ? '✓' : idx + 1}</span>
            <span class="vs-book-step-label">${esc(step.label)}</span>`;
        btn.addEventListener('click', () => {
            if (!state.project || state.productionPhase !== 'idle') return;
            state.bookMode = step.id;
            renderBookSteps();
            renderBookPanel();
        });
        li.appendChild(btn);
        box.appendChild(li);
    });
}

function bookDialectSelect() {
    const options = DIALECTS.map((d) =>
        `<option value="${esc(d.id)}" ${state.project.dialectId === d.id ? 'selected' : ''}>${esc(d.title)}</option>`).join('');
    return `
        <div class="vs-field-row">
            <label class="vs-field-label" for="vsBookDialect">اختيار اللهجة</label>
            <select class="form-control vs-field-select" id="vsBookDialect">${options}</select>
        </div>`;
}

function renderBookPanel() {
    const panel = $('vsBookPanel');
    panel.innerHTML = '';
    if (!state.project) {
        panel.innerHTML = '<p class="vs-book-note">لا يوجد مشروع نشط — ابدأ مشروعًا جديدًا من الزر أعلاه.</p>';
        return;
    }
    const project = state.project;
    const mode = state.bookMode;

    if (mode === 'new' || mode === 'import' || mode === 'script') {
        const head = document.createElement('div');
        head.innerHTML = bookDialectSelect();
        head.querySelector('#vsBookDialect').addEventListener('change', (e) => {
            updateActiveProject({ dialectId: e.target.value });
        });
        panel.appendChild(head);
    }

    if (mode === 'new') {
        const wrap = document.createElement('div');
        wrap.className = 'vs-book-panel';
        wrap.innerHTML = `
            <div>
                <label class="vs-field-label" for="vsBookName">عنوان الكتاب الصوتي</label>
                <input type="text" class="form-control" id="vsBookName" placeholder="أدخل عنوان الكتاب الصوتي هنا…" value="${esc(project.name)}">
            </div>
            <div>
                <label class="vs-field-label" for="vsBookContent">النص المبدئي</label>
                <textarea class="form-control vs-textarea" id="vsBookContent" placeholder="اكتب أو الصق نص الكتاب هنا…">${esc(project.content)}</textarea>
            </div>
            <button type="button" class="btn btn-primary vs-book-next" id="vsBookToImport">المتابعة لاستيراد النص</button>`;
        wrap.querySelector('#vsBookName').addEventListener('input', (e) => updateActiveProject({ name: e.target.value }));
        wrap.querySelector('#vsBookContent').addEventListener('input', (e) => updateActiveProject({ content: e.target.value }));
        wrap.querySelector('#vsBookToImport').addEventListener('click', () => {
            state.bookMode = 'import';
            state.importTextBuffer = '';
            renderBookSteps();
            renderBookPanel();
        });
        panel.appendChild(wrap);
        return;
    }

    if (mode === 'import') {
        const wrap = document.createElement('div');
        wrap.className = 'vs-book-panel';
        wrap.innerHTML = `
            <div class="vs-tr-grid">
                <div>
                    <label class="vs-field-label">استيراد من ملف</label>
                    <input type="file" class="form-control" id="vsBookFile" accept=".txt,.doc,.docx,.pdf">
                    <p class="vs-import-name" id="vsBookFileName" hidden></p>
                </div>
                <div>
                    <label class="vs-field-label" for="vsBookImportText">محرر الاستيراد السريع</label>
                    <textarea class="form-control vs-textarea" id="vsBookImportText" placeholder="أو الصق النص هنا…"></textarea>
                </div>
            </div>
            <button type="button" class="btn btn-primary vs-book-next" id="vsBookSaveImport">حفظ النص في المشروع</button>
            <button type="button" class="btn btn-outline vs-book-next" id="vsBookToScript" hidden>متابعة لتجهيز النص</button>`;
        const importText = wrap.querySelector('#vsBookImportText');
        importText.value = state.importTextBuffer;
        importText.addEventListener('input', (e) => { state.importTextBuffer = e.target.value; });
        wrap.querySelector('#vsBookFile').addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const nameEl = wrap.querySelector('#vsBookFileName');
            nameEl.hidden = false;
            nameEl.textContent = `جارٍ قراءة ${file.name}…`;
            try {
                state.importTextBuffer = await extractFileText(file);
                importText.value = state.importTextBuffer;
                nameEl.textContent = `تمت قراءة: ${file.name}`;
            } catch (err) {
                showError(err.message || 'فشل استخراج النص.');
                nameEl.hidden = true;
            } finally {
                e.target.value = '';
            }
        });
        wrap.querySelector('#vsBookSaveImport').addEventListener('click', () => {
            if (!state.importTextBuffer.trim()) {
                showError('لا يوجد نص للحفظ.');
                return;
            }
            updateActiveProject({ content: state.importTextBuffer });
            announceOk('تمت إضافة النص إلى مشروع الكتاب الصوتي.');
            wrap.querySelector('#vsBookToScript').hidden = false;
        });
        wrap.querySelector('#vsBookToScript').addEventListener('click', () => {
            state.bookMode = 'script';
            renderBookSteps();
            renderBookPanel();
        });
        panel.appendChild(wrap);
        return;
    }

    if (mode === 'script') {
        const wrap = document.createElement('div');
        wrap.className = 'vs-book-panel';
        wrap.innerHTML = `
            <div class="vs-tr-grid">
                <div>
                    <label class="vs-field-label" for="vsBookOriginal">النص الأصلي</label>
                    <textarea class="form-control vs-textarea" id="vsBookOriginal">${esc(project.content)}</textarea>
                </div>
                <div>
                    <label class="vs-field-label" for="vsBookEnhanced">النص المُحسن والمعدل</label>
                    <textarea class="form-control vs-textarea" id="vsBookEnhanced" placeholder="النص المُحسن والمعدل…">${esc(project.enhancedContent || project.content)}</textarea>
                </div>
            </div>
            <div class="vs-tr-send">
                <button type="button" class="btn btn-outline" id="vsBookEnhance">تحسين النص ذكياً</button>
                <button type="button" class="btn btn-primary" id="vsBookApprove">اعتماد المخطوطة</button>
            </div>
            <button type="button" class="btn btn-outline vs-book-next" id="vsBookToMulti" hidden>متابعة لتوزيع النص وتوزيع الأدوار</button>`;
        wrap.querySelector('#vsBookOriginal').addEventListener('input', (e) => updateActiveProject({ content: e.target.value }));
        wrap.querySelector('#vsBookEnhanced').addEventListener('input', (e) => updateActiveProject({ enhancedContent: e.target.value }));
        wrap.querySelector('#vsBookEnhance').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'جاري التحسين…';
            try {
                const dialectTitle = DIALECTS.find((d) => d.id === project.dialectId)?.title || 'فصحى';
                const enhanced = await voiceService.preprocessText(project.content, {
                    dialect: dialectTitle, field: 'Novels', personality: 'Professional', controls: {},
                });
                updateActiveProject({ enhancedContent: enhanced });
                wrap.querySelector('#vsBookEnhanced').value = enhanced;
            } catch (err) {
                showError(err.message || 'تعذّر تحسين النص.');
            } finally {
                btn.disabled = false;
                btn.textContent = 'تحسين النص ذكياً';
            }
        });
        wrap.querySelector('#vsBookApprove').addEventListener('click', () => {
            announceOk('تم اعتماد المخطوطة.');
            wrap.querySelector('#vsBookToMulti').hidden = false;
        });
        wrap.querySelector('#vsBookToMulti').addEventListener('click', () => {
            state.bookMode = 'multi';
            renderBookSteps();
            renderBookPanel();
        });
        panel.appendChild(wrap);
        return;
    }

    if (mode === 'multi') {
        renderBookMulti(panel);
        return;
    }

    if (mode === 'pilot') {
        renderBookPilot(panel);
        return;
    }

    if (mode === 'production') {
        renderBookProduction(panel);
    }
}

function bookVoicesForProject() {
    return DIALECTS.find((d) => d.id === state.project.dialectId)?.profiles || allVoicesFlattened();
}

function renderBookMulti(panel) {
    const project = state.project;
    const wrap = document.createElement('div');
    wrap.className = 'vs-book-panel';
    const preview = document.createElement('div');
    preview.className = 'vs-seg';
    preview.innerHTML = `
        <span class="vs-field-label">معاينة نص المشروع</span>
        <p class="vs-book-note" style="text-align:right; white-space:pre-wrap;"></p>`;
    preview.querySelector('p').textContent = project.enhancedContent || project.content;
    wrap.appendChild(preview);

    const tools = document.createElement('div');
    tools.className = 'vs-tr-send';
    tools.innerHTML = `
        <button type="button" class="btn btn-outline" id="vsBookSplitManual">تقسيم حسب الفقرات</button>
        <button type="button" class="btn btn-outline" id="vsBookSplitSmart">توزيع ذكي للأدوار</button>`;
    wrap.appendChild(tools);

    const segmentsBox = document.createElement('div');
    segmentsBox.className = 'vs-book-panel';
    const renderSegments = () => {
        segmentsBox.innerHTML = '';
        project.segments.forEach((seg, idx) => {
            const segEl = document.createElement('div');
            segEl.className = 'vs-seg';
            const voiceOptions = bookVoicesForProject().map((v) =>
                `<option value="${esc(v.name)}" ${seg.selectedVoice === v.name ? 'selected' : ''}>${esc(v.name)} (${esc(v.category)})</option>`).join('');
            segEl.innerHTML = `
                <div class="vs-seg-head">
                    <div class="vs-seg-label-wrap">
                        <label class="vs-field-label">عنوان المقطع (فصل / مشهد)</label>
                        <input type="text" class="vs-seg-label" value="${esc(seg.label)}">
                    </div>
                    <div>
                        <label class="vs-field-label">المؤدي الصوتي</label>
                        <select class="form-control vs-seg-voice"><option value="">اختر الصوت…</option>${voiceOptions}</select>
                    </div>
                </div>
                <div>
                    <label class="vs-field-label">محتوى النص للمقطع</label>
                    <textarea class="form-control vs-seg-content">${esc(seg.content)}</textarea>
                </div>
                <div class="vs-seg-actions">
                    <button type="button" class="btn btn-outline btn-sm vs-seg-add">+ إضافة مقطع بعد</button>
                    <button type="button" class="btn btn-outline btn-sm vs-seg-remove">حذف</button>
                    <button type="button" class="btn btn-outline btn-sm vs-seg-merge">دمج مع التالي</button>
                </div>`;
            segEl.querySelector('.vs-seg-label').addEventListener('input', (e) => {
                project.segments[idx].label = e.target.value;
                saveProject();
            });
            segEl.querySelector('.vs-seg-voice').addEventListener('change', (e) => {
                project.segments[idx].selectedVoice = e.target.value;
                saveProject();
            });
            segEl.querySelector('.vs-seg-content').addEventListener('input', (e) => {
                project.segments[idx].content = e.target.value;
                saveProject();
            });
            segEl.querySelector('.vs-seg-add').addEventListener('click', () => {
                project.segments.splice(idx + 1, 0, {
                    id: Date.now(), label: 'مقطع جديد', role: 'شخصية', selectedVoice: '', content: '',
                });
                updateActiveProject({ segments: project.segments });
                renderSegments();
            });
            segEl.querySelector('.vs-seg-remove').addEventListener('click', () => {
                if (project.segments.length <= 1) return;
                project.segments.splice(idx, 1);
                updateActiveProject({ segments: project.segments });
                renderSegments();
            });
            const mergeBtn = segEl.querySelector('.vs-seg-merge');
            mergeBtn.hidden = idx >= project.segments.length - 1;
            mergeBtn.addEventListener('click', () => {
                if (idx >= project.segments.length - 1) return;
                project.segments[idx].content += `\n\n${project.segments[idx + 1].content}`;
                project.segments.splice(idx + 1, 1);
                updateActiveProject({ segments: project.segments });
                renderSegments();
            });
            segmentsBox.appendChild(segEl);
        });
    };
    renderSegments();
    wrap.appendChild(segmentsBox);

    const footer = document.createElement('div');
    footer.className = 'vs-book-panel';
    footer.innerHTML = `
        <button type="button" class="btn btn-outline vs-book-next" id="vsBookAddSeg">+ إضافة مقطع يدوي جديد</button>
        <button type="button" class="btn btn-primary vs-generate" id="vsBookSaveDist">حفظ التوزيع والمتابعة</button>
        <button type="button" class="btn btn-outline vs-book-next" id="vsBookToPilot" hidden>متابعة لتوليد مقاطع تجريبية</button>`;
    footer.querySelector('#vsBookAddSeg').addEventListener('click', () => {
        project.segments.push({ id: Date.now(), label: 'مقطع جديد', role: 'شخصية', selectedVoice: '', content: '' });
        updateActiveProject({ segments: project.segments });
        renderSegments();
    });
    footer.querySelector('#vsBookSaveDist').addEventListener('click', () => {
        const unassigned = project.segments.some((s) => !s.selectedVoice);
        if (unassigned) {
            showError('يرجى التأكد من اختيار صوت لكل مقطع نصي قبل المتابعة.');
            return;
        }
        announceOk('تم حفظ التوزيع.');
        footer.querySelector('#vsBookToPilot').hidden = false;
    });
    footer.querySelector('#vsBookToPilot').addEventListener('click', () => {
        state.bookMode = 'pilot';
        renderBookSteps();
        renderBookPanel();
    });
    wrap.appendChild(footer);

    tools.querySelector('#vsBookSplitManual').addEventListener('click', () => {
        const text = project.enhancedContent || project.content;
        const paragraphs = splitTextByParagraphs(text);
        if (!paragraphs.length) {
            showError('لا يوجد نص متاح لتوزيع الأصوات.');
            return;
        }
        const voices = bookVoicesForProject();
        updateActiveProject({
            segments: paragraphs.map((p, i) => ({
                id: Date.now() + i,
                label: `فقرة ${i + 1}`,
                role: 'الراوي',
                selectedVoice: voices[0]?.name || '',
                content: p,
            })),
        });
        renderSegments();
    });
    tools.querySelector('#vsBookSplitSmart').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const sourceText = project.enhancedContent || project.content;
        if (!sourceText.trim()) {
            showError('لا يوجد نص متاح لتوزيع الأصوات.');
            return;
        }
        btn.disabled = true;
        btn.textContent = 'جاري التوزيع…';
        try {
            const suggestions = await voiceService.analyzeAndSegmentText(sourceText);
            const availableVoices = bookVoicesForProject();
            const roleVoiceMap = {};
            const newSegments = suggestions.map((sug, idx) => {
                if (!roleVoiceMap[sug.role]) {
                    roleVoiceMap[sug.role] = mapRoleToVoice(sug.role, availableVoices);
                }
                return {
                    id: Date.now() + idx,
                    label: sug.label,
                    role: sug.role,
                    selectedVoice: roleVoiceMap[sug.role],
                    content: sug.text,
                };
            });
            updateActiveProject({ segments: newSegments });
            renderSegments();
            announceOk('تم التوزيع الذكي للأدوار.');
        } catch (err) {
            showError('حدث خطأ أثناء التوزيع التلقائي الذكي.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'توزيع ذكي للأدوار';
        }
    });

    panel.appendChild(wrap);
}

function renderBookPilot(panel) {
    const project = state.project;
    const wrap = document.createElement('div');
    wrap.className = 'vs-book-panel';
    wrap.innerHTML = `
        <p class="vs-book-note">استمع لعينات صوتية من كل مقطع للتأكد من تناغم الأصوات قبل بدء الإنتاج الماستر النهائي.</p>
        <div class="vs-book-panel" id="vsPilotGrid"></div>
        <button type="button" class="btn btn-primary vs-book-next" id="vsBookToProduction">متابعة للإنتاج النهائي الكامل</button>`;
    const grid = wrap.querySelector('#vsPilotGrid');
    project.segments.forEach((seg, idx) => {
        const card = document.createElement('div');
        card.className = 'vs-seg';
        card.innerHTML = `
            <div class="vs-seg-head">
                <div class="vs-seg-label-wrap">
                    <h4 class="vs-book-step-label" style="font-size:1rem; text-align:right;"></h4>
                    <p class="vs-book-note" style="text-align:right;">المؤدي: ${esc(seg.selectedVoice || 'غير محدد')}</p>
                </div>
            </div>
            <div class="vs-seg-pilot"></div>`;
        card.querySelector('h4').textContent = seg.label;
        const pilotBox = card.querySelector('.vs-seg-pilot');
        if (seg.pilotAudioUrl) {
            pilotBox.appendChild(createPlayer({
                url: seg.pilotAudioUrl, title: `عينة: ${seg.label}`, subtitle: seg.selectedVoice,
                ext: seg.pilotAudioExt || 'wav',
            }));
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-outline';
            btn.disabled = !seg.selectedVoice || !seg.content.trim() || state.pilotLoadingId !== null;
            btn.textContent = state.pilotLoadingId === seg.id ? 'جاري التوليد…' : 'توليد عينة تجريبية (أول ١٠٠ حرف)';
            btn.addEventListener('click', async () => {
                state.pilotLoadingId = seg.id;
                renderBookPanel();
                try {
                    const voice = allVoicesFlattened().find((v) => v.name === seg.selectedVoice);
                    if (!voice) throw new Error('الصوت غير موجود.');
                    const result = await voiceService.generateVoiceOver(
                        seg.content.substring(0, 100),
                        getBaseVoiceForType(voice.voiceType, voice.gender),
                        voice, state.controls, 'Pilot Lock', project.dialectId, state.engine,
                    );
                    noteEngineUsed(result);
                    const updated = [...project.segments];
                    updated[idx] = {
                        ...updated[idx],
                        pilotAudioUrl: result.url,
                        pilotAudioExt: result.mimeType === 'audio/mpeg' ? 'mp3' : 'wav',
                    };
                    updateActiveProject({ segments: updated });
                } catch (err) {
                    showError(err.message || 'الصوت غير متاح حالياً.');
                } finally {
                    state.pilotLoadingId = null;
                    renderBookPanel();
                }
            });
            pilotBox.appendChild(btn);
        }
        grid.appendChild(card);
    });
    wrap.querySelector('#vsBookToProduction').addEventListener('click', () => {
        state.bookMode = 'production';
        renderBookSteps();
        renderBookPanel();
    });
    panel.appendChild(wrap);
}

function renderBookProduction(panel) {
    const project = state.project;
    const wrap = document.createElement('div');
    wrap.className = 'vs-book-panel';
    wrap.style.alignItems = 'center';
    wrap.innerHTML = `
        <p class="vs-book-note">سيتم الآن معالجة كافة المقاطع وتوليد النسخة النهائية الماستر للكتاب الصوتي. قد تستغرق هذه العملية عدة دقائق بناءً على طول النص الإجمالي لضمان الجودة الفائقة.</p>
        <div id="vsProdBox" style="width:100%; display:flex; flex-direction:column; align-items:center; gap:1rem;"></div>`;
    const box = wrap.querySelector('#vsProdBox');
    if (state.productionPhase === 'completed' && state.masterAudioUrl) {
        const ok = document.createElement('p');
        ok.className = 'vs-book-success';
        ok.textContent = '✓ تم إنتاج الماستر النهائي بنجاح';
        box.appendChild(ok);
        box.appendChild(createPlayer({
            url: state.masterAudioUrl,
            title: project.name || 'كتاب صوتي جديد',
            subtitle: 'النسخة الماستر الكاملة',
            showShare: true,
        }));
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'btn btn-outline';
        closeBtn.textContent = 'إغلاق المشروع والبدء من جديد';
        closeBtn.addEventListener('click', () => {
            state.masterAudioUrl = null;
            state.productionPhase = 'idle';
            state.bookMode = 'new';
            renderBookSteps();
            renderBookPanel();
        });
        box.appendChild(closeBtn);
    } else {
        const launch = document.createElement('button');
        launch.type = 'button';
        launch.className = 'btn btn-primary vs-generate';
        launch.disabled = state.productionPhase === 'generating';
        launch.textContent = state.productionPhase === 'generating' ? 'جاري الإنتاج…' : 'إطلاق الإنتاج الصوتي';
        launch.addEventListener('click', async () => {
            state.productionPhase = 'generating';
            state.productionProgress = 0;
            renderBookPanel();
            const segments = [...project.segments];
            const updated = [...segments];
            try {
                for (let i = 0; i < segments.length; i++) {
                    const voice = allVoicesFlattened().find((v) => v.name === segments[i].selectedVoice);
                    if (!voice) continue;
                    const result = await voiceService.generateVoiceOver(
                        segments[i].content,
                        getBaseVoiceForType(voice.voiceType, voice.gender),
                        voice, state.controls, `Full Production: Segment ${i + 1}`, project.dialectId, state.engine,
                    );
                    noteEngineUsed(result);
                    updated[i] = { ...updated[i], finalAudioUrl: result.url };
                    state.productionProgress = Math.round(((i + 1) / segments.length) * 100);
                    const bar = $('vsProdBar');
                    const pct = $('vsProdPct');
                    if (bar) bar.style.width = `${state.productionProgress}%`;
                    if (pct) pct.textContent = `${state.productionProgress}%`;
                }
                const valid = updated.map((u) => u.finalAudioUrl).filter(Boolean);
                if (!valid.length) throw new Error('لم يتم توليد أي مقاطع بنجاح.');
                state.masterAudioUrl = await mergeAudioUrls(valid);
                state.productionPhase = 'completed';
                updateActiveProject({ segments: updated });
            } catch (err) {
                showError(`خطأ في الإنتاج النهائي: ${err.message}`);
                state.productionPhase = 'idle';
            }
            renderBookPanel();
        });
        box.appendChild(launch);
        if (state.productionPhase === 'generating') {
            const progress = document.createElement('div');
            progress.className = 'vs-progress';
            progress.style.width = '100%';
            progress.innerHTML = `
                <div class="meter" role="presentation"><span class="meter-fill" id="vsProdBar" style="width:${state.productionProgress}%"></span></div>
                <p class="vs-progress-pct" id="vsProdPct">${state.productionProgress}%</p>`;
            box.appendChild(progress);
        }
    }
    panel.appendChild(wrap);
}

function initAudiobook() {
    state.project = loadProject();
    if (state.project) state.bookMode = 'new';
    renderBookSteps();
    renderBookPanel();
    $('vsBookNewBtn').addEventListener('click', () => {
        initializeNewProject();
        renderBookSteps();
        renderBookPanel();
        switchMode('audiobook');
    });
}

/* ───────────────────────── وضع البودكاست ───────────────────────── */

function podcastDialectVoices() {
    return DIALECTS.find((d) => d.id === state.podcast.dialectId)?.profiles || [];
}

function renderPodcastSpeakers() {
    const box = $('vsPodSpeakers');
    box.innerHTML = '';
    state.podcast.speakers.forEach((speaker, sIdx) => {
        const assignedVoiceId = state.podcast.voiceMap[speaker.id];
        const assignedVoice = podcastDialectVoices().find((v) => v.id === assignedVoiceId);
        const isManual = speaker.id.startsWith('manual_speaker');
        const card = document.createElement('div');
        card.className = 'vs-speaker';
        const voiceOptions = podcastDialectVoices().map((v) =>
            `<option value="${esc(v.id)}" ${assignedVoiceId === v.id ? 'selected' : ''}>${esc(v.name)} (${esc(v.category)})</option>`).join('');
        card.innerHTML = `
            <span class="vs-speaker-tag">${isManual ? 'تعريف المستخدم' : 'اقتراح ذكي'}</span>
            <span class="vs-field-label">الشخصية ${sIdx + 1} — المعرّف: ${esc(speaker.id.slice(0, 8))}</span>
            <div class="vs-tr-grid" style="grid-template-columns:1fr 1fr;">
                <div>
                    <label class="vs-field-label">الدور</label>
                    <input type="text" class="form-control vs-speaker-role" value="${esc(speaker.role)}">
                </div>
                <div>
                    <label class="vs-field-label">النبرة (Tone)</label>
                    <input type="text" class="form-control vs-speaker-tone" value="${esc(speaker.tone)}">
                </div>
            </div>
            <div>
                <label class="vs-field-label">اختيار المؤدي الصوتي</label>
                <div style="display:flex; gap:.5rem;">
                    <select class="form-control vs-speaker-voice" style="flex:1;"><option value="" disabled ${assignedVoiceId ? '' : 'selected'}>اختر صوتاً…</option>${voiceOptions}</select>
                    <button type="button" class="btn btn-outline btn-sm vs-speaker-preview" ${assignedVoice ? '' : 'hidden'}>${activePreviewId === assignedVoiceId ? 'إيقاف' : 'معاينة'}</button>
                </div>
            </div>
            ${state.podcast.distMode === 'smart' && speaker.reasoning ? `<span class="vs-speaker-reason"></span>` : ''}
            <p class="vs-speaker-desc"></p>`;
        if (state.podcast.distMode === 'smart' && speaker.reasoning) {
            card.querySelector('.vs-speaker-reason').textContent = speaker.reasoning;
        }
        card.querySelector('.vs-speaker-desc').textContent = speaker.description || '';
        card.querySelector('.vs-speaker-role').addEventListener('input', (e) => {
            state.podcast.speakers[sIdx].role = e.target.value;
        });
        card.querySelector('.vs-speaker-tone').addEventListener('input', (e) => {
            state.podcast.speakers[sIdx].tone = e.target.value;
        });
        card.querySelector('.vs-speaker-voice').addEventListener('change', (e) => {
            state.podcast.voiceMap[speaker.id] = e.target.value;
            if (state.podcast.distMode === 'smart') {
                state.podcast.distMode = 'manual';
                renderPodcastDistMode();
            }
            renderPodcastSpeakers();
        });
        const previewBtn = card.querySelector('.vs-speaker-preview');
        if (assignedVoice && previewBtn) {
            previewBtn.addEventListener('click', () => handleVoicePreview(assignedVoice));
        }
        box.appendChild(card);
    });
}

function renderPodcastDistMode() {
    document.querySelectorAll('[data-vs-pod-dist]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.vsPodDist === state.podcast.distMode);
    });
}

function renderPodcastTurns() {
    const box = $('vsPodTurns');
    box.innerHTML = '';
    (state.podcast.script || []).forEach((turn, idx) => {
        const speaker = state.podcast.speakers.find((s) => s.id === turn.speakerId);
        const turnEl = document.createElement('div');
        turnEl.className = 'vs-pod-turn';
        const speakerOptions = state.podcast.speakers.map((s) =>
            `<option value="${esc(s.id)}" ${turn.speakerId === s.id ? 'selected' : ''}>${esc(s.role)}</option>`).join('');
        turnEl.innerHTML = `
            <div class="vs-pod-turn-head">
                <span class="vs-pod-turn-speaker">المتحدث:</span>
                <select class="form-control vs-pod-turn-speaker-select" style="width:auto;">${speakerOptions}</select>
            </div>
            <textarea class="vs-pod-turn-text" aria-label="نص الدور">${esc(turn.text)}</textarea>`;
        turnEl.querySelector('.vs-pod-turn-speaker-select').addEventListener('change', (e) => {
            state.podcast.script[idx].speakerId = e.target.value;
        });
        turnEl.querySelector('.vs-pod-turn-text').addEventListener('input', (e) => {
            state.podcast.script[idx].text = e.target.value;
        });
        box.appendChild(turnEl);
    });
}

function applySmartDistribution() {
    state.podcast.voiceMap = smartDistributeSpeakers(state.podcast.speakers, podcastDialectVoices());
}

async function handleGeneratePodcastScript() {
    const content = state.podcast.text.trim() || $('vsPodText').value.trim();
    if (!content) {
        showError('يرجى إدخال النص أولاً للتحليل.');
        return;
    }
    state.podcast.text = content;
    const btn = $('vsPodAnalyzeBtn');
    btn.disabled = true;
    btn.textContent = 'جاري التحليل…';
    state.podcast.audioUrl = null;
    state.podcast.generated = false;
    state.podcast.distributed = false;
    try {
        const dialectName = DIALECTS.find((d) => d.id === state.podcast.dialectId)?.title || 'فصحى';
        const result = await voiceService.generatePodcastScript(
            content, dialectName, state.podcast.dialectId, state.podcast.speakers,
        );
        if (result.error) {
            showError(result.error);
            return;
        }
        state.podcast.script = result.turns || [];
        const merged = [...state.podcast.speakers];
        for (const newSpeaker of result.speakers || []) {
            if (!merged.some((s) => s.id === newSpeaker.id)) merged.push(newSpeaker);
        }
        state.podcast.speakers = merged;
        if (state.podcast.distMode === 'smart') applySmartDistribution();
        else {
            // يوزّع الذكي فقط من لا صوت له بعد
            const partial = smartDistributeSpeakers(state.podcast.speakers, podcastDialectVoices());
            state.podcast.voiceMap = { ...partial, ...state.podcast.voiceMap };
        }
        $('vsPodDistribution').hidden = false;
        $('vsPodScript').hidden = false;
        $('vsPodResult').hidden = true;
        renderPodcastSpeakers();
        renderPodcastTurns();
        renderPodcastDistMode();
    } catch (err) {
        showError(err.message || 'تعذر تحليل المحتوى.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'تحليل المحتوى وصياغة المسودة';
    }
}

function initPodcast() {
    const dialectSelect = $('vsPodDialect');
    dialectSelect.innerHTML = DIALECTS.map((d) =>
        `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join('');
    dialectSelect.value = state.podcast.dialectId;
    dialectSelect.addEventListener('change', (e) => {
        state.podcast.dialectId = e.target.value;
        state.podcast.script = null;
        state.podcast.speakers = [];
        state.podcast.audioUrl = null;
        state.podcast.generated = false;
        state.podcast.distributed = false;
        state.podcast.voiceMap = {};
        $('vsPodDistribution').hidden = true;
        $('vsPodScript').hidden = true;
        $('vsPodResult').hidden = true;
        renderPodcastSpeakers();
    });

    document.querySelectorAll('[data-vs-pod-source]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.podcast.source = btn.dataset.vsPodSource;
            document.querySelectorAll('[data-vs-pod-source]').forEach((b) =>
                b.classList.toggle('is-active', b === btn));
            $('vsPodManualBox').hidden = state.podcast.source !== 'manual';
            $('vsPodUploadBox').hidden = state.podcast.source !== 'upload';
        });
    });
    $('vsPodText').addEventListener('input', (e) => {
        state.podcast.text = e.target.value;
    });
    $('vsPodFile').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const nameEl = $('vsPodFileName');
        nameEl.hidden = false;
        nameEl.textContent = `جارٍ قراءة ${file.name}…`;
        try {
            state.podcast.text = await extractFileText(file);
            $('vsPodText').value = state.podcast.text;
            nameEl.textContent = `تمت قراءة: ${file.name}`;
        } catch (err) {
            showError(err.message || 'فشل استخراج النص.');
            nameEl.hidden = true;
        } finally {
            e.target.value = '';
        }
    });

    $('vsPodAnalyzeBtn').addEventListener('click', handleGeneratePodcastScript);
    $('vsPodReanalyze').addEventListener('click', handleGeneratePodcastScript);

    $('vsPodAddSpeaker').addEventListener('click', () => {
        state.podcast.speakers.push({
            id: `manual_speaker_${Date.now()}`,
            role: 'شخصية جديدة',
            tone: 'هادئ',
            style: 'رسمي',
            gender: 'any',
            categoryHint: 'podcast',
            description: 'شخصية تمت إضافتها يدوياً',
            reasoning: 'إضافة يدوية',
        });
        state.podcast.distMode = 'manual';
        renderPodcastDistMode();
        renderPodcastSpeakers();
    });

    document.querySelectorAll('[data-vs-pod-dist]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.podcast.distMode = btn.dataset.vsPodDist;
            if (state.podcast.distMode === 'smart') applySmartDistribution();
            renderPodcastDistMode();
            renderPodcastSpeakers();
        });
    });

    $('vsPodConfirmBtn').addEventListener('click', () => {
        const allAssigned = state.podcast.speakers.length > 0
            && state.podcast.speakers.every((s) => state.podcast.voiceMap[s.id]);
        if (!allAssigned) {
            $('vsPodDistNote').hidden = false;
            return;
        }
        $('vsPodDistNote').hidden = true;
        state.podcast.distributed = true;
        announceOk('تم اعتماد التوزيع بنجاح.');
    });

    $('vsPodGenerateBtn').addEventListener('click', async () => {
        if (!state.podcast.script || !state.podcast.script.length) return;
        const btn = $('vsPodGenerateBtn');
        btn.disabled = true;
        $('vsPodProgress').hidden = false;
        try {
            const audioParts = [];
            for (let i = 0; i < state.podcast.script.length; i++) {
                const turn = state.podcast.script[i];
                const voiceId = state.podcast.voiceMap[turn.speakerId];
                const profile = podcastDialectVoices().find((v) => v.id === voiceId);
                if (!profile) throw new Error('يجب اختيار أصوات صحيحة لكافة الشخصيات.');
                const voiceName = getBaseVoiceForType(profile.voiceType, profile.gender);
                const result = await voiceService.generateVoiceOver(
                    turn.text, voiceName, profile, state.controls,
                    'Podcast Audio Production', state.podcast.dialectId, state.engine,
                );
                noteEngineUsed(result);
                audioParts.push(result.url);
                const pct = Math.round(((i + 1) / state.podcast.script.length) * 100);
                state.podcast.progress = pct;
                $('vsPodProgressBar').style.width = `${pct}%`;
                $('vsPodProgressPct').textContent = `${pct}%`;
                $('vsPodProgressLabel').textContent = `جاري الإنتاج (${pct}%)…`;
            }
            state.podcast.audioUrl = await mergeAudioUrls(audioParts);
            state.podcast.generated = true;
            const resultBox = $('vsPodResult');
            resultBox.innerHTML = '';
            resultBox.appendChild(createPlayer({
                url: state.podcast.audioUrl, title: 'Podcast Production Result', showShare: true,
            }));
            const restart = document.createElement('button');
            restart.type = 'button';
            restart.className = 'btn btn-outline';
            restart.textContent = 'بدء جلسة بودكاست جديدة';
            restart.addEventListener('click', () => {
                state.podcast.script = null;
                state.podcast.speakers = [];
                state.podcast.audioUrl = null;
                state.podcast.generated = false;
                state.podcast.distributed = false;
                state.podcast.distMode = 'smart';
                state.podcast.voiceMap = {};
                $('vsPodDistribution').hidden = true;
                $('vsPodScript').hidden = true;
                $('vsPodResult').hidden = true;
                $('vsPodProgress').hidden = true;
                renderPodcastSpeakers();
            });
            resultBox.appendChild(restart);
            resultBox.hidden = false;
        } catch (err) {
            showError('حدث خطأ أثناء توليد البودكاست الصوتي.');
        } finally {
            btn.disabled = false;
            $('vsPodProgress').hidden = true;
        }
    });
}

/* ───────────────────────── وضع التفريغ النصي ───────────────────────── */

function initTranscript() {
    $('vsTrFile').addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
            showError('هذا القسم يدعم ملفات الوسائط (صوت أو فيديو) فقط.');
            e.target.value = '';
            return;
        }
        state.transcript.file = file;
        state.transcript.status = 'idle';
        state.transcript.result = '';
        $('vsTrResultBox').hidden = true;
        const nameEl = $('vsTrFileName');
        nameEl.hidden = false;
        nameEl.textContent = file.name;
        e.target.value = '';
    });

    $('vsTrTimestamps').addEventListener('click', () => {
        state.transcript.useTimestamps = !state.transcript.useTimestamps;
        $('vsTrTimestamps').setAttribute('aria-checked', String(state.transcript.useTimestamps));
    });

    $('vsTrStartBtn').addEventListener('click', async () => {
        if (!state.transcript.file) {
            showError('يرجى اختيار ملف وسائط أولاً.');
            return;
        }
        const btn = $('vsTrStartBtn');
        btn.disabled = true;
        btn.textContent = 'جاري التفريغ…';
        state.transcript.status = 'transcribing';
        try {
            const base64 = await fileToBase64(state.transcript.file);
            const result = await voiceService.transcribeMedia(
                base64, state.transcript.file.type, state.transcript.useTimestamps, 'Auto',
            );
            state.transcript.result = result;
            state.transcript.status = 'completed';
            $('vsTrResult').value = result;
            $('vsTrResultBox').hidden = false;
            announceOk('اكتمل التفريغ النصي.');
        } catch (err) {
            state.transcript.status = 'idle';
            showError(err.message || 'فشل في عملية التفريغ.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'بدء التفريغ النصي';
        }
    });

    $('vsTrCopy').addEventListener('click', async () => {
        const text = $('vsTrResult').value;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            $('vsTrCopy').textContent = 'تم نسخ النص';
            setTimeout(() => { $('vsTrCopy').textContent = 'نسخ النص'; }, 2000);
        } catch (e) {
            showError('تعذّر النسخ.');
        }
    });

    $('vsTrFormat').addEventListener('change', (e) => {
        state.transcript.format = e.target.value;
    });

    $('vsTrDownload').addEventListener('click', () => {
        const text = $('vsTrResult').value;
        if (!text) return;
        const format = state.transcript.format;
        let content = text;
        let mime = 'text/plain';
        if (format === 'srt') content = buildSrt(text);
        if (format === 'docx') {
            content = buildDocxHtml(text);
            mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
        const blob = new Blob([content], { type: mime });
        downloadBlob(blob, transcriptFileName(format, state.transcript.file?.name || 'result'));
    });

    $('vsTrToPodcast').addEventListener('click', () => {
        const text = $('vsTrResult').value;
        if (!text) return;
        state.podcast.text = text;
        $('vsPodText').value = text;
        state.podcast.source = 'manual';
        document.querySelectorAll('[data-vs-pod-source]').forEach((b) =>
            b.classList.toggle('is-active', b.dataset.vsPodSource === 'manual'));
        $('vsPodManualBox').hidden = false;
        $('vsPodUploadBox').hidden = true;
        switchMode('podcast');
    });

    $('vsTrToAudiobook').addEventListener('click', () => {
        const text = $('vsTrResult').value;
        if (!text) return;
        initializeNewProject(text);
        renderBookSteps();
        renderBookPanel();
        switchMode('audiobook');
    });
}

/* ───────────────────────── التشغيل ───────────────────────── */

const boot = await bootOwnerPage();
if (boot) {
    state.history = loadHistory();
    initIntro();
    initGeminiKey();
    initEngine();
    document.querySelectorAll('#vsModeTabs .vs-mode-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchMode(btn.dataset.vsMode));
    });
    initVoiceSection();
    initAudiobook();
    initPodcast();
    initTranscript();
}
