/**
 * فحوص ساكنة على أسعار واتساب بالدولار + سعر الصرف الحي وقت المحاسبة.
 *
 * النموذج: الأسعار بالدولار كما هي من بطاقة Meta لمصر (سارية 1 أكتوبر
 * 2026)، بلا مصاريف مدعوم وبلا سعر صرف ثابت في أي ملف. الجنيه يُحسب
 * وقت المحاسبة فقط: دولار × سعر البنك المركزي الحي من دالة fx-rate.
 *
 * منطق الفوترة يعيش في TypeScript على Deno، فلا يُشغَّل هنا؛ الخصائص
 * التي تهمّ قابلة للإثبات من المصدر نفسه (نهج
 * api-token-function-static.test.mjs): أي انحراف يعيد رقمًا ثابتًا أو
 * مصاريف، والاختبار يفشل قبل أن يصل الكود إلى مراجعة بشرية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BILLING_SEND = read('supabase/functions/send-whatsapp/_shared/whatsapp-billing.ts');
const BILLING_MCP = read('supabase/functions/mcp/_shared/whatsapp-billing.ts');
const SERVICE_SEND = read('supabase/functions/send-whatsapp/_shared/whatsapp-service.ts');
const SERVICE_MCP = read('supabase/functions/mcp/_shared/whatsapp-service.ts');
const MIGRATION_125 = read('migrations/125_whatsapp_pricing_sourced_rates.sql');
const API_DOCS = read('api-docs.html');

/** جسم الكود بلا تعليقات — الفحوص يجب أن تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ── الاشتقاق الحسابي نفسه: دولار × سعر الصرف الحي، بلا إضافات ─────────── */

// متوسط البنك المركزي 23 نوفمبر 2026 (شراء 54.2883 / بيع 54.3883) —
// قيمة اختبار فقط، لا ثابت في الكود.
const CBE_MIDPOINT_2026_11_23 = 54.3383;

test('السعر المحلي = سعر Meta بالدولار × سعر الصرف الحي، بلا مصاريف', () => {
    assert.equal(round2(0.0644 * CBE_MIDPOINT_2026_11_23), 3.5, 'تسويق');
    assert.equal(round2(0.0036 * CBE_MIDPOINT_2026_11_23), 0.2, 'مرافق/تحقق/خدمة');
    assert.equal(round2(0.0650 * CBE_MIDPOINT_2026_11_23), 3.53, 'تحقق دولي');
    // ولو أضيفت مصاريف 0.25 لاختلف الناتج — هذا الفحص يثبّت غيابها.
    assert.notEqual(round2(0.0036 * CBE_MIDPOINT_2026_11_23 + 0.25), 0.2, 'مصاريف تسللت للمعادلة');
});

/* ── الثوابت المصدَّرة في نسختي whatsapp-billing.ts ─────────────────────── */

for (const [name, src] of [['send-whatsapp', BILLING_SEND], ['mcp', BILLING_MCP]]) {
    const CODE = codeOnly(src);
    test(`[${name}] أسعار Meta لمصر بالدولار مثبَّتة، وبلا رقم صرف ثابت`, () => {
        assert.match(CODE, /marketing: 0\.0644/, 'سعر التسويق بالدولار مفقود');
        assert.match(CODE, /utility: 0\.0036/, 'سعر المرافق بالدولار مفقود');
        assert.match(CODE, /service: 0\.0036/, 'سعر الخدمة بالدولار مفقود');
        assert.match(CODE, /META_RATE_CARD_EFFECTIVE = "2026-10-01"/, 'تاريخ السريان مفقود');
        assert.doesNotMatch(CODE, /USD_EGP_FX_RATE/, 'سعر صرف ثابت ما زال في الكود');
        assert.doesNotMatch(CODE, /LOCAL_SURCHARGE_EGP/, 'مصاريف مدعوم ما زالت في الكود');
        assert.doesNotMatch(CODE, /DERIVED_LOCAL_CHARGE_EGP/, 'أسعار جنيه مشتقة ثابتة ما زالت في الكود');
        assert.doesNotMatch(CODE, /54\.38|54\.3383/, 'قيمة صرف مثبَّتة في الكود');
    });

    test(`[${name}] الإعدادات بالدولار مع افتراضي 0.0036`, () => {
        assert.match(CODE, /templateChargeUsd: Number\(map\.get\("template_charge_usd"\) \?\? 0\.0036\)/,
            'افتراضي القالب ليس 0.0036 دولار');
        assert.match(CODE, /textChargeUsd: Number\(map\.get\("text_charge_usd"\) \?\? 0\.0036\)/,
            'افتراضي النصية ليس 0.0036 دولار');
        assert.doesNotMatch(CODE, /template_charge_egp|text_charge_egp/, 'مفاتيح الجنيه القديمة ما زالت تُقرأ');
        assert.doesNotMatch(CODE, /0\.45/, 'السعر الجنيه المشتق 0.45 ما زال في الكود');
    });

    test(`[${name}] سعر الصرف الحي من دالة fx-rate مع بديل من fx_rates`, () => {
        assert.match(CODE, /export async function getUsdEgpRate/, 'جالب سعر الصرف مفقود');
        assert.match(CODE, /\/functions\/v1\/fx-rate/, 'نداء دالة fx-rate مفقود');
        assert.match(CODE, /\.from\("fx_rates"\)/, 'البديل من جدول fx_rates مفقود');
        assert.match(CODE, /export async function toEgp/, 'محوّل الدولار→جنيه مفقود');
        assert.match(CODE, /export async function resolveTemplateCharge/, 'بوابة سعر القالب مفقودة');
        assert.match(CODE, /resolveServiceCharge/, 'بوابة سعر الخدمة مفقودة');
    });

    test(`[${name}] الشريحة المجانية: 1,000 رسالة خدمة شهريًا لكل رقم`, () => {
        assert.match(CODE, /SERVICE_FREE_TIER_PER_MONTH = 1000/, 'ثابت الشريحة مفقود');
        assert.match(CODE, /export async function countServiceMessagesUsedThisMonth/,
            'عدّاد رسائل الخدمة الشهرية مفقود');
        assert.match(CODE, /export function cairoMonthStartIso/, 'حساب أول الشهر بتوقيت القاهرة مفقود');
        assert.match(CODE, /timeZone: "Africa\/Cairo"/, 'توقيت حساب المراسلة ليس القاهرة');
        assert.match(CODE, /used < SERVICE_FREE_TIER_PER_MONTH/, 'حد الشريحة لا يُفحص');
    });

    test(`[${name}] العدّاد يعدّ رسائل الخدمة المسلَّمة فقط لهذا الرقم`, () => {
        assert.match(CODE, /\.in\("message_type", \["text", "media"\]\)/, 'العدّاد لا يقتصر على نص/وسائط');
        assert.match(CODE, /\.neq\("status", "failed"\)/, 'العدّاد يحسب الرسائل الفاشلة');
        assert.match(CODE, /\.in\("delivery_status", \["sent", "delivered", "read"\]\)/,
            'العدّاد لا يقتصر على المسلَّمة/المقبولة');
        assert.match(CODE, /\.gte\("created_at", cairoMonthStartIso\(\)\)/, 'العدّاد لا يحدّه أول الشهر');
        assert.match(CODE, /query\.eq\("waba_id", params\.wabaId\)/, 'العدّاد لا يقتصر على الرقم');
    });
}

test('نسختا whatsapp-billing.ts متطابقتان', () => {
    assert.equal(BILLING_SEND, BILLING_MCP, 'النسختان انحرفتا — عدّل الاثنتين معًا');
});

/* ── مسار الإرسال يستخدم البوابة ─────────────────────────────────────────── */

for (const [name, src] of [['send-whatsapp', SERVICE_SEND], ['mcp', SERVICE_MCP]]) {
    const CODE = codeOnly(src);
    test(`[${name}] رسائل القالب تُسعَّر بالدولار × سعر الصرف الحي`, () => {
        assert.match(CODE, /const amount = await resolveTemplateCharge\(settings\);/,
            'رسائل القالب لا تمر ببوابة السعر الحي');
        assert.doesNotMatch(CODE, /const amount = settings\.templateCharge;/,
            'رسائل القالب ما زالت تستخدم سعرًا ثابتًا');
        assert.doesNotMatch(CODE, /settings\.templateCharge[^U]/,
            'بقايا حقل templateCharge القديم في مسار الإرسال');
    });
}

/* ── الترحيل والتوثيق ───────────────────────────────────────────────────── */

test('الترحيل 125 يثبّت المفتاحين بالدولار (0.0036) مع المصدر', () => {
    assert.match(MIGRATION_125, /'template_charge_usd', '0\.0036'::jsonb/, 'القالب ليس 0.0036 دولار');
    assert.match(MIGRATION_125, /'text_charge_usd', '0\.0036'::jsonb/, 'النصية ليست 0.0036 دولار');
    assert.match(MIGRATION_125, /سارية 1 أكتوبر 2026/, 'تاريخ سريان بطاقة Meta مفقود');
    assert.match(MIGRATION_125, /fx-rate/, 'دالة سعر الصرف غير مذكورة في الترحيل');
    // القيمتان القديمتان مذكورتان في الترويسة كتوثيق لما تغيّر؛ الفحص هنا
    // على الجزء التنفيذي فقط (بلا تعليقات).
    const executable = MIGRATION_125.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(executable, /0\.45|0\.282/, 'قيمة جنيه قديمة ما زالت في جزء الترحيل التنفيذي');
    assert.doesNotMatch(executable, /template_charge_egp|text_charge_egp/, 'الترحيل ما زال يكتب مفاتيح الجنيه');
});

test('api-docs.html يعرض القيمتين بالدولار', () => {
    assert.match(API_DOCS, /template_charge_usd<\/code><\/td><td><code>0\.0036<\/code>/, 'التوثيق يعرض قيمة الجنيه القديمة للقالب');
    assert.match(API_DOCS, /text_charge_usd<\/code><\/td><td><code>0\.0036<\/code>/, 'التوثيق يعرض قيمة الجنيه القديمة للنصية');
});
