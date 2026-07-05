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

// الخطط اللي بتستحق ترقية super_user
const SUPER_USER_PLANS = ['support', 'bundle'];

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
 * عدد الأيام التقريبي لكل نوع فترة - قيمة معلوماتية بس (duration_days)،
 * الاحتساب الفعلي لتاريخ النهاية بيتم بإضافة شهر/سنة تقويميًا كاملاً
 * (انظر addBillingPeriod) مش بجمع عدد أيام ثابت.
 */
function getDurationDays(billingCycle) {
    return billingCycle === 'yearly' ? 365 : 30;
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
 * هل عند المستخدم دا اشتراك واتساب/باقة نشط تاني (غير الاشتراك المحدد)؟
 * تُستخدم قبل قفل profiles.whatsapp_enabled عشان منقفلش وصول عميل عنده
 * أكتر من اشتراك نشط (نادر، بس ممكن يحصل لو جدد قبل انتهاء القديم).
 */
async function hasOtherActiveWhatsappAccess(userId, excludeSubscriptionId) {
    const now = new Date().toISOString();
    let query = supabase
        .from('whatsapp_subscriptions')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .in('plan', ['whatsapp', 'bundle'])
        .gt('end_date', now);

    if (excludeSubscriptionId) {
        query = query.neq('id', excludeSubscriptionId);
    }

    const { data, error } = await query.limit(1);
    if (error) {
        console.error('Error checking other active whatsapp access:', error);
        return true; // في حالة الشك، منقفلش الوصول تفاديًا لأي أثر جانبي
    }
    return !!(data && data.length > 0);
}

/**
 * هل عند المستخدم دا اشتراك support/bundle نشط تاني (غير الاشتراك المحدد)؟
 * تُستخدم قبل تنزيل رتبة super_user لما اشتراك يخلص، عشان منلغيش صلاحية
 * super_user لعميل لسه عنده اشتراك دعم فني/باقة نشط من مصدر تاني.
 */
async function hasOtherActiveSuperUserAccess(userId, excludeSubscriptionId) {
    const now = new Date().toISOString();
    let query = supabase
        .from('whatsapp_subscriptions')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .in('plan', SUPER_USER_PLANS)
        .gt('end_date', now);

    if (excludeSubscriptionId) {
        query = query.neq('id', excludeSubscriptionId);
    }

    const { data, error } = await query.limit(1);
    if (error) {
        console.error('Error checking other active super_user access:', error);
        return true; // في حالة الشك، منلغيش الرتبة تفاديًا لأي أثر جانبي
    }
    return !!(data && data.length > 0);
}

/**
 * ترقية العميل لـ super_user، بس لو رتبته الحالية 'user' بالظبط. أي رتبة
 * تانية (admin، رتب مخصصة...) بتفضل زي ما هي.
 */
async function upgradeToSuperUserIfEligible(userId) {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching profile for super_user upgrade:', error);
            return;
        }

        if (profile && profile.role === 'user') {
            const { error: updateError } = await supabase
                .from('profiles')
                .update({ role: 'super_user' })
                .eq('id', userId);

            if (updateError) {
                console.error('Error upgrading profile to super_user:', updateError);
            }
        }
    } catch (error) {
        console.error('Unexpected error upgrading to super_user:', error);
    }
}

/**
 * تنزيل رتبة العميل من super_user لـ user، بس لو رتبته الحالية super_user
 * بالظبط ومفيش اشتراك support/bundle نشط تاني عنده.
 */
async function downgradeFromSuperUserIfNoAccessLeft(userId, excludeSubscriptionId) {
    try {
        const stillEligible = await hasOtherActiveSuperUserAccess(userId, excludeSubscriptionId);
        if (stillEligible) return;

        const { data: profile, error } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching profile for super_user downgrade:', error);
            return;
        }

        if (profile && profile.role === 'super_user') {
            const { error: updateError } = await supabase
                .from('profiles')
                .update({ role: 'user' })
                .eq('id', userId);

            if (updateError) {
                console.error('Error downgrading profile from super_user:', updateError);
            }
        }
    } catch (error) {
        console.error('Unexpected error downgrading from super_user:', error);
    }
}

/**
 * Create a subscription request ticket for any plan.
 * @param {string} plan - 'support' | 'whatsapp' | 'bundle'
 * @param {string} billingCycle - 'monthly' | 'yearly'
 * @param {Object} [options]
 * @param {boolean} [options.isRenewal=false] - لو true، بيتم اعتباره طلب تجديد
 *        وبيتم تمديد المدة من تاريخ انتهاء الاشتراك النشط الحالي لنفس الخطة
 *        (لو موجود) بدلاً من احتسابها من الآن.
 * @returns {Promise<Object>} - { success, ticket, subscription }
 */
export async function createSubscriptionTicket(plan, billingCycle, options = {}) {
    assertValidPlan(plan);
    assertValidBillingCycle(billingCycle);

    const isRenewal = !!options.isRenewal;

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

        const durationDays = getDurationDays(billingCycle);
        const planLabel = PLAN_LABELS[plan];
        const billingLabel = BILLING_LABELS[billingCycle];
        const durationLabel = billingCycle === 'yearly' ? 'سنة واحدة' : 'شهر واحد';

        // ملاحظة مهمة: start_date/end_date هنا قيم مبدئية (placeholder) فقط
        // لإن عمود end_date مطلوب (NOT NULL) في قاعدة البيانات. التواريخ
        // الحقيقية بتتحدد فعليًا فقط عند تأكيد الطلب في confirmPurchaseTicket،
        // فمفيش أي عميل بيكسب أيام من عمر اشتراكه وهو لسه pending.
        const placeholderStart = new Date();
        const placeholderEnd = addBillingPeriod(placeholderStart, billingCycle);

        let description;
        if (isRenewal && previousEndDate) {
            description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nاشتراكك الحالي ينتهي في: ${previousEndDate.toLocaleString('ar-EG')}\nسيتم تمديد الاشتراك لمدة ${durationLabel} إضافية بدءًا من تاريخ الانتهاء الحالي عند تأكيد الطلب من فريق الدعم.`;
        } else if (isRenewal) {
            description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nملاحظة: لم يتم العثور على اشتراك نشط حالي لهذه الخطة، سيتم احتساب المدة من تاريخ تأكيد الطلب.`;
        } else {
            description = `طلب اشتراك جديد\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nسيتم احتساب تاريخ البداية والنهاية الفعلي عند تأكيد الطلب من فريق الدعم.`;
        }

        // Create a support ticket for the subscription request
        const { data: ticket, error: ticketError } = await supabase
            .from('tickets')
            .insert({
                user_id: user.id,
                title: `${isRenewal ? 'طلب تجديد اشتراك' : 'طلب اشتراك'} - ${planLabel} (${billingLabel})`,
                description,
                status: 'open',
                priority: 'high'
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        // Create subscription record with pending status (no payment taken yet)
        const { data: subscription, error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .insert({
                user_id: user.id,
                ticket_id: ticket.id,
                plan,
                billing_cycle: billingCycle,
                start_date: placeholderStart.toISOString(),
                end_date: placeholderEnd.toISOString(),
                status: 'pending',
                is_renewal: isRenewal,
                duration_days: durationDays,
                previous_end_date: previousEndDate ? previousEndDate.toISOString() : null
            })
            .select()
            .single();

        if (subError) throw subError;

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
 * @returns {Promise<Object>}
 */
export async function renewSubscription(plan, billingCycle) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        return await createSubscriptionTicket(plan, billingCycle, { isRenewal: true });
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
            // قفل whatsapp_enabled بس لو مفيش اشتراك واتساب/باقة نشط تاني للعميل
            if (subscription.plan === 'whatsapp' || subscription.plan === 'bundle') {
                const stillHasAccess = await hasOtherActiveWhatsappAccess(subscription.user_id, subscription.id);
                if (!stillHasAccess) {
                    await supabase
                        .from('profiles')
                        .update({ whatsapp_enabled: false })
                        .eq('id', subscription.user_id);
                }
            }

            // تنزيل رتبة super_user بس لو مفيش اشتراك support/bundle نشط تاني للعميل
            if (SUPER_USER_PLANS.includes(subscription.plan)) {
                await downgradeFromSuperUserIfNoAccessLeft(subscription.user_id, subscription.id);
            }
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

        // Only plans that include WhatsApp access should flip this flag
        if (updatedSubscription.plan === 'whatsapp' || updatedSubscription.plan === 'bundle') {
            await supabase
                .from('profiles')
                .update({ whatsapp_enabled: true })
                .eq('id', updatedSubscription.user_id);
        }

        // خطط الدعم الفني/الباقة بس هي اللي بترقّي العميل لـ super_user.
        // خطة واتساب لوحدها ما بتغيرش الرتبة، تفضل user زي ما هي.
        if (SUPER_USER_PLANS.includes(updatedSubscription.plan)) {
            await upgradeToSuperUserIfEligible(updatedSubscription.user_id);
        }

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
