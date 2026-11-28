/**
 * باقة المتاجر تنضم للباقة الفائقة (162) — فحوص ساكنة بلا DOM ولا شبكة:
 *   ① صفحة الأسعار: بلا بطاقة متجر ولا زر لها، وبطاقة الفائقة تسرد مزايا المتجر
 *   ② سكربت الأسعار ونافذة نوع الحساب: بلا مسار باقة متاجر منفصلة
 *   ③ صفحة المالك للمتاجر: بلا نماذج سعر/حصة/منح وبلا نداءات الدوال المتقاعدة
 *   ④ مساعدات المالك: مساعدات السعر/الحصة حُذفت، ومساعدات إدارة الاشتراك القائم باقية
 *   ⑤ الترحيل 162: مزايا المتجر للفائقة، والدوال المتقاعدة ترفض برسالة الدمج، والتراجع موجود
 * المنطق الخادمي (SQL) موثَّق في tests/sql/store-into-super-162.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** الكود بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const SUBS_HTML = read('subscriptions.html');
const SUBS_JS = read('subscriptions-script.js');
const ONBOARDING_JS = read('assets/js/company/company-onboarding.js');
const STORES_JS = codeOnly(read('assets/js/owner/pages/stores.js'));
const STORES_HTML = read('owner/stores.html');
const LABELS_JS = read('assets/js/owner/owner-labels.js');
const TRIAL_JS = read('assets/js/saas-trial-model.js');
const MIGRATION = read('migrations/162_store_into_super.sql');
const ROLLBACK = read('migrations/_rollback/162_store_into_super.down.sql');

// ── ① صفحة الأسعار ─────────────────────────────────────────────────────
test('① صفحة الأسعار: بلا بطاقة متجر، وبطاقة الفائقة تسرد مزايا المتجر', () => {
    assert.doesNotMatch(SUBS_HTML, /data-plan="store"/, 'بطاقة باقة متاجر ما زالت في صفحة الأسعار');
    assert.doesNotMatch(SUBS_HTML, /data-plan-btn="store"/, 'زر باقة متاجر ما زال في صفحة الأسعار');
    assert.match(SUBS_HTML, /ربط متجر Shopify \(قراءة فقط\)/, 'بطاقة الفائقة بلا ربط متجر Shopify');
    assert.match(SUBS_HTML, /دعم المتاجر: إرجاع واستبدال وتقارير/, 'بطاقة الفائقة بلا دعم المتاجر');
    assert.match(SUBS_HTML, /متاجر Shopify — ربط ودعم المتجر/, 'جدول المقارنة بلا صف متاجر Shopify');
    assert.match(SUBS_HTML, /مشمول في الفائقة/, 'جدول المقارنة لا يقول إن المتاجر مشمولة في الفائقة');
});

// ── ② سكربت الأسعار ونافذة نوع الحساب ──────────────────────────────────
test('② سكربت الأسعار: بلا مسار باقة متاجر منفصلة', () => {
    assert.doesNotMatch(SUBS_JS, /applyStorePlanAvailability/, 'دالة توافر باقة المتاجر ما زالت موجودة');
    assert.doesNotMatch(SUBS_JS, /storePlan/, 'أي إشارة storePlan ما زالت في سكربت الأسعار');
    assert.doesNotMatch(SUBS_JS, /اشترك كمتجر/, 'زر «اشترك كمتجر» ما زال موجودًا');
});

test('② نافذة نوع الحساب: خيار المتجر يشير للباقة الفائقة، بلا storePlan/storeOnly', () => {
    assert.doesNotMatch(ONBOARDING_JS, /storePlan|storeOnly/, 'مسار باقة متاجر منفصلة ما زال في نافذة نوع الحساب');
    assert.match(ONBOARDING_JS, /تشترك في الباقة الفائقة وتربط متجرك/, 'خيار المتجر لا يشير للباقة الفائقة');
});

// ── ③ صفحة المالك للمتاجر ──────────────────────────────────────────────
test('③ صفحة المالك للمتاجر: بلا نماذج سعر/حصة/منح وبلا نداءات الدوال المتقاعدة', () => {
    for (const name of ['owner_set_store_plan_price', 'owner_store_grant_exception',
        'owner_set_store_plan_quota_features']) {
        assert.doesNotMatch(STORES_JS, new RegExp(name), `نداء ${name} ما زال في صفحة المالك`);
    }
    for (const id of ['storePriceForm', 'storeQuotaForm', 'subGrantForm', 'planDeactivate']) {
        assert.doesNotMatch(STORES_JS, new RegExp(id), `النموذج ${id} ما زال في صفحة المالك`);
    }
    assert.match(STORES_JS, /دُمجت في الباقة الفائقة/, 'ملاحظة الدمج غائبة من قسم الباقة');
    assert.match(STORES_JS, /دُمجت في الباقة الفائقة \(162\)/, 'ملاحظة الدمج غائبة من إدارة الاشتراك');
    assert.doesNotMatch(STORES_HTML, /نموذج السعر في قسم التشخيص/, 'نص نموذج السعر القديم ما زال في صفحة المالك');
    // إدارة اشتراكات المتاجر القائمة باقية: إيقاف/استئناف/انتهاء/دورة
    for (const name of ['owner_store_pause', 'owner_store_resume', 'owner_store_set_end_date',
        'owner_store_change_cycle', 'owner_store_subscription']) {
        assert.match(STORES_JS, new RegExp(name), `إدارة الاشتراك القائم فقدت ${name}`);
    }
});

// ── ④ مساعدات المالك ───────────────────────────────────────────────────
test('④ مساعدات المالك: سعر/حصة الباقة حُذفت، وإدارة الاشتراك القائم باقية', () => {
    for (const name of ['storePriceError', 'storePlanPriceArgs', 'storePlanFromConfig',
        'storeQuotaDisableWarning']) {
        assert.doesNotMatch(LABELS_JS, new RegExp(`export function ${name}`), `المساعد ${name} ما زال مصدَّرًا`);
    }
    assert.match(LABELS_JS, /export function storeResumeBasis/, 'storeResumeBasis حُذف — وهو لازم لإدارة الاشتراك القائم');
    assert.match(LABELS_JS, /export function storeReasonError/, 'storeReasonError حُذف');
    assert.match(LABELS_JS, /export function storeEndDateError/, 'storeEndDateError حُذف');
    assert.match(LABELS_JS, /export const STORE_FEATURE_LABELS/, 'STORE_FEATURE_LABELS حُذف');
});

// ── ⑤ الترحيل 162 ──────────────────────────────────────────────────────
test('⑤ الترحيل 162: مزايا المتجر للفائقة، والدوال المتقاعدة ترفض برسالة الدمج', () => {
    assert.match(MIGRATION, /162_store_into_super/, 'اسم الترحيل غائب من الملف نفسه');
    for (const f of ['integrations_hub', 'shopify_integration', 'store_support']) {
        assert.match(MIGRATION, new RegExp(`'ultimate'[^;]*'${f}'|plan_features[^;]*'${f}'`),
            `منح ${f} للفائقة غائب من الترحيل`);
    }
    assert.match(MIGRATION, /merged_into/, 'علامة الدمج merged_into غائبة من owner_store_plan_config');
    assert.match(MIGRATION, /دُمجت/, 'رسالة الدمج غائبة من الترحيل');
    for (const fn of ['owner_set_store_plan_price', 'owner_store_grant_exception',
        'owner_set_store_plan_quota_features']) {
        assert.match(MIGRATION, new RegExp(`create or replace function public\\.${fn}`),
            `الدالة المتقاعدة ${fn} غير معرّفة في الترحيل`);
    }
    assert.match(MIGRATION, /plan_price_monthly/, 'الاحتياطي لسعر الاشتراك الشهري المخزّن غائب من owner_store_change_cycle');
    assert.match(MIGRATION, /plan_price_yearly/, 'الاحتياطي لسعر الاشتراك السنوي المخزّن غائب من owner_store_change_cycle');
    assert.match(MIGRATION, /'support', 'ultimate'/, 'قيد خطة التجربة لم يُضيَّق إلى support/ultimate');
});

test('⑤ التراجع 162 موجود ويعيد الفائقة بلا مزايا المتجر والدوال المتقاعدة لحالها', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'migrations/_rollback/162_store_into_super.down.sql')),
        'ملف التراجع غائب');
    assert.match(ROLLBACK, /delete from public\.plan_features/, 'التراجع لا يحذف صفوف plan_features الممنوحة');
    assert.match(ROLLBACK, /'support', 'ultimate', 'store'/, 'التراجع لا يعيد قيد خطة التجربة إلى 3 خطط');
    assert.match(ROLLBACK, /owner_set_store_plan_price/, 'التراجع لا يعيد دالة السعر');
});

// ── ⑥ التجربة المجانية ─────────────────────────────────────────────────
test('⑥ التجربة: باقة المتاجر ليست خيار تجربة، وتسميتها باقية لعرض القديم فقط', () => {
    assert.doesNotMatch(TRIAL_JS, /TRIAL_PLAN_KEYS = \[[^\]]*'store'/, 'store ما زالت في TRIAL_PLAN_KEYS');
    assert.match(TRIAL_JS, /TRIAL_PLAN_KEYS = \['support', 'ultimate'\]/, 'TRIAL_PLAN_KEYS ليست support/ultimate');
    assert.match(TRIAL_JS, /store: 'باقة المتاجر الإلكترونية'/, 'تسمية store للعرض القديم حُذفت من TRIAL_PLAN_LABELS');
});
