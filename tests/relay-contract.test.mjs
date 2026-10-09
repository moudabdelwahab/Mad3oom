/**
 * Relay المرحلة B: العقد المشترك (assets/js/relay/relay-contract.js) ومطابقته
 * للترحيل 073. الضمانات الأمنية نفسها مقيسة في tests/sql/relay-core.test.sql؛
 * هنا: الوحدة النقية + حراسة الانحراف بين العقد والترحيل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
    CONTRACT_VERSION, RECORD_KINDS, STATUSES, SOURCE_TYPES, REDACTION_REASONS, SENDER_LABELS, LIMITS,
    ERROR_CODES, RETENTION_MS, mapRelayError, sensitiveKinds, buildCreateRequest, validateCreateRequest,
    describeSource, retentionDeadline,
} from '../assets/js/relay/relay-contract.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const KEY = '4b0c2f8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const checkList = (sql, column) => {
    const m = sql.match(new RegExp(`${column}[^\\n]*?check \\(${column} in \\(([^)]*)\\)\\)`, 's'));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};

test('enums and limits match the CHECK constraints in 073', async () => {
    const sql = await read('migrations/073_relay_core.sql');
    const kinds = sql.match(/check \(kind in \(('follow_up'[^)]*)\)\)/)[1];
    assert.deepEqual([...kinds.matchAll(/'([^']+)'/g)].map((x) => x[1]), [...RECORD_KINDS]);
    const status = sql.match(/check \(status in \(([^)]*)\)\)/s)[1];
    assert.deepEqual([...status.matchAll(/'([^']+)'/g)].map((x) => x[1]), [...STATUSES]);
    const types = sql.match(/source_type\s+text not null check \(source_type in \(([^)]*)\)\)/s)[1];
    assert.deepEqual([...types.matchAll(/'([^']+)'/g)].map((x) => x[1]), [...SOURCE_TYPES]);
    assert.deepEqual(checkList(sql, 'redaction_reason'), [...REDACTION_REASONS]);
    assert.deepEqual(checkList(sql, 'sender_label'), [...SENDER_LABELS]);
    assert.match(sql, new RegExp(`char_length\\(btrim\\(title\\)\\) between 1 and ${LIMITS.title}`));
    assert.match(sql, new RegExp(`char_length\\(excerpt\\) <= ${LIMITS.excerpt}`));
    assert.match(sql, /check \(snapshot_retention_days = 365\)/);
    assert.match(sql, /make_interval\(hours => p_days \* 24\)/);
    assert.equal(RETENTION_MS, 365 * 24 * 3600 * 1000);
});

test('every SQLSTATE the migration raises has a contract code', async () => {
    const sql = await read('migrations/073_relay_core.sql');
    const raised = new Set([...sql.matchAll(/errcode = '([0-9A-Z]{5})'/g)].map((m) => m[1]));
    for (const state of raised) assert.ok(ERROR_CODES[state], `unmapped SQLSTATE ${state}`);
});

test('every internal helper is revoked and only public RPCs are granted', async () => {
    const sql = await read('migrations/073_relay_core.sql');
    const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    const granted = new Set([...sql.matchAll(/'public\.(relay_\w+)\(/g)].map((m) => m[1]));
    const publicRpcs = ['relay_create', 'relay_get', 'relay_list', 'relay_update', 'relay_assign', 'relay_transition',
        'relay_attach_sources', 'relay_redact_source', 'relay_redact_for_subject', 'relay_find_by_source', 'relay_events_for'];
    for (const name of defined) {
        const revoked = new RegExp(`revoke all on function (public\\.)?${name}\\(`).test(sql)
            || new RegExp(`'public\\.${name}\\(`).test(sql);
        assert.ok(revoked, `${name} has no explicit revoke/grant`);
    }
    const grantBlock = sql.slice(sql.indexOf('7) صلاحيات التنفيذ'), sql.indexOf('8) تحقق'));
    const grantedNames = [...grantBlock.matchAll(/'public\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(grantedNames.sort(), [...publicRpcs].sort());
    assert.ok(!grantedNames.includes('relay_retention_sweep'));
    assert.ok(granted.has('relay_can_access'), 'relay_can_access is in the revoke list');
    // كل دالة security definer لها search_path ثابت
    for (const m of sql.matchAll(/create or replace function public\.(\w+)\([^;]*?security definer([^\n]*)/gs)) {
        assert.match(m[2], /set search_path to 'public'/, `${m[1]} lacks fixed search_path`);
    }
});

test('mapRelayError maps SQLSTATEs and never echoes server text', () => {
    const e = mapRelayError({ code: '22023', message: 'MARKER secret', details: '{"code":"validation_failed","field":"sources","reason":"sensitive_content","kinds":["card_number"]}' });
    assert.deepEqual({ ...e, message: undefined }, {
        code: 'validation_failed', field: 'sources', reason: 'sensitive_content', kinds: ['card_number'],
        currentVersion: null, message: undefined,
    });
    assert.ok(!e.message.includes('MARKER'));
    assert.equal(mapRelayError({ code: '40001', details: '{"current_version":7}' }).currentVersion, 7);
    assert.equal(mapRelayError({ code: 'P0002', details: 'not json' }).code, 'not_found');
    assert.equal(mapRelayError({ code: 'XX000' }).code, 'unknown_error');
    assert.equal(mapRelayError(null).code, 'unknown_error');
});

test('sensitiveKinds mirrors the server samples (M1)', () => {
    assert.ok(sensitiveKinds('الكارت 4111 1111 1111 1111').includes('card_number'));
    assert.ok(sensitiveKinds('الرقم القومي 29801011234567').includes('national_id'));
    assert.ok(sensitiveKinds('كود التحقق ٤٨٢٩١٣').includes('otp'));
    assert.ok(sensitiveKinds('your verification code is 1234').includes('otp'));
    assert.ok(sensitiveKinds('الباسورد: Abc123').includes('password'));
    assert.ok(sensitiveKinds('password = hunter2').includes('password'));
    assert.deepEqual(sensitiveKinds('رقمي 01000000041 والطلب 1234 بكرة الساعة 10'), []);
    assert.deepEqual(sensitiveKinds(null), []);
});

test('buildCreateRequest sends message ids only and never pre-fills text from messages', () => {
    const r = buildCreateRequest({
        idempotencyKey: KEY, kind: 'follow_up', title: '  اتصال  ', nextAction: 'اتصل',
        due: { at: '2026-10-10T12:00:00', tz: 'Africa/Cairo' }, messageIds: ['m1', 'm1', 'm2'],
    });
    assert.equal(r.contract_version, CONTRACT_VERSION);
    assert.equal(r.title, 'اتصال');
    assert.equal(r.summary, null);
    assert.equal(r.sources.length, 2);
    for (const s of r.sources) {
        assert.deepEqual(Object.keys(s).sort(), ['adapter', 'adapter_version', 'internal', 'provider', 'type']);
        assert.deepEqual(Object.keys(s.internal), ['chat_message_id']);
    }
    assert.ok(!('sensitive_ack' in r));
    assert.equal(buildCreateRequest({ idempotencyKey: KEY, kind: 'issue', title: 'x', sensitiveAck: true }).sensitive_ack, true);
    assert.ok(!('created_by' in r) && !('workspace_id' in r) && !('owner_context' in r));
});

test('validateCreateRequest gives early feedback but is advisory', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const ok = buildCreateRequest({ idempotencyKey: KEY, kind: 'follow_up', title: 't', nextAction: 'n',
        due: { at: '2026-10-10T12:00:00', tz: 'Africa/Cairo' }, messageIds: [KEY] });
    assert.deepEqual(validateCreateRequest(ok, { now }), []);
    const fields = (req) => validateCreateRequest(req, { now }).map((e) => `${e.field}:${e.reason}`);
    assert.ok(fields({ ...ok, kind: 'handover' }).includes('kind:feature_not_enabled'));
    assert.ok(fields({ ...ok, title: ' ' }).includes('title:length'));
    assert.ok(fields({ ...ok, title: 'x'.repeat(161) }).includes('title:length'));
    assert.ok(fields({ ...ok, due: { at: '2026-10-10T12:00:00Z', tz: 'Africa/Cairo' } }).includes('due.at:local_time_expected'));
    assert.ok(fields({ ...ok, due: { at: '2028-10-10T12:00:00', tz: 'Africa/Cairo' } }).includes('due.at:too_far'));
    assert.ok(fields({ ...ok, due: null }).includes('follow_up:next_action_and_due_required'));
    assert.ok(fields({ ...ok, sources: [{ type: 'web_selection' }] }).includes('sources.type:feature_not_enabled'));
    assert.ok(fields({ ...ok, sources: Array(21).fill(ok.sources[0]) }).includes('sources:too_many'));
    assert.ok(fields({ ...ok, priority: 9 }).includes('priority:range'));
    assert.ok(fields({ ...ok, idempotency_key: undefined }).includes('idempotency_key:required'));
    assert.ok(fields({ contract_version: 1, idempotency_key: KEY, kind: 'issue', title: 'x' }).includes('issue.problem:required'));
});

test('describeSource only reflects the server decision for this read', () => {
    assert.deepEqual(describeSource({ excerpt: null, excerpt_hidden: 'no_conversation_access' }),
        { state: 'hidden', label: 'محتوى من محادثة لا تملك صلاحية الوصول إليها' });
    assert.equal(describeSource({ excerpt: null, excerpt_hidden: 'no_provider_rule' }).state, 'hidden');
    assert.equal(describeSource({ excerpt: null, redacted: { reason: 'retention' } }).state, 'redacted');
    assert.equal(describeSource({ excerpt: null, retention_expired: true }).state, 'retention_expired');
    assert.equal(describeSource({}).state, 'hidden');
    const v = describeSource({ excerpt: 'نص', sender_label: 'العميل', source_deleted: true });
    assert.deepEqual(v, { state: 'visible', excerpt: 'نص', senderLabel: 'العميل', deletedAtSource: true, editedAfterCapture: false });
});

test('retentionDeadline is closure + 8760 hours; active records have none', () => {
    assert.equal(retentionDeadline(null), null);
    assert.equal(retentionDeadline('bad'), null);
    assert.equal(retentionDeadline('2026-03-01T00:00:00Z').toISOString(), '2027-03-01T00:00:00.000Z');
});

test('the relay frontend never persists content in browser storage', async () => {
    const dir = new URL('../assets/js/relay/', import.meta.url);
    for (const f of await readdir(dir)) {
        const src = await readFile(new URL(f, dir), 'utf8');
        assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /localStorage|sessionStorage|indexedDB|chrome\.storage/, f);
    }
});
