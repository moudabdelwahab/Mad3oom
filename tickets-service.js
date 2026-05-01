import { supabase } from './api-config.js';
import { logActivity } from './activity-service.js';
import { createNotification } from './notifications-service.js';

/**
 * جلب التذاكر
 */
export async function fetchUserTickets(filters = {}) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    let query = supabase
        .from('tickets')
        .select('*, profiles(full_name, email, role)')
        .order('created_at', { ascending: false });

    // إذا كان المستخدم عميلاً (أو لا يوجد بروفايل بعد)، نفلتر التذاكر الخاصة به فقط
    if (!profile || profile.role !== 'admin') {
        query = query.eq('user_id', user.id);
    }

    if (filters.status && filters.status !== 'all') {
        query = query.eq('status', filters.status);
    }

    if (filters.priority && filters.priority !== 'all') {
        query = query.eq('priority', filters.priority);
    }

    if (filters.search) {
        query = query.ilike('title', `%${filters.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
}

/**
 * إنشاء تذكرة جديدة
 */
export async function createTicket({ title, description, priority, image_url = null }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { data, error } = await supabase
        .from('tickets')
        .insert({
            user_id: user.id,
            title,
            description,
            priority,
            image_url,
            status: 'open'
        })
        .select()
        .single();

    if (error) throw error;

    // إشعار للأدمن فقط عند إنشاء تذكرة جديدة من قبل العميل
    const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin');
    if (admins) {
        for (const admin of admins) {
            await createNotification({
                userId: admin.id,
                title: 'تذكرة دعم جديدة',
                message: `قام العميل بفتح تذكرة جديدة: ${title}`,
                type: 'info',
                link: `admin/tickets.html?ticket=${data.id}`
            });
        }
    }

    await logActivity('ticket_create', { ticket_id: data.id });
    return data;
}

/**
 * جلب إحصائيات التذاكر
 */
export async function fetchTicketStats() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    let query = supabase.from('tickets').select('status', { count: 'exact' });

    // إذا كان المستخدم عميلاً، نفلتر التذاكر الخاصة به فقط
    if (!profile || profile.role !== 'admin') {
        query = query.eq('user_id', user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    const stats = {
        total: data.length,
        open: data.filter(t => t.status === 'open').length,
        inProgress: data.filter(t => t.status === 'in-progress').length,
        resolved: data.filter(t => t.status === 'resolved').length
    };

    return stats;
}

/**
 * تحديث حالة التذكرة
 */
export async function updateTicketStatus(ticketId, status) {
    const { error } = await supabase
        .from('tickets')
        .update({ status })
        .eq('id', ticketId);

    if (error) throw error;

    // جلب بيانات التذكرة لإرسال إشعار للعميل فقط
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
    if (ticket) {
        const statusMap = { 'open': 'مفتوحة', 'in-progress': 'قيد المعالجة', 'resolved': 'محلولة' };
        // إشعار للعميل فقط عند تغيير حالة تذكرته من قبل الإدارة
        await createNotification({
            userId: ticket.user_id,
            title: 'تحديث حالة التذكرة',
            message: `تم تغيير حالة تذكرتك #${ticket.ticket_number} إلى ${statusMap[status]}`,
            type: 'info',
            link: `customer-dashboard.html?ticket=${ticket.id}`
        });
    }

    await logActivity('ticket_status_update', { ticket_id: ticketId, status });
}

/**
 * إغلاق التذكرة مع تعليق (للأدمن)
 */
export async function closeTicketWithComment(ticketId, comment) {
    // إضافة الرد أولاً
    if (comment) {
        await addTicketReply(ticketId, comment, false);
    }
    
    // ثم إغلاق التذكرة
    await updateTicketStatus(ticketId, 'resolved');
}

// Store active ticket channels to prevent duplicate subscriptions
const activeTicketChannels = new Map();

/**
 * الاشتراك في تحديثات التذاكر (Realtime)
 */
export function subscribeToTickets(callback) {
    const channelName = 'public:tickets';
    
    if (activeTicketChannels.has(channelName)) {
        console.log('[Tickets] Already subscribed to tickets channel');
        return activeTicketChannels.get(channelName);
    }

    const channel = supabase
        .channel(channelName)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, callback)
        .subscribe((status) => {
            if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                activeTicketChannels.delete(channelName);
            }
        });
    
    activeTicketChannels.set(channelName, channel);
    return channel;
}

/**
 * الاشتراك في تحديثات الردود (Realtime)
 */
export function subscribeToTicketReplies(ticketId, callback) {
    return supabase
        .channel(`public:ticket_replies:ticket_id=eq.${ticketId}`)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'ticket_replies',
            filter: `ticket_id=eq.${ticketId}`
        }, callback)
        .subscribe();
}

/**
 * حذف تذكرة
 */
export async function deleteTicket(ticketId) {
    const { error } = await supabase
        .from('tickets')
        .delete()
        .eq('id', ticketId);

    if (error) throw error;
}

/**
 * إضافة رد على تذكرة
 */
export async function addTicketReply(ticketId, message, isInternal = false) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
        .from('ticket_replies')
        .insert({
            ticket_id: ticketId,
            user_id: user.id,
            message: message,
            is_internal: isInternal
        });

    if (error) throw error;

    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).single();

    // إشعار للجهة المقابلة
    if (!isInternal && ticket) {
        if (ticket.user_id !== user.id) {
            // الرد من الأدمن -> إشعار للعميل
            await createNotification({
                userId: ticket.user_id,
                title: 'رد جديد على تذكرتك',
                message: `هناك رد جديد من الإدارة على تذكرتك #${ticket.ticket_number}`,
                type: 'success',
                link: `customer-dashboard.html?ticket=${ticket.id}`
            });
        } else {
            // الرد من العميل -> إشعار للأدمن
            const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin');
            if (admins) {
                for (const admin of admins) {
                    await createNotification({
                        userId: admin.id,
                        title: 'رد جديد من عميل',
                        message: `قام العميل بالرد على التذكرة #${ticket.ticket_number}`,
                        type: 'info',
                        link: `admin/tickets.html?ticket=${ticket.id}`
                    });
                }
            }
        }
    }

    // تحديث حالة التذكرة إلى 'in-progress' إذا كانت 'open' والرد من الأدمن
    if (ticket && ticket.user_id !== user.id) {
        await supabase
            .from('tickets')
            .update({ status: 'in-progress' })
            .eq('id', ticketId)
            .eq('status', 'open');
    }
    
    await logActivity('ticket_reply', { ticket_id: ticketId, is_internal: isInternal });
}

/**
 * جلب ردود التذكرة
 */
export async function fetchTicketReplies(ticketId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    let query = supabase
        .from('ticket_replies')
        .select('*, profiles(full_name, role)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

    // إذا كان المستخدم ليس أدمن، نفلتر الملاحظات الداخلية
    if (!profile || profile.role !== 'admin') {
        query = query.eq('is_internal', false);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data;
}
