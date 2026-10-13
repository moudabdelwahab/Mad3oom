// ============================================================================
// contract.js — الواجهة المشتركة لموصلات مركز التكاملات.
//
// كل موصل يعلن كل عملية من العمليات أدناه: إما دالة، أو unsupported(سبب).
// لا دالة «تنجح» لعملية لا يدعمها المزوّد: invoke() يرمي ConnectorError
// ('unsupported') ولا يستدعي شيئًا. الكتالوج في القاعدة (ihub_providers)
// يعكس نفس الحقيقة للواجهة، ويحرسه اختبار node يقارن الاثنين.
// ============================================================================

import { ConnectorError } from './errors.js';

export const OPERATIONS = Object.freeze([
    'connect', 'verifyConnection', 'refreshCredentials', 'disconnect',
    'fetchCustomer', 'fetchOrder', 'fetchInvoice', 'handleWebhook', 'syncRecords', 'getHealthStatus'
]);

const UNSUPPORTED = Symbol('unsupported');

export function unsupported(reason) {
    return Object.freeze({ [UNSUPPORTED]: true, reason: String(reason) });
}

export function isUnsupported(op) {
    return !!(op && op[UNSUPPORTED]);
}

export function defineConnector(spec) {
    for (const op of OPERATIONS) {
        const v = spec.operations?.[op];
        if (typeof v !== 'function' && !isUnsupported(v)) {
            throw new Error(`connector ${spec.key}: operation ${op} must be a function or unsupported(reason)`);
        }
    }
    return Object.freeze({ ...spec, operations: Object.freeze({ ...spec.operations }) });
}

export function supports(connector, op) {
    return typeof connector.operations[op] === 'function';
}

export async function invoke(connector, op, ...args) {
    const fn = connector.operations[op];
    if (typeof fn !== 'function') throw new ConnectorError('unsupported', `${connector.key}.${op}`);
    return fn(...args);
}

/** خريطة القدرات للعرض والاختبار: عملية ← 'supported' | سبب عدم الدعم. */
export function describe(connector) {
    const out = {};
    for (const op of OPERATIONS) {
        const v = connector.operations[op];
        out[op] = typeof v === 'function' ? 'supported' : `unsupported: ${v.reason}`;
    }
    return out;
}

/** شكل السجل الذي يُخزَّن (ihub_external_records). كل موصل يرجع هذا فقط. */
export function recordShape({ recordType, externalId, displayRef, summary, externalUrl = null, sourceUpdatedAt = null }) {
    const id = String(externalId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new ConnectorError('invalid_response', 'external_id');
    const clean = {};
    for (const [k, v] of Object.entries(summary || {})) {
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
        clean[k] = v;
    }
    const json = JSON.stringify(clean);
    if (new TextEncoder().encode(json).length > 3800) throw new ConnectorError('response_too_large', 'summary');
    return {
        record_type: recordType,
        external_id: id,
        display_ref: displayRef ? String(displayRef).slice(0, 120) : null,
        summary: clean,
        external_url: externalUrl && /^https:\/\//.test(externalUrl) ? String(externalUrl).slice(0, 500) : null,
        source_updated_at: sourceUpdatedAt || null
    };
}

/**
 * يحذف كل ما بين < و > ولا يُخرج أيًّا منهما — مرور واحد على المحارف، فمدخل مثل
 * «<scr<script>ipt>» أو وسم غير مغلق لا يترك وسمًا جزئيًا (بخلاف استبدال regex واحد).
 */
function stripTags(str) {
    let out = '';
    let inTag = false;
    for (const ch of str) {
        if (ch === '<') inTag = true;
        else if (ch === '>') inTag = false;
        else if (!inTag) out += ch;
    }
    return out;
}

/** نص قصير آمن للعرض (بلا وسوم ولا محارف تحكم). */
export function shortText(v, max = 80) {
    if (v === null || v === undefined) return null;
    const s = stripTags(String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
}

/** مبلغ نصّي كما يرجعه المزوّد ('10.00') — يُقبل الرقم فقط. */
export function amountText(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(typeof v === 'object' ? v.amount ?? '' : v).trim();
    return /^-?\d{1,12}(\.\d{1,4})?$/.test(s) ? s : null;
}

/** تاريخ ISO بتوقيت UTC، أو null. */
export function isoUtc(v, { assumeUtc = true } = {}) {
    if (!v) return null;
    let s = String(v).trim();
    if (assumeUtc && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
