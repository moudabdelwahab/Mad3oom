# Language & Normalization Layer — Test Suite

Permanent regression suite for `/support-engine/language/`. No external test
framework is required — these use Node's built-in test runner
(`node:test` + `node:assert`), available in Node 18+.

## Running the tests

From the `support-engine/language/` directory:

```bash
node --test tests/
```

Or from the project root:

```bash
node --test support-engine/language/tests/
```

To run a single file:

```bash
node --test tests/normalizer.test.mjs
```

## What's covered

| File | Covers |
|---|---|
| `tokenizer.test.mjs` | Script-aware tokenization (Arabic/Latin/digit/mixed classification, offsets, punctuation handling) |
| `dialect-normalizer.test.mjs` | Diacritics/tatweel/alef-form/taa-marbuta/hamza normalization, repeated-character collapsing |
| `typo-tolerance.test.mjs` | Levenshtein distance, fuzzy word matching thresholds, best-match selection |
| `response-language-policy.test.mjs` | Arabic-default / English-only-when-earned rules, including the "Arabic wins back immediately" and "technical terms don't count as English" rules |
| `providers.test.mjs` | Provider abstraction contract: caching behavior, concurrent-load dedup, resilience to malformed loader results — this is what guarantees the future Supabase swap won't require touching consuming modules |
| `normalizer.test.mjs` | End-to-end/golden-file tests: the original mixed-language example set, Arabizi resolution, and full session language-switching sequences |

## Why these tests use `helpers/node-providers.js` instead of the shipped `.local.js` providers

The shipped `technical-glossary.local.js` / `arabizi-map.local.js` use
`fetch(new URL('./data/*.json', import.meta.url))`, which is correct for the
real runtime (a browser loading these files as static assets over HTTP,
exactly like `chat-logic.js` already does with `/api-config.js`). Node's
`fetch` does not resolve `file://` URLs the same way, so the test helpers
inject Node-native (fs-based) provider implementations through the exact
same `createTechnicalGlossaryProvider` / `createArabiziMapProvider` factory
functions used in production — reading the **same real JSON files** shipped
in `../data/`, not separate test fixtures. This means:

- Editing `data/technical-glossary.json` or `data/arabizi-map.json` will be
  caught by these tests if it changes existing behavior.
- The tests double as a live proof that the provider abstraction works:
  swapping the loading mechanism required zero changes to `normalizer.js`.

## Adding new tests when the glossary/Arabizi data grows

When new entries are added to `data/technical-glossary.json` or
`data/arabizi-map.json`, add a corresponding case to
`normalizer.test.mjs` asserting the expected canonical token — this keeps
the golden-file suite in sync with the vocabulary as it grows.
