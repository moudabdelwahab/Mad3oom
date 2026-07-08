// rewards-service.js - نظام المكافآت والنقاط المتكامل
import { supabase } from './api-config.js';
import { createNotification } from './notifications-service.js';

// ==================== نقاط الخطورة ====================
export const SEVERITY_POINTS = {
    low: 10,
    medium: 25,
    high: 50,
    critical: 100
};

// ==================== مستويات العضوية ====================
// تم التحديث لتتطابق مع rewards.html
export const MEMBERSHIP_LEVELS = [
    { name: 'عضو جديد', minPoints: 0, maxPoints: 100 },
    { name: 'عضو نشط', minPoints: 101, maxPoints: 300 },
    { name: 'خبير', minPoints: 301, maxPoints: 1000 },
    { name: 'محترف (Pro)', minPoints: 1001, maxPoints: Infinity }
];

// ==================== الحصول على محفظة المستخدم ====================
export async function getUserWallet(userId) {
    try {
        const { data, error } = await supabase
            .from('user_wallets')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        if (!data) {
            // إنشاء محفظة جديدة
            return await createUserWallet(userId);
        }

        return data;
    } catch (error) {
        console.error('خطأ في جلب المحفظة:', error);
        throw error;
    }
}

// ==================== إنشاء محفظة جديدة ====================
export async function createUserWallet(userId) {
    try {
        const { data, error } = await supabase
            .from('user_wallets')
            .insert([{
                user_id: userId,
                total_points: 0,
                available_points: 0,
                pending_points: 0,
                membership_level: 'عضو جديد',
                is_pro: false,
                pro_badge_earned_at: null,
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('خطأ في إنشاء محفظة:', error);
        throw error;
    }
}

// ==================== إرسال بلاغ جديد ====================
export async function submitReport(userId, reportData) {
    try {
        const estimatedPoints = SEVERITY_POINTS[reportData.severity] || 0;

        // إنشاء البلاغ. ملاحظة أمنية: النقاط المعلقة (pending_points) بتتضاف
        // للمحفظة تلقائياً من خلال trigger على الخادم (trg_handle_new_reward_report)،
        // مش من هنا. ده عشان العميل ما يقدرش يعدّل رصيد محفظته مباشرة من الـ JS.
        const { data: report, error: reportError } = await supabase
            .from('user_reports')
            .insert([{
                user_id: userId,
                problem_type: reportData.problemType,
                severity: reportData.severity,
                title: reportData.title,
                description: reportData.description,
                estimated_points: estimatedPoints,
                status: 'pending',
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (reportError) throw reportError;

        // إشعار للمسؤولين عند تقديم بلاغ جديد
        const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin');
        if (admins) {
            for (const admin of admins) {
                await createNotification({
                    userId: admin.id,
                    title: 'بلاغ مكافأة جديد',
                    message: `قام مستخدم بتقديم بلاغ جديد: ${reportData.title}`,
                    type: 'info',
                    link: `admin-dashboard.html?tab=rewards`
                });
            }
        }

        // تسجيل في السجل
        await logRewardActivity(userId, 'report_submitted', {
            reportId: report.id,
            estimatedPoints: estimatedPoints,
            status: 'pending'
        });

        return report;
    } catch (error) {
        console.error('خطأ في إرسال البلاغ:', error);
        throw error;
    }
}

// ==================== الحصول على بلاغات المستخدم ====================
export async function getUserReports(userId) {
    try {
        const { data, error } = await supabase
            .from('user_reports')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('خطأ في جلب البلاغات:', error);
        throw error;
    }
}

// ==================== الموافقة على البلاغ وإضافة النقاط ====================
export async function approveReport(reportId, actualPoints) {
    try {
        // نجيب عنوان البلاغ الأول للإشعار (القراءة مسموحة للأدمن حسب RLS)
        const { data: report, error: reportError } = await supabase
            .from('user_reports')
            .select('*')
            .eq('id', reportId)
            .single();
        if (reportError) throw reportError;

        // كل التحديثات الحساسة (حالة البلاغ + نقاط المحفظة + مستوى العضوية +
        // شارة Pro) بتتم داخل دالة واحدة على الخادم (SECURITY DEFINER) بشكل ذرّي.
        // الدالة بتتحقق بنفسها إن المستخدم أدمن فعلاً من جدول profiles، وترفض
        // التنفيذ لغير ذلك - مفيش تعديل مباشر من الـ JS على المحفظة بعد كده.
        const { data: result, error: rpcError } = await supabase.rpc('approve_reward_report', {
            p_report_id: reportId,
            p_actual_points: actualPoints
        });
        if (rpcError) throw rpcError;

        // إشعار للعميل عند الموافقة على البلاغ
        await createNotification({
            userId: report.user_id,
            title: 'تمت الموافقة على بلاغك',
            message: `تمت الموافقة على بلاغك "${report.title}" وإضافة ${actualPoints} نقطة إلى رصيدك.`,
            type: 'success',
            link: `customer-dashboard.html?tab=rewards`
        });

        return {
            report: { ...report, status: 'approved', actual_points: actualPoints },
            wallet: {
                total_points: result.total_points,
                is_pro: result.is_pro
            }
        };
    } catch (error) {
        console.error('خطأ في الموافقة على البلاغ:', error);
        throw error;
    }
}

// ==================== رفض البلاغ ====================
export async function rejectReport(reportId, reason) {
    try {
        // كل التحديثات (حالة البلاغ + خصم النقاط المعلقة) بتتم داخل دالة واحدة
        // على الخادم بعد التحقق من صلاحية الأدمن من جدول profiles.
        const { data: result, error: rpcError } = await supabase.rpc('reject_reward_report', {
            p_report_id: reportId,
            p_reason: reason
        });
        if (rpcError) throw rpcError;

        const { data: report, error: reportError } = await supabase
            .from('user_reports')
            .select('*')
            .eq('id', reportId)
            .single();
        if (reportError) throw reportError;

        return report;
    } catch (error) {
        console.error('خطأ في رفض البلاغ:', error);
        throw error;
    }
}

// ==================== حساب مستوى العضوية ====================
export function calculateMembershipLevel(points) {
    for (let i = MEMBERSHIP_LEVELS.length - 1; i >= 0; i--) {
        if (points >= MEMBERSHIP_LEVELS[i].minPoints) {
            return MEMBERSHIP_LEVELS[i].name;
        }
    }
    return 'عضو جديد';
}

// ==================== الحصول على معلومات التقدم نحو Pro ====================
export function getProProgressInfo(totalPoints) {
    const currentPoints = totalPoints;
    const targetPoints = 1000;
    const progressPercentage = Math.min((currentPoints / targetPoints) * 100, 100);
    const isPro = currentPoints >= targetPoints;
    const pointsNeeded = Math.max(0, targetPoints - currentPoints);

    return {
        currentPoints,
        targetPoints,
        progressPercentage,
        isPro,
        pointsNeeded
    };
}

// ==================== تسجيل نشاط المكافآت ====================
export async function logRewardActivity(userId, activityType, details) {
    try {
        const { error } = await supabase
            .from('reward_activity_logs')
            .insert([{
                user_id: userId,
                activity_type: activityType,
                details: details,
                created_at: new Date().toISOString()
            }]);

        if (error) throw error;
    } catch (error) {
        console.error('خطأ في تسجيل النشاط:', error);
    }
}

// ==================== الحصول على جميع البلاغات المعلقة (للمسؤول) ====================
export async function getPendingReports(limit = 50) {
    try {
        const { data, error } = await supabase
            .from('user_reports')
            .select(`
                *,
                profiles:user_id(id, email, full_name)
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('خطأ في جلب البلاغات المعلقة:', error);
        throw error;
    }
}

// ==================== الحصول على إحصائيات المكافآت ====================
export async function getRewardsStats() {
    try {
        const { data: pendingReports, error: pendingError } = await supabase
            .from('user_reports')
            .select('id')
            .eq('status', 'pending');

        const { data: approvedReports, error: approvedError } = await supabase
            .from('user_reports')
            .select('id')
            .eq('status', 'approved');

        const { data: rejectedReports, error: rejectedError } = await supabase
            .from('user_reports')
            .select('id')
            .eq('status', 'rejected');

        const { data: proUsers, error: proError } = await supabase
            .from('user_wallets')
            .select('id')
            .eq('is_pro', true);

        if (pendingError || approvedError || rejectedError || proError) {
            throw new Error('خطأ في جلب الإحصائيات');
        }

        return {
            pendingReports: pendingReports?.length || 0,
            approvedReports: approvedReports?.length || 0,
            rejectedReports: rejectedReports?.length || 0,
            proUsers: proUsers?.length || 0
        };
    } catch (error) {
        console.error('خطأ في جلب الإحصائيات:', error);
        throw error;
    }
}

// ==================== البحث عن البلاغات ====================
export async function searchReports(query, status = null) {
    try {
        let queryBuilder = supabase
            .from('user_reports')
            .select(`
                *,
                profiles:user_id(id, email, full_name)
            `)
            .or(`title.ilike.%${query}%,description.ilike.%${query}%`);

        if (status) {
            queryBuilder = queryBuilder.eq('status', status);
        }

        const { data, error } = await queryBuilder.order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('خطأ في البحث عن البلاغات:', error);
        throw error;
    }
}

// ==================== تصدير الدوال ====================
export default {
    getUserWallet,
    createUserWallet,
    submitReport,
    getUserReports,
    approveReport,
    rejectReport,
    calculateMembershipLevel,
    getProProgressInfo,
    logRewardActivity,
    getPendingReports,
    getRewardsStats,
    searchReports,
    SEVERITY_POINTS,
    MEMBERSHIP_LEVELS
};
