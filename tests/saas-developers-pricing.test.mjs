/**
 * اختبارات مجموعة «المطوّرون والأسعار» (الترحيل 141).
 *
 * دوال خالصة فقط — بلا DOM وبلا شبكة — فيُختبر المنطق بمعزل:
 *   • developers-model: نقاط النهاية وأدوات MCP والحدود وWebhooks.
 *   • api-token-model: بيئة المفتاح (ساندبوكس API).
 *   • plan-pricing-model: واتساب مشمول في الفائقة حتى إشعار آخر.
 *   • فحوص ساكنة على HTML: سطر واتساب في بطاقة الفائقة وجدول المقارنة،
 *     وحقل بيئة المفتاح وتنبيه الساندبوكس في نافذة إنشاء المفتاح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    API_ENDPOINTS, MCP_TOOLS, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_SECONDS,
    WEBHOOK_EVENTS, WEBHOOK_EVENT_KEYS, validateWebhookForm, toWebhookCreatePayload,
    deliveryStatus, webhookHealth, minuteUsage, remainingQuota, isFunctionMissingError
} from '../assets/js/company/developers-model.js';
import {
    TOKEN_ENVIRONMENTS, DEFAULT_ENVIRONMENT, validateTokenForm, toCreatePayload,
    environmentLabel, isTestEnvironment
} from '../assets/js/company/api-token-model.js';
import { SALE_PLAN_KEYS, planFeatureRows } from '../assets/js/plan-pricing-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ── نقاط النهاية ─────────────────────────────────────────────────────── */

test('نقاط النهاية: MCP أولًا ثم OAuth — ولا ihub-api بمفتاح', () => {
    const mcp = API_ENDPOINTS.find(e => e.key === 'mcp');
    assert.equal(mcp.method, 'POST');
    assert.equal(mcp.url, 'https://mad3oom.com/mcp');
    assert.equal(mcp.auth, 'مفتاح API');
    assert.ok(API_ENDPOINTS.some(e => e.key === 'oauth-token' && e.url === 'https://mad3oom.com/oauth/token'));
    assert.ok(!API_ENDPOINTS.some(e => /ihub/i.test(e.key + e.url)),
        'ihub-api تُنادى بجلسة من اللوحة لا بمفتاح، فلا تظهر هنا');
});

test('أدوات MCP الـ18 بصلاحياتها — مطابقة لـ api-docs.html', () => {
    assert.equal(MCP_TOOLS.length, 18);
    const byKey = new Map(MCP_TOOLS.map(t => [t.key, t.scope]));
    assert.equal(byKey.get('list_tickets'), 'tickets:read');
    assert.equal(byKey.get('create_ticket'), 'tickets:write');
    assert.equal(byKey.get('send_whatsapp'), 'whatsapp:send');
    assert.equal(byKey.get('list_subscription_plans'), 'subscriptions:plans');
    assert.equal(byKey.get('renew_subscription'), 'subscriptions:renew');
    assert.equal(byKey.get('cancel_subscription'), 'subscriptions:cancel');
    assert.equal(byKey.get('manage_notification'), 'notifications:manage');
    assert.equal(new Set(MCP_TOOLS.map(t => t.key)).size, 18, 'بلا تكرار');
    // التوثيق الكامل يقول 18 أداة — أي زيادة/نقصان هنا انحراف عنه
    const docs = fs.readFileSync(path.join(ROOT, 'api-docs.html'), 'utf8');
    assert.match(docs, /18 أداة/);
    for (const tool of MCP_TOOLS) assert.ok(docs.includes(tool.key), `الأداة ${tool.key} غائبة من api-docs.html`);
});

/* ── حدود الاستخدام ───────────────────────────────────────────────────── */

test('حدّ المعدّل 60 نداءً/دقيقة لكل مفتاح — كما في api-auth.ts', () => {
    assert.equal(RATE_LIMIT_PER_MINUTE, 60);
    assert.equal(RATE_LIMIT_WINDOW_SECONDS, 60);
    for (const file of [
        'supabase/functions/mcp/_shared/api-auth.ts',
        'supabase/functions/send-whatsapp/_shared/api-auth.ts'
    ]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(src, /RATE_LIMIT_MAX_PER_MINUTE = 60/, `${file} غيّر الحدّ`);
    }
});

test('عدّاد الدقيقة الأخيرة والمتبقي', () => {
    const now = new Date('2026-11-25T12:00:30Z').getTime();
    const rows = [
        { token_id: 't1', created_at: '2026-11-25T12:00:10Z' },
        { token_id: 't1', created_at: '2026-11-25T11:59:20Z' },
        { token_id: 't1', created_at: '2026-11-25T11:59:31Z' },
        { token_id: 't2', created_at: '2026-11-25T12:00:05Z' },
        { token_id: 't1', created_at: 'not-a-date' }
    ];
    assert.equal(minuteUsage(rows, 't1', now), 2);
    assert.equal(minuteUsage(rows, 't2', now), 1);
    assert.equal(minuteUsage(rows, 't3', now), 0);
    assert.equal(minuteUsage(null, 't1', now), 0);
    assert.equal(remainingQuota(2), 58);
    assert.equal(remainingQuota(60), 0);
    assert.equal(remainingQuota(99), 0);
});

/* ── Webhooks: الأحداث والتحقق ────────────────────────────────────────── */

test('أحداث Webhooks الستة — مطابقة لقيد الترحيل 141 حرفيًا', () => {
    assert.deepEqual(WEBHOOK_EVENT_KEYS, [
        'ticket.created', 'ticket.replied', 'ticket.closed',
        'customer.created', 'subscription.renewed', 'subscription.upgraded'
    ]);
    const migration = fs.readFileSync(path.join(ROOT, 'migrations/141_saas_developers_pricing.sql'), 'utf8');
    for (const key of WEBHOOK_EVENT_KEYS) assert.ok(migration.includes(`'${key}'`), `الحدث ${key} غائب من الترحيل`);
    assert.equal(WEBHOOK_EVENTS.length, 6);
});

test('تحقّق نموذج Webhook: https إلزامي وحدث واحد على الأقل', () => {
    const good = { name: 'نظام المبيعات', url: 'https://example.com/hook', events: ['ticket.created'] };
    assert.equal(validateWebhookForm(good).isValid, true);
    assert.equal(validateWebhookForm({ ...good, url: 'http://example.com/hook' }).errors.url,
        'رابط الـWebhook يجب أن يبدأ بـ https://');
    assert.equal(validateWebhookForm({ ...good, url: '' }).errors.url, 'الرابط مطلوب');
    assert.equal(validateWebhookForm({ ...good, events: [] }).errors.events, 'اختر حدثًا واحدًا على الأقل');
    assert.equal(validateWebhookForm({ ...good, events: ['ticket.deleted'] }).errors.events, 'حدث غير معروف');
    assert.equal(validateWebhookForm({ ...good, name: 'x'.repeat(81) }).errors.name,
        'الاسم طويل جدًا (الحد الأقصى 80 حرفًا)');
    assert.deepEqual(toWebhookCreatePayload(good),
        { name: 'نظام المبيعات', url: 'https://example.com/hook', events: ['ticket.created'] });
});

test('حالات التسليم وصحة الـWebhook', () => {
    assert.equal(deliveryStatus({ status: 'sent' }).label, 'تم التسليم');
    assert.equal(deliveryStatus({ status: 'failed' }).tone, 'danger');
    assert.equal(deliveryStatus({ status: 'pending' }).label, 'معلّق');
    assert.equal(deliveryStatus(null).label, 'معلّق');
    assert.equal(webhookHealth({ is_active: true, deliveries_count: 0 }).label, 'بلا تسليم بعد');
    assert.equal(webhookHealth({ is_active: false, deliveries_count: 5 }).label, 'موقوف');
    assert.equal(webhookHealth({ is_active: true, deliveries_count: 3, last_delivery_status: 'sent' }).label, 'يُسلَّم');
    assert.equal(webhookHealth({ is_active: true, deliveries_count: 3, last_delivery_status: 'failed' }).tone, 'danger');
});

test('تمييز خطأ «الدالة غير موجودة» — الترحيل 141 لم يُطبَّق بعد', () => {
    assert.equal(isFunctionMissingError({ code: 'PGRST202' }), true);
    assert.equal(isFunctionMissingError({ message: 'Could not find the function public.company_webhook_list' }), true);
    assert.equal(isFunctionMissingError({ code: '42501', message: 'permission denied' }), false);
    assert.equal(isFunctionMissingError(null), false);
});

/* ── ساندبوكس API: بيئة المفتاح ───────────────────────────────────────── */

test('بيئتا المفتاح: الحي افتراضي، والاختبار ساندبوكس API فقط', () => {
    assert.equal(DEFAULT_ENVIRONMENT, 'live');
    assert.deepEqual(TOKEN_ENVIRONMENTS.map(e => e.key), ['live', 'test']);
    const sandbox = TOKEN_ENVIRONMENTS.find(e => e.key === 'test');
    assert.match(sandbox.label, /ساندبوكس/);
    assert.match(sandbox.hint, /للاختبار فقط/);
    assert.match(sandbox.hint, /ليس بيئة تجريبية للتجربة المجانية/);
    assert.equal(environmentLabel('test'), 'اختبار');
    assert.equal(environmentLabel('live'), 'حي');
    assert.equal(environmentLabel(undefined), 'حي');
    assert.equal(isTestEnvironment('test'), true);
    assert.equal(isTestEnvironment('live'), false);
});

test('تحقّق النموذج يقبل البيئتين ويرفض غيرهما، والحمولة تمرّرها', () => {
    const base = {
        name: 'تكامل', credentialType: 'api_key_secret', scopes: ['tickets:read'],
        expiryPreset: '90'
    };
    assert.equal(validateTokenForm({ ...base, environment: 'test' }).isValid, true);
    assert.equal(validateTokenForm({ ...base, environment: 'staging' }).errors.environment, 'بيئة المفتاح غير صالحة');
    assert.equal(toCreatePayload({ ...base }).environment, 'live');
    assert.equal(toCreatePayload({ ...base, environment: 'test' }).environment, 'test');
    // باقي الحمولة لم يتغير
    const payload = toCreatePayload({ ...base, environment: 'test' }, { now: Date.parse('2026-11-25T00:00:00Z') });
    assert.equal(payload.credential_type, 'api_key_secret');
    assert.deepEqual(payload.scopes, ['tickets:read']);
});

/* ── الأسعار: واتساب في الفائقة ────────────────────────────────────────── */

test('الفائقة تشمل واتساب حتى إشعار آخر، والبيع لم يتغير', () => {
    assert.deepEqual(SALE_PLAN_KEYS, ['support', 'ultimate']);
    const ultimate = planFeatureRows('ultimate');
    const wa = ultimate.find(r => r.label === 'واتساب بيزنس');
    assert.ok(wa && wa.included, 'واتساب غير مشمول في الفائقة');
    assert.match(wa.value || '', /حتى إشعار آخر/);
    assert.ok(planFeatureRows('bundle').some(r => r.label === 'واتساب بيزنس' && r.included));
    assert.ok(!planFeatureRows('support').some(r => r.label === 'واتساب بيزنس' && r.included));
    assert.ok(!planFeatureRows('free').some(r => r.label === 'واتساب بيزنس'));
});

/* ── فحوص ساكنة على HTML ──────────────────────────────────────────────── */

test('صفحة الأسعار: واتساب في بطاقة الفائقة وجدول المقارنة', () => {
    const html = fs.readFileSync(path.join(ROOT, 'subscriptions.html'), 'utf8');
    const ultimateCard = html.slice(html.indexOf('data-plan="ultimate"'), html.indexOf('data-plan="store"'));
    assert.match(ultimateCard, /واتساب بيزنس مشمول — حتى إشعار آخر/);
    assert.match(ultimateCard, /data-monthly="1999" data-yearly="19999"/, 'سعر الفائقة لم يتغير');
    assert.match(html, /<td>واتساب بيزنس<\/td><td><span class="cross">✗<\/span><\/td><td><span class="cross">✗<\/span><\/td><td><span class="check">✓ مشمول — حتى إشعار آخر<\/span><\/td>/);
});

test('نافذة إنشاء المفتاح: حقل بيئة وتنبيه ساندبوكس صريح', () => {
    const html = fs.readFileSync(path.join(ROOT, 'company-dashboard/index.html'), 'utf8');
    assert.ok(html.includes('id="apiTokenEnvironments"'), 'حاوية خيارات البيئة غائبة');
    assert.ok(html.includes('id="apiTokenSandboxNote"'), 'تنبيه الساندبوكس غائب');
    const note = html.slice(html.indexOf('apiTokenSandboxNote'), html.indexOf('apiTokenSandboxNote') + 600)
        .replace(/\s+/g, ' ');
    assert.match(note, /ساندبوكس API/);
    assert.match(note, /ليس بيئة تجريبية للتجربة المجانية/);
});
