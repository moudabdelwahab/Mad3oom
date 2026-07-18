import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../tokenizer.js';

test('tokenizer: empty/nullish input returns no tokens', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
});

test('tokenizer: classifies pure Arabic-script tokens', () => {
    const tokens = tokenize('مش شغال');
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].raw, 'مش');
    assert.equal(tokens[0].script, 'arabic');
    assert.equal(tokens[1].raw, 'شغال');
    assert.equal(tokens[1].script, 'arabic');
});

test('tokenizer: classifies pure Latin-script tokens', () => {
    const tokens = tokenize('Login Failed');
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].script, 'latin');
    assert.equal(tokens[1].script, 'latin');
    assert.equal(tokens[0].lower, 'login');
});

test('tokenizer: classifies pure digit tokens', () => {
    const tokens = tokenize('401');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].script, 'digit');
});

test('tokenizer: classifies mixed alphanumeric tokens (e.g. Arabizi digit-letters)', () => {
    const tokens = tokenize('3ayez');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].script, 'mixed');
});

test('tokenizer: splits mixed-language sentence into correctly ordered, classified tokens', () => {
    const tokens = tokenize('الـ API مش شغال');
    const scripts = tokens.map((t) => t.script);
    const rawWords = tokens.map((t) => t.raw);
    // "الـ" includes the tatweel character (U+0640), which falls inside
    // the Arabic Unicode block, so it is correctly captured as part of
    // this Arabic-script token here. Tatweel removal is dialect
    // normalization's job (see dialect-normalizer.test.mjs), not the
    // tokenizer's — the tokenizer only segments and classifies script.
    assert.deepEqual(rawWords, ['الـ', 'API', 'مش', 'شغال']);
    assert.deepEqual(scripts, ['arabic', 'latin', 'arabic', 'arabic']);
});

test('tokenizer: reports accurate character offsets for downstream glossary-span matching', () => {
    const text = 'عندي Error 401';
    const tokens = tokenize(text);
    for (const token of tokens) {
        assert.equal(text.slice(token.start, token.end), token.raw);
    }
});

test('tokenizer: ignores punctuation and whitespace as separators', () => {
    const tokens = tokenize('SSL Certificate, هل ده بيؤثر؟!');
    const rawWords = tokens.map((t) => t.raw);
    assert.ok(!rawWords.includes(','));
    assert.ok(!rawWords.includes('؟'));
    assert.ok(!rawWords.includes('!'));
});
