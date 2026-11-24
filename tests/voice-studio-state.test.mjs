/**
 * اختبارات المنطق النقي للاستوديو الصوتي (voice-studio-state.js):
 * بصمة الصوت، وتغليف WAV، ودمج المقاطع، وتنسيق الوقت، وبناء SRT،
 * وأسماء الملفات، وأقفال اللهجات وبرومبت TTS، والتوزيع الذكي،
 * وفحص إعادة التسمية على البيانات.
 *
 * ملاحظة: سلاسل الاسم القديم والألوان المحظورة مبنية من مقاطع هنا
 * حتى يبقى ملف الاختبار نفسه نظيفًا عند فحص grep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DIALECTS, VOICE_FIELDS, STUDIO_CONTROLS, CATEGORY_STYLES, PREVIEW_SCRIPTS,
    WORKFLOW_STEPS, VOICE_TYPES, getBaseVoiceForType,
    EDGE_VOICE_MAP, SUDANESE_EDGE_FALLBACK_NOTE, TTS_ENGINES, TTS_ENGINE_DEFAULT,
} from '../assets/js/owner/voice-studio-data.js';
import {
    EDGE_ACTIONS, DIALECT_PHONETIC_LOCKS, PURPOSE_DIRECTIVES,
    resolveDialectId, phoneticLockForDialect, generateVoiceFingerprint,
    buildTtsPrompt, formatTime, formatSrtTime, ensureWavBuffer, concatWavBuffers,
    splitTextByParagraphs, buildSrt, buildDocxHtml, transcriptFileName, audioFileName,
    mapRoleToVoice, smartDistributeSpeakers, hasForbiddenBrand, findForbiddenBrandInData,
    resolveEdgeVoice, resolveTtsEngine, edgeProsodyForControls, EDGE_IGNORED_CONTROLS,
    buildEdgeSsml, edgeVoiceSsmlName, edgeDateString, generateSecMsGec,
    encodePcmToWav, mergeDecodedAudio, EDGE_VOICE_NAME_PATTERN, EDGE_TTS_ENGINE_DEFAULT,
} from '../assets/js/owner/voice-studio-state.js';

/* سلاسل محظورة مبنية من مقاطع — لا تظهر حرفيًا في هذا الملف. */
const FORBIDDEN = [
    ['sa', 'vio'].join(''),
    ['\u0633', '\u0627', '\u0641', '\u064a', '\u0648'].join(''),
    ['ai', 'studio', '-', 'build'].join(''),
    ['am', 'ber'].join(''),
    '#'.concat('d4af37'),
    '#'.concat('f1c40f'),
    '#'.concat('9a7b00'),
    '#'.concat('00f3ff'),
    '#'.concat('00ff9d'),
];

/* ─────────────────── البيانات كاملة ─────────────────── */

test('البيانات: 12 لهجة و110 أصوات بالأعداد نفسها في الأصل', () => {
    assert.equal(DIALECTS.length, 12);
    assert.deepEqual(DIALECTS.map((d) => d.id), [
        'egyptian', 'saudi', 'levantine', 'iraqi', 'algerian', 'moroccan',
        'tunisian', 'khaleeji', 'sudanese', 'yemeni', 'lebanese', 'fusha',
    ]);
    assert.deepEqual(
        DIALECTS.map((d) => d.profiles.length),
        [14, 12, 9, 7, 7, 7, 7, 7, 7, 7, 7, 19],
    );
    assert.equal(DIALECTS.reduce((n, d) => n + d.profiles.length, 0), 110);
});

test('البيانات: كل صوت له معرّف واسم وجنس ونوع وفئة ووصف', () => {
    // استثناء واحد منقول حرفيًا من الأصل: mor_mahdi نوعه «تقديم معلوماتي»
    // وهو خارج VOICE_TYPES، فلا يظهر في أي مرشّح — في الأصل وفي هذه
    // النسخة معًا. يُوثَّق هنا بدل إخفائه بتعديل البيانات.
    const knownOutliers = new Set(['mor_mahdi']);
    for (const dialect of DIALECTS) {
        assert.ok(dialect.title && dialect.description, dialect.id);
        for (const profile of dialect.profiles) {
            assert.ok(profile.id && profile.name, dialect.id);
            assert.ok(['male', 'female'].includes(profile.gender), profile.id);
            if (!knownOutliers.has(profile.id)) {
                assert.ok(VOICE_TYPES.includes(profile.voiceType), profile.id);
            }
            assert.ok(CATEGORY_STYLES[profile.categoryKey], profile.id);
            assert.ok(profile.category && profile.description, profile.id);
        }
    }
    const ids = DIALECTS.flatMap((d) => d.profiles.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length, 'معرّفات الأصوات فريدة');
});

test('البيانات: 9 مجالات و6 أدوات استوديو و9 نصوص معاينة و6 خطوات', () => {
    assert.equal(VOICE_FIELDS.length, 9);
    assert.deepEqual(Object.keys(STUDIO_CONTROLS), ['temp', 'emotion', 'speed', 'depth', 'pitch', 'drama']);
    assert.equal(Object.keys(PREVIEW_SCRIPTS).length, 9);
    assert.deepEqual(WORKFLOW_STEPS.map((s) => s.id), ['new', 'import', 'script', 'multi', 'pilot', 'production']);
});

test('الصوت الأساسي حسب النوع والجنس كما في الأصل', () => {
    assert.equal(getBaseVoiceForType('بالغ', 'female'), 'Kore');
    assert.equal(getBaseVoiceForType('بالغ', 'male'), 'Fenrir');
    assert.equal(getBaseVoiceForType('كبار السن', 'male'), 'Charon');
    assert.equal(getBaseVoiceForType('شخصية كارتونية', 'male'), 'Kore');
    assert.equal(getBaseVoiceForType('شخصية كارتونية', 'female'), 'Kore');
});

/* ─────────────────── بصمة الصوت وبرومبت TTS ─────────────────── */

test('بصمة الصوت: نفس دالة التجزئة في الخادم، 8 خانات مستقرة', () => {
    assert.equal(generateVoiceFingerprint('يوسف'), '49559596');
    assert.equal(generateVoiceFingerprint('يوسف'), generateVoiceFingerprint('يوسف'));
    assert.match(generateVoiceFingerprint('نورا'), /^\d{1,8}$/);
    assert.notEqual(generateVoiceFingerprint('يوسف'), generateVoiceFingerprint('نورا'));
});

test('استنتاج اللهجة من بادئة معرّف الصوت', () => {
    assert.equal(resolveDialectId('egy_youssef'), 'egyptian');
    assert.equal(resolveDialectId('sau_nasser'), 'saudi');
    assert.equal(resolveDialectId('fus_tariq'), 'fusha');
    assert.equal(resolveDialectId('xyz_1', 'levantine'), 'levantine');
    assert.equal(resolveDialectId(undefined), 'fusha');
});

test('قفل اللهجة موجود للهجات الثماني في الخادم، والأربع الباقية تسقط للفصحى', () => {
    // server.ts يعرّف أقفالًا لثماني لهجات فقط؛ العراقية والجزائرية
    // والمغربية والتونسية تسقط لقفل الفصحى هناك وهنا معًا.
    for (const id of ['egyptian', 'saudi', 'khaleeji', 'levantine', 'sudanese', 'yemeni', 'lebanese', 'fusha']) {
        assert.ok(DIALECT_PHONETIC_LOCKS[id], id);
    }
    for (const id of ['iraqi', 'algerian', 'moroccan', 'tunisian']) {
        assert.equal(phoneticLockForDialect(id), DIALECT_PHONETIC_LOCKS.fusha, id);
    }
    assert.equal(phoneticLockForDialect('unknown'), DIALECT_PHONETIC_LOCKS.fusha);
    assert.match(phoneticLockForDialect('egyptian'), /EGYPTIAN PHONETIC LOCK/);
});

test('برومبت TTS يحمل الهوية والبصمة والقفل والغرض والنص', () => {
    const prompt = buildTtsPrompt({
        text: 'مرحباً بالعالم',
        profile: { id: 'egy_youssef', name: 'يوسف', description: 'صوت وثائقي' },
        controls: { speed: 'متوسطة', pitch: 'متوسطة', emotion: 'متوسط', purpose: 'إعلان' },
        performanceNote: 'Pilot Lock',
        dialectId: 'egyptian',
    });
    assert.match(prompt, /MODE: READY_FOR_TTS/);
    assert.match(prompt, /IDENTITY: يوسف \(صوت وثائقي\)/);
    assert.match(prompt, /FINGERPRINT: 49559596/);
    assert.match(prompt, /DIALECT: egyptian/);
    assert.match(prompt, /EGYPTIAN PHONETIC LOCK/);
    assert.match(prompt, /Advertisement - energetic/);
    assert.match(prompt, /Pilot Lock/);
    assert.match(prompt, /TEXT_TO_SYNTHESIZE: "مرحباً بالعالم"/);
});

test('برومبت TTS بهوية افتراضية عند غياب الصوت', () => {
    const prompt = buildTtsPrompt({ text: 'x', profile: null, controls: {}, performanceNote: '', dialectId: undefined });
    assert.match(prompt, /IDENTITY: مدعوم Voice/);
    assert.match(prompt, /DIALECT: fusha/);
    assert.match(prompt, /MSA LOCK/);
});

test('توجيهات الغرض الخمسة موجودة', () => {
    assert.equal(Object.keys(PURPOSE_DIRECTIVES).length, 5);
    for (const purpose of ['إعلان', 'قصصي', 'توعوي', 'إخباري', 'تعليمي']) {
        assert.ok(PURPOSE_DIRECTIVES[purpose], purpose);
    }
});

/* ─────────────────── WAV والوقت والتصدير ─────────────────── */

test('تغليف PCM في WAV: ترويسة 44 بايت صحيحة', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = ensureWavBuffer(pcm);
    assert.equal(wav.length, 48);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
    const view = new DataView(wav.buffer);
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(view.getUint32(40, true), 4);
    assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4]);
});

test('تغليف WAV جاهز يُعاد كما هو دون إعادة تغليف', () => {
    const wav = ensureWavBuffer(new Uint8Array([9, 9]));
    assert.equal(ensureWavBuffer(wav).length, wav.length);
    assert.equal(ensureWavBuffer(wav), wav);
});

test('دمج مقاطع WAV يلصق الحمولات بترويسة واحدة', () => {
    const a = ensureWavBuffer(new Uint8Array([1, 2]));
    const b = ensureWavBuffer(new Uint8Array([3, 4, 5, 6]));
    const merged = concatWavBuffers([a, b]);
    assert.equal(merged.length, 44 + 6);
    assert.equal(String.fromCharCode(...merged.slice(0, 4)), 'RIFF');
    assert.deepEqual([...merged.slice(44)], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...concatWavBuffers([]).slice(44)], []);
});

test('تنسيق الوقت د:ثث', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(5), '0:05');
    assert.equal(formatTime(65), '1:05');
    assert.equal(formatTime(600), '10:00');
});

test('طابع SRT بصيغة HH:MM:SS,mmm', () => {
    assert.equal(formatSrtTime(5), '00:00:05,000');
    assert.equal(formatSrtTime(65.25), '00:01:05,250');
    assert.equal(formatSrtTime(3661.5), '01:01:01,500');
});

test('بناء SRT من طوابع [MM:SS] في النص', () => {
    const srt = buildSrt('[00:05] مرحبا بالعالم\n[00:09] جملة ثانية');
    assert.equal(srt,
        '1\n00:00:05,000 --> 00:00:09,000\nمرحبا بالعالم\n\n'
        + '2\n00:00:09,000 --> 00:00:13,000\nجملة ثانية\n');
});

test('بناء SRT من نص بلا طوابع: جمل متتالية كل 4 ثوانٍ', () => {
    const srt = buildSrt('جملة أولى. جملة ثانية.');
    assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\nجملة أولى\./);
    assert.match(srt, /2\n00:00:04,000 --> 00:00:08,000\nجملة ثانية\./);
    assert.equal(buildSrt(''), '');
});

test('غلاف DOCX عربي RTL بخط Cairo ويهرّب HTML', () => {
    const html = buildDocxHtml('نص <b>مهم</b>\nسطر ثانٍ');
    assert.match(html, /direction:rtl/);
    assert.match(html, /Cairo/);
    assert.match(html, /نص &lt;b&gt;مهم&lt;\/b&gt;<br>سطر ثانٍ/);
});

test('أسماء ملفات الإخراج بالبادئة الجديدة', () => {
    assert.equal(transcriptFileName('txt', 'lecture.mp3'), 'mad3oom_transcript_lecture.txt');
    assert.equal(transcriptFileName('srt', 'a b.wav'), 'mad3oom_transcript_a b.srt');
    assert.equal(transcriptFileName('docx', 'result'), 'mad3oom_transcript_result.docx');
    assert.equal(audioFileName('جلسة: مصر'), 'جلسة_ مصر.wav');
    assert.equal(audioFileName(''), 'mad3oom_audio.wav');
    assert.equal(audioFileName(), 'mad3oom_audio.wav');
});

test('تقسيم الفقرات يحذف الفارغ ويقصّ المسافات', () => {
    assert.deepEqual(splitTextByParagraphs('أولى\n\nثانية\n  \nثالثة'), ['أولى', 'ثانية', 'ثالثة']);
    assert.deepEqual(splitTextByParagraphs(''), []);
});

/* ─────────────────── التوزيع الذكي ─────────────────── */

test('ربط الدور بصوت: الراوي يأخذ رواية أو وثائقي، وغيره ثابت بالبصمة', () => {
    const voices = [
        { name: 'أ', categoryKey: 'ads' },
        { name: 'ب', categoryKey: 'novels' },
        { name: 'ج', categoryKey: 'doc' },
    ];
    assert.equal(mapRoleToVoice('الراوي', voices), 'ب');
    assert.equal(mapRoleToVoice('البطل', voices), mapRoleToVoice('البطل', voices));
    assert.equal(mapRoleToVoice('البطل', voices), 'أ');
    assert.equal(mapRoleToVoice('الراوي', []), '');
});

test('التوزيع الذكي للبودكاست: يطابق الجنس والفئة ولا يكرر صوتًا', () => {
    const voices = [
        { id: 'v1', gender: 'male', categoryKey: 'podcast' },
        { id: 'v2', gender: 'female', categoryKey: 'podcast' },
        { id: 'v3', gender: 'male', categoryKey: 'doc' },
    ];
    const speakers = [
        { id: 's1', gender: 'male', categoryHint: 'podcast' },
        { id: 's2', gender: 'female', categoryHint: 'podcast' },
        { id: 's3', gender: 'male', categoryHint: 'podcast' },
    ];
    const map = smartDistributeSpeakers(speakers, voices);
    assert.equal(map.s1, 'v1');
    assert.equal(map.s2, 'v2');
    assert.equal(map.s3, 'v1', 'عند نفاد المطابق غير المستخدم يعود لأول مطابق كما في الأصل');
    assert.equal(Object.keys(map).length, 3);
});

/* ─────────────────── محرك Edge TTS ─────────────────── */

test('خريطة أصوات Edge: كل لهجة من الـ 12 لها ذكر وأنثى من أسماء Edge الحقيقية', () => {
    const expected = {
        egyptian: ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural'],
        saudi: ['ar-SA-ZariyahNeural', 'ar-SA-HamedNeural'],
        levantine: ['ar-SY-AmanyNeural', 'ar-SY-LaithNeural'],
        iraqi: ['ar-IQ-RanaNeural', 'ar-IQ-BasselNeural'],
        algerian: ['ar-DZ-AminaNeural', 'ar-DZ-IsmaelNeural'],
        moroccan: ['ar-MA-MounaNeural', 'ar-MA-JamalNeural'],
        tunisian: ['ar-TN-ReemNeural', 'ar-TN-HediNeural'],
        yemeni: ['ar-YE-MaryamNeural', 'ar-YE-SalehNeural'],
        lebanese: ['ar-LB-LaylaNeural', 'ar-LB-RamiNeural'],
        khaleeji: ['ar-AE-FatimaNeural', 'ar-AE-HamdanNeural'],
        sudanese: ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural'],
        fusha: ['ar-SA-ZariyahNeural', 'ar-SA-HamedNeural'],
    };
    assert.deepEqual(Object.keys(EDGE_VOICE_MAP).sort(), Object.keys(expected).sort());
    for (const [dialect, [female, male]] of Object.entries(expected)) {
        assert.equal(EDGE_VOICE_MAP[dialect].female, female, dialect);
        assert.equal(EDGE_VOICE_MAP[dialect].male, male, dialect);
        assert.match(female, EDGE_VOICE_NAME_PATTERN, dialect);
        assert.match(male, EDGE_VOICE_NAME_PATTERN, dialect);
    }
    // السودانية بديل موثّق لا صوت أصلي (لا ar-SD في قائمة Edge)
    assert.equal(EDGE_VOICE_MAP.sudanese.fallback, true);
    assert.match(SUDANESE_EDGE_FALLBACK_NOTE, /لا يوجد صوت سوداني أصلي/);
    assert.equal(TTS_ENGINE_DEFAULT, 'edge');
    assert.deepEqual(TTS_ENGINES, ['edge', 'gemini']);
});

test('حلّ صوت Edge من الملف الشخصي: لهجة وجنس، والسودانية بديل موثّق', () => {
    assert.deepEqual(
        resolveEdgeVoice({ gender: 'female' }, 'egyptian'),
        { voice: 'ar-EG-SalmaNeural', dialectId: 'egyptian', gender: 'female', isFallback: false },
    );
    assert.deepEqual(
        resolveEdgeVoice({ gender: 'male' }, 'saudi'),
        { voice: 'ar-SA-HamedNeural', dialectId: 'saudi', gender: 'male', isFallback: false },
    );
    assert.deepEqual(
        resolveEdgeVoice({ id: 'egy_youssef', gender: 'male' }),
        { voice: 'ar-EG-ShakirNeural', dialectId: 'egyptian', gender: 'male', isFallback: false },
    );
    const sudanese = resolveEdgeVoice({ gender: 'female' }, 'sudanese');
    assert.equal(sudanese.voice, 'ar-EG-SalmaNeural');
    assert.equal(sudanese.isFallback, true);
    assert.equal(resolveEdgeVoice({ gender: 'male' }, 'unknown').voice, 'ar-SA-HamedNeural');
    assert.equal(resolveEdgeVoice({ gender: 'male' }, 'unknown').dialectId, 'fusha');
});

test('بناء SSML: الصيغة الطويلة للصوت و prosody والهروب', () => {
    const ssml = buildEdgeSsml({
        text: 'أهلاً & <بيك>', voice: 'ar-EG-SalmaNeural', rate: '+15%', pitch: '-5Hz',
    });
    assert.equal(ssml,
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
        + `<voice name='Microsoft Server Speech Text to Speech Voice (ar-EG, SalmaNeural)'>`
        + `<prosody pitch='-5Hz' rate='+15%' volume='+0%'>أهلاً &amp; &lt;بيك&gt;</prosody></voice></speak>`);
    assert.equal(
        edgeVoiceSsmlName('ar-SA-HamedNeural'),
        'Microsoft Server Speech Text to Speech Voice (ar-SA, HamedNeural)',
    );
    // اسم غير صالح يسقط للصوت الافتراضي
    assert.match(buildEdgeSsml({ text: 'x', voice: 'Fenrir' }), /ar-SA, ZariyahNeural/);
});

test('ترجمة أدوات الاستوديو إلى prosody: السرعة والطبقة والعمق والنوع', () => {
    assert.deepEqual(
        edgeProsodyForControls({ speed: 'متوسطة', pitch: 'متوسطة', depth: 'متوسطة' }, 'بالغ'),
        { rate: '+0%', pitch: '+0Hz', volume: '+0%' },
    );
    assert.deepEqual(
        edgeProsodyForControls({ speed: 'سريعة', pitch: 'عالية', depth: 'خفيفة' }, 'بالغ'),
        { rate: '+15%', pitch: '+10Hz', volume: '+0%' },
    );
    assert.deepEqual(
        edgeProsodyForControls({ speed: 'بطيئة', pitch: 'منخفضة', depth: 'عميقة' }, 'بالغ'),
        { rate: '-15%', pitch: '-10Hz', volume: '+0%' },
    );
    // كبار السن: إبطاء وخفض إضافي؛ كرتوني: تسريع ورفع إضافي
    assert.deepEqual(
        edgeProsodyForControls({ speed: 'متوسطة', pitch: 'متوسطة', depth: 'متوسطة' }, 'كبار السن'),
        { rate: '-10%', pitch: '-4Hz', volume: '+0%' },
    );
    assert.deepEqual(
        edgeProsodyForControls({ speed: 'متوسطة', pitch: 'متوسطة', depth: 'متوسطة' }, 'شخصية كارتونية'),
        { rate: '+10%', pitch: '+8Hz', volume: '+0%' },
    );
    // الحرارة والانفعال والدراما والغرض لا تغيّر prosody — تُتجاهل بصراحة
    const base = edgeProsodyForControls({ speed: 'متوسطة', pitch: 'متوسطة' }, 'بالغ');
    const withIgnored = edgeProsodyForControls(
        { speed: 'متوسطة', pitch: 'متوسطة', temp: 'دافئ', emotion: 'قوي', drama: 'قوي', purpose: 'إعلان' },
        'بالغ',
    );
    assert.deepEqual(withIgnored, base);
    assert.deepEqual(EDGE_IGNORED_CONTROLS, ['temp', 'emotion', 'drama', 'purpose']);
});

test('توليد Sec-MS-GEC: حتمي، بالشكل الصحيح، ويطابق قيم المكتبة المرجعية', () => {
    // قيم مرجعية محسوبة من مكتبة edge-tts 7.3.1 المثبتة (drm.py) — لا
    // قيمة ضد خادم حي: الشبكة في بيئة الوكيل تمنع الوصول لمايكروسوفت.
    assert.equal(generateSecMsGec(1700000000.0),
        '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2');
    assert.equal(generateSecMsGec(1700000300.0),
        '0919602B5750900A-EC9DD394F23CB5635CF62A0E8E24136DCD32B26D10C543B10082E482D7516397');
    assert.equal(generateSecMsGec(0.0),
        '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6');
    assert.equal(generateSecMsGec(1790000000.5),
        'D4216A7D3DE0C94F-91D741832FD084A110FDAD52BE2FFA569C6EA5F7D06A9429380A398738F4559A');
    // نفس نافذة 5 دقائق = نفس التوكن؛ نافذة أخرى = توكن آخر
    assert.equal(generateSecMsGec(1700000001.0), generateSecMsGec(1700000000.0));
    assert.notEqual(generateSecMsGec(1700000300.0), generateSecMsGec(1700000000.0));
    assert.match(generateSecMsGec(1700000000.0), /^[0-9A-F]{16}-[0-9A-F]{64}$/);
});

test('سلسلة تاريخ Edge بصيغة JavaScript', () => {
    assert.equal(
        edgeDateString(new Date('2026-11-24T22:00:00Z')),
        'Tue Nov 24 2026 22:00:00 GMT+0000 (Coordinated Universal Time)',
    );
});

test('اختيار المحرك: افتراضي edge، وgemini فقط مع مفتاح', () => {
    assert.deepEqual(resolveTtsEngine(undefined, false), { engine: 'edge' });
    assert.deepEqual(resolveTtsEngine('edge', false), { engine: 'edge' });
    assert.deepEqual(resolveTtsEngine('gemini', true), { engine: 'gemini' });
    assert.deepEqual(resolveTtsEngine('gemini', false), { engine: null, error: 'gemini-key-required' });
    assert.deepEqual(resolveTtsEngine('unknown', false), { engine: 'edge' });
    assert.equal(EDGE_TTS_ENGINE_DEFAULT, 'edge');
});

test('أسماء ملفات الصوت: mp3 لمحرك Edge وwav الافتراضي', () => {
    assert.equal(audioFileName('جلسة مصر', 'mp3'), 'جلسة مصر.mp3');
    assert.equal(audioFileName('جلسة: مصر', 'mp3'), 'جلسة_ مصر.mp3');
    assert.equal(audioFileName(''), 'mad3oom_audio.wav');
    assert.equal(audioFileName('x', 'MP3'), 'x.mp3');
});

test('ترميز PCM إلى WAV: ترويسة صحيحة وعينات 16-بت', () => {
    const wav = encodePcmToWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 24000, 1);
    assert.equal(wav.length, 44 + 10);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
    const view = new DataView(wav.buffer);
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), 0x3FFF);
    assert.equal(view.getInt16(48, true), -0x4000);
    assert.equal(view.getInt16(50, true), 0x7FFF);
    assert.equal(view.getInt16(52, true), -0x8000);
});

test('دمج مقاطع مفكوكة: يلصق القنوات ويعيد WAV واحدًا', () => {
    const a = { sampleRate: 24000, channels: [new Float32Array([0.25, 0.5])] };
    const b = { sampleRate: 24000, channels: [new Float32Array([-0.5])] };
    const merged = mergeDecodedAudio([a, b]);
    assert.equal(merged.length, 44 + 6);
    const view = new DataView(merged.buffer);
    assert.equal(view.getInt16(44, true), 0x1FFF);
    assert.equal(view.getInt16(46, true), 0x3FFF);
    assert.equal(view.getInt16(48, true), -0x4000);
    assert.equal(mergeDecodedAudio([]).length, 44);
    // مقطع أحادي بعد ستيريو يُملأ صمتًا في القناة الثانية
    const stereo = mergeDecodedAudio([
        { sampleRate: 24000, channels: [new Float32Array([1]), new Float32Array([0.5])] },
        { sampleRate: 24000, channels: [new Float32Array([0])] },
    ]);
    const sv = new DataView(stereo.buffer);
    assert.equal(sv.getUint16(22, true), 2);
    assert.equal(sv.getInt16(44, true), 0x7FFF);
    assert.equal(sv.getInt16(46, true), 0x3FFF);
    assert.equal(sv.getInt16(48, true), 0);
    assert.equal(sv.getInt16(50, true), 0);
});

/* ─────────────────── إعادة التسمية ─────────────────── */

test('فحص العلامة المحظورة يكشف الاسم القديم ويتجاهل النص النظيف', () => {
    assert.equal(hasForbiddenBrand('مرحباً في مدعوم'), false);
    assert.equal(hasForbiddenBrand('test ' + ['sa', 'vio'].join('')), true);
    assert.equal(hasForbiddenBrand(['ai', 'studio', '-', 'build'].join('')), true);
});

test('لا أثر للاسم القديم أو الألوان المحظورة في أي بيانات', () => {
    const hits = findForbiddenBrandInData({
        DIALECTS, VOICE_FIELDS, STUDIO_CONTROLS, CATEGORY_STYLES, PREVIEW_SCRIPTS, WORKFLOW_STEPS,
        EDGE_VOICE_MAP,
    });
    assert.deepEqual(hits, []);
    const joined = JSON.stringify({ DIALECTS, VOICE_FIELDS, STUDIO_CONTROLS, EDGE_VOICE_MAP });
    for (const forbidden of FORBIDDEN) {
        assert.ok(!joined.includes(forbidden), `ظهرت السلسلة المحظورة: ${forbidden}`);
    }
});

test('أسماء إجراءات الـ Edge Function ثمانية كما في الخادم الأصلي', () => {
    assert.deepEqual(EDGE_ACTIONS, [
        'preprocess-text', 'identify-key-sentences', 'analyze-and-segment',
        'transcribe-media', 'extract-text', 'generate-podcast-script', 'tts', 'generate-stream',
    ]);
});
