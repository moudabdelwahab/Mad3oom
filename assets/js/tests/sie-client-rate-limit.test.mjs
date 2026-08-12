import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * ------------------------------------------------------------
 * sie-client.js is the single boundary between Mad3oom and SIE, and it
 * cannot be imported here: it pulls in supabase-config.js and browser
 * globals. So these are source-text assertions on the three behaviours
 * that are wrong in a way nobody notices until a customer is stuck —
 * a retried 429, a swallowed limit message, or headers read from a
 * response that never exposes them.
 */
const read = () => readFile(fileURLToPath(new URL('../sie-client.js', import.meta.url)), 'utf8');

test('a 429 is never retried', async () => {
    const src = await read();
    const fn = src.slice(src.indexOf('function isRetryableError'), src.indexOf('function sleep'));
    // Retrying spends another token and pushes the reset further out — the
    // customer would be punished for the client's impatience.
    assert.match(fn, /SieRateLimitError|status === 429/);
    const guardAt = fn.search(/429|SieRateLimitError/);
    const serverErrorAt = fn.indexOf('>= 500');
    assert.ok(guardAt > -1 && guardAt < serverErrorAt, 'the 429 guard must come before the >= 500 retry rule');
});

test('a 429 becomes a friendly reply instead of a silent fallback', async () => {
    const src = await read();
    const handler = src.slice(src.indexOf("if (err?.name === 'SieRateLimitError')"));
    assert.ok(handler.length > 0, 'getSieReply does not handle the rate-limit error');
    // Returning null here would route the customer to the traditional
    // engine, hiding the fact that they are sending too fast and doubling
    // the load rather than slowing it.
    assert.match(handler, /rateLimited: true/);
    assert.match(handler, /retryAfterSeconds/);
    assert.match(handler, /alreadyPersisted: false/, 'the caller must persist this message itself');
    assert.match(handler, /[؀-ۿ]/, 'the customer-facing message must be Arabic');
});

test('the limit standing is recorded from every response, not only the 429', async () => {
    const src = await read();
    const fetchOnce = src.slice(src.indexOf('async function sieFetchOnce'), src.indexOf('async function sieRequest'));
    const recordAt = fetchOnce.indexOf('recordRateLimitHeaders(response)');
    const notOkAt = fetchOnce.indexOf('if (!response.ok)');
    assert.ok(recordAt > -1, 'headers are never recorded');
    // Before the !ok branch, so a success updates the standing too — that
    // is what makes warning ahead of the wall possible at all.
    assert.ok(recordAt < notOkAt, 'headers must be recorded before the error branch returns');
});

test('both header spellings are read, and an absent header never invents a number', async () => {
    const src = await read();
    const fn = src.slice(src.indexOf('function recordRateLimitHeaders'), src.indexOf('export function getSieRateLimitSnapshot'));
    assert.match(fn, /RateLimit-Limit/);
    assert.match(fn, /X-RateLimit-Limit/);
    // If the API does not expose the headers through CORS, the values stay
    // null and consumers degrade to "unknown" — never to a wrong number.
    assert.match(fn, /if \(limit === null && remaining === null\) return;/);
});

test('the snapshot reports unknown rather than guessing', async () => {
    const src = await read();
    const fn = src.slice(src.indexOf('export function getSieRateLimitSnapshot'));
    assert.match(fn, /known: false/);
    for (const level of ['exhausted', 'critical', 'warning', 'ok']) {
        assert.ok(fn.includes(`'${level}'`), `the ${level} level is missing`);
    }
});

test('the architecture rule still holds — no SIE source is imported', async () => {
    const src = await read();
    // Mad3oom must never import SIE source code; every interaction goes
    // through public HTTP APIs, and this file is the single boundary.
    assert.doesNotMatch(src, /from\s+['"][^'"]*sie-integration\//);
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/sie\//);
});
