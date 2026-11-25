/**
 * اختبارات قرارات «إصلاح أو حذف» على الاستوديو الصوتي — تدقيق 2026-11-25.
 *
 * كل اختبار هنا يثبّت قرارًا واحدًا من التقرير: وظيفة أُصلحت عبر
 * ai-gateway، أو حُذفت من الواجهة وكودها والدالة معًا. القاعدة:
 * أي زر باقٍ ينادي مسارًا شغالًا، وأي وظيفة محذوفة لا أثر لها في
 * الواجهة ولا في الكود المستدعى ولا في الدالة.
 *
 * ملاحظة: سلاسل الأسماء المحذوفة تُفحص بالصيغ المقتبسة ("…") لأن
 * تعليقات الترويسة توثّق الحذف نفسه بالاسم العربي/اللاتيني دون اقتباس.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    STUDIO_CONTROLS,
} from '../assets/js/owner/voice-studio-data.js';
import * as dataModule from '../assets/js/owner/voice-studio-data.js';
import * as stateModule from '../assets/js/owner/voice-studio-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = () => read('owner/voice-studio.html');
const pageJs = () => read('assets/js/owner/pages/voice-studio.js');
const dataJs = () => read('assets/js/owner/voice-studio-data.js');
const stateJs = () => read('assets/js/owner/voice-studio-state.js');
const css = () => read('assets/css/owner-voice-studio.css');
const fnTs = () => read('supabase/functions/voice-studio/index.ts');

const DELETED_VOICE_ACTIONS = [
    '"preprocess-text"', '"identify-key-sentences"', '"analyze-and-segment"',
    '"transcribe-media"', '"extract-text"', '"generate-podcast-script"',
    '"generate-stream"',
];

/* ─────────────────── 1. الإجراءات النصية عبر ai-gateway ─────────────────── */

test('الإجراءات النصية الأربعة تُوجَّه إلى ai-gateway بمفاتيح المنصة', () => {
    const js = pageJs();
    assert.match(js, /supabase\.functions\.invoke\(AI_GATEWAY_FUNCTION/);
    assert.match(js, /action: 'generate'/);
    assert.match(js, /messages: \[\{ role: 'user', content: userText \}\]/);
    assert.match(js, /source: 'voice-studio'/);
    // لا مفتاح شخصي يُرسَل للبوابة: النداء بلا هيدر x-gemini-api-key
    assert.doesNotMatch(js, /callAiGateway\(\{[^}]*x-gemini-api-key/s);
    // كل إجراء نصي له system prompt خاص ومحلِّل JSON صارم
    assert.match(js, /async preprocessText\(text, options\)/);
    assert.match(js, /async identifyKeySentences\(text\)/);
    assert.match(js, /async analyzeAndSegmentText\(text\)/);
    assert.match(js, /async generatePodcastScript\(content, dialect, dialectId/);
    assert.match(js, /extractJsonObject\(reply\)/);
});

test('لا نجاح زائف صامت: الفشل يُرمى كخطأ ولا بديل افتراضي', () => {
    const js = pageJs();
    // لا إعادة للمدخل ولا مقطع افتراضي عند الفشل في أي إجراء نصي
    assert.doesNotMatch(js, /\.then\(\(d\) => d\.text \?\? text\)/);
    assert.doesNotMatch(js, /label: 'مقطع افتراضي'/);
    assert.doesNotMatch(js, /segments: \[\{ label: 'مقطع افتراضي'/);
    assert.match(js, /if \(!clean\.length\) throw new Error\('تعذّر تحليل النص وتقسيمه/);
    assert.match(js, /if \(!turns\.length\) throw new Error\('تعذّر تحليل المحتوى/);
    assert.match(js, /if \(!String\(text\)\.trim\(\)\) throw new Error\('خدمة الذكاء الاصطناعي أعادت ردًا فارغًا\.'\)/);
});

test('الدالة لا تحمل أي إجراء نصي — لا أثر مقتبس لسبعة إجراءات', () => {
    const fn = fnTs();
    for (const action of DELETED_VOICE_ACTIONS) {
        assert.ok(!fn.includes(action), action);
    }
    assert.match(fn, /if \(action === "tts"\)/);
    assert.match(fn, /الدالة تدعم tts فقط/);
});

test('الصفحة لا تنادي أي إجراء نصي قديم في دالة voice-studio', () => {
    const js = pageJs();
    for (const action of DELETED_VOICE_ACTIONS) {
        assert.ok(!js.includes(action), action);
    }
    assert.doesNotMatch(js, /this\.call\('(preprocess-text|identify-key-sentences|analyze-and-segment|transcribe-media|extract-text|generate-podcast-script)'/);
});

/* ─────────────────── 2. خلل معاينة اللهجة ─────────────────── */

test('المعاينة تمرّر لهجة الصوت المعروض نفسه لا لهجة وضع آخر', () => {
    const js = pageJs();
    assert.match(js, /async function handleVoicePreview\(profile, dialectId = state\.dialectId\)/);
    assert.match(js, /generateVoiceOver\(\s*previewText, baseVoice, profile, state\.controls, 'Identity Preview',\s*dialectId, state\.engine,/s);
    assert.match(js, /handleVoicePreview\(assignedVoice, state\.podcast\.dialectId\)/);
    // التعبير الخاطئ بقي في تعليق توثيقي واحد فقط، لا في كود منفَّذ
    const occurrences = js.split('state.project?.dialectId').length - 1;
    assert.equal(occurrences, 1);
});

/* ─────────────────── 3+4+5. الضوابط والمجال والبصمة ─────────────────── */

test('أدوات الاستوديو: سرعة وعمق وطبقة فقط — لا حرارة ولا دراما ولا انفعال', () => {
    assert.deepEqual(Object.keys(STUDIO_CONTROLS), ['speed', 'depth', 'pitch']);
    assert.equal(dataModule.VOICE_FIELDS, undefined);
    assert.equal(dataModule.VOICE_PURPOSES, undefined);
    assert.ok(!('temp' in STUDIO_CONTROLS) && !('drama' in STUDIO_CONTROLS) && !('emotion' in STUDIO_CONTROLS));
});

test('المجال والغرض والبصمة: لا أثر لها في الواجهة ولا في كود الصفحة', () => {
    const page = html();
    const js = pageJs();
    for (const id of ['vsField', 'vsPurpose', 'vsPurposeNote', 'vsFingerprintBtn', 'vsFingerprintPanel', 'vsFpName', 'vsFpSave', 'vsFpStyle', 'vsFpRhythm', 'vsFpNarrative', 'vsFpCancel', 'vsFpDeactivate', 'vsFpConfirm']) {
        assert.ok(!page.includes(`id="${id}"`), id);
        assert.ok(!js.includes(`$('${id}')`), id);
    }
    assert.doesNotMatch(js, /state\.fingerprint/);
    assert.doesNotMatch(js, /fingerprint/);
    assert.doesNotMatch(js, /selectedField\(\)/);
    assert.doesNotMatch(js, /سيتم ضبط الأداء ليكون/);
    for (const cls of ['.vs-purpose', '.vs-fingerprint', '.vs-fp-opt']) {
        assert.ok(!css().includes(cls), cls);
    }
});

test('الفئة العمرية باقية مع وسم صريح أنها تقريب prosody', () => {
    assert.match(html(), /الفئة العمرية تقريب لإيقاع الصوت وطبقته/);
    assert.match(html(), /وليست صوتًا مختلفًا/);
});

/* ─────────────────── 7. البث النصي ─────────────────── */

test('البث النصي generate-stream: لا منادٍ ولا إجراء ولا دالة streamText', () => {
    assert.doesNotMatch(pageJs(), /streamText/);
    assert.doesNotMatch(pageJs(), /generate-stream/);
    assert.doesNotMatch(fnTs(), /handleStream/);
    assert.equal(stateModule.EDGE_ACTIONS.length, 1);
    assert.deepEqual(stateModule.EDGE_ACTIONS, ['tts']);
});

/* ─────────────────── 8+9+10. التفريغ والاستخراج وتصديرهما ─────────────────── */

test('وضع التفريغ النصي محذوف كاملًا من الواجهة وكود الصفحة', () => {
    const page = html();
    const js = pageJs();
    assert.doesNotMatch(page, /data-vs-mode="transcript"/);
    assert.doesNotMatch(page, /vsSectionTranscript/);
    for (const id of ['vsTrFile', 'vsTrStartBtn', 'vsTrResult', 'vsTrCopy', 'vsTrDownload', 'vsTrFormat', 'vsTrToPodcast', 'vsTrToAudiobook', 'vsTrTimestamps']) {
        assert.ok(!page.includes(`id="${id}"`), id);
        assert.ok(!js.includes(`$('${id}')`), id);
    }
    assert.doesNotMatch(js, /initTranscript/);
    assert.doesNotMatch(js, /state\.transcript/);
    assert.doesNotMatch(js, /transcribeMedia/);
});

test('تصدير التفريغ محذوف معه: لا SRT ولا DOCX ولا أسماء ملفات تفريغ', () => {
    assert.equal(stateModule.buildSrt, undefined);
    assert.equal(stateModule.buildDocxHtml, undefined);
    assert.equal(stateModule.transcriptFileName, undefined);
    assert.equal(stateModule.formatSrtTime, undefined);
    assert.doesNotMatch(stateJs(), /export function buildSrt/);
    assert.doesNotMatch(stateJs(), /export function buildDocxHtml/);
    assert.doesNotMatch(stateJs(), /export function transcriptFileName/);
    assert.doesNotMatch(stateJs(), /export function formatSrtTime/);
    for (const cls of ['.vs-tr-toggle', '.vs-tr-result', '.vs-switch']) {
        assert.ok(!css().includes(cls), cls);
    }
});

test('استيراد الملفات محلي فقط: TXT وDOCX، وأي صيغة أخرى تُرفض صراحة', () => {
    const js = pageJs();
    const page = html();
    assert.doesNotMatch(js, /extractTextFromFile/);
    assert.match(js, /الصيغة غير مدعومة — الاستيراد يقبل TXT وDOCX فقط\./);
    assert.match(page, /id="vsImportFile" accept="\.txt,\.docx"/);
    assert.match(page, /id="vsPodFile" accept="\.txt,\.docx"/);
    assert.match(js, /id="vsBookFile" accept="\.txt,\.docx"/);
    assert.doesNotMatch(page, /\.pdf/);
    assert.doesNotMatch(js, /accept="\.txt,\.doc,\.docx,\.pdf"/);
});

/* ─────────────────── 11. السجل الأخير ─────────────────── */

test('السجل يحفظ الصوت كـ data URL دائم ويسقط روابط blob الميتة', () => {
    const js = pageJs();
    assert.match(js, /dataUrl: `data:\$\{mimeType\};base64,\$\{data\.audioBase64\}`/);
    assert.match(js, /url: result\.dataUrl \|\| url,/);
    assert.match(js, /item\.url\.startsWith\('data:audio\/'\)/);
    assert.match(js, /previewAudio\.play\(\)\.catch\(\(\) => \{/);
    assert.match(js, /هذا التسجيل لم يعد متاحًا — أعد توليده\./);
});

/* ─────────────────── 12. البودكاست ─────────────────── */

test('إنتاج البودكاست مربوط بالاعتماد وبالسكربت — لا صمت', () => {
    const js = pageJs();
    assert.match(js, /if \(!state\.podcast\.script \|\| !state\.podcast\.script\.length\) \{/);
    assert.match(js, /لا يوجد سكربت بعد — حلّل المحتوى أولًا/);
    assert.match(js, /if \(!state\.podcast\.distributed\) \{/);
    assert.match(js, /اعتمد التوزيع أولًا من زر «اعتماد التوزيع والمتابعة»/);
    assert.match(js, /const unassigned = state\.podcast\.script\.some\(\(t\) => !state\.podcast\.voiceMap\[t\.speakerId\]\)/);
});

/* ─────────────────── ما بقي شغالًا ─────────────────── */

test('ما يعمل بقي: Edge TTS والمعرض والتثبيت والتقسيم اليدوي واستيراد TXT/DOCX', () => {
    const js = pageJs();
    assert.match(js, /engine = 'edge'/);
    assert.match(js, /resolveEdgeVoice\(/);
    assert.match(js, /function filteredProfiles\(\)/);
    assert.match(js, /vsLockBtn/);
    assert.match(js, /splitTextByParagraphs\(text\)/);
    assert.match(js, /readFileAsText\(file\)/);
    assert.match(js, /loadMammoth\(\)/);
    assert.match(dataJs(), /mad3oom_voice_gemini_key/);
});
