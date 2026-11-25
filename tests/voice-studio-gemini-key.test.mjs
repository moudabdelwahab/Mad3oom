/**
 * اختبارات مفتاح Gemini الشخصي في الاستوديو الصوتي
 * (assets/js/owner/pages/voice-studio.js + owner/voice-studio.html).
 *
 * ما تحرسه هذه الاختبارات:
 *  • المفتاح في ذاكرة الصفحة فقط (in-memory) — لا localStorage ولا
 *    sessionStorage، ولا يُملأ الحقل بمفتاح محفوظ أبدًا.
 *  • زر مسح صريح + تحذير واضح في الصفحة.
 *  • أي مفتاح قديم محفوظ نصًا صريحًا في localStorage يُحذف عند الفتح.
 *  • المفتاح لا يُرسل إلا لمسار tts في Edge Function «voice-studio» —
 *    وظائف النص عبر ai-gateway بمفاتيح المنصة لا تراه إطلاقًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const studioJs = () => read('assets/js/owner/pages/voice-studio.js');
const studioHtml = () => read('owner/voice-studio.html');
const studioData = () => read('assets/js/owner/voice-studio-data.js');

test('المفتاح في ذاكرة الصفحة فقط — لا كتابة في أي تخزين متصفح', () => {
    const js = studioJs();
    // الحقل الخاص هو المخزن الوحيد للمفتاح.
    assert.match(js, /_geminiKey = '';/);
    assert.match(js, /setUserApiKey\(key\) \{\s*\n\s*this\._geminiKey = key/);
    assert.match(js, /getUserApiKey\(\) \{\s*\n\s*return this\._geminiKey;/);
    // لا setItem للمفتاح في أي مكان — التخزين الوحيد للمفتاح هو الذاكرة.
    assert.doesNotMatch(js, /localStorage\.setItem\(GEMINI_KEY_STORAGE/);
    assert.doesNotMatch(js, /sessionStorage\.setItem\(GEMINI_KEY_STORAGE/);
    assert.doesNotMatch(js, /sessionStorage\.getItem\(GEMINI_KEY_STORAGE/);
});

test('الحقل لا يُملأ بمفتاح محفوظ أبدًا — ويُمسح بعد الحفظ', () => {
    const js = studioJs();
    assert.doesNotMatch(js, /input\.value = saved/);
    assert.doesNotMatch(js, /input\.value = .*getUserApiKey\(\)/);
    // بعد الحفظ يُمسح الحقل فورًا حتى لا يبقى المفتاح في DOM.
    assert.match(js, /voiceService\.setUserApiKey\(input\.value\);\s*\n\s*const saved = voiceService\.hasUserApiKey\(\);\s*\n\s*input\.value = '';/);
});

test('زر مسح صريح وتحذير واضح في الصفحة', () => {
    const html = studioHtml();
    assert.match(html, /id="vsClearKeyBtn"/);
    assert.match(html, /مسح المفتاح/);
    assert.match(html, /يُحفظ في ذاكرة هذه الصفحة فقط/);
    assert.match(html, /لا يُحفظ في المتصفح/);
    assert.match(html, /يُنسى بإغلاق الصفحة أو بزر المسح/);
    const js = studioJs();
    assert.match(js, /clearUserApiKey\(\)/);
    assert.match(js, /vsClearKeyBtn/);
    assert.match(js, /مفتاح شخصي محفوظ في ذاكرة هذه الصفحة فقط/);
});

test('مفتاح قديم في localStorage يُحذف عند الفتح ولا يُعاد تحميله', () => {
    const js = studioJs();
    assert.match(js, /migrateLegacyKey\(\)/);
    assert.match(js, /localStorage\.getItem\(GEMINI_KEY_STORAGE\)/);
    assert.match(js, /localStorage\.removeItem\(GEMINI_KEY_STORAGE\)/);
    assert.match(js, /voiceService\.migrateLegacyKey\(\)/);
    assert.match(js, /حُذف مفتاح قديم كان محفوظًا في المتصفح/);
    // الحذف لا يعيد تعبئة الحقل ولا يقرأ القيمة لاستخدامها.
    assert.doesNotMatch(js, /setUserApiKey\(.*getItem\(GEMINI_KEY_STORAGE\)/);
});

test('المفتاح لا يُرسل إلا لمسار tts — وظائف النص لا تراه', () => {
    const js = studioJs();
    // الهيدر يُرفق فقط عندما يكون الإجراء tts.
    assert.match(js, /headersFor\(action\)/);
    assert.match(js, /return action === 'tts' && key/);
    assert.match(js, /headers: this\.headersFor\(action\)/);
    // نداء ai-gateway النصي بلا هيدر مفتاح إطلاقًا.
    const gateway = js.slice(js.indexOf('async callAiGateway'));
    assert.doesNotMatch(gateway.slice(0, gateway.indexOf('async preprocessText')), /headers/);
    // الثابت نفسه لم يعد مفتاح حفظ — بل اسم المفتاح القديم للحذف فقط.
    assert.match(studioData(), /لم يعد يُكتب إطلاقًا/);
});
