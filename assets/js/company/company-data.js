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

/**
 * نوع الحساب كما يحسبه الخادم (my_account_kind، الترحيل 095): company_admin |
 * company_employee | company_customer | … . data = null قبل 095 (الدالة غير موجودة)،
 * فتبقى اللوحة كما كانت.
 */
export async function fetchAccountKind() {
    return safe('accountKind', async () => {
        const { data, error } = await supabase.rpc('my_account_kind');
        if (error && (['PGRST202', '42883', 'PGRST404'].includes(error.code) || error.status === 404)) return null;
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
 * تحديث بيانات شركة المستخدم الحالي (لوحة الشركة).
 * القاعدة هي اللي بتفرض: المالك فقط يعدّل، والعضو الفرعي يُرفض، ورقم السجل
 * التجاري فريد. الواجهة بتعرض رسالة القاعدة زي ما هي (كلها بالعربي).
 * إنشاء شركة جديدة مش هنا: بقى طلبًا تراجعه الإدارة (submitCompanyAccountRequest).
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
 * طلب تحويل حساب المستخدم الحالي إلى حساب شركة (migrations/068).
 * لا يُنشئ شركة: الطلب ينتظر موافقة الإدارة، والموافقة هي اللي بتُنشئها.
 * صاحب الطلب بيتحدد من auth.uid() في القاعدة، فمفيش مُعامل هنا يوجّهه
 * لحساب تاني. الباقة ودورة الفوترة بيتسجّلوا عشان إخطار الموافقة يقول
 * للعميل يكمل اشتراكه فيها.
 */
export async function submitCompanyAccountRequest(values, { plan = null, billingCycle = null } = {}) {
    return safe('submitCompanyAccountRequest', async () => {
        const { data, error } = await supabase.rpc('submit_company_account_request', {
            p_company_name: values.companyName,
            p_commercial_registration_number: values.crNumber,
            p_commercial_registration_expiry: values.crExpiry,
            p_company_email: values.companyEmail || null,
            p_company_phone: values.companyPhone || null,
            p_requested_plan: plan || null,
            p_requested_billing_cycle: billingCycle || null
        });
        if (error) throw error;
        return data;
    });
}

/**
 * آخر طلب حساب شركة للمستخدم الحالي (الطلب قيد المراجعة أولًا)، أو null.
 * بيرجّع الحالة وسبب الرفض بس — مش بيانات الشركة القانونية كاملة.
 */
export async function fetchMyCompanyAccountRequest() {
    return safe('myCompanyAccountRequest', async () => {
        const { data, error } = await supabase.rpc('my_company_account_request');
        if (error) throw error;
        return data || null;
    });
}

/**
 * أعضاء الشركة (المالك + المستخدمون الفرعيون).
 * بلا مُعاملات — الشركة تُشتق من auth.uid() في القاعدة.
 */
export async function fetchCompanyMembers() {
    return safe('companyMembers', async () => {
        const { data, error } = await supabase.rpc('company_members');
        if (error) throw error;
        return data || null;
    });
}

/**
 * إنشاء مستخدم فرعي تابع لشركة المستخدم الحالي.
 *
 * المسار: Edge Function اسمها create-sub-user (موجودة ومنشورة بالفعل —
 * supabase/functions/create-sub-user/index.ts). العقد الفعلي كما هو في الملف:
 *
 *   POST  { email, password, full_name }
 *   Authorization: Bearer <access_token>   ← يضيفه supabase-js تلقائيًا من
 *                                            الجلسة الحالية، فمفيش تمرير يدوي
 *                                            لأي رمز هنا.
 *   200 → { success: true, user: { id, email, full_name } }
 *   401 → لا رأس تفويض | 403 → رتبة غير كافية | 400 → بيانات ناقصة/إنشاء فشل
 *
 * **super_user_id لا يُرسَل في الطلب إطلاقًا** — الدالة تشتقّه من هوية المنادي
 * المتحقَّق منها. ده اللي بيمنع تزوير تبعية الحساب، وعشان كده الواجهة
 * لا تملك ولا تحتاج أي معرّف شركة هنا.
 *
 * بوابة الصلاحية قبل النداء: نعيد قراءة can_manage من company_members()
 * (دالة SECURITY DEFINER في القاعدة) في نفس اللحظة. الغرض إن مصدر القرار
 * يكون الخادم وقت الإرسال، لا حالة محفوظة في الصفحة ولا زر ظاهر في الشاشة.
 *
 * والخادم يفحص بنفسه أيضًا: الدالة تنادي sub_user_create_context() (الترحيل
 * 037) فتقرّر القاعدة المسار — مدير الشركة يُنشئ عضوًا تابعًا، وطاقم المنصة
 * يُنشئ حسابًا مستقلًا من لوحة الإدارة. فالبوابة هنا توفّر رحلة فاشلة،
 * والحاجز الفعلي على الخادم.
 */
export async function createCompanyMember({ fullName, email, password }) {
    const permission = await fetchCompanyMembers();

    if (!permission.ok) {
        return { ok: false, data: null, error: 'تعذّر التحقق من صلاحيتك الآن. حاول مرة أخرى.' };
    }
    if (permission.data?.can_manage !== true) {
        return {
            ok: false,
            data: null,
            error: 'حسابك غير مخوَّل بإضافة مستخدمين لهذه الشركة. الإضافة متاحة لمالك الحساب عند وجود اشتراك يمنح ميزة المستخدمين الفرعيين.'
        };
    }

    return safe('createCompanyMember', async () => {
        const { data, error } = await supabase.functions.invoke('create-sub-user', {
            body: {
                email: String(email || '').trim().toLowerCase(),
                password,
                full_name: String(fullName || '').trim()
            }
        });

        // ردود الخطأ من Edge Function بتوصل في error.context (Response)، مش
        // في data. من غير القراءة دي كان المستخدم هيشوف "خطأ غير معروف" بدل
        // رسالة الخادم الحقيقية.
        if (error) throw new Error(await readFunctionError(error, 'تعذّر إنشاء المستخدم. حاول مرة أخرى.'));
        if (data?.error) throw new Error(data.error);
        if (!data?.success) throw new Error('تعذّر إنشاء المستخدم. حاول مرة أخرى.');

        return data.user || null;
    });
}

/**
 * يستخرج رسالة الخطأ من رد Edge Function غير الناجح.
 * رسائل الدوال دي كلها بالعربي أصلًا، فبنعرضها زي ما هي بدل ترجمة تانية.
 */
async function readFunctionError(error, fallback = 'تعذّر تنفيذ الطلب. حاول مرة أخرى.') {
    try {
        const body = await error?.context?.json?.();
        if (body?.error) return body.error;
    } catch { /* الرد مش JSON — نكمّل للرسالة العامة */ }
    return error?.message || fallback;
}

/**
 * إنشاء مفتاح API لحساب الشركة.
 *
 * المسار: Edge Function اسمها create-api-token — **منشورة بالفعل** على
 * الإنتاج (قُرئ مصدرها منه، لا من الذاكرة)، وعقدها كما هو في
 * assets/js/company/api-token-model.js.
 *
 *   POST { name, description?, credential_type?, scopes?, expires_at? }
 *   Authorization: Bearer <access_token>  ← يضيفه supabase-js من الجلسة،
 *                                           فمفيش تمرير يدوي لأي رمز هنا.
 *   200 → { token, secret } | { token, bearer_token } | { credential_group_id, … }
 *
 * **user_id لا يُرسَل إطلاقًا** — الدالة تشتقّه من الجلسة المتحقَّق منها،
 * فلا سبيل لإنشاء مفتاح باسم حساب آخر مهما عُدِّل الطلب.
 *
 * بوابة الاستحقاق قبل النداء: نعيد قراءة company_has_feature('api_tokens')
 * من القاعدة في نفس اللحظة — نفس نمط createCompanyMember. القرار من الخادم
 * لا من حالة محفوظة في الصفحة ولا من زر ظاهر.
 *
 * والخادم يفحص الآن نفس الشرط بنفسه: create-api-token (v26) تنادي
 * api_token_issue_context() فترفض من لا يستحق بـ403، وترفض أي صلاحية خارج
 * سقف حسابه. فالبوابة هنا توفّر رحلة فاشلة، والحاجز الفعلي على الخادم.
 */
export async function createCompanyApiToken(payload) {
    const entitled = await checkCompanyFeature('api_tokens');

    if (!entitled.ok) {
        return { ok: false, data: null, error: 'تعذّر التحقق من استحقاق حسابك الآن. حاول مرة أخرى.' };
    }
    if (entitled.data !== true) {
        return {
            ok: false,
            data: null,
            error: 'باقتك الحالية لا تشمل مفاتيح API. فعّل باقة تمنح ميزة api_tokens ثم أعد المحاولة.'
        };
    }

    return safe('createCompanyApiToken', async () => {
        const { data, error } = await supabase.functions.invoke('create-api-token', { body: payload });

        if (error) throw new Error(await readFunctionError(error, 'تعذّر إنشاء المفتاح. حاول مرة أخرى.'));
        if (data?.error) throw new Error(data.error);
        if (!data) throw new Error('تعذّر إنشاء المفتاح. حاول مرة أخرى.');

        return data;
    });
}

/**
 * إزالة عضو من الشركة — قطع علاقة لا حذف حساب.
 *
 * المسار: دالة القاعدة remove_company_member (الترحيل 035). لا تأخذ معرّف
 * شركة إطلاقًا: النطاق يُشتق من auth.uid() داخلها، وشرط
 * `super_user_id = المنادي` هو ما يمنع الـIDOR — فمعرّف عضو في شركة أخرى
 * لا يطابق أي صف مهما أُرسل.
 *
 * حذف صف البروفايل كان ممكنًا قبل 035 لمالك الشركة، وكان ينتج حسابًا قادرًا
 * على الدخول بلا بروفايل. الإزالة الآن تقطع العلاقة ويسقط دور الشركة معها
 * بمحفّز، والحساب يبقى حسابًا شخصيًا.
 */
export async function removeCompanyMember(memberId) {
    return safe('removeCompanyMember', async () => {
        const { data, error } = await supabase.rpc('remove_company_member', {
            p_member_id: memberId
        });
        if (error) throw error;
        return data;
    });
}

/* ── فريق الشركة (migrations/086_company_staff.sql) ──────────────────────
 *
 * الموظفون (مشرف/موظف دعم) عضوية صريحة منفصلة عن عملاء الشركة. كل الدوال
 * بلا معرّف شركة: الشركة تُشتق من auth.uid() في القاعدة، والهدف يجب أن يكون
 * تابعًا لشركة المنادي وإلا رُفض بنفس الخطأ للحساب الغريب وغير الموجود.
 *
 * قبل تطبيق 086 على القاعدة الدوال غير موجودة: نرجّع data = null بلا خطأ،
 * فيختفي الجزء من الواجهة ولا ينكسر شيء — الواجهة والقاعدة تُنشران بأي ترتيب.
 */
const MISSING_RPC_CODES = new Set(['PGRST202', '42883', 'PGRST404']);
const isMissingRpc = (error) => !!error && (MISSING_RPC_CODES.has(error.code) || error.status === 404);

/** فريق شركة المنادي — null لعميل الشركة، ولمن لا شركة له، وقبل 086. */
export async function fetchCompanyStaff() {
    return safe('companyStaff', async () => {
        const { data, error } = await supabase.rpc('company_staff_list');
        if (isMissingRpc(error)) return null;
        if (error) throw error;
        return data || null;
    });
}

/** منح دور موظف (supervisor | agent) لتابع، أو تغيير دوره. القرار في القاعدة. */
export async function setCompanyStaffRole(userId, role) {
    return safe('setCompanyStaffRole', async () => {
        const { data, error } = await supabase.rpc('company_staff_set', {
            p_user: userId,
            p_role: role
        });
        if (error) throw error;
        return data;
    });
}

/** إلغاء دور الموظف: يعود الحساب عميلًا للشركة كما كان. */
export async function revokeCompanyStaff(userId) {
    return safe('revokeCompanyStaff', async () => {
        const { data, error } = await supabase.rpc('company_staff_revoke', {
            p_user: userId
        });
        if (error) throw error;
        return data;
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

/* ── عملاء الشركة ودعواتهم (migrations/096_company_memberships.sql) ─────────
 *
 * company_customers_list(): للمدير والمشرف، العملاء النشطون بلا الموظفين وبلا أي أثر
 * لعضوياتهم في شركات أخرى. الدعوة بالبريد للمدير (+ sub_users) والمفتاح مفعّل؛ الرد
 * واحد دائمًا ({status: 'pending'}) فلا يكشف وجود حساب. قبل 096: data = null بلا خطأ.
 */
export async function fetchCompanyCustomers() {
    return safe('companyCustomers', async () => {
        const { data, error } = await supabase.rpc('company_customers_list');
        if (isMissingRpc(error)) return null;
        if (error) throw error;
        return data || null;
    });
}

export async function fetchCompanyInvitations() {
    return safe('companyInvitations', async () => {
        const { data, error } = await supabase.rpc('company_invitations_list');
        if (isMissingRpc(error)) return null;
        if (error) throw error;
        return Array.isArray(data) ? data : null;
    });
}

export async function inviteCompanyCustomer(email) {
    return safe('inviteCompanyCustomer', async () => {
        const { data, error } = await supabase.rpc('company_invite_customer', { p_email: email });
        if (error) throw error;
        return data;
    });
}

export async function cancelCompanyInvitation(invitationId) {
    return safe('cancelCompanyInvitation', async () => {
        const { data, error } = await supabase.rpc('company_invitation_cancel', { p_invitation: invitationId });
        if (error) throw error;
        return data;
    });
}

/* ── صلاحيات الفريق وتذاكر الشركة (migrations/098_company_permissions_usage_ledger.sql) ──
 *
 * my_company_permissions(): للفريق وحده (null للعميل وقبل 098). المفتاح company_permissions_enabled
 * يقرر هل يرى الفريق تذاكر الشركة؛ company_tickets_list() تحصر الصفوف بالصلاحية صفًا صفًا
 * (كلها للمشرف، المسندة لموظف الدعم افتراضيًا)، بلا معرّف شركة من المتصفح.
 */
export async function fetchMyCompanyPermissions() {
    return safe('companyPermissions', async () => {
        const { data, error } = await supabase.rpc('my_company_permissions');
        if (isMissingRpc(error)) return null;
        if (error) throw error;
        return data || null;
    });
}

export async function fetchCompanyScopeTickets() {
    const { data, error } = await supabase.rpc('company_tickets_list');
    if (error) throw error;
    return Array.isArray(data) ? data : [];
}

/** الحالة والإسناد عبر الدالتين فقط؛ ترميان الخطأ ليعرضه قسم التذاكر في مكانه. */
export async function setCompanyTicketStatus(ticketId, status) {
    const { data, error } = await supabase.rpc('company_ticket_set_status', { p_ticket: ticketId, p_status: status });
    if (error) throw error;
    return data;
}

export async function assignCompanyTicket(ticketId, assigneeId) {
    const { data, error } = await supabase.rpc('company_ticket_assign', { p_ticket: ticketId, p_assignee: assigneeId || null });
    if (error) throw error;
    return data;
}
