/**
 * Subscription Service
 * Manages subscription requests for all plans (support / whatsapp / bundle).
 *
 * NOTE: kept at this file path (/whatsapp-subscription-service.js) so any other
 * page that already imports from here keeps working. Internally it is now
 * generic across all three plans via the `plan` + `billing_cycle` columns on
 * public.whatsapp_subscriptions.
 *
 * BREAKING CHANGE vs the previous version of this file:
 *   createSubscriptionTicket(planType) -> createSubscriptionTicket(plan, billingCycle)
 *   renewSubscription(planType)        -> renewSubscription(plan, billingCycle)
 * If any other page still calls these with the old single-argument signature,
 * it needs to be updated to pass both a plan id and a billing cycle.
 *
 * This module intentionally contains NO payment provider logic (no Stripe, no
 * price IDs, no payment links). It only creates a subscription *request*
 * (a ticket + a pending row). Activation happens later via
 * confirmPurchaseTicket() (admin side), once a payment provider is wired up.
 *
 * ملاحظة (تحديث): انتهاء الاشتراكات (end_date فات) بقى بيتم تلقائيًا كل ساعة
 * عبر Postgres function مجدولة بـ pg_cron اسمها expire_stale_subscriptions()
 * (شوف migration: auto_expire_subscriptions_scheduled_job). الدالة دي بتحول
 * الحالة لـ 'expired' وتقفل profiles.whatsapp_enabled تلقائيًا لو مفيش
 * اشتراك واتساب/باقة نشط تاني للعميل، وتبعت إشعار له. expireSubscription()
 * هنا اتسابت كمان كإجراء يدوي احتياطي من لوحة الإدارة، وبتعمل نفس المنطق.
 *
 * ملاحظة (تحديث جديد): ترقية/تنزيل رتبة العميل (profiles.role) بقت مرتبطة
 * بخطط الاشتراك:
 *   - اشتراك "الدعم الفني" أو "دعم فني + واتساب" (support / bundle) ->
 *     العميل بيترقّى تلقائيًا لـ super_user عند تأكيد الاشتراك (لو كان
 *     رتبته 'user' بالظبط، عشان منلمسش أدمن أو رتب خاصة تانية بالغلط).
 *   - اشتراك "واتساب" بس (whatsapp) -> الرتبة تفضل زي ما هي (user).
 *   - لو الاشتراك انتهى (expired) ومفيش اشتراك support/bundle نشط تاني
 *     للعميل، الرتبة بترجع تلقائيًا لـ user (بس لو كانت super_user
 *     بالظبط، عشان منلمسش أدمن).
 *
 * ملاحظة (تحديث جديد - معالجة التواريخ + تتبع الموظف):
 *   كان start_date/end_date بيتسجلوا وقت إنشاء طلب الاشتراك (createSubscriptionTicket)
 *   نفسه، يعني العميل كان بيبدأ ياخد من عمر اشتراكه وهو لسه pending ومستني
 *   موافقة الإدارة. اتصلح المنطق بحيث:
 *     - وقت إنشاء الطلب: بنسجل بس duration_days (ومدة تقديرية placeholder
 *       في start_date/end_date لإن العمود مطلوب)، وبنعلّم الطلب لو تجديد
 *       (is_renewal) مع تاريخ انتهاء الاشتراك الحالي (previous_end_date).
 *     - وقت التأكيد (confirmPurchaseTicket): بنحسب start_date/end_date
 *       الحقيقيين دلوقتي فقط:
 *         * اشتراك جديد -> من لحظة التأكيد.
 *         * تجديد -> من previous_end_date لو لسه في المستقبل (تمديد فعلي)،
 *           أو من لحظة التأكيد لو الاشتراك القديم خلص بالفعل قبل ما حد يراجع
 *           الطلب.
 *   وكمان بقى بيتسجل reviewed_by/reviewed_at (هوية الموظف اللي أكّد أو رفض)
 *   على whatsapp_subscriptions، و last_updated_by/last_updated_at على
 *   tickets، عشان يظهر اسم موظف الدعم في لوحة الإدارة.
 */

import { supabase } from '/api-config.js';
import { createNotification } from '/notifications-service.js';
import { uploadTicketAttachment } from '/tickets-service.js';

export const PLANS = ['support', 'whatsapp', 'bundle'];
export const BILLING_CYCLES = ['monthly', 'yearly'];

export const PLAN_LABELS = {
    support: 'الدعم الفني',
    whatsapp: 'واتساب',
    bundle: 'دعم فني + واتساب'
};

export const BILLING_LABELS = {
    monthly: 'شهري',
    yearly: 'سنوي'
};

// وسائل الدفع المتاحة لطلب الاشتراك
// كل وسيلة غير "gateway" تعتبر "تحويل خارجي": تتطلب إثبات (صورة/PDF) إلزامي
// ومراجعة من فريق الدعم خلال ساعة كحد أقصى.
export const PAYMENT_METHODS = [
    'bank_transfer',
    'cash_wallet',
    'instapay',
    'gateway'
];

export const PAYMENT_METHOD_LABELS = {
    bank_transfer: 'تحويل بنكي',
    cash_wallet: 'محفظة كاش',
    instapay: 'إنستاباي',
    gateway: 'بوابة دفع إلكترونية (داخلية)'
};

// وسائل التحويل الخارجي (كلها بتتطلب إثبات + مراجعة خلال ساعة)، مقابل
// "gateway" اللي هي الوسيلة الداخلية الوحيدة ومش بتتطلب إثبات حاليًا.
export const EXTERNAL_PAYMENT_METHODS = PAYMENT_METHODS.filter((m) => m !== 'gateway');

// أنواع الملفات المسموح بها كإثبات تحويل، وحجمها الأقصى
const PROOF_ALLOWED_MIME_PREFIXES = ['image/'];
const PROOF_ALLOWED_MIME_EXACT = ['application/pdf'];
const PROOF_MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

// أقصى مدة مسموح بها لمراجعة أي طلب تحويل خارجي (بنكي أو محفظة) قبل التأكيد/الرفض
const EXTERNAL_PAYMENT_REVIEW_SLA_MS = 60 * 60 * 1000; // ساعة واحدة


function assertValidPlan(plan) {
    if (!PLANS.includes(plan)) {
        throw new Error(`Invalid plan: ${plan}. Expected one of: ${PLANS.join(', ')}`);
    }
}

function assertValidBillingCycle(billingCycle) {
    if (!BILLING_CYCLES.includes(billingCycle)) {
        throw new Error(`Invalid billing cycle: ${billingCycle}. Expected one of: ${BILLING_CYCLES.join(', ')}`);
    }
}

/**
 * يتأكد إن وسيلة الدفع محددة وصحيحة. اختيار وسيلة الدفع إلزامي لأي طلب اشتراك
 * (جديد أو تجديد) - مفيش قيمة افتراضية.
 */
function assertValidPaymentMethod(paymentMethod) {
    if (!paymentMethod || !PAYMENT_METHODS.includes(paymentMethod)) {
        throw new Error('يجب اختيار وسيلة الدفع (تحويل بنكي خارجي أو بوابة دفع داخلية) قبل إرسال طلب الاشتراك.');
    }
}

/**
 * لو وسيلة الدفع "تحويل بنكي خارجي"، إرفاق صورة أو PDF لإثبات التحويل إلزامي.
 * وسيلة "بوابة الدفع الداخلية" لسه مش شرط ليها إثبات (لحد ما تتفعّل فعليًا).
 */
function assertValidProofFile(paymentMethod, proofFile) {
    if (!EXTERNAL_PAYMENT_METHODS.includes(paymentMethod)) return;

    if (!proofFile) {
        throw new Error('التحويل البنكي الخارجي يتطلب إرفاق صورة أو ملف PDF لإثبات التحويل.');
    }

    const mimeType = proofFile.type || '';
    const isAllowedType =
        PROOF_ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) ||
        PROOF_ALLOWED_MIME_EXACT.includes(mimeType);

    if (!isAllowedType) {
        throw new Error('إثبات التحويل يجب أن يكون صورة (JPG/PNG...) أو ملف PDF فقط.');
    }

    if (proofFile.size > PROOF_MAX_SIZE_BYTES) {
        throw new Error('حجم ملف إثبات التحويل كبير جدًا. الحد الأقصى 8 ميجابايت.');
    }
}

/**
 * يضيف فترة اشتراك واحدة (شهر أو سنة تقويميًا) لتاريخ معين ويرجع تاريخ جديد.
 */
function addBillingPeriod(baseDate, billingCycle) {
    const d = new Date(baseDate);
    if (billingCycle === 'yearly') {
        d.setFullYear(d.getFullYear() + 1);
    } else {
        d.setMonth(d.getMonth() + 1);
    }
    return d;
}

/**
 * إعادة حساب صلاحيات العميل بعد أي تغيير في اشتراكاته.
 *
 * كان هنا أربع دوال تدير رتبة super_user من الواجهة (ترقية عند الشراء، تنزيل
 * عند الانتهاء، وفحصان مساعدان بأسماء باقات مثبَّتة نصًّا). أُزيلت كلها في
 * إصلاح C2/H4 لسببين:
 *
 *   • **الرتبة لم تعد تُشتق من الاشتراك.** امتلاك اشتراك يمنح Entitlements ولا
 *     يمنح سلطة إدارية. ملكية الشركة تُشتق من العلاقة (companies.user_id و
 *     profiles.super_user_id) لا من قيمة في عمود role.
 *   • **كانت تفشل صامتة أصلًا.** حارس القاعدة يشترط الأدمن الرئيسي لأي إسناد
 *     لـsuper_user، والخطأ كان يُبتلع في console.error — فالميزة لم تعمل قط
 *     (صفر صفوف في profiles.super_user_id في الإنتاج).
 *
 * الباقي هنا هو إعادة حساب الامتيازات فقط، ويمر على دالة القاعدة الواحدة
 * بدل تكرار قاعدة «أي باقة تمنح واتساب؟» في الواجهة.
 */
async function recomputeAccess(userId) {
    const { error } = await supabase.rpc('admin_recompute_user_access', { p_user_id: userId });
    if (error) {
        // لا نبتلعه: الأدمن يحتاج أن يعرف أن الصلاحيات لم تُحدَّث.
        console.error('recomputeAccess failed:', error.message);
        return { ok: false, error };
    }
    return { ok: true };
}

/**
 * Create a subscription request ticket for any plan.
 * @param {string} plan - 'support' | 'whatsapp' | 'bundle'
 * @param {string} billingCycle - 'monthly' | 'yearly'
 * @param {Object} options
 * @param {boolean} [options.isRenewal=false] - لو true، بيتم اعتباره طلب تجديد
 *        وبيتم تمديد المدة من تاريخ انتهاء الاشتراك النشط الحالي لنفس الخطة
 *        (لو موجود) بدلاً من احتسابها من الآن.
 * @param {string} options.paymentMethod - إحدى قيم PAYMENT_METHODS (إلزامي).
 * @param {string} [options.paymentReference] - رقم/مرجع التحويل أو ملاحظة اختيارية من العميل.
 * @param {File} [options.proofFile] - صورة أو PDF لإثبات التحويل. إلزامي لو
 *        أي وسيلة غير 'gateway' (تحويل خارجي)، ويُتجاهل تمامًا لو 'gateway'.
 * @returns {Promise<Object>} - { success, ticket, subscription }
 */
export async function createSubscriptionTicket(plan, billingCycle, options = {}) {
    assertValidPlan(plan);
    assertValidBillingCycle(billingCycle);
    assertValidPaymentMethod(options.paymentMethod);
    assertValidProofFile(options.paymentMethod, options.proofFile);

    const isRenewal = !!options.isRenewal;
    const isUpgrade = !!options.isUpgrade;
    const paymentMethod = options.paymentMethod;
    const paymentReference = options.paymentReference ? String(options.paymentReference).trim().slice(0, 500) : null;
    const proofFile = EXTERNAL_PAYMENT_METHODS.includes(paymentMethod) ? options.proofFile : null;

    let createdTicketId = null;
    let createdSubscriptionId = null;

    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        // منع إنشاء طلب اشتراك جديد لنفس الخطة لو فيه طلب pending لسه ماتراجعش
        // (فيه كمان partial unique index على الداتابيز كخط دفاع ثاني، لكن
        // الفحص هنا بيدّي رسالة عربية واضحة بدل ما يظهر خطأ قاعدة بيانات خام).
        const { data: existingPending, error: pendingCheckError } = await supabase
            .from('whatsapp_subscriptions')
            .select('id')
            .eq('user_id', user.id)
            .eq('plan', plan)
            .eq('status', 'pending')
            .maybeSingle();

        if (pendingCheckError) throw pendingCheckError;

        if (existingPending) {
            throw new Error(`عندك بالفعل طلب اشتراك في خطة "${PLAN_LABELS[plan]}" قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.`);
        }

        // قاعدة التداخل: القرار مبني على الخدمات المملوكة فعلًا، لا على اسم
        // الباقة — فالباقة الشاملة تمنع شراء واتساب أو الدعم منفردين تلقائيًا.
        // نفس الدالة تفرضها القاعدة في trigger على الجدول، فالنداء هنا لإظهار
        // السبب بالعربي قبل الإرسال، مش هو الحماية.
        const { data: purchaseCheck, error: purchaseCheckError } = await supabase
            .rpc('subscription_purchase_check', { p_plan: plan, p_is_renewal: isRenewal });

        if (purchaseCheckError) throw purchaseCheckError;
        if (purchaseCheck && purchaseCheck.allowed === false) {
            throw new Error(purchaseCheck.reason || 'لا يمكن الاشتراك في هذه الباقة حاليًا.');
        }

        // لو تجديد: نجيب الاشتراك النشط الحالي لنفس الخطة عشان نعرف من امتى
        // هنمدد. لو مفيش اشتراك نشط فعلاً، الطلب هيتعامل معاه كاشتراك جديد
        // عادي عند التأكيد (هيبدأ من تاريخ التأكيد).
        let previousEndDate = null;
        if (isRenewal) {
            const activeSub = await getActiveSubscription(plan);
            if (activeSub && activeSub.end_date) {
                previousEndDate = new Date(activeSub.end_date);
            }
        }

        const planLabel = PLAN_LABELS[plan];
        const billingLabel = BILLING_LABELS[billingCycle];
        const durationLabel = billingCycle === 'yearly' ? 'سنة واحدة' : 'شهر واحد';
        const paymentMethodLabel = PAYMENT_METHOD_LABELS[paymentMethod];

        // مدة الطلب وتواريخه المبدئية تُحسب كلها في القاعدة داخل
        // request_subscription_purchase. كانت تُحسب هنا وتُرسَل، وهو ما جعل
        // العميل قادرًا على اختيارها. التواريخ الحقيقية تُثبَّت عند التأكيد،
        // فلا يكسب أحد يومًا من عمر اشتراكه وهو pending.

        let description;
        if (isRenewal && previousEndDate) {
            description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nوسيلة الدفع: ${paymentMethodLabel}\nاشتراكك الحالي ينتهي في: ${previousEndDate.toLocaleString('ar-EG')}\nسيتم تمديد الاشتراك لمدة ${durationLabel} إضافية بدءًا من تاريخ الانتهاء الحالي عند تأكيد الطلب من فريق الدعم.`;
        } else if (isRenewal) {
            description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nوسيلة الدفع: ${paymentMethodLabel}\nملاحظة: لم يتم العثور على اشتراك نشط حالي لهذه الخطة، سيتم احتساب المدة من تاريخ تأكيد الطلب.`;
        } else {
            description = `طلب اشتراك جديد\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nوسيلة الدفع: ${paymentMethodLabel}\nسيتم احتساب تاريخ البداية والنهاية الفعلي عند تأكيد الطلب من فريق الدعم.`;
        }

        if (paymentReference) {
            description += `\nمرجع التحويل: ${paymentReference}`;
        }

        const now = new Date();
        const ticketPayload = {
            user_id: user.id,
            title: `${isUpgrade ? 'طلب ترقية ودمج الباقة' : (isRenewal ? 'طلب تجديد اشتراك' : 'طلب اشتراك')} - ${planLabel} (${billingLabel})`,
            description,
            status: 'open',
            priority: 'high'
        };

        // طلبات التحويل البنكي الخارجي لازم تُراجع خلال ساعة كحد أقصى، بغض
        // النظر عن مهلة الـ SLA الافتراضية للأولوية العالية (4 ساعات). القيمة
        // دي بتتحدد صراحةً هنا عشان الـ trigger set_ticket_sla() ما يغيّرهاش
        // (بيتفعّل بس لو العمود NULL وقت الإدراج).
        if (EXTERNAL_PAYMENT_METHODS.includes(paymentMethod)) {
            ticketPayload.sla_response_due_at = new Date(now.getTime() + EXTERNAL_PAYMENT_REVIEW_SLA_MS).toISOString();
            description += `\n\n⚠️ طلب تحويل خارجي (${paymentMethodLabel}) - يجب مراجعته وتأكيده أو رفضه خلال ساعة كحد أقصى من فريق الدعم.`;
            ticketPayload.description = description;
        }

        // Create a support ticket for the subscription request
        const { data: ticket, error: ticketError } = await supabase
            .from('tickets')
            .insert(ticketPayload)
            .select()
            .single();

        if (ticketError) throw ticketError;
        createdTicketId = ticket.id;

        // مسار الترقية: الصف بيتعمل في القاعدة عبر request_subscription_upgrade
        // عشان المبلغ يتحسب هناك ولا يُقبل من العميل، ويرث دورة الاشتراك
        // الحالية بدل ما يبدأ دورة جديدة.
        let subscription;
        if (isUpgrade) {
            const { data: upgradeResult, error: upgradeError } = await supabase
                .rpc('request_subscription_upgrade', {
                    p_plan: plan,
                    p_ticket_id: ticket.id,
                    p_payment_method: paymentMethod,
                    p_payment_reference: paymentReference
                });

            if (upgradeError) {
                await supabase.from('tickets').delete().eq('id', createdTicketId);
                throw upgradeError;
            }

            createdSubscriptionId = upgradeResult.subscription_id;
            const { data: upgradeRow } = await supabase
                .from('whatsapp_subscriptions')
                .select('*')
                .eq('id', createdSubscriptionId)
                .maybeSingle();
            subscription = upgradeRow;
        } else {

        // الإنشاء عبر دالة القاعدة، لا بـINSERT مباشر (إصلاح C1).
        //
        // السبب: سياسة INSERT القديمة كانت تتحقق من auth.uid() = user_id فقط،
        // فكان العميل يكتب لنفسه status='active' وتاريخ انتهاء بعيدًا ويحصل على
        // كل الخدمات مجانًا. لم تعد هناك سياسة INSERT للمستخدم إطلاقًا؛ الدالة
        // هي المسار الوحيد وهي التي تفرض 'pending' وتحسب التواريخ في الخادم.
        //
        // لاحظ أن التوقيع لا يقبل user_id ولا status ولا تواريخ: ما لا يُمرَّر
        // لا يمكن تزويره.
        const { data: created, error: subError } = await supabase
            .rpc('request_subscription_purchase', {
                p_plan: plan,
                p_billing_cycle: billingCycle,
                p_ticket_id: ticket.id,
                p_is_renewal: isRenewal,
                p_payment_method: paymentMethod,
                p_payment_reference: paymentReference
            });

        if (subError) {
            await supabase.from('tickets').delete().eq('id', createdTicketId);
            throw subError;
        }

        createdSubscriptionId = created.subscription_id;
        const { data: createdRow } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('id', createdSubscriptionId)
            .maybeSingle();
        subscription = createdRow;
        }

        // إثبات التحويل (لو تحويل بنكي خارجي) بيتخزن كمرفق عادي على نفس
        // التذكرة، فيظهر تلقائيًا في لوحة الإدارة زي أي مرفق تذكرة تاني.
        if (proofFile) {
            try {
                await uploadTicketAttachment(ticket.id, proofFile);
            } catch (uploadError) {
                console.error('Error uploading subscription payment proof, rolling back:', uploadError);
                // تراجع حقيقي عن الطلب والتذكرة.
                //
                // الكود القديم كان ينادي delete() على الجدولين مباشرة — ولا سياسة
                // DELETE لأي منهما للمستخدم العادي، فالحذف كان **ينجح صامتًا بصفر
                // صفوف** ويترك طلب تحويل بنكي معلّقًا بلا إثبات (Finding N1).
                // الدالة تحذف الاثنين بملكية مُتحقَّق منها، وترجع false لو لم تحذف.
                const { data: cancelled, error: cancelError } =
                    await supabase.rpc('cancel_my_subscription_request', {
                        p_subscription_id: createdSubscriptionId
                    });
                if (cancelError || cancelled !== true) {
                    console.error('rollback failed — طلب معلّق بلا إثبات:', cancelError || 'no rows');
                }
                throw new Error('فشل رفع صورة/ملف إثبات التحويل. حاول مرة أخرى.');
            }
        }

        return {
            success: true,
            ticket,
            subscription
        };
    } catch (error) {
        console.error('Error creating subscription ticket:', error);
        throw error;
    }
}

/**
 * قاعدة الشراء كما تقرّرها قاعدة البيانات — نفس الدالة التي يفرضها الـtrigger.
 * تُستخدم في الواجهة لعرض حالة كل باقة (مملوكة / ترقية / تجديد) بدل تخمينها.
 * @param {string} plan
 * @param {boolean} [isRenewal=false]
 * @returns {Promise<{allowed: boolean, code: string, reason: string}>}
 */
export async function checkPurchaseAllowed(plan, isRenewal = false) {
    try {
        const { data, error } = await supabase
            .rpc('subscription_purchase_check', { p_plan: plan, p_is_renewal: isRenewal });
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error checking purchase eligibility:', error);
        // فشل الفحص لا يفتح الباب: القاعدة هي التي تمنع فعليًا، والواجهة
        // تتصرف بتحفّظ وتترك الزر يحاول ليظهر سبب الرفض الحقيقي.
        return { allowed: true, code: 'check_failed', reason: '' };
    }
}

/**
 * الخدمات التي يملكها العميل فعليًا عبر كل اشتراكاته الفعّالة.
 * مصدر واحد مع لوحة الشركة ولوحة الإدارة.
 * @returns {Promise<string[]>}
 */
export async function getOwnedFeatures() {
    try {
        const { data, error } = await supabase.rpc('owned_feature_keys');
        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('Error fetching owned features:', error);
        return [];
    }
}

/**
 * عرض الترقية كما تحسبه القاعدة (الباقتان، الأيام المتبقية، الفرق، المستحق الآن،
 * وسعر التجديد القادم). الواجهة تعرضه ولا تحسب أي مبلغ بنفسها.
 * @param {string} plan
 * @returns {Promise<Object|null>}
 */
export async function getUpgradeQuote(plan) {
    try {
        const { data, error } = await supabase.rpc('subscription_upgrade_quote', { p_plan: plan });
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error fetching upgrade quote:', error);
        return null;
    }
}

/**
 * أسعار الباقات من قاعدة البيانات — المصدر الوحيد.
 * صفحات الأسعار تملأ منها بدل الاعتماد على قيم مكتوبة في HTML.
 * @returns {Promise<Array<{key,name_ar,price_monthly,price_yearly,currency}>>}
 */
export async function getPlanPrices() {
    try {
        const { data, error } = await supabase
            .from('subscription_plans')
            .select('key, name, name_ar, price_monthly, price_yearly, currency, sort_order')
            .eq('is_active', true)
            .order('sort_order');
        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('Error fetching plan prices:', error);
        return [];
    }
}

/**
 * Get the user's currently active subscription.
 * @param {string} [plan] - Optional: filter to a specific plan ('support' | 'whatsapp' | 'bundle')
 * @returns {Promise<Object|null>}
 */
export async function getActiveSubscription(plan) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const now = new Date().toISOString();

        let query = supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .gt('end_date', now)
            .order('end_date', { ascending: false })
            .limit(1);

        if (plan) {
            assertValidPlan(plan);
            query = query.eq('plan', plan);
        }

        const { data: subscription, error } = await query.maybeSingle();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error fetching active subscription:', error);
        return null;
    }
}

/**
 * Get all of the user's subscriptions (active, pending, expired, rejected).
 * @returns {Promise<Array>}
 */
export async function getUserSubscriptions() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return [];

        const { data: subscriptions, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return subscriptions || [];
    } catch (error) {
        console.error('Error fetching user subscriptions:', error);
        return [];
    }
}

/**
 * Check if the active subscription is expiring soon (within 7 days).
 * @returns {Promise<Object|null>}
 */
export async function checkExpiringSubscription() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .gt('end_date', now.toISOString())
            .lte('end_date', sevenDaysFromNow.toISOString())
            .order('end_date', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error checking expiring subscription:', error);
        return null;
    }
}

/**
 * @param {Date|string} endDate
 * @returns {number} days remaining (never negative)
 */
export function calculateDaysRemaining(endDate) {
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
}

/**
 * Renew a subscription by creating a new request ticket marked as a renewal.
 * المدة الجديدة هتتحسب (عند التأكيد) من تاريخ انتهاء الاشتراك النشط الحالي
 * لنفس الخطة، مش من تاريخ التأكيد نفسه - إلا لو الاشتراك القديم خلص فعلاً.
 * @param {string} plan - 'support' | 'whatsapp' | 'bundle'
 * @param {string} billingCycle - 'monthly' | 'yearly'
 * @param {Object} paymentInfo - نفس خيارات الدفع المطلوبة في createSubscriptionTicket
 * @param {string} paymentInfo.paymentMethod - إحدى قيم PAYMENT_METHODS (إلزامي)
 * @param {string} [paymentInfo.paymentReference]
 * @param {File} [paymentInfo.proofFile] - إلزامي لأي وسيلة تحويل خارجي (كل شيء عدا 'gateway')
 * @returns {Promise<Object>}
 */
export async function renewSubscription(plan, billingCycle, paymentInfo = {}) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        return await createSubscriptionTicket(plan, billingCycle, { ...paymentInfo, isRenewal: true });
    } catch (error) {
        console.error('Error renewing subscription:', error);
        throw error;
    }
}

/**
 * Get subscription status for display, across any plan.
 * @returns {Promise<Object>}
 */
export async function getSubscriptionStatus() {
    try {
        const activeSubscription = await getActiveSubscription();
        const expiringSubscription = await checkExpiringSubscription();

        return {
            hasActiveSubscription: !!activeSubscription,
            activeSubscription,
            isExpiringSoon: !!expiringSubscription,
            expiringSubscription,
            daysRemaining: activeSubscription ? calculateDaysRemaining(activeSubscription.end_date) : 0
        };
    } catch (error) {
        console.error('Error getting subscription status:', error);
        return {
            hasActiveSubscription: false,
            activeSubscription: null,
            isExpiringSoon: false,
            expiringSubscription: null,
            daysRemaining: 0
        };
    }
}

/**
 * Subscribe to real-time subscription updates for the current user.
 * @param {Function} callback
 * @returns {Promise<Function>} unsubscribe function
 */
export async function subscribeToSubscriptionUpdates(callback) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return () => {};

        const channel = supabase
            .channel(`whatsapp_subscriptions_updates_${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'whatsapp_subscriptions',
                    filter: `user_id=eq.${user.id}`
                },
                (payload) => callback(payload)
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    } catch (error) {
        console.error('Error subscribing to subscription updates:', error);
        return () => {};
    }
}

/* ==================== Admin functions ==================== */

/**
 * Mark a subscription as expired (admin function - إجراء يدوي احتياطي).
 * الانتهاء التلقائي بقى بيتم كل ساعة عبر public.expire_stale_subscriptions()
 * المجدولة بـ pg_cron، فالدالة دي غالبًا مش هتتحتاج غير لو الأدمن عايز
 * ينهي اشتراك يدويًا قبل معاده الطبيعي.
 */
export async function expireSubscription(subscriptionId) {
    try {
        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .update({ status: 'expired' })
            .eq('id', subscriptionId)
            .select()
            .single();

        if (error) throw error;

        if (subscription) {
            // الامتيازات تُعاد حسابها من محرك واحد في القاعدة. الكود القديم كان
            // يكرر هنا قاعدة «أي باقة تمنح واتساب؟» بأسماء مثبَّتة نصًّا، فكان
            // يختلف عن المحرك عند إضافة أي باقة جديدة. والرتبة لم تعد تُلمس.
            await recomputeAccess(subscription.user_id);
        }

        if (subscription) {
            await createNotification({
                userId: subscription.user_id,
                title: 'انتهى اشتراكك',
                message: `انتهت صلاحية اشتراكك (${PLAN_LABELS[subscription.plan] || subscription.plan}). يمكنك التجديد من صفحة الاشتراكات.`,
                type: 'warning',
                link: '/customer-subscriptions.html'
            });
        }

        return subscription;
    } catch (error) {
        console.error('Error expiring subscription:', error);
        throw error;
    }
}

/**
 * Activate a pending subscription directly (admin function).
 */
export async function activateSubscription(subscriptionId) {
    try {
        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .update({ status: 'active' })
            .eq('id', subscriptionId)
            .select()
            .single();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error activating subscription:', error);
        throw error;
    }
}

/**
 * Confirm a subscription request ticket: activates the subscription and the
 * ticket, flips profiles.whatsapp_enabled on for plans that include
 * WhatsApp access ('whatsapp' and 'bundle'), ترقّي رتبة العميل لـ
 * super_user لخطط 'support' و'bundle'، وبتبلّغ العميل. Plan-specific
 * entitlement logic لسه موجودة هنا في مكان واحد عشان لو زودنا خطط تانية
 * بعدين يبقى سهل نتحكم فيها.
 *
 * التواريخ الفعلية (start_date/end_date) بيتم احتسابها هنا فقط - وقت
 * التأكيد - مش وقت إنشاء الطلب:
 *   - اشتراك جديد (is_renewal = false): من لحظة التأكيد دلوقتي.
 *   - تجديد (is_renewal = true) مع previous_end_date في المستقبل: من
 *     previous_end_date نفسه (تمديد فعلي للمدة المتبقية + المدة الجديدة).
 *   - تجديد لكن previous_end_date فات بالفعل قبل ما حد يراجع الطلب: من
 *     لحظة التأكيد (زي الاشتراك الجديد بالظبط).
 *
 * حراسة الأمان (idempotency):
 *   - لو مفيش صف في whatsapp_subscriptions مرتبط بالـ ticket_id ده، العملية
 *     بتتوقف فورًا وبترجع error واضح — والتذكرة نفسها ما بتتلمسش (تفضل
 *     زي ما هي، مش confirmed).
 *   - التفعيل بيحصل فقط لو حالة الاشتراك كانت 'pending' وقت التنفيذ. الـ
 *     update بيتعمل بشرط .eq('status', 'pending') في نفس الاستعلام، فلو
 *     الدالة اتنادت مرتين (أو نودّي عليها بالغلط) على نفس التذكرة، المرة
 *     التانية مش هتلاقي صف يطابق الشرط (لإن الحالة بقت active بالفعل)،
 *     فمش هتعمل ولا ترقية رتبة ولا تفعيل واتساب ولا إشعار تاني، وهترجع
 *     error واضح بدل ما تكرر التفعيل بصمت.
 * @param {string} ticketId
 * @returns {Promise<Object>}
 */
export async function confirmPurchaseTicket(ticketId) {
    try {
        console.log('Confirming purchase ticket:', ticketId);

        const { data: { user: adminUser } } = await supabase.auth.getUser();

        const { data: subscription, error: fetchError } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('ticket_id', ticketId)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (!subscription) {
            console.error('confirmPurchaseTicket: no whatsapp_subscriptions row linked to ticket', ticketId);
            return {
                success: false,
                error: 'لا يوجد سجل اشتراك مرتبط بهذه التذكرة (whatsapp_subscriptions). لم يتم تأكيد التذكرة.'
            };
        }

        // الترقية لها مسار تأكيد خاص: تفعيل الجديد بنفس دورة القديم + تعليم
        // القديم superseded + إعادة حساب الامتيازات + تدقيق، كلها في معاملة
        // واحدة داخل القاعدة. لا يمكن تنفيذها بخطوات متفرقة من المتصفح لأن
        // أي فشل بينها كان هيسيب اشتراكين فعّالين متداخلين.
        if (subscription.upgraded_from_subscription_id) {
            const { data: upgradeResult, error: upgradeError } = await supabase
                .rpc('admin_confirm_subscription_upgrade', { p_subscription_id: subscription.id });

            if (upgradeError) {
                return { success: false, error: upgradeError.message };
            }

            const { error: upgradeTicketError } = await supabase
                .from('tickets')
                .update({
                    status: 'confirmed',
                    last_updated_by: adminUser ? adminUser.id : null,
                    last_updated_at: new Date().toISOString()
                })
                .eq('id', ticketId);
            if (upgradeTicketError) throw upgradeTicketError;

            const upgradedPlanLabel = PLAN_LABELS[subscription.plan] || subscription.plan;
            await createNotification({
                userId: subscription.user_id,
                title: '✓ تمت ترقية اشتراكك',
                message: `تم دمج اشتراكك في باقة "${upgradedPlanLabel}" بنفس تاريخ انتهاء اشتراكك الحالي. المبلغ المحصّل: ${upgradeResult.amount_charged}.`,
                type: 'success',
                link: '/customer-subscriptions.html'
            });

            return { success: true, upgrade: upgradeResult };
        }

        // احتساب التواريخ الفعلية دلوقتي (وقت التأكيد)، مش وقت إنشاء الطلب
        const now = new Date();
        let actualStart = now;
        if (subscription.is_renewal && subscription.previous_end_date) {
            const prevEnd = new Date(subscription.previous_end_date);
            actualStart = prevEnd > now ? prevEnd : now;
        }
        const actualEnd = addBillingPeriod(actualStart, subscription.billing_cycle);

        // تحديث مشروط بحالة 'pending' حاليًا فقط — لو الصف مش pending دلوقتي
        // (اتأكد قبل كده، أو مرفوض، أو منتهي)، الشرط مش هيطابق أي صف والـ
        // update هيرجع بدون صفوف.
        const { data: updatedSubscription, error: subUpdateError } = await supabase
            .from('whatsapp_subscriptions')
            .update({
                status: 'active',
                start_date: actualStart.toISOString(),
                end_date: actualEnd.toISOString(),
                reviewed_by: adminUser ? adminUser.id : null,
                reviewed_at: now.toISOString(),
                updated_at: now.toISOString()
            })
            .eq('id', subscription.id)
            .eq('status', 'pending')
            .select()
            .maybeSingle();

        if (subUpdateError) throw subUpdateError;

        if (!updatedSubscription) {
            return {
                success: false,
                error: `لا يمكن تأكيد هذا الاشتراك لأن حالته الحالية "${subscription.status}" وليست "pending". لم يتم تنفيذ أي تعديل (لا على الرتبة ولا على التذكرة) لتفادي تكرار التفعيل.`
            };
        }

        // الصلاحيات تُشتق من الاشتراك عبر محرك واحد (plan_features)، فلا يحتاج
        // هذا الموضع أن يعرف أي باقة تمنح ماذا. والرتبة لا تُمنح بالشراء إطلاقًا
        // بعد إصلاح C2/H4: الاشتراك يمنح Entitlements لا سلطة.
        await recomputeAccess(updatedSubscription.user_id);

        const { error: ticketUpdateError } = await supabase
            .from('tickets')
            .update({
                status: 'confirmed',
                last_updated_by: adminUser ? adminUser.id : null,
                last_updated_at: now.toISOString()
            })
            .eq('id', ticketId);

        if (ticketUpdateError) throw ticketUpdateError;

        // إشعار العميل بتفعيل اشتراكه، بما فيه تاريخ الانتهاء الفعلي الجديد
        const planLabel = PLAN_LABELS[updatedSubscription.plan] || updatedSubscription.plan;
        const billingLabel = BILLING_LABELS[updatedSubscription.billing_cycle] || updatedSubscription.billing_cycle;
        await createNotification({
            userId: updatedSubscription.user_id,
            title: '✓ تم تفعيل اشتراكك',
            message: `تم تأكيد وتفعيل اشتراكك في خطة "${planLabel}" (${billingLabel}). ينتهي في: ${actualEnd.toLocaleDateString('ar-EG')}.`,
            type: 'success',
            link: '/customer-subscriptions.html'
        });

        return { success: true };
    } catch (error) {
        console.error('Error confirming purchase ticket:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Reject a subscription request ticket.
 * @param {string} ticketId
 * @param {string} [reason]
 * @returns {Promise<Object>}
 */
export async function rejectPurchaseTicket(ticketId, reason = '') {
    try {
        console.log('Rejecting purchase ticket:', ticketId, reason);

        const { data: { user: adminUser } } = await supabase.auth.getUser();
        const nowIso = new Date().toISOString();

        const { error: updateTicketError } = await supabase
            .from('tickets')
            .update({
                status: 'rejected',
                last_updated_by: adminUser ? adminUser.id : null,
                last_updated_at: nowIso
            })
            .eq('id', ticketId);

        if (updateTicketError) throw updateTicketError;

        // نجيب الاشتراك المرتبط بالتذكرة عشان نبعت إشعار مضبوط ونحفظ السبب
        // وهوية الموظف اللي رفض معاه
        const { data: subscription, error: subUpdateError } = await supabase
            .from('whatsapp_subscriptions')
            .update({
                status: 'rejected',
                rejection_reason: reason || null,
                reviewed_by: adminUser ? adminUser.id : null,
                reviewed_at: nowIso,
                updated_at: nowIso
            })
            .eq('ticket_id', ticketId)
            .select()
            .maybeSingle();

        if (subUpdateError) {
            console.error('Failed to update subscription on rejection:', subUpdateError);
        }

        if (subscription) {
            const planLabel = PLAN_LABELS[subscription.plan] || subscription.plan;
            await createNotification({
                userId: subscription.user_id,
                title: 'تم رفض طلب اشتراكك',
                message: reason
                    ? `تم رفض طلب اشتراكك في خطة "${planLabel}". السبب: ${reason}`
                    : `تم رفض طلب اشتراكك في خطة "${planLabel}". تواصل مع الدعم لمزيد من التفاصيل.`,
                type: 'error',
                link: '/customer-subscriptions.html'
            });
        }

        return { success: true };
    } catch (error) {
        console.error('Error rejecting purchase ticket:', error);
        return { success: false, error: error.message };
    }
}
