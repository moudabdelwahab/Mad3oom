/**
 * اختبارات ربط صفحة الاستوديو الصوتي (owner/voice-studio.html):
 *  • الصفحة موجودة بقشرة المالك ومربوطة في القائمة بعد رابط شات Muse.
 *  • كل id يقرأه الـ JS معرّف في الـ HTML أو في قالب يرسمه الـ JS.
 *  • لا أثر للاسم القديم أو الألوان المحظورة في أي ملف جديد.
 *  • التنسيق مقصور على الصفحة وبلا ألوان ثابتة — توكنز فقط.
 *  • الـ Edge Function تحمل الإجراءات الثمانية بلا WebSocket.
 *
 * ملاحظة: سلاسل الاسم القديم والألوان المحظورة مبنية من مقاطع هنا
 * حتى يبقى ملف الاختبار نفسه نظيفًا عند فحص grep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = () => read('owner/voice-studio.html');
const pageJs = () => read('assets/js/owner/pages/voice-studio.js');
const dataJs = () => read('assets/js/owner/voice-studio-data.js');
const stateJs = () => read('assets/js/owner/voice-studio-state.js');
const css = () => read('assets/css/owner-voice-studio.css');
const fnTs = () => read('supabase/functions/voice-studio/index.ts');
const edgeTs = () => read('supabase/functions/voice-studio/edge-tts.ts');
const workflow = () => read('.github/workflows/deploy-voice-studio.yml');
const sidebar = () => read('assets/components/owner-sidebar.html');

const NEW_FILES = [
    'owner/voice-studio.html',
    'assets/js/owner/voice-studio-data.js',
    'assets/js/owner/voice-studio-state.js',
    'assets/js/owner/pages/voice-studio.js',
    'assets/css/owner-voice-studio.css',
    'supabase/functions/voice-studio/index.ts',
    'supabase/functions/voice-studio/edge-tts.ts',
    '.github/workflows/deploy-voice-studio.yml',
    'tests/voice-studio.render.test.mjs',
    'tests/voice-studio-state.test.mjs',
];

/* سلاسل محظورة مبنية من مقاطع — لا تظهر حرفيًا في هذا الملف. */
const FORBIDDEN_BRAND = [
    ['sa', 'vio'].join(''),
    ['\u0633', '\u0627', '\u0641', '\u064a', '\u0648'].join(''),
    ['ai', 'studio', '-', 'build'].join(''),
    ['ahmed', '_', 'sav', 'io'].join(''),
];
const FORBIDDEN_COLORS = [
    ['am', 'ber'].join(''),
    '#'.concat('d4af37'),
    '#'.concat('f1c40f'),
    '#'.concat('9a7b00'),
    '#'.concat('00f3ff'),
    '#'.concat('00ff9d'),
    ['go', 'ld'].join(''),
];

/* ─────────────────── الملفات والربط ─────────────────── */

test('كل الملفات الجديدة موجودة', () => {
    for (const file of NEW_FILES) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    }
});

test('الصفحة بنفس قشرة لوحة المالك وتربط أصولها الموجودة', () => {
    const page = html();
    assert.match(page, /data-owner-page="voice-studio"/);
    assert.match(page, /<title>الاستوديو الصوتي \| مدعوم<\/title>/);
    assert.match(page, /<script type="module" src="\/assets\/js\/owner\/pages\/voice-studio\.js"><\/script>/);
    assert.match(page, /owner-voice-studio\.css/);
    assert.match(page, /customer-dashboard\.css/);
    assert.match(page, /owner-dashboard\.css/);
    assert.match(page, /id="sidebar-container"/);
    assert.match(page, /id="ownerGate"/);
    assert.match(page, /id="ownerContent"/);
    assert.match(page, /fonts\.googleapis\.com\/css2\?family=Cairo/);
    assert.doesNotMatch(page, /Montserrat|Tajawal|Amiri/);
});

test('الصفحة فيها تبويبات الأوضاع الأربعة وحقول المفتاح والتلميح', () => {
    const page = html();
    for (const mode of ['voice', 'audiobook', 'podcast', 'transcript']) {
        assert.match(page, new RegExp(`data-vs-mode="${mode}"`), mode);
    }
    assert.match(page, /id="vsIntro"/);
    assert.match(page, /id="vsIntroClose"/);
    assert.match(page, /id="vsGeminiKey"/);
    assert.match(page, /id="vsSaveKeyBtn"/);
    assert.match(page, /id="vsSectionVoice"/);
    assert.match(page, /id="vsSectionAudiobook"/);
    assert.match(page, /id="vsSectionPodcast"/);
    assert.match(page, /id="vsSectionTranscript"/);
});

test('الصفحة فيها شارة المحرك واختياره وملاحظة الخدمة غير الرسمية', () => {
    const page = html();
    assert.match(page, /id="vsEngineBadge"/);
    assert.match(page, /المحرك: Edge TTS — مجاني، بلا مفتاح/);
    assert.match(page, /id="vsEngineEdge" data-vs-engine="edge"/);
    assert.match(page, /id="vsEngineGemini" data-vs-engine="gemini"/);
    assert.match(page, /Edge TTS خدمة غير رسمية من مايكروسوفت/);
    assert.match(page, /ليست خدمة مضمونة/);
    assert.match(page, /id="vsDialectNote"/);
    assert.match(page, /لا يوجد صوت سوداني أصلي في Edge TTS/);
    assert.match(page, /مفتاح Gemini الشخصي \(اختياري — لمحرك Gemini ووظائف النص فقط\)/);
    assert.match(page, /التوليد الصوتي يعمل عبر Edge TTS المجاني/);
});

test('القائمة الجانبية: رابط الاستوديو بعد رابط شات Muse مباشرة، ولا رابط آخر تغيّر', () => {
    const nav = sidebar();
    assert.match(nav, /href="\/owner\/voice-studio\.html" class="sidebar-item" data-page="voice-studio" data-label="الاستوديو الصوتي"/);
    assert.ok(nav.indexOf('data-page="voice-studio"') > nav.indexOf('data-page="muse-chat"'));
    assert.ok(nav.indexOf('data-page="voice-studio"') < nav.indexOf('data-page="muse-activity-log"'));
    assert.match(nav, /href="\/owner\/muse-chat\.html" class="sidebar-item" data-page="muse-chat"/);
    assert.match(nav, /<svg[^>]*viewBox="0 0 24 24"[^>]*>[\s\S]*?M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z/);
});

test('كل id يقرأه الـ JS معرّف في الـ HTML أو في قالب يرسمه الـ JS', () => {
    const js = pageJs();
    const page = html();
    const ids = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
    assert.ok(ids.length > 50, `عدد الـ ids المقروءة قليل بشكل مريب: ${ids.length}`);
    const missing = ids.filter((id) => !page.includes(`id="${id}"`) && !js.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
});

test('الصفحة تستورد بوابة المالك وبيانات الاستوديو ومنطقه', () => {
    const js = pageJs();
    assert.match(js, /import \{ supabase, bootOwnerPage, esc, announce \} from '\/assets\/js\/owner\/owner-page\.js'/);
    assert.match(js, /from '\/assets\/js\/owner\/voice-studio-data\.js'/);
    assert.match(js, /from '\/assets\/js\/owner\/voice-studio-state\.js'/);
    assert.match(js, /await bootOwnerPage\(\)/);
    assert.match(js, /supabase\.functions\.invoke\(VOICE_STUDIO_FUNCTION/);
    assert.match(js, /Mad3oomVoiceService/);
    assert.match(js, /x-gemini-api-key/);
    assert.doesNotMatch(js, /functions\.invoke\('ai-session'/);
    assert.doesNotMatch(js, /ai-gateway/);
    assert.doesNotMatch(js, /WebSocket/);
});

test('الصفحة تمرر المحرك وتستخدم صوت Edge وتدمج عبر فك التشفير', () => {
    const js = pageJs();
    assert.match(js, /resolveEdgeVoice\(/);
    assert.match(js, /engine = 'edge'/);
    assert.match(js, /dialectId, engine,/);
    assert.match(js, /decodeAudioData/);
    assert.match(js, /mergeDecodedAudio\(/);
    assert.match(js, /audioFileName\(title, ext\)/);
    assert.match(js, /vsEngineBadge/);
    assert.match(js, /data-vs-engine/);
    assert.match(js, /noteEngineUsed\(/);
    assert.match(js, /audio\/mpeg/);
});

test('مفاتيح التخزين بالاسم الجديد لا القديم', () => {
    assert.match(dataJs(), /mad3oom_voice_gemini_key/);
    assert.match(dataJs(), /mad3oom_voice_intro_played/);
    assert.match(dataJs(), /mad3oom_voice_history/);
    assert.match(stateJs(), /mad3oom_transcript_/);
    assert.match(stateJs(), /mad3oom_audio/);
    assert.match(pageJs(), /audioFileName\(/);
    assert.match(pageJs(), /transcriptFileName\(/);
});

/* ─────────────────── إعادة التسمية والألوان ─────────────────── */

test('لا أثر للاسم القديم في أي ملف جديد', () => {
    for (const file of NEW_FILES) {
        const src = read(file);
        for (const forbidden of FORBIDDEN_BRAND) {
            assert.ok(
                !src.toLowerCase().includes(forbidden.toLowerCase()),
                `${file}: ظهرت السلسلة المحظورة «${forbidden}»`,
            );
        }
    }
});

test('لا ألوان ذهبية أو نيون في أي ملف جديد', () => {
    for (const file of NEW_FILES) {
        const src = read(file);
        for (const forbidden of FORBIDDEN_COLORS) {
            assert.ok(
                !src.toLowerCase().includes(forbidden.toLowerCase()),
                `${file}: ظهر اللون/الكلمة المحظورة «${forbidden}»`,
            );
        }
    }
});

test('التنسيق بلا أي لون hex ثابت، ومقصور على الصفحة', () => {
    const style = css();
    assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(style, /var\(--color-accent\)/);
    assert.match(style, /var\(--owner-tint\)/);
    assert.match(style, /var\(--owner-border\)/);
    const selectors = [...style.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    assert.ok(selectors.length > 40, `قواعد التنسيق قليلة: ${selectors.length}`);
    const unscoped = selectors
        .flatMap((s) => s.split(',').map((part) => part.trim()))
        .filter((s) => s && !s.startsWith('@') && !s.includes('[data-owner-page="voice-studio"]'));
    assert.deepEqual(unscoped, []);
});

test('التنسيق يعرف المشغّل وخطوات الكتاب والتفريغ والبودكاست', () => {
    const style = css();
    for (const cls of ['.vs-player', '.vs-book-steps', '.vs-pod-speakers', '.vs-tr-toggle', '.vs-mode-tab', '.vs-voice-card', '.vs-fingerprint', '.vs-error', '.vs-engine-badge', '.vs-engine-pills', '.vs-engine-note', '.vs-dialect-note']) {
        assert.ok(style.includes(cls), cls);
    }
    assert.match(style, /\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
});

/* ─────────────────── الـ Edge Function ─────────────────── */

test('الدالة تحمل الإجراءات الثمانية وتقرأ المفتاح من البيئة أو الهيدر', () => {
    const fn = fnTs();
    for (const action of ['preprocess-text', 'identify-key-sentences', 'analyze-and-segment', 'transcribe-media', 'extract-text', 'generate-podcast-script', 'tts', 'generate-stream']) {
        assert.ok(fn.includes(`"${action}"`), action);
    }
    assert.match(fn, /Deno\.env\.get\("GEMINI_API_KEY"\)/);
    assert.match(fn, /x-gemini-api-key/);
    assert.match(fn, /generativelanguage\.googleapis\.com/);
    assert.match(fn, /gemini-3\.1-flash-tts-preview/);
    assert.match(fn, /gemini-2\.5-flash-preview-tts/);
    assert.match(fn, /gemini-3\.5-transcribe/);
    assert.match(fn, /تم استنفاد الحصة المجانية المؤقتة/);
    assert.match(fn, /النموذج يواجه ضغطاً مؤقتاً/);
    assert.match(fn, /data: \[DONE\]/);
    // بلا أي خادم WebSocket حي: التلميح في الترويسة يوثّق الإسقاط فقط،
    // فالفحص على كود فعلي لا على كلمة في تعليق.
    assert.doesNotMatch(fn, /new WebSocket\(|WebSocketServer|wss\.on\(/);
    assert.doesNotMatch(fn, /\/live/);
});

test('إجراء tts بمحركين: edge افتراضي بلا مفتاح وgemini بمفتاح فقط', () => {
    const fn = fnTs();
    assert.match(fn, /handleTts/);
    assert.match(fn, /synthesizeGeminiTts/);
    assert.match(fn, /synthesizeEdge/);
    assert.match(fn, /if \(action === "tts"\)/);
    assert.match(fn, /audio\/mpeg/);
    assert.match(fn, /engine: "edge"/);
    assert.match(fn, /fallbackFrom: "edge"/);
    assert.match(fn, /فشل محرك Edge TTS/);
    assert.match(fn, /محرك Gemini يحتاج مفتاحًا/);
    assert.match(fn, /هذه الوظيفة تحتاج مفتاح Gemini/);
    assert.match(fn, /من supabase\/functions\/voice-studio\/edge-tts\.ts|from "\.\/edge-tts\.ts"/);
});

test('وحدة Edge تحمل البروتوكول الموثّق كاملًا', () => {
    const edge = edgeTs();
    assert.match(edge, /generateSecMsGec/);
    assert.match(edge, /EDGE_TRUSTED_CLIENT_TOKEN/);
    assert.match(edge, /EDGE_SEC_MS_GEC_VERSION/);
    assert.match(edge, /speech\.platform\.bing\.com/);
    assert.match(edge, /Path:speech\.config/);
    assert.match(edge, /turn\.end/);
    assert.match(edge, /audio-24khz-48kbitrate-mono-mp3/);
    assert.match(edge, /Microsoft Server Speech Text to Speech Voice/);
    assert.match(edge, /Deno\.connectTls/);
    assert.match(edge, /Sec-MS-GEC/);
    assert.match(edge, /splitEdgeText/);
    assert.match(edge, /edgeProsodyForControls/);
    assert.doesNotMatch(edge, /new WebSocket\(/);
});

test('الفحص الحي للتوليف متخطٍّ صراحةً — موثّق كخطوات يدوية لا كنجاح', () => {
    const edge = edgeTs();
    assert.match(edge, /LIVE CHECK/);
    assert.match(edge, /ar-EG-SalmaNeural/);
    assert.match(edge, /ar-EG-ShakirNeural/);
    assert.match(edge, /ar-SA-HamedNeural/);
    assert.match(edge, /لم يُتحقق من التوليف حيًا هنا/);
});

test('ملف النشر ينشر الدالة وحدها على نمط verify-turnstile', () => {
    const yml = workflow();
    assert.match(yml, /workflow_dispatch/);
    assert.match(yml, /supabase functions deploy voice-studio/);
    assert.match(yml, /supabase\/functions\/voice-studio\/index\.ts/);
    assert.match(yml, /SUPABASE_PROJECT_REF/);
});
