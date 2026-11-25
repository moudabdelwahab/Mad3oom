import { supabase } from './api-config.js';
import { logActivity } from './activity-service.js';
import { createNotification } from './notifications-service.js';

/**
 * تقديم اقتراح جديد
 */
export async function submitSuggestion({ title, description, category = 'general' }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { data, error } = await supabase
        .from('suggestions')
        .insert({
            user_id: user.id,
            title,
            description,
            category,
            status: 'pending'
        })
        .select()
        .single();

    if (error) {
        // إذا لم يكن الجدول موجوداً، سنقوم بإنشاء تذكرة دعم بنوع خاص كبديل مؤقت
        console.warn('Suggestions table might not exist, falling back to tickets');
        const { data: ticketData, error: ticketError } = await supabase
            .from('tickets')
            .insert({
                user_id: user.id,
                title: `[اقتراح] ${title}`,
                description: `التصنيف: ${category}\n\n${description}`,
                priority: 'low',
                status: 'open'
            })
            .select()
            .single();
        
        if (ticketError) throw ticketError;
        
        // إشعار للمديرين
        await notifyAdmins('اقتراح جديد (عبر التذاكر)', `قام العميل بتقديم اقتراح جديد: ${title}`, `admin/tickets.html?ticket=${ticketData.id}`);
        
        await logActivity('suggestion_submit_fallback', { ticket_id: ticketData.id });
        return ticketData;
    }

    // إشعار للمديرين
    await notifyAdmins('اقتراح جديد', `قام العميل بتقديم اقتراح جديد: ${title}`, `admin/suggestions.html?id=${data.id}`);

    await logActivity('suggestion_submit', { suggestion_id: data.id });
    return data;
}

/**
 * إشعار جميع المديرين
 */
async function notifyAdmins(title, message, link) {
    const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin');
    if (admins) {
        for (const admin of admins) {
            await createNotification({
                userId: admin.id,
                title,
                message,
                type: 'info',
                link
            });
        }
    }
}

/**
 * جلب الاقتراحات (للمديرين)
 */
export async function fetchSuggestions() {
    const { data, error } = await supabase
        .from('suggestions')
        .select('*, profiles(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(200); // قائمة مراجعة إدارية — لا تُجلب بلا حد.

    if (error) throw error;
    return data;
}
