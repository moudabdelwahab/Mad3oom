import test from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, fuzzyWordMatch, findBestFuzzyMatch } from '../typo-tolerance.js';

test('levenshtein: identical strings have distance 0', () => {
    assert.equal(levenshtein('مشكله', 'مشكله'), 0);
});

test('levenshtein: empty-string edge cases equal the other string\'s length', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
});

test('levenshtein: counts single-character edits correctly', () => {
    assert.equal(levenshtein('مشكله', 'مشكلة'), 1); // one substitution
    assert.equal(levenshtein('كات', 'كاتب'), 1);     // one insertion
});

test('fuzzyWordMatch: exact match always matches', () => {
    assert.equal(fuzzyWordMatch('تذكره', 'تذكره'), true);
});

test('fuzzyWordMatch: tolerates a single-character typo on a short word', () => {
    assert.equal(fuzzyWordMatch('مشكله', 'مشكلة'), true);
});

test('fuzzyWordMatch: rejects words with too great a length difference', () => {
    assert.equal(fuzzyWordMatch('لا', 'لالالالالالا'), false);
});

test('fuzzyWordMatch: allows a larger edit distance for longer words (>=7 chars)', () => {
    // "اشتراكات" (8 chars) vs a 2-edit typo should still pass under the
    // length>=7 threshold of 2
    assert.equal(fuzzyWordMatch('اشتراكاط', 'اشتراكات'), true);
});

test('fuzzyWordMatch: rejects unrelated words of similar length', () => {
    assert.equal(fuzzyWordMatch('تذكره', 'مشكله'), false);
});

test('findBestFuzzyMatch: returns the closest matching candidate', () => {
    const result = findBestFuzzyMatch('مشكله', ['تذكره', 'مشكلة', 'اشتراك']);
    assert.equal(result, 'مشكلة');
});

test('findBestFuzzyMatch: returns null when nothing is close enough', () => {
    const result = findBestFuzzyMatch('مشكله', ['تذكره', 'اشتراك', 'دخول']);
    assert.equal(result, null);
});
