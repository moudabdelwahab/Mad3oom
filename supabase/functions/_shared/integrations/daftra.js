// ============================================================================
// daftra.js — موصل دفترة (API2، قراءة فقط).
//
// ما تحقّقنا منه (docs.daftara.dev عبر البحث فقط — النطاق محجوب في هذه البيئة،
// ولا يوجد SDK رسمي على npm أو Packagist):
//   • قاعدة الـAPI: https://<subdomain>.daftra.com/api2
//   • مصادقة بمفتاح API يُولَّد من إعدادات الحساب، في ترويسة APIKEY، دون ترويسة
//     Authorization (الوثيقة تحذّر: وجودها يُفشل الطلب). OAuth2 مذكور، لكن نقطة
//     الرمز ومعاملاتها لم تُعثر عليها ⇒ غير مُنفَّذ.
//   • GET /clients/{id} يرجع العميل داخل Client وفيه business_name.
//   • الفواتير تحت /invoices؛ الكتابة بغلاف Invoice وفيه client_id و currency_code.
//
// غير مُتحقَّق (PROVIDER_DAFTRA.md): لاحقة .json في المسارات، أسماء حقول
// الفاتورة (no, date, summary_total, summary_paid, summary_unpaid, payment_status)،
// الترقيم، ووجود ويب هوك. لذلك: لا ويب هوك، لا مزامنة، لا كتابة — جلب عند الطلب
// فقط لسجل يربطه موظف بتذكرة، وكل حقل غير متوقع الشكل يُهمل.
//
// SSRF: المضيف ثابت (*.daftra.com) والمستخدم يعطي النطاق الفرعي فقط.
// ============================================================================

import { defineConnector, unsupported, recordShape, shortText, amountText } from './contract.js';
import { ConnectorError, codeForStatus } from './errors.js';
import { safeFetch } from './http.js';

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'api', 'app', 'docs', 'mail', 'admin', 'static', 'cdn']);

export function baseUrlFor(subdomain) {
    return `https://${subdomain}.daftra.com`;
}

export function normalizeConnectInput(input = {}) {
    let sub = String(input.subdomain || '').trim().toLowerCase();
    // يقبل «acme» أو «acme.daftra.com» أو «https://acme.daftra.com»
    const m = sub.match(/^(?:https:\/\/)?([a-z0-9-]+)(?:\.daftra\.com)?\/?$/);
    sub = m ? m[1] : '';
    if (!SUBDOMAIN_RE.test(sub) || RESERVED.has(sub)) throw new ConnectorError('invalid_input', 'subdomain');
    const apiKey = String(input.api_key || '').trim();
    if (!/^[A-Za-z0-9._-]{16,256}$/.test(apiKey)) throw new ConnectorError('invalid_input', 'api_key');
    const baseUrl = baseUrlFor(sub);
    return {
        baseUrl,
        externalAccountId: `${sub}.daftra.com`,
        label: shortText(input.label, 120) || `${sub}.daftra.com`,
        credentials: { api_key: apiKey }
    };
}

async function get(ctx, path) {
    const res = await safeFetch(ctx.fetch, `${ctx.baseUrl}/api2${path}`, {
        headers: { APIKEY: ctx.credentials.api_key, Accept: 'application/json' }
    });
    return res;
}

async function verifyConnection(ctx) {
    const res = await get(ctx, '/clients.json?limit=1');
    if (res.status === 200 && res.json && typeof res.json === 'object') return { ok: true };
    if (res.status === 404) throw new ConnectorError('api_not_found');
    throw new ConnectorError(codeForStatus(res.status));
}

function idOf(ref, what) {
    const s = String(ref ?? '').trim().replace(/^#/, '');
    if (!/^[0-9]{1,20}$/.test(s)) throw new ConnectorError('invalid_input', what);
    return s;
}

export function mapInvoice(json) {
    const inv = json?.data?.Invoice ?? json?.Invoice;
    if (!inv || typeof inv !== 'object' || !/^[0-9]{1,20}$/.test(String(inv.id ?? ''))) {
        throw new ConnectorError('invalid_response', 'invoice');
    }
    return recordShape({
        recordType: 'invoice',
        externalId: String(inv.id),
        displayRef: `#${shortText(inv.no, 40) || inv.id}`,
        summary: {
            number: shortText(inv.no, 40),
            date: /^\d{4}-\d{2}-\d{2}/.test(String(inv.date || '')) ? String(inv.date).slice(0, 10) : null,
            currency: /^[A-Z]{3}$/.test(String(inv.currency_code || '')) ? inv.currency_code : null,
            total: amountText(inv.summary_total),
            paid: amountText(inv.summary_paid),
            unpaid: amountText(inv.summary_unpaid),
            payment_status_code: /^[0-9]{1,3}$/.test(String(inv.payment_status ?? '')) ? String(inv.payment_status) : null,
            client_name: shortText(inv.client_business_name, 80),
            client_ref: /^[0-9]{1,20}$/.test(String(inv.client_id ?? '')) ? String(inv.client_id) : null,
            field_mapping: 'unverified'
        },
        externalUrl: null,
        sourceUpdatedAt: null
    });
}

export function mapClient(json) {
    const c = json?.data?.Client ?? json?.Client;
    if (!c || typeof c !== 'object' || !/^[0-9]{1,20}$/.test(String(c.id ?? ''))) {
        throw new ConnectorError('invalid_response', 'client');
    }
    return recordShape({
        recordType: 'customer',
        externalId: String(c.id),
        displayRef: shortText(c.business_name, 60) || `#${c.id}`,
        summary: {
            business_name: shortText(c.business_name, 80),
            client_number: shortText(c.client_number, 40),
            field_mapping: 'unverified'
        },
        externalUrl: null,
        sourceUpdatedAt: null
    });
}

async function fetchInvoice(ctx, reference) {
    const res = await get(ctx, `/invoices/${idOf(reference, 'invoice_id')}.json`);
    if (res.status === 200) return mapInvoice(res.json);
    throw new ConnectorError(codeForStatus(res.status));
}

async function fetchCustomer(ctx, reference) {
    const res = await get(ctx, `/clients/${idOf(reference, 'client_id')}.json`);
    if (res.status === 200) return mapClient(res.json);
    throw new ConnectorError(codeForStatus(res.status));
}

export const daftra = defineConnector({
    key: 'daftra',
    authKind: 'api_key',
    linkTypes: ['invoice', 'customer'],
    normalizeConnectInput,
    operations: {
        connect: async (ctx) => verifyConnection(ctx),
        verifyConnection,
        refreshCredentials: unsupported('Daftra API keys do not expire through an API we could verify'),
        disconnect: unsupported('no verified revocation endpoint; the account owner deletes the key in Daftra settings'),
        fetchCustomer,
        fetchOrder: unsupported('Daftra is an accounting system; orders are out of scope'),
        fetchInvoice,
        handleWebhook: unsupported('no Daftra webhook mechanism was found in the official documentation'),
        fetchProduct: unsupported('Daftra is an accounting system; products are out of scope'),
        search: unsupported('records are linked by id; no verified search endpoint'),
        syncRecords: unsupported('no verified incremental-sync filter; records are fetched on demand only'),
        getHealthStatus: verifyConnection
    }
});
