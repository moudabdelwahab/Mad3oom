import { supabase } from './api-config.js';
import { logActivity } from './activity-service.js';
import { createNotification } from './notifications-service.js';

// ─── Auth/Profile cache ───────────────────────────────────────────────────────
// Avoids repeating getUser() + profiles query on every service call.
let _cachedUser = null;
let _cachedProfile = null;

async function getCurrentUser() {
    if (_cachedUser) return _cachedUser;
    const { data: { user } } = await supabase.auth.getUser();
    _cachedUser = user;
    return user;
}

async function getCurrentProfile(userId) {
    if (_cachedProfile) return _cachedProfile;
    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
    _cachedProfile = profile;
    return profile;
}

// Invalidate cache on auth state changes (login / logout)
supabase.auth.onAuthStateChange(() => {
    _cachedUser = null;
    _cachedProfile = null;
});
// ─────────────────────────────────────────────────────────────────────────────

/**
 * جلب التذاكر
 */
export async function fetchUserTickets(filters = {}) {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const profile = await getCurrentProfile(user.id);
    const isAdmin = profile && profile.role === 'admin';

    let query = supabase
        .from('tickets')
        .select('*, profiles(full_name, email, role)')
        .order('created_at', { ascending: false });

    // إذا كان المستخدم عميلاً (أو لا يوجد بروفايل بعد)، نفلتر التذاكر الخاصة به فقط
    // ونستثني التذاكر التي قام بأرشفتها (حذفها من واجهته) بنفسه.
    // الأدمن يرى كل التذاكر دائماً بما فيها المؤرشفة من العميل، للمراجعة والتدقيق.
    if (!isAdmin) {
        query = query.eq('user_id', user.id).eq('archived_by_customer', false);
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
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    
    // التحقق من صحة المدخلات
    if (!title || !title.trim()) throw new Error('عنوان التذكرة مطلوب');
    if (!description || !description.trim()) throw new Error('وصف المشكلة مطلوب');
    if (!priority) throw new Error('الأولوية مطلوبة');
    
    // التحقق من أن الأولوية قيمة صحيحة
    const validPriorities = ['low', 'medium', 'high'];
    if (!validPriorities.includes(priority)) throw new Error('أولوية غير صحيحة');

    const { data, error } = await supabase
        .from('tickets')
        .insert({
            user_id: user.id,
            title: title.trim(),
            description: description.trim(),
            priority,
            image_url,
            status: 'open'
        })
        .select()
        .single();

    if (error) {
        console.error('Error creating ticket:', error);
        throw new Error(error.message || 'فشل إنشاء التذكرة');
    }

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
    
    console.log('Ticket created successfully:', data.id);
    return data;
}

/**
 * جلب إحصائيات التذاكر
 */
export async function fetchTicketStats() {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const profile = await getCurrentProfile(user.id);
    const isAdmin = profile && profile.role === 'admin';

    let query = supabase.from('tickets').select('status', { count: 'exact' });

    // إذا كان المستخدم عميلاً، نفلتر التذاكر الخاصة به فقط
    // ونستثني التذاكر المؤرشفة من قبله (نفس منطق fetchUserTickets)
    if (!isAdmin) {
        query = query.eq('user_id', user.id).eq('archived_by_customer', false);
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
 *
 * نتحقق من البيانات المُرجعة فعلياً (وليس فقط من غياب الخطأ)، لأن RLS
 * قد يرفض التحديث بصمت (error = null مع 0 صفوف متأثرة) لو الأدمن الحالي
 * خسر صلاحيته في نفس الجلسة أو لو التذكرة غير موجودة. الاعتماد على غياب
 * الخطأ فقط هنا قد يؤدي لإرسال إشعار "تم تغيير الحالة" بينما الحالة
 * الفعلية في قاعدة البيانات لم تتغير.
 */
export async function updateTicketStatus(ticketId, status) {
    const { data: updated, error } = await supabase
        .from('tickets')
        .update({ status })
        .eq('id', ticketId)
        .select('id')
        .maybeSingle();

    if (error) throw error;

    if (!updated) {
        throw new Error('لم يتم تحديث حالة التذكرة. قد لا تملك صلاحية هذا الإجراء أو أن التذكرة غير موجودة.');
    }

    // جلب بيانات التذكرة لإرسال إشعار للعميل ومعالجة الاشتراكات
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
    if (ticket) {
        // إذا كانت التذكرة محلولة (resolved) وهي تذكرة شراء، نقوم بتأكيد الاشتراك تلقائياً
        if (status === 'resolved') {
            const isPurchaseTicket = ticket.title.toLowerCase().includes('شراء') || 
                                     ticket.title.toLowerCase().includes('اشتراك') ||
                                     ticket.title.toLowerCase().includes('واتساب');
            
            if (isPurchaseTicket) {
                try {
                    const { confirmPurchaseTicket } = await import('./whatsapp-subscription-service.js');
                    await confirmPurchaseTicket(ticketId);
                } catch (subErr) {
                    console.error('Failed to auto-activate subscription:', subErr);
                }
            }
        }

        const statusMap = { 'open': 'مفتوحة', 'in-progress': 'قيد المعالجة', 'resolved': 'محلولة', 'confirmed': 'مؤكدة', 'rejected': 'مرفوضة' };
        // إشعار للعميل فقط عند تغيير حالة تذكرته من قبل الإدارة
        await createNotification({
            userId: ticket.user_id,
            title: 'تحديث حالة التذكرة',
            message: `تم تغيير حالة تذكرتك #${ticket.ticket_number} إلى ${statusMap[status] || status}`,
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
 * حذف تذكرة (من منظور العميل)
 *
 * ملاحظة مهمة: هذه الدالة لا تحذف الصف فعلياً من قاعدة البيانات.
 * بدلاً من ذلك، تقوم بأرشفتها (soft delete) عبر تعليم
 * archived_by_customer = true. هذا يخفي التذكرة من واجهة العميل
 * فقط، بينما تبقى التذكرة وسجل ردودها متاحة بالكامل للأدمن
 * للمراجعة والتدقيق ولحل أي نزاع مستقبلي.
 *
 * الحذف الفعلي للصف مسموح به فقط للأدمن (انظر RLS policy
 * "Admin can delete tickets")، وأي محاولة حذف فعلي (.delete())
 * من حساب عميل سترفضها قاعدة البيانات بصمت (0 صفوف متأثرة)
 * لعدم وجود policy تسمح بذلك لغير الأدمن.
 *
 * نتحقق هنا من البيانات المُرجعة فعلياً (وليس فقط من غياب الخطأ)
 * لأن RLS قد يرفض العملية بصمت (error = null مع 0 صفوف متأثرة)
 * إذا لم تكن الصلاحيات مضبوطة كما هو متوقع.
 */
export async function deleteTicket(ticketId) {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const { data, error } = await supabase
        .from('tickets')
        .update({
            archived_by_customer: true,
            archived_at: new Date().toISOString()
        })
        .eq('id', ticketId)
        .eq('user_id', user.id) // طبقة حماية إضافية بجانب RLS: لا تسمح إلا بأرشفة تذاكر المستخدم الحالي
        .select('id')
        .maybeSingle();

    if (error) throw error;

    // لو data فاضية (null)، يبقى معنى ذلك أن الصف لم يتأثر فعلياً —
    // إما لأن التذكرة غير موجودة، أو لا تخص هذا المستخدم، أو رفضتها RLS بصمت.
    // في هذه الحالة لا نعتبر العملية ناجحة ولا نخفيها من الواجهة بدون تأكيد فعلي.
    if (!data) {
        throw new Error('لم يتم العثور على التذكرة أو لا يمكن أرشفتها. حاول تحديث الصفحة والمحاولة مرة أخرى.');
    }

    await logActivity('ticket_archive_by_customer', { ticket_id: ticketId });

    return data;
}

/**
 * إضافة رد على تذكرة
 */
export async function addTicketReply(ticketId, message, isInternal = false) {
    const user = await getCurrentUser();
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
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // جلب البروفايل لمعرفة الدور
    const profile = await getCurrentProfile(user.id);

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
