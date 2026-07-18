import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collapseRepeatedChars,
    normalizeArabicText,
    normalizeArabicToken
} from '../dialect-normalizer.js';

test('collapseRepeatedChars: collapses runs of 3+ repeated characters', () => {
    assert.equal(collapseRepeatedChars('مشكلططططة'), 'مشكلطة');
    assert.equal(collapseRepeatedChars('noooooo'), 'no');
});

test('collapseRepeatedChars: leaves normal double letters untouched', () => {
    assert.equal(collapseRepeatedChars('hello'), 'hello'); // "ll" is only 2, not 3+
});

test('normalizeArabicText: removes diacritics (tashkeel)', () => {
    const withDiacritics = 'مُشْكِلَة';
    assert.equal(normalizeArabicText(withDiacritics), normalizeArabicText('مشكله'));
});

test('normalizeArabicText: removes tatweel (elongation)', () => {
    assert.equal(normalizeArabicText('اهـــلا'), normalizeArabicText('اهلا'));
});

test('normalizeArabicText: unifies alef forms (إأآا -> ا)', () => {
    const normalized = normalizeArabicText('أنا إنت آنسة انا');
    // all four alef variants collapse to the same base form
    assert.ok(!/[إأآ]/.test(normalized));
});

test('normalizeArabicText: unifies ya/alef-maksura (ى -> ي)', () => {
    assert.equal(normalizeArabicText('علي'), normalizeArabicText('على'));
});

test('normalizeArabicText: unifies taa marbuta (ة -> ه)', () => {
    assert.equal(normalizeArabicText('مشكلة'), normalizeArabicText('مشكله'));
});

test('normalizeArabicText: normalizes hamza carriers per the existing rule (ؤ->و, ئ->ي)', () => {
    // This mirrors the exact rule inherited from chatbot-engine.js's
    // normalizeArabic: ؤ and ئ are NOT unified to a shared form, they map
    // to their respective base letters (و and ي). Asserting the real,
    // preserved behavior rather than assuming they collapse to one form.
    assert.equal(normalizeArabicText('مسؤول'), 'مسوول');
    assert.equal(normalizeArabicText('مسئول'), 'مسيول');
});

test('normalizeArabicText: strips Arabic punctuation (؟ ، ؛ ٪)', () => {
    const normalized = normalizeArabicText('مش شغال؟');
    assert.ok(!normalized.includes('؟'));
});

test('normalizeArabicText: collapses whitespace and trims', () => {
    assert.equal(normalizeArabicText('  مش   شغال  '), 'مش شغال');
});

test('normalizeArabicText: empty/nullish input returns empty string', () => {
    assert.equal(normalizeArabicText(''), '');
    assert.equal(normalizeArabicText(null), '');
    assert.equal(normalizeArabicText(undefined), '');
});

test('normalizeArabicToken: behaves identically to normalizeArabicText for single tokens', () => {
    assert.equal(normalizeArabicToken('شغّال'), normalizeArabicText('شغّال'));
});
