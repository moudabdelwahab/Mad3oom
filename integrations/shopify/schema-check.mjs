// ============================================================================
// schema-check.mjs — يتحقق من كل وثيقة GraphQL يرسلها shopify-admin.js (ومتغيراتها) على مخطط
// Admin API الحقيقي. ليس جزءًا من npm test (يحتاج حزمة graphql وملف المخطط، وكلاهما خارج المستودع).
//
//   1) المخطط (introspection) لإصدار 2026-10، مثلًا من مستكشف shopify.dev:
//        node -e "…getIntrospectionQuery…" → schema.json   (أو من متجر تطوير بعد الربط)
//   2) npm i graphql@16 في مجلد مؤقت
//   3) GRAPHQL_PATH=/tmp/x/node_modules/graphql/index.mjs node integrations/shopify/schema-check.mjs schema.json
//
// يشغّل كل عملية بمدخلها الصالح من tests/fixtures/shopify/admin-fixtures.mjs على Shopify مزيّف، ويلتقط
// كل طلب، ثم: validate(schema, document) و getVariableValues(schema, variableDefinitions, variables).
// النجاح يثبت أن الأسماء والأنواع والقيم المرسلة صحيحة في المخطط — لا أن Shopify يقبلها تجاريًا
// (الأهلية، الخطة، البيانات المحمية): ذلك على متجر تطوير.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { OPERATIONS, OPERATION_KEYS, validateOperation, _DOCS } from '../../supabase/functions/_shared/integrations/shopify-admin.js';
import { SHOP, VALID_INPUTS, shopState, answer } from '../../tests/fixtures/shopify/admin-fixtures.mjs';

const gql = await import(process.env.GRAPHQL_PATH || 'graphql');
const { buildClientSchema, parse, validate } = gql;
const { getVariableValues } = gql;
const file = process.argv[2];
if (!file) {
    console.error('usage: GRAPHQL_PATH=… node integrations/shopify/schema-check.mjs <introspection.json>');
    process.exit(2);
}
const intro = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const schema = buildClientSchema(intro.data || intro);
const NOW = Date.parse('2026-10-28T10:00:00Z');

const captured = [];
function ctxFor(st) {
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        captured.push(body);
        const a = answer(body.query, body.variables, st);
        return new Response(JSON.stringify({ data: a.data, extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 1000, restoreRate: 100 } } } }),
                            { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, env: {}, externalAccountId: SHOP, credentials: { access_token: 'shpat_' + 'x'.repeat(32), expires_at: null }, now: () => NOW };
}

let ran = 0;
for (const op of OPERATION_KEYS) {
    const st = shopState({ returnStatus: op === 'return.close' || op === 'return.cancel' ? 'OPEN' : 'REQUESTED' });
    const ctx = ctxFor(st);
    const def = OPERATIONS[op];
    const v = validateOperation(op, VALID_INPUTS[op], { nowMs: NOW });
    const check = def.check ? await def.check(ctx, v) : null;
    await def.run(ctx, v, { opId: '00000000-0000-4000-8000-000000000001', check });
    ran++;
}
for (const [name, doc] of Object.entries(_DOCS)) captured.push({ query: doc, variables: null, name });

const seen = new Set();
let failures = 0;
let documents = 0;
for (const c of captured) {
    const key = c.query + '\n' + JSON.stringify(c.variables);
    if (seen.has(key)) continue;
    seen.add(key);
    let ast;
    try {
        ast = parse(c.query);
    } catch (e) {
        failures++;
        console.log('PARSE FAIL', c.name || '', e.message, '\n', c.query.slice(0, 200));
        continue;
    }
    documents++;
    const errs = validate(schema, ast);
    if (errs.length) {
        failures++;
        console.log('INVALID', c.name || c.query.replace(/\s+/g, ' ').slice(0, 90));
        for (const e of errs) console.log('   ', e.message);
    }
    if (c.variables) {
        const opDef = ast.definitions.find((d) => d.kind === 'OperationDefinition');
        const r = getVariableValues(schema, opDef.variableDefinitions || [], c.variables);
        if (r.errors?.length) {
            failures++;
            console.log('BAD VARIABLES', c.query.replace(/\s+/g, ' ').slice(0, 90));
            for (const e of r.errors) console.log('   ', e.message);
        }
    }
}
console.log(`${ran} operations run, ${documents} distinct documents/variable sets checked against the schema, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
