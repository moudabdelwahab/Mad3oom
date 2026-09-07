/**
 * company-data.js — طبقة قراءة/كتابة بيانات الشركة.
 *
 * كل شيء هنا بيمر على دوال قاعدة البيانات (RPC) اللي أضافها
 * migrations/016_company_dashboard.sql، مش على الجداول مباشرة. السبب أمني
 * وصريح: الدوال دي **لا تأخذ معرّف شركة كمُعامل** — الشركة بتتحدد من
 * auth.uid() جوّه القاعدة. يعني مفيش أي مُعامل في أي نداء هنا يقدر يوجّه
 * الطلب لشركة تانية، حتى لو اتعدّل الطلب يدويًا من المتصفح.
 *
 * نفس اصطلاح customer-data.js: كل دالة بترجّع { ok, data, error } بدل ما
 * ترمي استثناء، عشان فشل قسم ما يوقّعش اللوحة كلها.
 */

import { supabase } from '/api-config.js';

async function safe(label, fn) {
    try {
        const data = await fn();
        return { ok: true, data, error: null };
    } catch (err) {
        console.error(`[CompanyData] ${label}:`, err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تحميل البيانات' };
    }
}

/**
 * حمولة لوحة الشركة كاملة (بيانات الشركة + اشتراكاتها + امتيازاتها).
 * بترجّع data = null لو المستخدم مش تابع لأي شركة — وده مش خطأ، ده حالة.
 */
export async function fetchCompanyDashboard() {
    return safe('companyDashboard', async () => {
        const { data, error } = await supabase.rpc('get_my_company_dashboard');
        if (error) throw error;
        return data || null;
    });
}

/** فحص امتياز مفرد على مستوى الشركة (نفس مصدر اللوحة). */
export async function checkCompanyFeature(featureKey) {
    return safe('companyFeature', async () => {
        const { data, error } = await supabase.rpc('company_has_feature', { p_feature_key: featureKey });
        if (error) throw error;
        return data === true;
    });
}

/**
 * إنشاء/تحديث بيانات شركة المستخدم الحالي.
 * القاعدة هي اللي بتفرض: المالك فقط يعدّل، والعضو الفرعي يُرفض، ورقم السجل
 * التجاري فريد. الواجهة بتعرض رسالة القاعدة زي ما هي (كلها بالعربي).
 */
export async function saveCompany(values) {
    return safe('saveCompany', async () => {
        const { data, error } = await supabase.rpc('upsert_my_company', {
            p_company_name: values.companyName,
            p_commercial_registration_number: values.crNumber,
            p_commercial_registration_expiry: values.crExpiry,
            p_company_email: values.companyEmail || null,
            p_company_phone: values.companyPhone || null,
            p_address: values.address || null,
            p_city: values.city || null,
            p_country: values.country || null,
            p_tax_id: values.taxId || null
        });
        if (error) throw error;
        return data;
    });
}

/**
 * ربط اشتراك أنشأه المستخدم للتو بشركته.
 * بترجّع false لو الاشتراك مش بتاعه أو مربوط قبل كده — القاعدة بتتأكد،
 * مش الواجهة.
 */
export async function linkSubscriptionToCompany(subscriptionId) {
    return safe('linkSubscription', async () => {
        const { data, error } = await supabase.rpc('link_subscription_to_my_company', {
            p_subscription_id: subscriptionId
        });
        if (error) throw error;
        return data === true;
    });
}

/**
 * الباقات التي تستلزم شركة. بيانات مش شرط في الكود: أي باقة جديدة
 * requires_company = true بتدخل المسار تلقائيًا.
 */
export async function fetchCompanyRequiringPlans() {
    return safe('companyRequiringPlans', async () => {
        const { data, error } = await supabase
            .from('subscription_plans')
            .select('key, name, name_ar, requires_company')
            .eq('is_active', true)
            .eq('requires_company', true);
        if (error) throw error;
        return data || [];
    });
}

/** هل المستخدم الحالي تابع لأي شركة؟ (لإظهار مدخل اللوحة في القائمة) */
export async function hasCompany() {
    try {
        const { data, error } = await supabase.rpc('current_company_id');
        if (error) throw error;
        return !!data;
    } catch (err) {
        console.error('[CompanyData] hasCompany:', err?.message || err);
        return false;
    }
}
