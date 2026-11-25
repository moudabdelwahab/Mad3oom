/**
 * اختبارات المنطق النقي للاستوديو الصوتي (voice-studio-state.js):
 * بصمة الصوت، وتغليف WAV، ودمج المقاطع، وتنسيق الوقت، وأسماء
 * ملفات الصوت، وأقفال اللهجات وبرومبت TTS، والتوزيع الذكي،
 * وبرومبتات ai-gateway واستخراج JSON، وفحص إعادة التسمية على البيانات.
 *
 * حُذف في تدقيق 2026-11-25: بناء SRT وتغليف DOCX وأسماء ملفات
 * التفريغ (حُذف وضع التفريغ كاملًا)، والمجال وأدوات الاستوديو
 * المتجاهلة (حرارة/دراما/انفعال).
 *
 * ملاحظة: سلاسل الاسم القديم والألوان المحظورة مبنية من مقاطع هنا
 * حتى يبقى ملف الاختبار نفسه نظيفًا عند فحص grep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DIALECTS, STUDIO_CONTROLS, CATEGORY_STYLES, PREVIEW_SCRIPTS,
    WORKFLOW_STEPS, VOICE_TYPES, getBaseVoiceForType,
    EDGE_VOICE_MAP, SUDANESE_EDGE_FALLBACK_NOTE, TTS_ENGINES, TTS_ENGINE_DEFAULT,
} from '../assets/js/owner/voice-studio-data.js';
import {
    EDGE_ACTIONS, DIALECT_PHONETIC_LOCKS, PURPOSE_DIRECTIVES,
    resolveDialectId, phoneticLockForDialect, generateVoiceFingerprint,
    buildTtsPrompt, formatTime, ensureWavBuffer, concatWavBuffers,
    splitTextByParagraphs, audioFileName,
    mapRoleToVoice, smartDistributeSpeakers, hasForbiddenBrand, findForbiddenBrandInData,
    resolveEdgeVoice, resolveTtsEngine, edgeProsodyForControls, EDGE_IGNORED_CONTROLS,
    buildEdgeSsml, edgeVoiceSsmlName, edgeDateString, generateSecMsGec,
    encodePcmToWav, mergeDecodedAudio, EDGE_VOICE_NAME_PATTERN, EDGE_TTS_ENGINE_DEFAULT,
    DIALECT_PREPROCESS_INSTRUCTIONS, PODCAST_STYLE_GUIDES, extractJsonObject,
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

test('البيانات: 12 لهجة بصوتين حقيقيين لكل لهجة (24 صوتًا)', () => {
    assert.equal(DIALECTS.length, 12);
    assert.deepEqual(DIALECTS.map((d) => d.id), [
        'egyptian', 'saudi', 'levantine', 'iraqi', 'algerian', 'moroccan',
        'tunisian', 'khaleeji', 'sudanese', 'yemeni', 'lebanese', 'fusha',
    ]);
    assert.deepEqual(
        DIALECTS.map((d) => d.profiles.length),
        [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    );
    assert.equal(DIALECTS.reduce((n, d) => n + d.profiles.length, 0), 24);
});

test('البيانات: كل صوت له معرّف واسم وجنس ونوع وفئة ووصف وصوت Edge حقيقي', () => {
    for (const dialect of DIALECTS) {
        assert.ok(dialect.title && dialect.description, dialect.id);
        assert.equal(dialect.profiles.length, 2, dialect.id);
        assert.deepEqual(dialect.profiles.map((p) => p.gender).sort(), ['female', 'male'], dialect.id);
        for (const profile of dialect.profiles) {
            assert.ok(profile.id && profile.name, dialect.id);
            assert.ok(['male', 'female'].includes(profile.gender), profile.id);
            assert.ok(VOICE_TYPES.includes(profile.voiceType), profile.id);
            assert.ok(CATEGORY_STYLES[profile.categoryKey], profile.id);
            assert.ok(profile.category && profile.description, profile.id);
            // صوت Edge الحقيقي: يطابق خريطة اللهجة والجنس حرفيًا
            assert.match(profile.edgeVoice, EDGE_VOICE_NAME_PATTERN, profile.id);
            assert.equal(profile.edgeVoice, EDGE_VOICE_MAP[dialect.id][profile.gender], profile.id);
            assert.match(profile.description, /Edge TTS/);
        }
    }
    const ids = DIALECTS.flatMap((d) => d.profiles.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length, 'معرّفات الأصوات فريدة');
});

test('البيانات: 3 أدوات استوديو مؤثرة فعلًا و9 نصوص معاينة و6 خطوات', () => {
    // تدقيق 2026-11-25: حُذفت حرارة الصوت وشدة الدراما (متجاهلتان
    // في كلا المحركين) والانفعال (برومبت Gemini فقط) — فلا يبقى إلا
    // ما يؤثر في محرك Edge الافتراضي. وحُذف المجال (9 حقول) كاملًا.
    assert.deepEqual(Object.keys(STUDIO_CONTROLS), ['speed', 'depth', 'pitch']);
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
    assert.equal(generateVoiceFingerprint('سلمى'), '48871125');
    assert.equal(generateVoiceFingerprint('سلمى'), generateVoiceFingerprint('سلمى'));
    assert.match(generateVoiceFingerprint('شاكر'), /^\d{1,8}$/);
    assert.notEqual(generateVoiceFingerprint('سلمى'), generateVoiceFingerprint('شاكر'));
});

test('استنتاج اللهجة من بادئة معرّف الصوت', () => {
    assert.equal(resolveDialectId('egy_salma'), 'egyptian');
    assert.equal(resolveDialectId('sau_zariyah'), 'saudi');
    assert.equal(resolveDialectId('fus_zariyah'), 'fusha');
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
        profile: { id: 'egy_salma', name: 'سلمى', description: 'صوت Edge TTS متاح' },
        controls: { speed: 'متوسطة', pitch: 'متوسطة', emotion: 'متوسط', purpose: 'إعلان' },
        performanceNote: 'Pilot Lock',
        dialectId: 'egyptian',
    });
    assert.match(prompt, /MODE: READY_FOR_TTS/);
    assert.match(prompt, /IDENTITY: سلمى \(صوت Edge TTS متاح\)/);
    assert.match(prompt, /FINGERPRINT: 48871125/);
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


test('أسماء ملفات الصوت: تعقيم وافتراضي wav', () => {
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
        resolveEdgeVoice({ id: 'egy_salma', gender: 'male' }),
        { voice: 'ar-EG-ShakirNeural', dialectId: 'egyptian', gender: 'male', isFallback: false },
    );
    const sudanese = resolveEdgeVoice({ gender: 'female' }, 'sudanese');
    assert.equal(sudanese.voice, 'ar-EG-SalmaNeural');
    assert.equal(sudanese.isFallback, true);
    assert.equal(resolveEdgeVoice({ gender: 'male' }, 'unknown').voice, 'ar-SA-HamedNeural');
    assert.equal(resolveEdgeVoice({ gender: 'male' }, 'unknown').dialectId, 'fusha');
});

test('المعرض يعرض أصوات Edge الحقيقية فقط: المصرية سلمى وشاكر، ولا أسماء Gemini', () => {
    const byDialect = Object.fromEntries(
        DIALECTS.map((d) => [d.id, d.profiles.map((p) => p.name)]),
    );
    assert.deepEqual(byDialect.egyptian, ['سلمى', 'شاكر']);
    assert.deepEqual(byDialect.sudanese, ['سلمى', 'شاكر']);
    assert.deepEqual(byDialect.saudi, ['زارية', 'حامد']);
    assert.deepEqual(byDialect.fusha, ['زارية', 'حامد']);
    assert.deepEqual(byDialect.levantine, ['أماني', 'ليث']);
    assert.deepEqual(byDialect.iraqi, ['رنا', 'باسل']);
    assert.deepEqual(byDialect.algerian, ['أمينة', 'إسماعيل']);
    assert.deepEqual(byDialect.moroccan, ['منى', 'جمال']);
    assert.deepEqual(byDialect.tunisian, ['ريم', 'هادي']);
    assert.deepEqual(byDialect.khaleeji, ['فاطمة', 'حمدان']);
    assert.deepEqual(byDialect.yemeni, ['مريم', 'صالح']);
    assert.deepEqual(byDialect.lebanese, ['ليلى', 'رامي']);
    // الأسماء المميزة كلها أسماء أصوات Edge حقيقية (20 اسمًا؛ سلمى/شاكر/
    // زارية/حامد تتكرر بين لهجتين لأن الصوت نفسه).
    const names = new Set(DIALECTS.flatMap((d) => d.profiles.map((p) => p.name)));
    assert.equal(names.size, 20);
    for (const name of ['سلمى', 'شاكر', 'زارية', 'حامد', 'أماني', 'ليث', 'رنا', 'باسل',
        'أمينة', 'إسماعيل', 'منى', 'جمال', 'ريم', 'هادي', 'فاطمة', 'حمدان',
        'مريم', 'صالح', 'ليلى', 'رامي']) {
        assert.ok(names.has(name), name);
    }
    // لا أسماء شخصيات Gemini الوهمية في أي بروفايل (رامي/منى/ريم/مريم/
    // ليلى مستثناة هنا لأنها أسماء أصوات Edge حقيقية في لهجاتها).
    for (const fake of ['يوسف', 'مالك', 'سيف', 'زيد', 'لوجين', 'نورا', 'جمانة', 'فارس',
        'زيدان', 'مؤمن', 'سما', 'ناصر', 'راكان', 'فهد', 'محسن', 'الجوهرة', 'أفنان',
        'هيا', 'بدور', 'لولو', 'فواز', 'ربيع', 'جاد', 'ميلاد', 'لين', 'رهف', 'نور',
        'بيبو', 'ليليا', 'علي', 'مهند', 'حيدر', 'سمر', 'زهراء', 'ميمو', 'لولي',
        'أنور', 'قيس', 'حكيم', 'عايدة', 'هاجر', 'سيليا', 'المهدي', 'طارق', 'أمين',
        'سارة', 'ميمون', 'ليما', 'كريم', 'نادر', 'حسام', 'يسرى', 'ميمي', 'بولينو',
        'جاسم', 'راشد', 'مي', 'لمياء', 'لؤلان', 'إدريس', 'مازن', 'عثمان', 'الصادق',
        'إيثار', 'ريان', 'تسنيم', 'حمزة', 'وضاح', 'معاذ', 'بلقيس', 'أروى', 'مآب',
        'فؤاد', 'زياد', 'نادين', 'يارا', 'لانا', 'سامر', 'نديم', 'جود',
        'بطل كرتون', 'بطلة كرتون', 'عبد الرحمن', 'حسان', 'فاروق', 'صلاح', 'عدنان',
        'خديجة', 'عائشة', 'شريفة', 'نجلاء', 'رجاء', 'عبد العزيز']) {
        assert.ok(!names.has(fake), `اسم وهمي ما زال في المعرض: ${fake}`);
    }
});

test('المعرض لا يُفرغ لأي توليفة لهجة × نوع × جنس', () => {
    // filteredProfiles في الصفحة يُصفّى باللهجة والجنس فقط (لا voiceType)،
    // وهنا نتحقق على البيانات نفسها أن كل توليفة لها صوت واحد على الأقل —
    // نوع الصوت ضبط prosody لا يغيّر المعروض.
    for (const dialect of DIALECTS) {
        for (const type of VOICE_TYPES) {
            for (const gender of ['male', 'female']) {
                const shown = dialect.profiles.filter((p) => p.gender === gender);
                assert.ok(shown.length >= 1, `${dialect.id} / ${type} / ${gender}`);
            }
        }
    }
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
        DIALECTS, STUDIO_CONTROLS, CATEGORY_STYLES, PREVIEW_SCRIPTS, WORKFLOW_STEPS,
        EDGE_VOICE_MAP,
    });
    assert.deepEqual(hits, []);
    const joined = JSON.stringify({ DIALECTS, STUDIO_CONTROLS, EDGE_VOICE_MAP });
    for (const forbidden of FORBIDDEN) {
        assert.ok(!joined.includes(forbidden), `ظهرت السلسلة المحظورة: ${forbidden}`);
    }
});

test('أسماء إجراءات الـ Edge Function: توليد صوتي فقط', () => {
    // تدقيق 2026-11-25: الدالة tts فقط؛ الإجراءات النصية الأربعة
    // تُوجَّه إلى ai-gateway، والتفريغ والاستخراج والبث حُذفوا.
    assert.deepEqual(EDGE_ACTIONS, ['tts']);
});

/* ─────────────────── برومبتات ai-gateway واستخراج JSON ─────────────────── */

test('تعليمات تحويل اللهجة: سودانية ويمنية ولبنانية فقط', () => {
    assert.deepEqual(Object.keys(DIALECT_PREPROCESS_INSTRUCTIONS).sort(), ['lebanese', 'sudanese', 'yemeni']);
    assert.match(DIALECT_PREPROCESS_INSTRUCTIONS.sudanese, /سودانية/);
    assert.match(DIALECT_PREPROCESS_INSTRUCTIONS.yemeni, /يمنية/);
    assert.match(DIALECT_PREPROCESS_INSTRUCTIONS.lebanese, /لبنانية/);
});

test('إرشاد لهجة البودكاست: اللهجات الثماني في الخادم سابقًا', () => {
    assert.deepEqual(Object.keys(PODCAST_STYLE_GUIDES).sort(), [
        'egyptian', 'fusha', 'khaleeji', 'lebanese', 'levantine', 'saudi', 'sudanese', 'yemeni',
    ]);
    assert.match(PODCAST_STYLE_GUIDES.egyptian, /مصرية/);
    assert.match(PODCAST_STYLE_GUIDES.fusha, /فصحى/);
});

test('استخراج JSON من رد نصي حر: عادٍ ومسيّج ومحاط بنص', () => {
    assert.deepEqual(extractJsonObject('{"sentences":["أ","ب"]}'), { sentences: ['أ', 'ب'] });
    assert.deepEqual(
        extractJsonObject('```json\n{"segments":[{"label":"م","role":"الراوي","text":"ن"}]}\n```'),
        { segments: [{ label: 'م', role: 'الراوي', text: 'ن' }] },
    );
    assert.deepEqual(
        extractJsonObject('إليك النتيجة:\n{"turns":[],"speakers":[]}\nانتهى.'),
        { turns: [], speakers: [] },
    );
});

test('استخراج JSON يرمي عند الرد الفارغ أو غير JSON — لا بديل صامت', () => {
    assert.throws(() => extractJsonObject(''), /رد فارغ/);
    assert.throws(() => extractJsonObject('لا يوجد JSON هنا'), /تعذّر تحليل/);
    assert.throws(() => extractJsonObject('{ليس JSON}'), /JSON/);
});
