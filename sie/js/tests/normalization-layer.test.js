/**
 * normalization-layer.test.js
 * ------------------------------------------------------------
 * Unit tests for Module 1 (Normalization Layer) against its §8.1 contract:
 *   - Output shape (normalized_tokens fields).
 *   - Determinism (§7 Principle 2): same input -> same output, always.
 *   - No I/O / no side effects / no persistence (module purity).
 *   - Correct low-level intent detection (greeting/thanks/cancel only).
 *   - Attachment presence flags derived correctly from imageUrl/audioUrl.
 *   - prior_context passthrough behavior.
 *   - Must-never boundaries: no scenario/hypothesis/action fields present
 *     in the output (this module doesn't diagnose).
 * ------------------------------------------------------------
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as mod1 from '../modules/normalization-layer.js';

describe('normalize() — §8.1 contract', () => {
    test('returns the documented output shape', () => {
        const result = mod1.normalize({ text: 'مرحبا' });
        assert.equal(typeof result, 'object');
        assert.ok('raw_text' in result);
        assert.ok('normalized_text' in result);
        assert.ok('tokens' in result);
        assert.ok('low_level_intent' in result);
        assert.ok('attachments' in result);
        assert.ok('prior_context' in result);
        assert.equal(Object.keys(result).length, 6, 'no extra/undocumented fields');
    });

    test('is a pure function — identical input yields identical output on repeat calls', () => {
        const input = { text: 'عندي مشكلة في الواتساب من امبارح', imageUrl: 'https://example.com/x.png' };
        const first = mod1.normalize(input);
        const second = mod1.normalize(input);
        assert.deepEqual(first, second);
    });

    test('does not mutate its input', () => {
        const input = { text: '  ازيك  ', imageUrl: 'https://example.com/a.png' };
        const snapshot = JSON.stringify(input);
        mod1.normalize(input);
        assert.equal(JSON.stringify(input), snapshot);
    });

    test('trims and normalizes raw_text / normalized_text correctly', () => {
        const result = mod1.normalize({ text: '  ازيك يا صاحبي؟  ' });
        assert.equal(result.raw_text, 'ازيك يا صاحبي؟');
        assert.equal(result.normalized_text, mod1.normalizeArabic('ازيك يا صاحبي؟'));
    });

    test('tokens is normalized_text split on whitespace, no empty tokens', () => {
        const result = mod1.normalize({ text: 'ايه   الاخبار  يا معلم' });
        assert.ok(Array.isArray(result.tokens));
        assert.ok(result.tokens.every(t => t.length > 0));
        assert.deepEqual(result.tokens, result.normalized_text.split(' ').filter(Boolean));
    });

    test('empty/whitespace-only text yields empty tokens and null intent', () => {
        const resultEmpty = mod1.normalize({ text: '' });
        assert.equal(resultEmpty.normalized_text, '');
        assert.deepEqual(resultEmpty.tokens, []);
        assert.equal(resultEmpty.low_level_intent, null);

        const resultWs = mod1.normalize({ text: '     ' });
        assert.equal(resultWs.normalized_text, '');
        assert.deepEqual(resultWs.tokens, []);
        assert.equal(resultWs.low_level_intent, null);
    });

    test('missing text field defaults to empty string, does not throw', () => {
        assert.doesNotThrow(() => mod1.normalize({}));
        const result = mod1.normalize({});
        assert.equal(result.raw_text, '');
        assert.equal(result.normalized_text, '');
    });

    test('handles null/undefined rawMessage without throwing', () => {
        assert.doesNotThrow(() => mod1.normalize(null));
        assert.doesNotThrow(() => mod1.normalize(undefined));
        const result = mod1.normalize(null);
        assert.equal(result.raw_text, '');
    });

    describe('low_level_intent detection', () => {
        test('detects greeting', () => {
            assert.equal(mod1.normalize({ text: 'مرحبا' }).low_level_intent, 'greeting');
            assert.equal(mod1.normalize({ text: 'ازيك يا صاحبي' }).low_level_intent, 'greeting');
        });

        test('detects thanks', () => {
            assert.equal(mod1.normalize({ text: 'شكرا جزيلا' }).low_level_intent, 'thanks');
        });

        test('detects cancel', () => {
            assert.equal(mod1.normalize({ text: 'الغاء' }).low_level_intent, 'cancel');
            assert.equal(mod1.normalize({ text: 'رجعني للقائمة' }).low_level_intent, 'cancel');
        });

        test('returns null for diagnosis-relevant / unrelated text', () => {
            assert.equal(mod1.normalize({ text: 'عندي مشكلة في الواتساب' }).low_level_intent, null);
            assert.equal(mod1.normalize({ text: 'نسيت الباسورد بتاعي' }).low_level_intent, null);
            assert.equal(mod1.normalize({ text: 'ايه هي مدعوم' }).low_level_intent, null);
        });

        test('cancel takes priority when multiple intents appear in one message', () => {
            // "مرحبا شكرا الغاء" contains greeting + thanks + cancel patterns simultaneously.
            const result = mod1.normalize({ text: 'مرحبا شكرا الغاء' });
            assert.equal(result.low_level_intent, 'cancel');
        });
    });

    describe('attachments', () => {
        test('has_image true only when imageUrl present', () => {
            assert.equal(mod1.normalize({ text: 'x', imageUrl: 'https://x/y.png' }).attachments.has_image, true);
            assert.equal(mod1.normalize({ text: 'x' }).attachments.has_image, false);
            assert.equal(mod1.normalize({ text: 'x', imageUrl: '' }).attachments.has_image, false);
        });

        test('has_audio true only when audioUrl present', () => {
            assert.equal(mod1.normalize({ text: 'x', audioUrl: 'https://x/y.mp3' }).attachments.has_audio, true);
            assert.equal(mod1.normalize({ text: 'x' }).attachments.has_audio, false);
        });

        test('both flags independent and correct when both attachments present', () => {
            const result = mod1.normalize({ text: 'x', imageUrl: 'https://x/y.png', audioUrl: 'https://x/y.mp3' });
            assert.equal(result.attachments.has_image, true);
            assert.equal(result.attachments.has_audio, true);
        });
    });

    describe('prior_context passthrough', () => {
        test('defaults to null when not provided', () => {
            assert.equal(mod1.normalize({ text: 'مرحبا' }).prior_context, null);
        });

        test('passes through an explicit prior normalized_tokens object unmodified', () => {
            const prior = mod1.normalize({ text: 'اول رسالة' });
            const result = mod1.normalize({ text: 'تاني رسالة' }, prior);
            assert.deepEqual(result.prior_context, prior);
        });

        test('explicit null is preserved as null (not coerced to undefined)', () => {
            const result = mod1.normalize({ text: 'مرحبا' }, null);
            assert.equal(result.prior_context, null);
        });
    });

    describe('§8.1 "must never" boundaries', () => {
        test('output contains no scenario/hypothesis/action/decision fields', () => {
            const result = mod1.normalize({ text: 'عندي مشكلة في الواتساب من امبارح' });
            const forbiddenKeys = ['scenario', 'scenarios', 'hypothesis', 'hypotheses', 'decision', 'action', 'ranking'];
            for (const key of forbiddenKeys) {
                assert.ok(!(key in result), `output must not contain "${key}" — that's not this module's job`);
            }
        });

        test('module exposes no function that performs I/O (no async exports)', () => {
            for (const [name, value] of Object.entries(mod1)) {
                if (typeof value === 'function') {
                    assert.equal(
                        value.constructor.name,
                        'Function',
                        `export "${name}" must be a plain synchronous function, not async — Module 1 performs no I/O`
                    );
                }
            }
        });
    });
});

describe('exported pattern lists', () => {
    test('DEFAULT_GREETING_PATTERNS, THANKS_PATTERNS, CANCEL_PATTERNS are non-empty arrays of strings', () => {
        for (const list of [mod1.DEFAULT_GREETING_PATTERNS, mod1.THANKS_PATTERNS, mod1.CANCEL_PATTERNS]) {
            assert.ok(Array.isArray(list));
            assert.ok(list.length > 0);
            assert.ok(list.every(p => typeof p === 'string'));
        }
    });
});
