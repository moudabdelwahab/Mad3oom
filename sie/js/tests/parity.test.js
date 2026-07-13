/**
 * parity.test.js
 * ------------------------------------------------------------
 * Proves behavioral parity between Module 1 (modules/normalization-layer.js)
 * and the frozen production reference fixture
 * (reference/chatbot-engine-matching-utils.reference.js), which is a
 * verbatim copy of chatbot-engine.js v6's matching-utility section.
 *
 * This is the test that backs the claim "preserve existing behavior
 * exactly" from the architectural decision. If this file passes, Module 1's
 * normalization/matching primitives are provably identical in behavior to
 * what chatbot-engine.js currently does in production, across every case
 * exercised here.
 * ------------------------------------------------------------
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as mod1 from '../modules/normalization-layer.js';

const require = createRequire(import.meta.url);
const ref = require('../reference/chatbot-engine-matching-utils.reference.cjs');

// A broad set of fixtures: plain text, greetings, thanks, cancel phrases,
// typos, mixed Arabic/Latin, punctuation, elongation, empty/whitespace,
// numerals, and unrelated diagnosis-style text (should yield no low-level
// intent since that's out of §8.1's scope).
const TEXT_FIXTURES = [
    '',
    '   ',
    'مرحبا',
    'اهلاً بيك',
    'ازيك يا صاحبي',
    'ايه الاخبار يا معلم',
    'صباح الخير',
    'شكراً جزيلاً',
    'تسلم ايدك يا باشا',
    'الغاء',
    'رجعني للقائمة الرئيسية',
    'مش عايز اكمل، رجوع',
    'واتساب مش بيوصلني رسايل من امبارح',
    'عندي مشكلة في تسجيل الدخول',
    'نسيت الباسورد',
    'ايه هو مدعوم بالظبط؟',
    'عايز اعرف الاسعار كام',
    'ازيــــــــك', // elongation
    'ازيك؟!', // punctuation
    'HELLO there',
    'hi',
    'thanks a lot',
    'cancel please',
    '12345',
    'مرحبا شكرا الغاء', // multiple intents in one message
    'محتاج حد يساعدني في حاجة تانية خالص مش من اللي فوق',
    '   ازيك   ',
    'اهلا وسهلا بيك في اي وقت تحب',
];

describe('Module 1 parity with production chatbot-engine.js matching utilities', () => {
    test('normalizeArabic matches production for all fixtures', () => {
        for (const text of TEXT_FIXTURES) {
            assert.equal(
                mod1.normalizeArabic(text),
                ref.normalizeArabic(text),
                `normalizeArabic mismatch for input: ${JSON.stringify(text)}`
            );
        }
    });

    test('normalizeArabic handles falsy/non-string-ish edge cases like production', () => {
        assert.equal(mod1.normalizeArabic(null), ref.normalizeArabic(null));
        assert.equal(mod1.normalizeArabic(undefined), ref.normalizeArabic(undefined));
        assert.equal(mod1.normalizeArabic(0), ref.normalizeArabic(0));
    });

    test('collapseRepeatedChars matches production', () => {
        const fixtures = ['طيوووووول', 'aaaaabc', 'مرحبااااا', 'no repeats here', ''];
        for (const text of fixtures) {
            assert.equal(mod1.collapseRepeatedChars(text), ref.collapseRepeatedChars(text));
        }
    });

    test('levenshtein matches production across pairs', () => {
        const pairs = [
            ['', ''],
            ['a', ''],
            ['', 'abc'],
            ['ازيك', 'ازيك'],
            ['ازيك', 'ازيكك'],
            ['مرحبا', 'مرحب'],
            ['كيفك', 'شلونك'],
            ['hello', 'hallo'],
        ];
        for (const [a, b] of pairs) {
            assert.equal(mod1.levenshtein(a, b), ref.levenshtein(a, b), `levenshtein mismatch for ${a} / ${b}`);
        }
    });

    test('fuzzyWordMatch matches production across pairs', () => {
        const pairs = [
            ['ازيك', 'ازيك'],
            ['ازيكك', 'ازيك'],
            ['مرحبا', 'مرحب'],
            ['شكرا', 'شكر'],
            ['hello', 'hallo'],
            ['abc', 'xyz'],
        ];
        for (const [w, t] of pairs) {
            assert.equal(mod1.fuzzyWordMatch(w, t), ref.fuzzyWordMatch(w, t), `fuzzyWordMatch mismatch for ${w} / ${t}`);
        }
    });

    test('matchesPattern matches production for fixtures against representative patterns', () => {
        const patterns = [...ref.DEFAULT_GREETING_PATTERNS, ...ref.THANKS_PATTERNS, ...ref.CANCEL_PATTERNS];
        for (const text of TEXT_FIXTURES) {
            const normalized = ref.normalizeArabic(text);
            for (const pattern of patterns) {
                assert.equal(
                    mod1.matchesPattern(normalized, pattern),
                    ref.matchesPattern(normalized, pattern),
                    `matchesPattern mismatch: text=${JSON.stringify(text)} pattern=${JSON.stringify(pattern)}`
                );
            }
        }
    });

    test('matchAny matches production for fixtures against each pattern list', () => {
        for (const text of TEXT_FIXTURES) {
            const normalized = ref.normalizeArabic(text);
            assert.equal(
                mod1.matchAny(normalized, ref.DEFAULT_GREETING_PATTERNS),
                ref.matchAny(normalized, ref.DEFAULT_GREETING_PATTERNS),
                `matchAny(greeting) mismatch for ${JSON.stringify(text)}`
            );
            assert.equal(
                mod1.matchAny(normalized, ref.THANKS_PATTERNS),
                ref.matchAny(normalized, ref.THANKS_PATTERNS),
                `matchAny(thanks) mismatch for ${JSON.stringify(text)}`
            );
            assert.equal(
                mod1.matchAny(normalized, ref.CANCEL_PATTERNS),
                ref.matchAny(normalized, ref.CANCEL_PATTERNS),
                `matchAny(cancel) mismatch for ${JSON.stringify(text)}`
            );
        }
    });

    test('detectLowLevelIntent matches the reference intent-detection ordering', () => {
        for (const text of TEXT_FIXTURES) {
            const normalized = ref.normalizeArabic(text);
            assert.equal(
                mod1.detectLowLevelIntent(normalized),
                ref.referenceDetectLowLevelIntent(normalized),
                `detectLowLevelIntent mismatch for ${JSON.stringify(text)}`
            );
        }
    });
});
