import test from 'node:test';
import assert from 'node:assert/strict';
import { decideResponseLanguage } from '../response-language-policy.js';

test('response-language-policy: defaults to Arabic with no tokens at all', () => {
    const lang = decideResponseLanguage({ previousLanguage: 'ar', tokens: [] });
    assert.equal(lang, 'ar');
});

test('response-language-policy: pure Arabic-script tokens stay Arabic', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'ar',
        tokens: [
            { raw: 'مش', script: 'arabic', isGlossaryMatch: false, isArabiziResolved: false },
            { raw: 'شغال', script: 'arabic', isGlossaryMatch: false, isArabiziResolved: false }
        ]
    });
    assert.equal(lang, 'ar');
});

test('response-language-policy: genuinely English-only message switches to English', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'ar',
        tokens: [
            { raw: 'Login', script: 'latin', isGlossaryMatch: false, isArabiziResolved: false },
            { raw: 'Failed', script: 'latin', isGlossaryMatch: false, isArabiziResolved: false }
        ]
    });
    assert.equal(lang, 'en');
});

test('response-language-policy: technical-glossary terms do NOT count as English, even with no Arabic present', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'ar',
        tokens: [
            { raw: 'SSL', script: 'latin', isGlossaryMatch: true, isArabiziResolved: false },
            { raw: 'Certificate', script: 'latin', isGlossaryMatch: true, isArabiziResolved: false }
        ]
    });
    // Ambiguous (technical-only, no genuine prose either way) -> sticky, stays previous
    assert.equal(lang, 'ar');
});

test('response-language-policy: Arabizi-resolved tokens count as Arabic, not English', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'ar',
        tokens: [
            { raw: '3andy', script: 'mixed', isGlossaryMatch: false, isArabiziResolved: true },
            { raw: 'moshkela', script: 'latin', isGlossaryMatch: false, isArabiziResolved: true }
        ]
    });
    assert.equal(lang, 'ar');
});

test('response-language-policy: mixed Arabic + English technical term resolves to Arabic', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'en', // even if the session was previously in English
        tokens: [
            { raw: 'ال', script: 'arabic', isGlossaryMatch: false, isArabiziResolved: false },
            { raw: 'API', script: 'latin', isGlossaryMatch: true, isArabiziResolved: false },
            { raw: 'مش', script: 'arabic', isGlossaryMatch: false, isArabiziResolved: false }
        ]
    });
    assert.equal(lang, 'ar');
});

test('response-language-policy: Arabic reappearing switches back immediately, no streak required', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'en',
        tokens: [{ raw: 'مرحبا', script: 'arabic', isGlossaryMatch: false, isArabiziResolved: false }]
    });
    assert.equal(lang, 'ar');
});

test('response-language-policy: ambiguous message (numbers only) stays on previous language', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'en',
        tokens: [{ raw: '12345', script: 'digit', isGlossaryMatch: false, isArabiziResolved: false }]
    });
    assert.equal(lang, 'en');
});

test('response-language-policy: unrecognized (non-glossary, non-Arabizi) Latin word counts as genuine English', () => {
    const lang = decideResponseLanguage({
        previousLanguage: 'ar',
        tokens: [{ raw: 'thanks', script: 'latin', isGlossaryMatch: false, isArabiziResolved: false }]
    });
    assert.equal(lang, 'en');
});
