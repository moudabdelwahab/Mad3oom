/**
 * صفحات لوحة المالك المستقلة (/owner/*.html) — تشغيل حقيقي في Chromium مقابل البديل الاختباري.
 *
 * يثبت:
 *   ① القائمة: عناصر «الإدارة» و«التشغيل» تقود إلى /owner/ لا /admin/، والعنصر النشط من اسم الملف
 *   ② البوابة: غير المالك، أو المالك خارج سياقه، يرى السبب ولا تُنادى أي دالة بيانات
 *   ③ كل صفحة تُرسم بلا أخطاء وبلا تمرير أفقي على الجوال
 *   ④ العمليات تنادي القاعدة بالمعاملات الصحيحة، ورفض القاعدة (صفر صفوف أو 42501) يظهر خطأً لا «تم»
 *   ⑤ ما يكتبه غير المالك (ردود، حمولة السجل) يُعرض نصًا لا HTML
 * والقرار نفسه في القاعدة — مقيس في tests/sql/owner-pages-authority.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    subscriptionActions, subscriptionChangeError, searchTerm, pageRange, pagerText, SUBSCRIPTION_TRANSITIONS,
    storePriceError, storeReasonError, testDaysRemaining, BILLING_CYCLE_LABELS, storeEndDateError, csvCell, toCsv
} from '../assets/js/owner/owner-labels.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function resolveChromium() {
    try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* none */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const c = path.join(root, dir, rel);
                if (fs.existsSync(c)) return c;
            }
        }
    }
    return null;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SUPPORT = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const XSS = '<img src=x onerror="window.__XSS__=1">';

function fixtures({ context = 'owner', owner = true } = {}) {
    const future = new Date(Date.now() + 20 * 864e5).toISOString();
    return {
        returnUpdatedRows: true,
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: owner, active_context: context, preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner', granted: true, destination: '/owner-dashboard.html' }],
            owner_security_status: { mfa_enrolled: true, step_up_fresh: false, step_up_expires_at: null, in_owner_context: true },
            admin_list_subscriptions: [
                { id: 's-active', user_id: CUSTOMER, customer_name: 'عميل أ', customer_email: 'a@x.test', company_name: 'شركة أ', plan: 'support',
                  plan_name_ar: 'الدعم', status: 'active', billing_cycle: 'monthly', end_date: future, is_active: true, days_remaining: 5 },
                { id: 's-pending', user_id: ADMIN, customer_name: 'عميل ب', customer_email: 'b@x.test', plan: 'whatsapp',
                  plan_name_ar: 'واتساب', status: 'pending', billing_cycle: 'monthly', end_date: null, is_active: false, days_remaining: 0 },
                { id: 's-expired', user_id: SUPPORT, customer_name: 'عميل ج', plan: 'support', plan_name_ar: 'الدعم', status: 'expired',
                  billing_cycle: 'yearly', end_date: '2026-01-01T00:00:00Z', is_active: false, days_remaining: 0 }
            ],
            admin_subscription_audit: [{ action: 'deactivate', actor_email: 'admin@example.com', old_values: { status: 'active' },
                                         new_values: { status: 'expired' }, reason: XSS, created_at: '2026-10-01T00:00:00Z' }],
            admin_set_subscription_status: { subscription_id: 's-active' },
            admin_customer_filter_options: { companies: [{ id: 'c1', name: 'شركة أ' }, { id: 'c2', name: 'شركة ب' }] },
            get_public_registration_settings: { mode: 'waitlist', expected_launch_date: '2026-12-01' },
            owner_feature_switches: [{ key: 'company_isolation_enforced', enabled: false }, { key: 'company_documents_enabled', enabled: true }],
            // 118/119: المتاجر وShopify — بيانات وصفية فقط (لا رموز ولا بيانات عملاء)
            owner_accounts_overview: { total: 2, counts: { individual: 1, company: 1, ecommerce_store: 1 }, items: [
                { user_id: CUSTOMER, name: XSS, email: 'shop@x.test', created_at: '2026-10-01T00:00:00Z', account_type: 'ecommerce_store',
                  company_id: 'c9', company_name: 'متجر الورد', company_status: 'active',
                  subscription: { plan: 'store', plan_name: 'باقة المتاجر', status: 'active', effective: true },
                  shopify: { status: 'active', shop: 'ward.myshopify.com', last_sync_status: 'succeeded', last_error_code: null } },
                { user_id: OWNER, name: 'مالك المنصة', email: 'owner@example.com', created_at: '2026-01-01T00:00:00Z', account_type: 'company',
                  company_id: 'cw', company_name: 'شركة المالك', company_status: 'active', subscription: null, shopify: null }] },
            // الصفحات الجديدة في القائمة (طلبات الحسابات، دليل العملاء، شجرة الحسابات):
            // بلا هذه الردود يرجع الـdouble ‏data: null‏ فتعرض الصفحات حالة فارغة بلا جدول.
            account_requests_overview: { is_owner: true, execution: {}, owner_step_up: true },
            owner_account_requests: { rows: [
                { id: 'rq1', request_type: 'add_to_company', customer_id: CUSTOMER, customer_name: 'عميل أ', customer_email: 'a@x.test',
                  company_name: 'شركة أ', requester_name: 'عميل أ', requested_at: '2026-10-25T00:00:00Z', status: 'pending' }],
                total: 1, requesters: [{ id: CUSTOMER, name: 'عميل أ' }], pending_count: 1 },
            admin_customer_directory: { total: 1, rows: [
                { id: CUSTOMER, full_name: 'عميل أ', email: 'a@x.test', phone: '01000000000', manager: null, account_type: 'company',
                  company: { name: 'شركة أ' }, companies_count: 1, status: 'active', created_at: '2026-04-01T00:00:00Z' }] },
            owner_account_tree: { counts: { units: 1, companies: 1, direct_customers: 1, open_tickets: 0 },
                units: [{ id: 'u1', name: 'وحدة الاختبار' }] },
            owner_store_integrations: { provider: { enabled: false, release_stage: 'beta' }, required_scopes: ['read_customers', 'read_orders', 'read_products'],
                compliance_unmatched_30d: 0, connections: [
                { connection_id: 'cn1', company_id: 'c9', company_name: 'متجر الورد', status: 'error', shop: 'ward.myshopify.com', shop_name: 'الورد',
                  granted_scopes: ['read_orders'], missing_scopes: ['read_customers', 'read_products'], has_credentials: true,
                  last_error_code: 'forbidden_scope', last_error_at: '2026-10-27T00:00:00Z', last_sync_at: '2026-10-27T00:00:00Z',
                  last_sync_status: 'failed', events_7d: { processed: 4, dead: 1 }, sync_failures_7d: 2, compliance_pending: 1, entitled: true }] },
            owner_entitlement_diagnostics: { store_plan: { key: 'store', is_active: false, price_monthly: null, price_yearly: null, currency: 'EGP',
                features: ['integrations_hub', 'shopify_integration'], ticket_quota_defined: false },
                live_connection_without_entitlement: [], stores_without_subscription: 0, store_plan_on_non_store: 0, pending_store_requests: 2 },
            owner_store_events: { jobs: [], events: [], audit: [] },
            // 133: سعر باقة المتاجر وإجراءات المزامنة وحالة متجر الاختبار
            owner_set_store_plan_price: { key: 'store', is_active: true, price_monthly: 500, price_yearly: 5000, currency: 'EGP', activated: true },
            owner_ihub_sync_request: { job_id: 7, existing: false },
            owner_ihub_events_retry: { requeued: 1 },
            owner_set_company_account_kind: { changed: true, account_kind: 'ecommerce_store' },
            owner_store_test_entitlements: { company_id: 'cw', enabled: true, expires_at: future },
            owner_store_test_status: { company_id: 'cw', company_name: 'شركة المالك', account_kind: 'company', has_company: true, is_test_store: false,
                entitlements: [
                    { feature_key: 'integrations_hub', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null },
                    { feature_key: 'shopify_integration', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null },
                    { feature_key: 'store_support', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null }] },
            // 133: إدارة اشتراك المتجر كاستثناء + التنبيهات والطلبات وسجل العمليات
            owner_store_alerts: { count: 2, critical: 1, alerts: [
                { kind: 'dead_events', severity: 'critical', message: '3 أحداث ميتة في متجر الورد', count: 3, target: '#conn-cn1', connection_id: 'cn1' },
                { kind: 'no_entitlement', severity: 'warning', message: 'ربط حي بلا امتياز في متجر الورد', count: 1, target: '#storeDiagnostics', connection_id: 'cn1' }] },
            owner_store_requests: [
                { id: 'rq1', customer_name: 'طالب الطلب', customer_email: 'rq@x.test', company_name: 'متجر الطلب',
                  requested_plan: 'store', requested_billing_cycle: 'monthly', created_at: '2026-10-25T00:00:00Z' }],
            owner_store_request_decide: { id: 'rq1', status: 'approved', decision: 'approve', company_id: 'c10' },
            owner_store_subscription: { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'active',
                start_date: '2026-10-01T00:00:00Z', end_date: future, duration_days: 30, payment_method: 'owner_exception',
                price_snapshot: { amount: 0, exception: true, cycle_price: 500 }, effective: true },
            owner_store_grant_exception: { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'active',
                start_date: '2026-10-26T00:00:00Z', end_date: future, duration_days: 30, payment_method: 'owner_exception', effective: true },
            // 137: طلبات التجربة المجانية 3 أيام — معلّقة أولًا
            owner_list_saas_trial_requests: [
                { id: 'tr1', company_id: 'c9', company_name: 'متجر الورد', account_kind: 'ecommerce_store', plan_key: 'store',
                  plan_name_ar: 'باقة المتاجر الإلكترونية', status: 'pending', requested_by: CUSTOMER, requested_by_email: 'rq@x.test',
                  requested_at: '2026-10-25T00:00:00Z', decided_at: null, decided_by: null, decision_reason: null,
                  trial_starts_at: null, trial_ends_at: null, subscription_id: null, is_trial_active: false, days_remaining: 0 },
                { id: 'tr2', company_id: 'c1', company_name: 'شركة أ', account_kind: 'company', plan_key: 'ultimate',
                  plan_name_ar: 'الخطة الفائقة', status: 'approved', requested_by: CUSTOMER, requested_by_email: 'a@x.test',
                  requested_at: '2026-10-24T00:00:00Z', decided_at: '2026-10-24T01:00:00Z', decided_by: OWNER, decision_reason: null,
                  trial_starts_at: '2026-10-24T01:00:00Z', trial_ends_at: future, subscription_id: 'sub-trial', is_trial_active: true, days_remaining: 3 }],
            owner_store_set_end_date: { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'active', end_date: future, effective: true },
            owner_store_pause: { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'paused', effective: false },
            owner_store_resume: { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'active', effective: true },
            owner_store_change_cycle: { id: 'sub1', plan: 'store', billing_cycle: 'yearly', status: 'active', effective: true },
            // 135: إعداد الباقة يعيد التفعيل والسعرين أيضًا (لنموذج السعر)
            owner_store_plan_config: { plan: 'store', quota_defined: false, ticket_quota: null,
                is_active: false, price_monthly: null, price_yearly: null, currency: 'EGP', features: [
                { feature_key: 'integrations_hub', enabled: true, limits: null },
                { feature_key: 'shopify_integration', enabled: true, limits: null },
                { feature_key: 'store_support', enabled: false, limits: null },
                { feature_key: 'support_tickets', enabled: false, limits: null },
                { feature_key: 'sub_users', enabled: false, limits: null }] },
            owner_set_store_plan_quota_features: { plan: 'store', quota_defined: true, ticket_quota: 100, features: [] },
            owner_store_operations_log: [
                { action: 'store.plan_price', actor_email: 'owner@example.com', summary: 'حُدّد سعر باقة المتاجر: 500 شهري / 5000 سنوي.', created_at: '2026-10-27T00:00:00Z' },
                { action: 'store.grant_exception', actor_email: 'owner@example.com', summary: 'مُنحت باقة المتاجر لمتجر الورد كاستثناء.', created_at: '2026-10-26T00:00:00Z' }],
            owner_set_shopify_provider_enabled: { provider: 'shopify', enabled: true },
            owner_set_passcode: { ok: true },
            owner_set_passcode_active: { ok: true },
            // 121: مركز الأمان والصلاحيات
            owner_security_overview: { days: 7, logins: 12, failed_logins: 2, unique_ips: 5, shared_ips: 1, denied: 0, warnings: 1,
                pending_account_changes: 0, active_sessions: 9, owner_sessions: 2,
                recent_alerts: [{ id: 1, at: '2026-10-27T00:00:00Z', event_type: 'auth.failed_burst', severity: 'critical', target_email: XSS, details: { failures: 5 } }] },
            owner_account_change_list: [],
            owner_permission_matrix: { ok: true, permissions: [
                { key: 'settings.manage', category: 'platform', label: 'تعديل إعدادات التشغيل', description: XSS, enforced_on: 'RLS: advanced_settings',
                  owner_step_up: true, admin: true, support: true },
                { key: 'tickets.reply', category: 'support', label: 'الرد على التذاكر', description: 'رد', enforced_on: 'RLS: ticket_replies',
                  owner_step_up: false, admin: true, support: false }] },
            // الوكلاء (owner/agents.html): platformAuthority يسأل القاعدة — المالك في سياقه إداري (is_admin منذ 040)
            is_admin: true,
            is_platform_staff: true,
            has_elevated_authority: false,
            is_platform_owner: true,
            active_context: 'owner',
            can_manage_central_wallet: false
        },
        functions: {
            // agent-manager: قائمة الوكلاء — Muse بلا endpoint (كما هو حيًا) + Hermes باتصال مباشر
            'agent-manager': { byOp: { list: { data: { agents: [
                { id: 'ag-muse', name: 'Muse', slug: 'muse', type: 'muse', version: '1.0.0', status: 'stopped', enabled: true,
                  description: 'الوكيل الداخلي', endpoint: null, health_endpoint: null, last_heartbeat: null, last_error: null },
                { id: 'ag-hermes', name: 'Hermes', slug: 'hermes', type: 'hermes', version: '1.0.0', status: 'running', enabled: true,
                  description: 'وكيل Hermes', endpoint: 'https://hermes.internal:8080', health_endpoint: 'https://hermes.internal:8080/health',
                  last_heartbeat: '2026-11-27T00:00:00Z', last_error: null }
            ] } } } }
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none', created_at: '2026-01-01T00:00:00Z' },
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin', ban_status: 'none', created_at: '2026-02-01T00:00:00Z' },
                { id: SUPPORT, email: 'support@example.com', full_name: 'دعم', role: 'support', ban_status: 'none', is_locked: true, created_at: '2026-03-01T00:00:00Z' },
                { id: CUSTOMER, email: 'customer@example.com', full_name: 'عميل أ', role: 'user', ban_status: 'none', phone: '01000000000', created_at: '2026-04-01T00:00:00Z' }
            ],
            tickets: [
                { id: 't1', ticket_number: 101, title: 'مشكلة في الدفع', status: 'open', priority: 'high', scope: 'mad3oom_support', user_id: CUSTOMER,
                  assigned_to: null, created_at: '2026-10-20T10:00:00Z', description: 'وصف', sla_resolution_due_at: '2026-10-21T10:00:00Z' },
                { id: 't2', ticket_number: 102, title: 'استفسار شركة', status: 'in-progress', priority: 'medium', scope: 'company', company_id: 'c1',
                  user_id: CUSTOMER, assigned_to: SUPPORT, created_at: '2026-10-21T10:00:00Z', description: 'وصف 2' }
            ],
            ticket_replies: [
                { id: 'r1', ticket_id: 't1', user_id: CUSTOMER, message: XSS, created_at: '2026-10-20T11:00:00Z', is_internal: false },
                { id: 'r2', ticket_id: 't1', user_id: SUPPORT, message: 'ملاحظة للفريق', created_at: '2026-10-20T12:00:00Z', is_internal: true }
            ],
            activity_logs: [
                { id: 'a1', user_id: CUSTOMER, user_role: 'user', action: 'login', details: { note: XSS }, created_at: '2026-10-22T10:00:00Z', device_info: 'Chrome' },
                { id: 'a2', user_id: ADMIN, user_role: 'admin', action: 'ban_user', details: {}, created_at: '2026-10-22T09:00:00Z' }
            ],
            agent_activity_log: [
                { id: 'lg1', action: 'ticket.reply', details: { ticket_id: 't1' }, session_id: 's1', model_id: 'muse', created_at: '2026-10-26T10:00:00Z' }
            ],
            whatsapp_subscriptions: [{ id: 's-active', user_id: CUSTOMER, plan: 'support', status: 'active', billing_cycle: 'monthly', end_date: future }],
            api_tokens: [
                { id: 'k1', user_id: CUSTOMER, name: 'مفتاح الموقع', is_active: true, revoked_at: null, usage_count: 12, credential_type: 'api_key',
                  secret_last_four: 'abcd', created_at: '2026-09-01T00:00:00Z', last_used_at: '2026-10-25T00:00:00Z' },
                { id: 'k2', user_id: ADMIN, name: 'مفتاح موقوف', is_active: false, revoked_at: '2026-10-01T00:00:00Z', usage_count: 0, created_at: '2026-09-01T00:00:00Z' }
            ],
            external_integrations: [
                { id: 'i1', owner_scope: 'platform', provider: 'openai', display_name: 'OpenAI', protocol: 'openai', is_active: true,
                  last_tested_at: '2026-10-20T00:00:00Z', last_test_status: 'failed', priority: 1 }
            ],
            api_token_usage_logs: [{ id: 'u1', token_id: 'k1', user_id: CUSTOMER, endpoint: '/mcp', method: 'POST', status_code: 200, created_at: '2026-10-25T00:00:00Z' }],
            access_passcodes: [{ id: 'p1', label: 'فريق الدعم', is_active: true, created_at: '2026-09-01T00:00:00Z', passcode_redemptions: [{ user_id: CUSTOMER }] }],
            blog_posts: [{ id: 'b1', slug: 'hello', title: 'مقال أول', status: 'published', tags: [], view_count: 3, author_name: 'مدعوم',
                           published_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z' }],
            blog_categories: [],
            notifications: [],
            owner_context_audit: []
        }
    };
}

async function openPage(browser, baseUrl, file, fx, { width = 1440, confirm = true, query = '' } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); confirm ? d.accept() : d.dismiss(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/owner/${file}.html${query}`, { waitUntil: 'networkidle' });
    return { page, context, errors, dialogs };
}
const rpcCalls = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const writes = (page, table) => page.evaluate(t => (window.__WRITES__ || []).filter(w => w.table === t), table);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/*
 * كل صفحة /owner/ لها عنصر في القائمة — والمفاتيح هنا بترتيب القائمة نفسه
 * (الاختبار أدناه يطابقه حرفيًا). صفحتان في /owner/ ليستا قسمين عمدًا فلا
 * تدخلان هنا ولا في القائمة: `subscription-details` تفاصيل اشتراك واحد
 * (يُفتح بـ ?id= من الاشتراكات، وdata-owner-page فيها `subscriptions`)، و
 * `security-approval` صفحة تدفق من رابط بريد (قبول/رفض تغيير) بلا
 * data-owner-page. أي صفحة جديدة بلا مقابل في القائمة تُسقِط الاختبار.
 */
const PAGES = {
    stats: '#statsKpis .kpi',
    status: '#statusKpis .kpi',
    'muse-chat': '#museChatForm',
    'voice-studio': '#vsSectionVoice',
    'muse-activity-log': '#museLogTable table',
    agents: '#agentsGrid .agent-card',
    'agent-chat': '#agentPicker',
    'muse-activations': '#museAccountsTable table',
    permissions: '#permMatrix table',
    security: '#secKpis .kpi',
    'account-requests': '#reqTable table',
    tickets: '#ticketsTable table',
    subscriptions: '#subsTable table',
    trials: '#trialRequests table',
    accounts: '#acctTree .acct-tree',
    customers: '#cmTable table',
    blog: '#blogRows tr',
    activity: '#activityTable table',
    integrations: '#tokensTable table',
    stores: '#storeIntegrations table',
    passcodes: '#passcodesTable table',
    settings: '#regForm'
};

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── الأجزاء الخالصة ─────────────────────────────────────────────────────── */

test('انتقالات الاشتراك نسخة من شرط admin_set_subscription_status()', () => {
    assert.deepEqual(subscriptionActions('active').map(a => a.to), ['expired']);
    assert.deepEqual(subscriptionActions('expired').map(a => a.to), ['active']);
    assert.deepEqual(subscriptionActions('pending').map(a => a.to), ['active', 'rejected']);
    assert.deepEqual(subscriptionActions('rejected'), []);
    assert.deepEqual(subscriptionActions('superseded'), []);
    assert.deepEqual(Object.keys(SUBSCRIPTION_TRANSITIONS).sort(), ['active', 'expired', 'pending']);
    const now = new Date('2026-10-27T00:00:00Z');
    assert.match(subscriptionChangeError({ to: 'expired', reason: 'قص' }, now), /سببًا/);
    assert.equal(subscriptionChangeError({ to: 'expired', reason: 'انتهى الدفع' }, now), null);
    assert.match(subscriptionChangeError({ to: 'active', reason: 'تم الدفع', endDate: '2026-10-01' }, now), /المستقبل/);
    assert.equal(subscriptionChangeError({ to: 'active', reason: 'تم الدفع', endDate: '2026-11-30' }, now), null);
});

test('البحث لا يكسر مرشّح PostgREST، والترقيم شامل الحدّين', () => {
    assert.equal(searchTerm('a,b(c)*%d'), 'a b c d');
    assert.equal(searchTerm('name:"x" or'), 'name x or');
    assert.equal(searchTerm('a.b@x.com'), 'a.b@x.com');
    assert.equal(searchTerm('x'.repeat(300)).length, 100);
    assert.deepEqual(pageRange(0, 25), [0, 24]);
    assert.deepEqual(pageRange(2, 25), [50, 74]);
    assert.match(pagerText(1, 25, 60), /٢٦–٥٠ من ٦٠|26–50 من 60/);
});

test('سعر باقة المتاجر والسبب والأيام المتبقية نسخة من شرط القاعدة (133)', () => {
    assert.equal(storePriceError({ monthly: 500, yearly: 5000 }), null);
    assert.equal(storePriceError({ monthly: '500', yearly: '5000' }), null);
    assert.match(storePriceError({ monthly: 0, yearly: 5000 }), /الشهري/);
    assert.match(storePriceError({ monthly: -5, yearly: 5000 }), /الشهري/);
    assert.match(storePriceError({ monthly: 500, yearly: '' }), /السنوي/);
    assert.match(storePriceError({ monthly: 'abc', yearly: 5000 }), /الشهري/);
    assert.match(storeReasonError('قصير'), /10 أحرف/);
    assert.match(storeReasonError('   '), /10 أحرف/);
    assert.equal(storeReasonError('اختبار تجربة المتجر'), null);
    assert.equal(testDaysRemaining(null), null);
    assert.equal(testDaysRemaining('2026-01-01T00:00:00Z', new Date('2026-01-10T00:00:00Z')), 0);
    assert.equal(testDaysRemaining('2026-01-10T12:00:00Z', new Date('2026-01-10T00:00:00Z')), 1);
    assert.equal(testDaysRemaining('2026-01-16T00:00:00Z', new Date('2026-01-10T00:00:00Z')), 6);
});

test('تاريخ انتهاء اشتراك المتجر وتسميات الدورة وCSV نسخة من شرط القاعدة (133)', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    assert.equal(BILLING_CYCLE_LABELS.monthly, 'شهري');
    assert.equal(BILLING_CYCLE_LABELS.yearly, 'سنوي');
    assert.equal(storeEndDateError('2026-11-26T00:00:00Z', { maxDays: 365 }, now), null);
    assert.match(storeEndDateError('not-a-date', { maxDays: 365 }, now), /صحيحًا/);
    assert.match(storeEndDateError('2026-10-26T00:00:00Z', { maxDays: 365 }, now), /المستقبل/);
    assert.match(storeEndDateError('2027-11-01T00:00:00Z', { maxDays: 365 }, now), /365 يومًا/);
    assert.match(storeEndDateError('2026-11-01T00:00:00Z', { maxDays: 365, startDate: '2026-11-05T00:00:00Z' }, now), /أبعد من تاريخ بداية/);
    assert.equal(storeEndDateError('2026-11-06T00:00:00Z', { maxDays: 365, startDate: '2026-11-05T00:00:00Z' }, now), null);
    assert.equal(csvCell('بسيط'), 'بسيط');
    assert.equal(csvCell('فيه, فاصلة'), '"فيه, فاصلة"');
    assert.equal(csvCell('قال "مرحبا"'), '"قال ""مرحبا"""');
    assert.equal(csvCell(null), '');
    assert.equal(toCsv(['أ', 'ب'], [['1', 'x,y'], ['2', 'z']]), 'أ,ب\r\n1,"x,y"\r\n2,z');
});

/* ── القائمة ───────────────────────────────────────────────────────────── */

test('قائمة المالك: «الإدارة» و«التشغيل» صفحات /owner/ بقشرة المالك، لا روابط /admin/ إطلاقًا', () => {
    const html = fs.readFileSync(path.join(ROOT, 'assets/components/owner-sidebar.html'), 'utf8');
    const items = [...html.matchAll(/<a href="([^"]+)" class="sidebar-item"([^>]*)>/g)].map(m => [m[1], m[2]]);
    // بلا استثناء: «المستخدمون» قسم داخل اللوحة نفسها (data-tab)، ورابطه /owner-dashboard.html#users —
    // الاستثناء القديم (/admin/users.html احتياطًا لصفحة بلا القسم) أُلغي مع F3.
    assert.ok(!items.some(([href]) => href.startsWith('/admin/')),
        'عنصر في قائمة المالك يقود إلى /admin/');
    const pages = items.filter(([href]) => href.startsWith('/owner/')).map(([href, attrs]) => [href, /data-page="([^"]+)"/.exec(attrs)?.[1]]);
    // ترتيب القائمة = ترتيب PAGES. «المستخدمون» و«Pi Network» قسمان داخل اللوحة نفسها (data-tab)، لا صفحتان
    assert.deepEqual(pages.map(([h]) => h), Object.keys(PAGES).map(p => `/owner/${p}.html`));
    assert.ok(items.some(([href, attrs]) => href === '/owner-dashboard.html#users' && attrs.includes('data-tab="users"')), 'users');
    assert.ok(items.some(([href, attrs]) => href === '/owner-dashboard.html#pi' && attrs.includes('data-tab="pi"')), 'pi');
    for (const [href, dataPage] of pages) {
        assert.equal(`/owner/${dataPage}.html`, href, `data-page لا يطابق الملف: ${href}`);
        assert.ok(fs.existsSync(path.join(ROOT, href)), `الصفحة غير موجودة: ${href}`);
        assert.ok(fs.existsSync(path.join(ROOT, `assets/js/owner/pages/${dataPage}.js`)), `وحدة الصفحة غير موجودة: ${dataPage}`);
    }
});

/* ── البوابة ───────────────────────────────────────────────────────────── */

test('غير المالك والمالك خارج سياقه: رسالة السبب ولا نداء بيانات', { skip: !chromiumPath }, async () => {
    for (const [fx, reason] of [[fixtures({ owner: false, context: null }), /لمالك المنصة وحده/],
                                [fixtures({ context: 'admin' }), /خارج واجهة مالك المنصة/]]) {
        const { page, context, errors } = await openPage(browser, baseUrl, 'subscriptions', fx);
        await page.waitForSelector('#ownerGate:not([hidden])');
        assert.match(await page.textContent('#ownerGate'), reason);
        assert.equal(await page.isHidden('#ownerContent'), true);
        assert.deepEqual(await rpcCalls(page, 'admin_list_subscriptions'), []);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

/* ── كل صفحة ───────────────────────────────────────────────────────────── */

for (const [file, ready] of Object.entries(PAGES)) {
    test(`${file}: تُرسم بلا أخطاء، والعنصر النشط في القائمة، وبلا تمرير أفقي على الجوال`, { skip: !chromiumPath }, async () => {
        for (const width of [1440, 390]) {
            const { page, context, errors } = await openPage(browser, baseUrl, file, fixtures(), { width });
            await page.waitForSelector(ready, { timeout: 10000 });
            await page.waitForSelector(`.sidebar-item.active[data-page="${file}"]`, { state: 'attached' });
            assert.equal(await page.getAttribute(`.sidebar-item[data-page="${file}"]`, 'aria-current'), 'page');
            assert.equal(await page.isHidden('#ownerGate'), true);
            assert.ok(await noHorizontalScroll(page), `${file} @${width}: تمرير أفقي`);
            assert.deepEqual(errors, [], `${file} @${width}`);
            await context.close();
        }
    });
}

/* ── العمليات ──────────────────────────────────────────────────────────── */

test('الوكلاء: كرتا Muse بلا endpoint وHermes، والإحصائيات، ونافذة الإعدادات بكل الحقول', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'agents', fixtures());
    await page.waitForSelector('#agentsGrid .agent-card');
    assert.equal(await page.isHidden('#ownerGate'), true);
    // الإحصائيات: وكيلان، واحد نشط
    assert.equal(await page.textContent('#statTotal'), '2');
    assert.equal(await page.textContent('#statActive'), '1');
    // الكرتان: Muse بلا endpoint كمعلومة محايدة، وHermes يعمل
    assert.equal(await page.locator('#agentsGrid .agent-card').count(), 2);
    assert.match(await page.textContent('#agentsGrid'), /Muse/);
    assert.match(await page.textContent('#agentsGrid'), /Hermes/);
    assert.match(await page.textContent('#agentsGrid'), /بلا endpoint/);
    assert.match(await page.textContent('#agentsGrid'), /يعمل/);
    // البحث يصفّي
    await page.fill('#searchInput', 'Hermes');
    assert.equal(await page.locator('#agentsGrid .agent-card').count(), 1);
    await page.fill('#searchInput', '');
    assert.equal(await page.locator('#agentsGrid .agent-card').count(), 2);

    // نافذة Hermes: كل الحقول معبأة من الكاش، بلا نداء get إضافي
    await page.click('#agentsGrid > [data-open-agent="ag-hermes"]');
    await page.waitForSelector('#agentModal.open');
    assert.equal(await page.inputValue('#fName'), 'Hermes');
    assert.equal(await page.inputValue('#fSlug'), 'hermes');
    assert.equal(await page.inputValue('#fType'), 'hermes');
    assert.equal(await page.inputValue('#fEndpoint'), 'https://hermes.internal:8080');
    assert.equal(await page.inputValue('#fHealthEndpoint'), 'https://hermes.internal:8080/health');
    // الملاحظة داخل تبويب الحالة (مخفي حتى يُفتح التبويب)، فالصحيح فحص خاصية hidden لا الرؤية
    assert.equal(await page.evaluate(() => document.getElementById('noEndpointNote').hidden), true);
    assert.equal(await page.isDisabled('#btnRefreshStatus'), false);
    // كل التبويبات التسعة موجودة، وشبكتا الموارد والصلاحيات معبأتان
    assert.equal(await page.locator('#modalTabs .tab-btn').count(), 9);
    assert.ok(await page.locator('#resourcesGrid .check-item').count() > 0);
    assert.ok(await page.locator('#permissionsGrid .check-item').count() > 0);
    await page.click('#modalCloseBtn');
    assert.equal(await page.locator('#agentModal.open').count(), 0);

    // نافذة Muse: بلا endpoint — الملاحظة ظاهرة وزر التحديث معطّل
    await page.click('#agentsGrid > [data-open-agent="ag-muse"]');
    await page.waitForSelector('#agentModal.open');
    assert.equal(await page.inputValue('#fName'), 'Muse');
    assert.equal(await page.inputValue('#fEndpoint'), '');
    assert.equal(await page.evaluate(() => document.getElementById('noEndpointNote').hidden), false);
    assert.equal(await page.isDisabled('#btnRefreshStatus'), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('التذاكر: المحادثة نصّ لا HTML، وتغيير الحالة والمسؤول يُرسل الحقول المتغيرة مع الفاعل', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'tickets', fixtures());
    await page.waitForSelector('[data-ticket="t1"]');
    assert.match(await page.textContent('#ticketsTable'), /شركة: شركة أ/);
    await page.click('[data-ticket="t1"]');
    await page.waitForSelector('#ticketForm');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.match(await page.textContent('.owner-thread'), /<img src=x/);
    assert.match(await page.textContent('.owner-thread'), /ملاحظة داخلية/);

    await page.click('#ticketForm button[type=submit]');
    assert.match(await page.textContent('#ticketStatus'), /لا تغيير/);
    await page.selectOption('#tStatus', 'in-progress');
    await page.selectOption('#tAssignee', SUPPORT);
    await page.click('#ticketForm button[type=submit]');
    await page.waitForSelector('.owner-modal', { state: 'detached' });
    const [w] = await writes(page, 'tickets');
    assert.deepEqual(Object.keys(w.row).sort(), ['assigned_to', 'last_updated_at', 'last_updated_by', 'status']);
    assert.equal(w.row.status, 'in-progress');
    assert.equal(w.row.assigned_to, SUPPORT);
    assert.equal(w.row.last_updated_by, OWNER);
    assert.deepEqual(errors, []);
    await context.close();
});

test('التذاكر: رفض RLS بصفر صفوف لا يقول «تم»', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.updateDenied = ['tickets'];
    const { page, context } = await openPage(browser, baseUrl, 'tickets', fx, { query: '?ticket=t1' });
    await page.waitForSelector('#ticketForm');
    await page.selectOption('#tPriority', 'low');
    await page.click('#ticketForm button[type=submit]');
    await page.waitForSelector('#ticketStatus:not([hidden])');
    await page.waitForFunction(() => !/جارٍ/.test(document.querySelector('#ticketStatus').textContent));
    assert.match(await page.textContent('#ticketStatus'), /لم يُحفظ/);
    assert.equal(await page.locator('.owner-modal').count(), 1);
    await context.close();
});

test('الاشتراكات: أزرار الانتقالات المسموحة وحدها، والسبب إلزامي، والنداء بمعاملات الدالة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'subscriptions', fixtures());
    await page.waitForSelector('[data-sub="s-active"]');
    assert.deepEqual(await page.$$eval('[data-sub="s-active"]', b => b.map(x => x.dataset.to)), ['expired']);
    assert.deepEqual(await page.$$eval('[data-sub="s-pending"]', b => b.map(x => x.dataset.to)), ['active', 'rejected']);
    assert.deepEqual(await page.$$eval('[data-sub="s-expired"]', b => b.map(x => x.dataset.to)), ['active']);

    await page.click('[data-sub="s-active"][data-to="expired"]');
    await page.waitForSelector('#subForm');
    await page.click('#subForm button[type=submit]');
    assert.match(await page.textContent('#subStatus'), /سببًا/);
    assert.deepEqual(await rpcCalls(page, 'admin_set_subscription_status'), []);
    await page.fill('#subReason', 'لم يُستكمل الدفع');
    await page.click('#subForm button[type=submit]');
    await page.waitForSelector('.owner-modal', { state: 'detached' });
    assert.deepEqual(await rpcCalls(page, 'admin_set_subscription_status'),
        [{ p_subscription_id: 's-active', p_status: 'expired', p_reason: 'لم يُستكمل الدفع', p_end_date: null }]);

    // التصفية «تنتهي خلال 7 أيام»
    await page.selectOption('#subsStatus', 'expiring');
    assert.equal(await page.locator('#subsTable tbody tr').count(), 1);

    // السجل: السبب الذي كتبه غيره نصّ
    await page.selectOption('#subsStatus', '');
    await page.click('[data-audit="s-active"]');
    await page.waitForSelector('.owner-modal table');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    await context.close();
});

test('الاشتراكات: رفض الدالة يظهر برسالتها', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpcErrors = { admin_set_subscription_status: { code: '42501', message: 'هذه العملية متاحة للإدارة فقط' } };
    const { page, context } = await openPage(browser, baseUrl, 'subscriptions', fx);
    await page.waitForSelector('[data-sub="s-pending"][data-to="rejected"]');
    await page.click('[data-sub="s-pending"][data-to="rejected"]');
    await page.fill('#subReason', 'بيانات الدفع ناقصة');
    await page.click('#subForm button[type=submit]');
    await page.waitForFunction(() => /للإدارة فقط/.test(document.querySelector('#subStatus')?.textContent || ''));
    assert.equal(await page.locator('.owner-modal').count(), 1);
    await context.close();
});

test('المتاجر: سعر الباقة معبأ بالمعتمد (500/5000) ويُحفظ، والمزامنة وإعادة الأحداث تناديان دوال المالك', { skip: !chromiumPath }, async () => {
    // جلسة تحرير طازجة: حارس [data-critical] في الشريط الجانبي يعترض النقرة بلا جلسة
    // ويفتح نافذة التحقق — بالجلسة الطازجة يعيد النقرة نفسها فورًا.
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('#storeIntegrations table');
    await page.waitForSelector('#storePriceForm');

    // السعر: القيم الافتراضية المعتمدة، والتحقق قبل الإرسال
    assert.equal(await page.inputValue('#planMonthly'), '500');
    assert.equal(await page.inputValue('#planYearly'), '5000');
    await page.fill('#planMonthly', '');
    await page.click('#storePriceForm button[type=submit]');
    assert.match(await page.textContent('#planPriceStatus'), /الشهري/);
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_price'), []);
    await page.fill('#planMonthly', '500');
    await page.fill('#planYearly', '5000');
    await page.check('#planActivate');
    await page.click('#storePriceForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_store_plan_price'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_price'),
        [{ p_monthly: 500, p_yearly: 5000, p_activate: true }]);

    // المزامنة وإعادة الأحداث على الربط الخطأ (error) وبه حدث ميت
    await page.waitForSelector('[data-sync="cn1"]');
    await page.click('[data-sync="cn1"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_ihub_sync_request'));
    assert.deepEqual(await rpcCalls(page, 'owner_ihub_sync_request'), [{ p_connection: 'cn1' }]);
    await page.waitForSelector('[data-retry="cn1"]');
    await page.click('[data-retry="cn1"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_ihub_events_retry'));
    assert.deepEqual(await rpcCalls(page, 'owner_ihub_events_retry'), [{ p_connection: 'cn1' }]);

    // تحويل الشركة إلى متجر: السبب القصير لا يُرسل، والسبب الكامل يُرسل
    await page.waitForSelector('[data-kind="ecommerce_store"]');
    await page.click('[data-kind="ecommerce_store"]');
    await page.waitForSelector('#kindForm');
    await page.fill('#kindReason', 'قصير');
    await page.click('#kindForm button[type=submit]');
    assert.match(await page.textContent('#kindStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(page, 'owner_set_company_account_kind'), []);
    await page.fill('#kindReason', 'تحويل للاختبار التجريبي');
    await page.click('#kindForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_company_account_kind'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_company_account_kind'),
        [{ p_company: 'cw', p_kind: 'ecommerce_store', p_reason: 'تحويل للاختبار التجريبي' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المتاجر: نافذة السجل تعيد محاولة الأحداث الميتة، ونموذج المنح يعرض الامتياز الحالي', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    fx.rpc.owner_store_events = { jobs: [], audit: [],
        events: [{ topic: 'orders/create', status: 'dead', attempts: 6, last_error_code: 'timeout', received_at: '2026-10-27T00:00:00Z' }] };
    const { page, context } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('[data-events="cn1"]');
    await page.click('[data-events="cn1"]');
    await page.waitForSelector('#eventsRetry');
    await page.click('#eventsRetry');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_ihub_events_retry'));
    assert.deepEqual(await rpcCalls(page, 'owner_ihub_events_retry'), [{ p_connection: 'cn1' }]);
    await context.close();

    // متجر اختبار قائم: الامتياز الحالي معروض، والمنح بسبب قابل للتحرير، والسحب بتأكيد
    const fx2 = fixtures();
    fx2.rpc.owner_security_status = { ...fx2.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const future = new Date(Date.now() + 6 * 864e5).toISOString();
    fx2.rpc.owner_store_test_status = { company_id: 'cw', company_name: 'شركة المالك', account_kind: 'ecommerce_store',
        has_company: true, is_test_store: true,
        entitlements: [
            { feature_key: 'integrations_hub', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null },
            { feature_key: 'shopify_integration', granted: true, active: true, granted_at: '2026-10-26T00:00:00Z', expires_at: future, days_remaining: 6 },
            { feature_key: 'shopify_management', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null },
            { feature_key: 'store_support', granted: false, active: false, granted_at: null, expires_at: null, days_remaining: null }] };
    const second = await openPage(browser, baseUrl, 'stores', fx2);
    await second.page.waitForSelector('#testGrantForm');
    assert.match(await second.page.textContent('#testStore'), /تكامل Shopify/);
    assert.match(await second.page.textContent('#testStore'), /باقٍ [6٦] يوم/);
    await second.page.fill('#testGrantReason', 'قصير');
    await second.page.click('#testGrantForm button[type=submit]');
    assert.match(await second.page.textContent('#testGrantStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_entitlements'), []);
    await second.page.fill('#testGrantReason', 'اختبار المنح التجريبي');
    await second.page.click('#testGrantForm button[type=submit]');
    await second.page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_test_entitlements'));
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_entitlements'),
        [{ p_enable: true, p_days: 7, p_reason: 'اختبار المنح التجريبي' }]);
    await second.page.waitForSelector('#testRevoke');
    await second.page.click('#testRevoke');
    await second.page.waitForSelector('#confirmRevoke');
    await second.page.click('#confirmRevoke');
    await second.page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'owner_store_test_entitlements').length === 2);
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_entitlements'),
        [{ p_enable: true, p_days: 7, p_reason: 'اختبار المنح التجريبي' },
         { p_enable: false, p_days: 1, p_reason: null }]);

    // نموذج إدارة المتجر: حالته معروضة، والسبب القصير لا يُرسل، والكامل يمنح، والسحب بتأكيد
    await second.page.waitForSelector('#testMgmtForm');
    assert.match(await second.page.textContent('#testStore'), /إدارة المتجر: غير ممنوح/);
    await second.page.fill('#testMgmtReason', 'قصير');
    await second.page.click('#testMgmtForm button[type=submit]');
    assert.match(await second.page.textContent('#testMgmtStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_management'), []);
    await second.page.fill('#testMgmtReason', 'اختبار إدارة المتجر');
    await second.page.click('#testMgmtForm button[type=submit]');
    await second.page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_test_management'));
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_management'),
        [{ p_enable: true, p_days: 7, p_reason: 'اختبار إدارة المتجر' }]);
    await second.page.waitForSelector('#testMgmtRevoke');
    await second.page.click('#testMgmtRevoke');
    await second.page.waitForSelector('#confirmMgmtRevoke');
    await second.page.click('#confirmMgmtRevoke');
    await second.page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'owner_store_test_management').length === 2);
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_test_management'),
        [{ p_enable: true, p_days: 7, p_reason: 'اختبار إدارة المتجر' },
         { p_enable: false, p_days: 1, p_reason: null }]);
    await second.context.close();
});

test('المتاجر: التنبيهات والطلبات والسجل والفلاتر والتصدير والحصة ومبدّل المزوّد', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('#storeAlerts table');
    await page.waitForSelector('#storeRequests table');
    await page.waitForSelector('#storeOpsLog table');
    await page.waitForSelector('#storeQuotaForm');

    // التنبيهات: النوع والخطورة، والرابط يقفز لصف الربط المعني
    assert.match(await page.textContent('#storeAlerts'), /أحداث ميتة/);
    assert.match(await page.textContent('#storeAlerts'), /ربط حي بلا امتياز/);
    assert.match(await page.textContent('#storeAlerts'), /حرج/);
    const alertLink = await page.getAttribute('#storeAlerts a[href="#conn-cn1"]', 'href');
    assert.equal(alertLink, '#conn-cn1');
    assert.ok(await page.$('#conn-cn1'), 'صف الربط cn1 موجود كهدف للتنبيه');

    // سجل العمليات: إجراءات 133 بالملخص العربي والفاعل
    assert.match(await page.textContent('#storeOpsLog'), /store\.plan_price/);
    assert.match(await page.textContent('#storeOpsLog'), /store\.grant_exception/);
    assert.match(await page.textContent('#storeOpsLog'), /حُدّد سعر باقة المتاجر/);

    // الطلبات: الاعتماد بسبب قصير لا يُرسل، والسبب الكامل يُرسل
    await page.click('[data-decide="approve"][data-request="rq1"]');
    await page.waitForSelector('#requestDecideForm');
    await page.fill('#requestDecideReason', 'قصير');
    await page.click('#requestDecideForm button[type=submit]');
    assert.match(await page.textContent('#requestDecideStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(page, 'owner_store_request_decide'), []);
    await page.fill('#requestDecideReason', 'اعتماد طلب متجر الاختبار');
    await page.click('#requestDecideForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_request_decide'));
    assert.deepEqual(await rpcCalls(page, 'owner_store_request_decide'),
        [{ p_request: 'rq1', p_decision: 'approve', p_reason: 'اعتماد طلب متجر الاختبار' }]);

    // الفلاتر: حالة الاشتراك وحالة شوبيفاي تُرسلان كمعاملات جديدة
    await page.selectOption('#accountsSubStatus', 'active');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || [])
        .some(([n, a]) => n === 'owner_accounts_overview' && a.p_sub_status === 'active'));
    const lastOverview = (await rpcCalls(page, 'owner_accounts_overview')).at(-1);
    assert.equal(lastOverview.p_sub_status, 'active');
    await page.selectOption('#accountsShopify', 'error');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || [])
        .some(([n, a]) => n === 'owner_accounts_overview' && a.p_shopify_status === 'error'));
    assert.equal((await rpcCalls(page, 'owner_accounts_overview')).at(-1).p_shopify_status, 'error');
    await page.selectOption('#accountsSuspended', 'true');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || [])
        .some(([n, a]) => n === 'owner_accounts_overview' && a.p_suspended === true));
    assert.equal((await rpcCalls(page, 'owner_accounts_overview')).at(-1).p_suspended, true);

    // البحث بدومين المتجر يُرسل كما كُتب، واسم الحساب رابط لصفحة تفاصيله
    await page.selectOption('#accountsSuspended', '');
    await page.fill('#accountsSearch', 'ward.myshopify.com');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || [])
        .some(([n, a]) => n === 'owner_accounts_overview' && a.p_search === 'ward.myshopify.com'));
    assert.equal((await rpcCalls(page, 'owner_accounts_overview')).at(-1).p_search, 'ward.myshopify.com');
    assert.equal(await page.getAttribute('#accountsTable a[href="/owner/accounts.html?id=c9"]', 'href'), '/owner/accounts.html?id=c9');

    // التصدير: ملف CSV للصفوف المعروضة، بمحتوى عربي سليم
    const downloadPromise = page.waitForEvent('download');
    await page.click('#accountsExport');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'mad3oom-accounts.csv');
    const csvPath = await download.path();
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.match(csv, /متجر الورد/);
    assert.match(csv, /ward\.myshopify\.com/);

    // حد التذاكر والمزايا: فارغ = بلا حد، والسبب إلزامي، والنداء بالحد والمزايا المفعّلة
    assert.equal(await page.inputValue('#planQuota'), '');
    await page.fill('#planQuota', '100');
    await page.click('#storeQuotaForm button[type=submit]');
    assert.match(await page.textContent('#planQuotaStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_quota_features'), []);
    await page.fill('#planQuotaReason', 'تحديد حد التذاكر للاختبار');
    await page.click('#storeQuotaForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_store_plan_quota_features'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_quota_features'),
        [{ p_monthly_quota: 100, p_features: ['integrations_hub', 'shopify_integration'], p_reason: 'تحديد حد التذاكر للاختبار' }]);

    // مبدّل المزوّد: المزوّد مقفل في البيانات فيُعرض «تشغيل»، والسبب إلزامي
    await page.waitForSelector('#providerToggle');
    assert.match(await page.textContent('#providerToggle'), /تشغيل مزوّد Shopify/);
    await page.click('#providerToggle');
    await page.waitForSelector('#subReasonForm');
    await page.fill('#subReason', 'تشغيل مزود الاختبار');
    await page.click('#subReasonForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_shopify_provider_enabled'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_shopify_provider_enabled'),
        [{ p_enabled: true, p_reason: 'تشغيل مزود الاختبار' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المتاجر: إدارة اشتراك متجر — منح كاستثناء وإيقاف وتحويل دورة', { skip: !chromiumPath }, async () => {
    // اشتراك فعّال قائم: الإيقاف وتحويل الدورة بنوافذ سبب
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('[data-manage-sub="c9"]');
    await page.click('[data-manage-sub="c9"]');
    await page.waitForSelector('#subEndForm');
    assert.match(await page.textContent('#manageSubBody'), /شهري/);
    assert.match(await page.textContent('#manageSubBody'), /فعّال/);
    assert.match(await page.textContent('#manageSubBody'), /باقٍ/);
    await page.click('#subPause');
    await page.waitForSelector('#subReasonForm');
    await page.fill('#subReason', 'إيقاف الاشتراك للاختبار');
    await page.click('#subReasonForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_pause'));
    assert.deepEqual(await rpcCalls(page, 'owner_store_pause'),
        [{ p_subscription: 'sub1', p_reason: 'إيقاف الاشتراك للاختبار' }]);
    await page.waitForSelector('#subCycle');
    await page.click('#subCycle');
    await page.waitForSelector('#subReasonForm');
    await page.fill('#subReason', 'تحويل الدورة للاختبار');
    await page.click('#subReasonForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_change_cycle'));
    assert.deepEqual(await rpcCalls(page, 'owner_store_change_cycle'),
        [{ p_subscription: 'sub1', p_billing_cycle: 'yearly', p_reason: 'تحويل الدورة للاختبار' }]);
    assert.deepEqual(errors, []);
    await context.close();

    // بلا اشتراك: نموذج المنح — تاريخ ماضٍ مرفوض قبل الإرسال، والمنح الصحيح يُرسل
    const fx2 = fixtures();
    fx2.rpc.owner_security_status = { ...fx2.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    fx2.rpc.owner_store_subscription = null;
    const second = await openPage(browser, baseUrl, 'stores', fx2);
    await second.page.waitForSelector('[data-manage-sub="c9"]');
    await second.page.click('[data-manage-sub="c9"]');
    await second.page.waitForSelector('#subGrantForm');
    assert.match(await second.page.textContent('#manageSubBody'), /لا اشتراك متجر/);
    await second.page.fill('#subGrantEnd', '2020-01-01T00:00');
    await second.page.fill('#subGrantReason', 'منح استثناء للاختبار');
    await second.page.click('#subGrantForm button[type=submit]');
    assert.match(await second.page.textContent('#subGrantStatus'), /المستقبل/);
    assert.deepEqual(await rpcCalls(second.page, 'owner_store_grant_exception'), []);
    // تاريخ ضمن حد السنة في القاعدة (180 يومًا من الآن)
    const grantEnd = new Date(Date.now() + 180 * 864e5);
    await second.page.fill('#subGrantEnd', grantEnd.toISOString().slice(0, 16));
    await second.page.click('#subGrantForm button[type=submit]');
    await second.page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_grant_exception'));
    const grant = (await rpcCalls(second.page, 'owner_store_grant_exception'))[0];
    assert.equal(grant.p_company, 'c9');
    assert.equal(grant.p_billing_cycle, 'monthly');
    assert.equal(grant.p_reason, 'منح استثناء للاختبار');
    assert.ok(Math.abs(new Date(grant.p_end_date) - grantEnd) < 864e5, 'تاريخ الانتهاء المرسل هو المدخل');
    await second.context.close();
});

test('المتاجر (135): فشل التشخيص لا يُسقط نموذجي السعر والحصة', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    fx.rpcErrors = { owner_entitlement_diagnostics: { code: 'P0001', message: 'تعذّر التشخيص للاختبار' } };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('#storePriceForm');
    await page.waitForSelector('#storeQuotaForm');
    assert.match(await page.textContent('#storeDiagnostics'), /تعذّرت القراءة/);
    assert.match(await page.textContent('#storeDiagnostics'), /تعذّر التشخيص للاختبار/);
    // نموذج السعر يعمل من إعداد الباقة: القيم الافتراضية المعتمدة ثم الحفظ
    assert.equal(await page.inputValue('#planMonthly'), '500');
    assert.equal(await page.inputValue('#planYearly'), '5000');
    await page.check('#planActivate');
    await page.click('#storePriceForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_store_plan_price'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_price'),
        [{ p_monthly: 500, p_yearly: 5000, p_activate: true }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المتاجر (135): إلغاء تفعيل الباقة بتأكيد وسبب، والأسعار المحفوظة لا تتغيّر', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    fx.rpc.owner_store_plan_config = { ...fx.rpc.owner_store_plan_config,
        is_active: true, price_monthly: 500, price_yearly: 5000, currency: 'EGP' };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('#planDeactivate');
    assert.match(await page.textContent('#storeDiagnostics'), /مفعّلة/);
    await page.click('#planDeactivate');
    await page.waitForSelector('#subReasonForm');
    assert.match(await page.textContent('#subReasonForm'), /سيتوقف بيع باقة المتاجر/);
    await page.fill('#subReason', 'قصير');
    await page.click('#subReasonForm button[type=submit]');
    assert.match(await page.textContent('#subReasonStatus'), /10 أحرف/);
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_price'), []);
    await page.fill('#subReason', 'إلغاء تفعيل الباقة للاختبار');
    await page.click('#subReasonForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_store_plan_price'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_price'),
        [{ p_monthly: 500, p_yearly: 5000, p_activate: false, p_deactivate: true, p_reason: 'إلغاء تفعيل الباقة للاختبار' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المتاجر (135): تعطيل تكامل Shopify أو إلغاء كل المزايا يطلب تأكيدًا صريحًا', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('#storeQuotaForm');
    // تعطيل شوبيفاي وحده: تأكيد يظهر، والإلغاء لا يرسل، والتأكيد يرسل
    await page.uncheck('.planFeature[value="shopify_integration"]');
    await page.fill('#planQuotaReason', 'تعطيل تكامل شوبيفاي للاختبار');
    await page.click('#storeQuotaForm button[type=submit]');
    await page.waitForSelector('#quotaDisableConfirm');
    assert.match(await page.textContent('.owner-modal-body'), /تكامل Shopify/);
    await page.click('#quotaDisableCancel');
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_quota_features'), []);
    await page.click('#storeQuotaForm button[type=submit]');
    await page.waitForSelector('#quotaDisableConfirm');
    await page.click('#quotaDisableConfirm');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_store_plan_quota_features'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_store_plan_quota_features'),
        [{ p_monthly_quota: null, p_features: ['integrations_hub'], p_reason: 'تعطيل تكامل شوبيفاي للاختبار' }]);
    // إلغاء الكل: تأكيد يظهر أيضًا بعد إعادة الرسم
    await page.waitForSelector('#storeQuotaForm');
    await page.uncheck('.planFeature[value="integrations_hub"]');
    await page.uncheck('.planFeature[value="shopify_integration"]');
    await page.fill('#planQuotaReason', 'إلغاء كل مزايا الباقة للاختبار');
    await page.click('#storeQuotaForm button[type=submit]');
    await page.waitForSelector('#quotaDisableConfirm');
    assert.match(await page.textContent('.owner-modal-body'), /إلغاء كل مزايا/);
    await page.click('#quotaDisableConfirm');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'owner_set_store_plan_quota_features').length === 2);
    assert.deepEqual((await rpcCalls(page, 'owner_set_store_plan_quota_features')).at(-1),
        { p_monthly_quota: null, p_features: [], p_reason: 'إلغاء كل مزايا الباقة للاختبار' });
    assert.deepEqual(errors, []);
    await context.close();
});

test('المتاجر (135): تعديل الانتهاء أثناء الإيقاف تاريخ نهائي عند الاستئناف', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { ...fx.rpc.owner_security_status, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    const future = new Date(Date.now() + 20 * 864e5).toISOString();
    const past = new Date(Date.now() - 2 * 3600e3).toISOString();
    fx.rpc.owner_store_subscription = { id: 'sub1', plan: 'store', billing_cycle: 'monthly', status: 'paused',
        start_date: '2026-10-01T00:00:00Z', end_date: future, duration_days: 30, payment_method: 'owner_exception',
        price_snapshot: { amount: 0, exception: true, cycle_price: 500 }, paused_at: past,
        end_date_set_while_paused: true, cycle_changed_while_paused: false, days_remaining: 5, effective: false };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForSelector('[data-manage-sub="c9"]');
    await page.click('[data-manage-sub="c9"]');
    await page.waitForSelector('#subEndForm');
    assert.match(await page.textContent('#manageSubBody'), /متوقف مؤقتًا/);
    assert.match(await page.textContent('#manageSubBody'), /باقٍ [5٥] يوم/);
    assert.match(await page.textContent('#manageSubBody'), /النهائي بعد الاستئناف/);
    await page.waitForSelector('#subResume');
    await page.click('#subResume');
    await page.waitForSelector('#subReasonForm');
    assert.match(await page.textContent('#subReasonForm'), /دون تمديد إضافي/);
    await page.fill('#subReason', 'استئناف الاشتراك للاختبار');
    await page.click('#subReasonForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_store_resume'));
    assert.deepEqual(await rpcCalls(page, 'owner_store_resume'),
        [{ p_subscription: 'sub1', p_reason: 'استئناف الاشتراك للاختبار' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('سجل النشاط: الحمولة نصّ لا HTML، والتصفية بالحدث تُرسل للخادم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'activity', fixtures());
    await page.waitForSelector('#activityTable table');
    await page.click('#activityTable details summary');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.match(await page.textContent('#activityTable .owner-json'), /<img src=x/);
    assert.deepEqual(await page.$$eval('#activityAction option', o => o.map(x => x.value)), ['', 'ban_user', 'login']);
    await page.selectOption('#activityAction', 'login');
    await page.waitForFunction(() => document.querySelectorAll('#activityTable tbody tr').length === 1);
    await context.close();
});

test('التكاملات: إيقاف مفتاح يكتب is_active و revoked_at وحدهما، وتعطيل تكامل المنصة', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await openPage(browser, baseUrl, 'integrations', fixtures());
    await page.waitForSelector('[data-token="k1"]');
    assert.match(await page.textContent('#integrationsKpis'), /آخر اختبار فاشل\s*[1١]/);
    await page.click('[data-token="k1"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'api_tokens'));
    const [w] = await writes(page, 'api_tokens');
    assert.deepEqual(Object.keys(w.row).sort(), ['is_active', 'revoked_at']);
    assert.equal(w.row.is_active, false);
    assert.ok(dialogs.some(m => /يفقد الوصول فورًا/.test(m)));

    await page.click('[data-integration="i1"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'external_integrations'));
    assert.deepEqual((await writes(page, 'external_integrations'))[0].row, { is_active: false });
    await context.close();
});

test('أكواد المرور: الكود القصير لا يُرسل، والإنشاء والتعطيل عبر دوال المالك', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'passcodes', fixtures());
    await page.waitForSelector('[data-code="p1"]');
    await page.fill('#passcodeCode', '123');
    await page.click('#passcodeCreate');
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode'), []);
    await page.fill('#passcodeCode', 'MAD3OOM-2026');
    await page.fill('#passcodeLabel', 'فريق المبيعات');
    await page.click('#passcodeCreate');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_passcode'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode'), [{ p_code: 'MAD3OOM-2026', p_label: 'فريق المبيعات' }]);
    await page.click('[data-code="p1"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_passcode_active'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode_active'), [{ p_id: 'p1', p_active: false }]);
    await context.close();
});

test('الإعدادات: وضع التسجيل والمفاتيح والأمان من القاعدة، وأقسام التشغيل تبويبات أصيلة فيها', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'settings', fixtures());
    // F4: الأقسام تبويبات — محتواها يُحمَّل كله عند الفتح لكن المخفيّ منها لا يُرى
    // حتى يُنقر تبويبه؛ فعّل كل تبويب قبل انتظار محتواه المرئي.
    await page.click('[data-tab="security"]');
    await page.waitForSelector('#settingsSecurity dl');
    assert.match(await page.textContent('#settingsSecurity'), /مفعّل/);
    await page.click('[data-tab="switches"]');
    await page.waitForSelector('#settingsSwitches table');
    assert.match(await page.textContent('#settingsSwitches'), /عزل بيانات الشركات/);
    await page.click('[data-tab="registration"]');
    assert.match(await page.textContent('#settingsRegistration'), /قائمة انتظار/);
    // F4: جدول ADMIN_ONLY_SETTINGS القديم حُذف — أقسامه الآن تبويبات أصيلة في الصفحة نفسها.
    assert.match(await page.textContent('#settingsTabs'), /قواعد الأتمتة/);
    assert.match(await page.textContent('#tab-users'), /المستخدمون في لوحة المالك/);
    await context.close();
});

test('المدوّنة: نفس مساحة التحرير المشتركة تعمل بقشرة المالك', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'blog', fixtures());
    await page.waitForSelector('#blogWorkspace:not([hidden])');
    await page.waitForSelector('#blogRows tr');
    assert.match(await page.textContent('#blogRows'), /مقال أول/);
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');
    assert.equal(await page.inputValue('#fAuthorName'), 'مالك المنصة');
    assert.deepEqual(errors, []);
    await context.close();
});
