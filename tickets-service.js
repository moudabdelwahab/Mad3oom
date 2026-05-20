import { supabase } from './api-config.js';
import { logActivity } from './activity-service.js';
import { createNotification } from './notifications-service.js';

/**
 * جلب التذاكر مع دعم الفلاتر المتقدمة
 */
export async function fetchUserTickets(filters = {}) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    let query = supabase
        .from('tickets')
        .select('*, profiles(full_name, email, role), ticket_attachments(*)')
        .order('last_reply_at', { ascending: false });

    if (!profile || profile.role !== 'admin') {
        query = query.eq('user_id', user.id);
    }

    if (filters.status && filters.status !== 'all') {
        // توحيد الحالة للتعامل مع in_progress أو in-progress
        const statusValue = filters.status === 'in-progress' ? 'in_progress' : filters.status;
        query = query.eq('status', statusValue);
    }

    if (filters.priority && filters.priority !== 'all') {
        query = query.eq('priority', filters.priority);
    }

    if (filters.category && filters.category !== 'all') {
        query = query.eq('category', filters.category);
    }

    if (filters.search) {
        query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    
    // تصحيح الحالة في النتائج للعرض الموحد
    return data.map(t => ({
        ...t,
        status: t.status === 'in_progress' ? 'in-progress' : t.status
    }));
}

/**
 * إنشاء تذكرة جديدة مع دعم المرفقات والتصنيف
 */
export async function createTicket({ title, description, priority, category = 'general', attachments = [] }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');
    
    if (!title?.trim() || !description?.trim()) throw new Error('العنوان والوصف مطلوبان');

    const { data: ticket, error: ticketError } = await supabase
        .from('tickets')
        .insert({
            user_id: user.id,
            title: title.trim(),
            description: description.trim(),
            priority: priority || 'medium',
            category: category,
            status: 'open',
            last_reply_at: new Date().toISOString()
        })
        .select()
        .single();

    if (ticketError) throw ticketError;

    // إضافة المرفقات إذا وجدت
    if (attachments.length > 0) {
        const attachmentData = attachments.map(url => ({
            ticket_id: ticket.id,
            file_url: url,
            file_name: url.split('/').pop()
        }));
        await supabase.from('ticket_attachments').insert(attachmentData);
    }

    // إشعار للأدمن
    const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin');
    if (admins) {
        for (const admin of admins) {
            await createNotification({
                userId: admin.id,
                title: 'تذكرة دعم جديدة',
                message: `تذكرة جديدة: ${title}`,
                type: 'info',
                link: `admin/tickets.html?id=${ticket.id}`
            });
        }
    }

    await logActivity('ticket_create', { ticket_id: ticket.id });
    return ticket;
}

/**
 * إضافة رد مع دعم المرفقات والملاحظات الداخلية
 */
export async function addTicketReply(ticketId, message, isInternal = false, attachments = []) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { data: reply, error: replyError } = await supabase
        .from('ticket_replies')
        .insert({
            ticket_id: ticketId,
            user_id: user.id,
            message: message,
            is_internal: isInternal
        })
        .select()
        .single();

    if (replyError) throw replyError;

    // إضافة المرفقات للرد
    if (attachments.length > 0) {
        const attachmentData = attachments.map(url => ({
            ticket_id: ticketId,
            reply_id: reply.id,
            file_url: url,
            file_name: url.split('/').pop()
        }));
        await supabase.from('ticket_attachments').insert(attachmentData);
    }

    // تحديث وقت آخر رد وحالة التذكرة
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
    
    let updateData = { last_reply_at: new Date().toISOString() };
    
    // إذا كان الرد من الأدمن والتذكرة مفتوحة، نحولها لقيد المعالجة
    if (!isInternal && ticket && ticket.user_id !== user.id && ticket.status === 'open') {
        updateData.status = 'in_progress';
    }

    await supabase.from('tickets').update(updateData).eq('id', ticketId);

    // إرسال الإشعارات
    if (!isInternal && ticket) {
        const isResponseFromAdmin = ticket.user_id !== user.id;
        await createNotification({
            userId: isResponseFromAdmin ? ticket.user_id : (await getAdminIds())[0], // تبسيط للإشعار
            title: isResponseFromAdmin ? 'رد جديد من الدعم' : 'رد جديد من العميل',
            message: `رد جديد على التذكرة #${ticket.ticket_number}`,
            type: 'info',
            link: isResponseFromAdmin ? `customer-dashboard.html?ticket=${ticket.id}` : `admin/tickets.html?id=${ticket.id}`
        });
    }

    await logActivity('ticket_reply', { ticket_id: ticketId, is_internal: isInternal });
    return reply;
}

async function getAdminIds() {
    const { data } = await supabase.from('profiles').select('id').eq('role', 'admin');
    return data?.map(a => a.id) || [];
}

/**
 * تقييم التذكرة (للعميل)
 */
export async function rateTicket(ticketId, rating, feedback = '') {
    const { error } = await supabase
        .from('tickets')
        .update({ rating, feedback })
        .eq('id', ticketId);
    if (error) throw error;
    await logActivity('ticket_rate', { ticket_id: ticketId, rating });
}

/**
 * جلب ردود التذكرة مع المرفقات
 */
export async function fetchTicketReplies(ticketId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();

    let query = supabase
        .from('ticket_replies')
        .select('*, profiles(full_name, role), ticket_attachments(*)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

    if (!profile || profile.role !== 'admin') {
        query = query.eq('is_internal', false);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
}

/**
 * تحديث حالة التذكرة
 */
export async function updateTicketStatus(ticketId, status) {
    // توحيد التسمية لقاعدة البيانات
    const dbStatus = status === 'in-progress' ? 'in_progress' : status;
    const { error } = await supabase
        .from('tickets')
        .update({ status: dbStatus })
        .eq('id', ticketId);
    if (error) throw error;
    await logActivity('ticket_status_update', { ticket_id: ticketId, status: dbStatus });
}

export async function fetchTicketStats() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();

    let query = supabase.from('tickets').select('status');
    if (!profile || profile.role !== 'admin') {
        query = query.eq('user_id', user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
        total: data.length,
        open: data.filter(t => t.status === 'open').length,
        inProgress: data.filter(t => t.status === 'in_progress' || t.status === 'in-progress').length,
        resolved: data.filter(t => t.status === 'resolved').length
    };
}

export function subscribeToTickets(callback) {
    return supabase
        .channel('public:tickets')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, callback)
        .subscribe();
}

export function subscribeToTicketReplies(ticketId, callback) {
    return supabase
        .channel(`ticket_replies_${ticketId}`)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'ticket_replies',
            filter: `ticket_id=eq.${ticketId}`
        }, callback)
        .subscribe();
}
