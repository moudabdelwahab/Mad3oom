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
        .select('*, profiles!tickets_user_profile_fk(full_name, email, role), last_updated_by_profile:profiles!tickets_last_updated_by_fkey(full_name)')
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
 *
 * ملاحظة: الأولوية لم تعد تُحدَّد من قبل العميل. يتم تخزينها بقيمة افتراضية
 * ('medium') عند الإنشاء، والإدارة فقط هي من تُحدّد/تُعدّل الأولوية الفعلية
 * لاحقاً عبر updateTicketPriority أدناه (من لوحة الإدارة).
 */
export async function createTicket({ title, description, priority, image_url = null }) {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // التحقق من صحة المدخلات
    if (!title || !title.trim()) throw new Error('عنوان التذكرة مطلوب');
    if (!description || !description.trim()) throw new Error('وصف المشكلة مطلوب');

    // الأولوية أصبحت اختيارية من واجهة العميل: نستخدم قيمة افتراضية
    // إن لم تُرسَل قيمة صحيحة، بدلاً من رفض إنشاء التذكرة.
    const validPriorities = ['low', 'medium', 'high'];
    const finalPriority = validPriorities.includes(priority) ? priority : 'medium';

    const { data, error } = await supabase
        .from('tickets')
        .insert({
            user_id: user.id,
            title: title.trim(),
            description: description.trim(),
            priority: finalPriority,
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
 *
 * كمان بنسجل last_updated_by/last_updated_at بهوية الموظف اللي نفّذ
 * التعديل، عشان يظهر اسمه في لوحة الإدارة (تتبع أي تعديل يتم على التذكرة).
 */
export async function updateTicketStatus(ticketId, status) {
    const currentUser = await getCurrentUser();

    const { data: updated, error } = await supabase
        .from('tickets')
        .update({
            status,
            last_updated_by: currentUser ? currentUser.id : null,
            last_updated_at: new Date().toISOString()
        })
        .eq('id', ticketId)
        .select('id')
        .maybeSingle();

    if (error) throw error;

    if (!updated) {
        throw new Error('لم يتم تحديث حالة التذكرة. قد لا تملك صلاحية هذا الإجراء أو أن التذكرة غير موجودة.');
    }

    // جلب بيانات التذكرة لإرسال إشعار للعميل
    //
    // ملاحظة مهمة (تم إصلاحها): كان هنا منطق قديم بيطابق عنوان التذكرة نصياً
    // (كلمات زي "شراء"/"اشتراك"/"واتساب") ولو لقى تطابق وكانت الحالة الجديدة
    // "resolved"، كان بينادي confirmPurchaseTicket() تلقائياً — حتى لو
    // التذكرة دي مش طلب اشتراك أصلاً (مثلاً تذكرة دعم عادية عنوانها "مشكلة في
    // تفعيل الاشتراك"). النتيجة إن حالة التذكرة كانت بتتحول لـ "confirmed"
    // بدل "resolved" من غير قصد، ومفيش أي صف في whatsapp_subscriptions
    // بيتغير أصلاً لإن الدالة دي بتدور بـ ticket_id ومش هتلاقي حاجة.
    //
    // التحقق الصحيح من كون التذكرة "طلب اشتراك" بقى بيتم فعلياً عبر join على
    // whatsapp_subscriptions.ticket_id (شوف admin/tickets.js -> showAdminTicketInPanel)،
    // وتأكيد/رفض الاشتراك بقى بيتم فقط من خلال زرار "تأكيد"/"رفض" الصريحين في
    // لوحة الإدارة، مش تلقائياً من مجرد تغيير الحالة لـ resolved. فالمنطق ده
    // اتشال خالص من هنا عشان منمنعش تعارض بين الحالتين.
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
    if (ticket) {
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
 * تحديث أولوية التذكرة (للإدارة فقط)
 *
 * العميل لم يعد يختار أولوية تذكرته عند الإنشاء؛ الإدارة وحدها من تحدد
 * الأولوية الفعلية بعد مراجعة التذكرة. هذه الدالة تتحقق من البيانات
 * المُرجعة فعلياً (نفس منطق updateTicketStatus) لأن RLS قد يرفض التحديث
 * بصمت لو نُفذت الدالة من حساب غير مصرح له.
 *
 * ملاحظة مهمة: هذه الدالة وحدها لا تكفي لمنع العميل من تعديل الأولوية —
 * لازم يكون فيه RLS policy على جدول tickets يمنع أي مستخدم غير أدمن من
 * تحديث عمود priority. تأكد من ضبط الـ policy المناسبة في Supabase.
 *
 * كمان بنسجل last_updated_by/last_updated_at بهوية الموظف اللي غيّر
 * الأولوية.
 */
export async function updateTicketPriority(ticketId, priority) {
    const validPriorities = ['low', 'medium', 'high'];
    if (!validPriorities.includes(priority)) throw new Error('أولوية غير صحيحة');

    const currentUser = await getCurrentUser();

    const { data: updated, error } = await supabase
        .from('tickets')
        .update({
            priority,
            last_updated_by: currentUser ? currentUser.id : null,
            last_updated_at: new Date().toISOString()
        })
        .eq('id', ticketId)
        .select('id')
        .maybeSingle();

    if (error) throw error;

    if (!updated) {
        throw new Error('لم يتم تحديث أولوية التذكرة. قد لا تملك صلاحية هذا الإجراء أو أن التذكرة غير موجودة.');
    }

    await logActivity('ticket_priority_update', { ticket_id: ticketId, priority });
}

/**
 * تعيين التذكرة لموظف دعم معيّن (أو إلغاء التعيين لو agentId = null)
 * (للإدارة فقط - RLS يجب أن يمنع غير الأدمن من التعديل)
 */
export async function updateTicketAssignee(ticketId, agentId) {
    const currentUser = await getCurrentUser();

    const { data: updated, error } = await supabase
        .from('tickets')
        .update({
            assigned_to: agentId || null,
            last_updated_by: currentUser ? currentUser.id : null,
            last_updated_at: new Date().toISOString()
        })
        .eq('id', ticketId)
        .select('id')
        .maybeSingle();

    if (error) throw error;

    if (!updated) {
        throw new Error('لم يتم تحديث المسؤول عن التذكرة. قد لا تملك صلاحية هذا الإجراء أو أن التذكرة غير موجودة.');
    }

    if (agentId) {
        await createNotification({
            userId: agentId,
            title: 'تم تعيين تذكرة لك',
            message: 'تم تعيينك كمسؤول عن متابعة تذكرة دعم',
            type: 'info',
            link: `admin/tickets.html?ticket=${ticketId}`
        });
    }

    await logActivity('ticket_assignee_update', { ticket_id: ticketId, assigned_to: agentId });
}

/**
 * جلب قائمة موظفي الدعم (أدمن/دعم/مسؤول) الصالحين لتعيين التذاكر لهم
 */
export async function fetchSupportAgents() {
    const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .in('role', ['admin', 'support', 'super_user'])
        .order('full_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * تحديث عدة تذاكر دفعة واحدة (إجراءات جماعية من لوحة الإدارة)
 * يُرجع عدد التذاكر التي تم تحديثها فعلياً.
 */
export async function bulkUpdateTicketStatus(ticketIds, status) {
    if (!ticketIds || ticketIds.length === 0) return 0;
    const currentUser = await getCurrentUser();

    const { data, error } = await supabase
        .from('tickets')
        .update({
            status,
            last_updated_by: currentUser ? currentUser.id : null,
            last_updated_at: new Date().toISOString()
        })
        .in('id', ticketIds)
        .select('id');

    if (error) throw error;
    await logActivity('ticket_bulk_status_update', { ticket_ids: ticketIds, status });
    return data ? data.length : 0;
}

/**
 * تعيين عدة تذاكر لموظف دعم دفعة واحدة
 */
export async function bulkUpdateTicketAssignee(ticketIds, agentId) {
    if (!ticketIds || ticketIds.length === 0) return 0;
    const currentUser = await getCurrentUser();

    const { data, error } = await supabase
        .from('tickets')
        .update({
            assigned_to: agentId || null,
            last_updated_by: currentUser ? currentUser.id : null,
            last_updated_at: new Date().toISOString()
        })
        .in('id', ticketIds)
        .select('id');

    if (error) throw error;
    await logActivity('ticket_bulk_assignee_update', { ticket_ids: ticketIds, assigned_to: agentId });
    return data ? data.length : 0;
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
    //
    // ملاحظة: كان هذا التحديث بيتم من غير أي فحص لقيمة error، فكان أي فشل
    // (زي عدم تطابق القيمة مع CHECK constraint، أو رفض RLS بصمت) بيمر من
    // غير ما حد يلاحظه — ولا تذكرة وحدة فعليًا كانت بتوصل لحالة "قيد
    // المعالجة" نتيجة كده. دلوقتي بنسجل أي فشل في الـ console على الأقل
    // (من غير ما نكسر إرسال الرد نفسه، لإن الرد اتبعت بنجاح بالفعل)، وكمان
    // بنسجل last_updated_by بهوية الأدمن اللي رد لإن الرد نفسه سبب التحول
    // التلقائي للحالة.
    if (ticket && ticket.user_id !== user.id) {
        const { error: statusUpdateError } = await supabase
            .from('tickets')
            .update({
                status: 'in-progress',
                last_updated_by: user.id,
                last_updated_at: new Date().toISOString()
            })
            .eq('id', ticketId)
            .eq('status', 'open');

        if (statusUpdateError) {
            console.error('Failed to auto-transition ticket to in-progress:', statusUpdateError);
        }
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
    const isStaff = profile && ['admin', 'support', 'super_user'].includes(profile.role);

    let query = supabase
        .from('ticket_replies')
        .select('*, profiles(full_name, role)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

    // إذا كان المستخدم ليس موظف دعم/أدمن، نفلتر الملاحظات الداخلية
    if (!isStaff) {
        query = query.eq('is_internal', false);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data;
}

/* ==================== الردود الجاهزة (Canned Responses) ==================== */

export async function fetchCannedResponses() {
    const { data, error } = await supabase
        .from('canned_responses')
        .select('*')
        .order('category', { ascending: true })
        .order('title', { ascending: true });
    if (error) throw error;
    return data || [];
}

export async function createCannedResponse({ title, content, category = null, shortcut = null }) {
    const user = await getCurrentUser();
    if (!title || !title.trim()) throw new Error('عنوان الرد الجاهز مطلوب');
    if (!content || !content.trim()) throw new Error('محتوى الرد مطلوب');

    const { data, error } = await supabase
        .from('canned_responses')
        .insert({
            title: title.trim(),
            content: content.trim(),
            category: category ? category.trim() : null,
            shortcut: shortcut ? shortcut.trim() : null,
            created_by: user ? user.id : null
        })
        .select()
        .single();

    if (error) throw error;
    await logActivity('canned_response_create', { canned_response_id: data.id });
    return data;
}

export async function updateCannedResponse(id, { title, content, category, shortcut }) {
    const { data, error } = await supabase
        .from('canned_responses')
        .update({
            title: title?.trim(),
            content: content?.trim(),
            category: category ? category.trim() : null,
            shortcut: shortcut ? shortcut.trim() : null,
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteCannedResponse(id) {
    const { error } = await supabase.from('canned_responses').delete().eq('id', id);
    if (error) throw error;
}

/* ==================== الوسوم (Tags) ==================== */

export async function fetchTags() {
    const { data, error } = await supabase.from('ticket_tags').select('*').order('name', { ascending: true });
    if (error) throw error;
    return data || [];
}

export async function createTag(name, color = '#4DA3FF') {
    const user = await getCurrentUser();
    if (!name || !name.trim()) throw new Error('اسم الوسم مطلوب');

    const { data, error } = await supabase
        .from('ticket_tags')
        .insert({ name: name.trim(), color, created_by: user ? user.id : null })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteTag(id) {
    const { error } = await supabase.from('ticket_tags').delete().eq('id', id);
    if (error) throw error;
}

export async function fetchTicketTags(ticketId) {
    const { data, error } = await supabase
        .from('ticket_tag_links')
        .select('tag_id, ticket_tags(id, name, color)')
        .eq('ticket_id', ticketId);
    if (error) throw error;
    return (data || []).map(r => r.ticket_tags).filter(Boolean);
}

/**
 * جلب كل الوسوم لكل التذاكر دفعة واحدة (لتفادي استدعاء منفصل لكل تذكرة عند العرض في القائمة)
 */
export async function fetchAllTicketTagLinks() {
    const { data, error } = await supabase
        .from('ticket_tag_links')
        .select('ticket_id, tag_id, ticket_tags(id, name, color)');
    if (error) throw error;
    return data || [];
}

export async function addTagToTicket(ticketId, tagId) {
    const { error } = await supabase.from('ticket_tag_links').insert({ ticket_id: ticketId, tag_id: tagId });
    if (error) throw error;
}

export async function removeTagFromTicket(ticketId, tagId) {
    const { error } = await supabase.from('ticket_tag_links').delete().eq('ticket_id', ticketId).eq('tag_id', tagId);
    if (error) throw error;
}

/* ==================== مرفقات متعددة ==================== */

/**
 * رفع مرفق واحد للتذكرة (يُستدعى مرة لكل ملف عند اختيار عدة ملفات)
 * يخزن الملف في bucket "tickets" الموجود مسبقاً، ويربطه بصف في ticket_attachments.
 */
export async function uploadTicketAttachment(ticketId, file, replyId = null) {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${ticketId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;

    const { error: uploadError } = await supabase.storage.from('tickets').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined
    });
    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage.from('tickets').getPublicUrl(path);

    const { data, error } = await supabase
        .from('ticket_attachments')
        .insert({
            ticket_id: ticketId,
            reply_id: replyId,
            file_url: publicUrlData.publicUrl,
            file_name: file.name,
            file_size: file.size,
            mime_type: file.type || null,
            uploaded_by: user.id
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function fetchTicketAttachments(ticketId) {
    const { data, error } = await supabase
        .from('ticket_attachments')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

/* ==================== سجل النشاط (Activity Timeline) ==================== */

export async function fetchTicketActivity(ticketId) {
    const { data, error } = await supabase
        .from('ticket_activity')
        .select('*, profiles(full_name, role)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

/* ==================== تقييم العميل بعد الإغلاق ==================== */

export async function submitTicketRating(ticketId, rating, comment = '') {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    if (!rating || rating < 1 || rating > 5) throw new Error('التقييم يجب أن يكون بين 1 و 5');

    const { data, error } = await supabase
        .from('ticket_ratings')
        .insert({ ticket_id: ticketId, user_id: user.id, rating, comment: comment?.trim() || null })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function fetchTicketRating(ticketId) {
    const { data, error } = await supabase
        .from('ticket_ratings')
        .select('*')
        .eq('ticket_id', ticketId)
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function fetchAllTicketRatings() {
    const { data, error } = await supabase.from('ticket_ratings').select('*');
    if (error) throw error;
    return data || [];
}

/* ==================== فلاتر بحث محفوظة ==================== */

export async function fetchSavedFilters() {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    const { data, error } = await supabase
        .from('saved_ticket_filters')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function createSavedFilter(name, filters) {
    const user = await getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    if (!name || !name.trim()) throw new Error('اسم الفلتر مطلوب');

    const { data, error } = await supabase
        .from('saved_ticket_filters')
        .insert({ user_id: user.id, name: name.trim(), filters })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteSavedFilter(id) {
    const { error } = await supabase.from('saved_ticket_filters').delete().eq('id', id);
    if (error) throw error;
}

/* ==================== لوحة الإحصائيات (Analytics) ==================== */

/**
 * يحسب مؤشرات أداء نظام التذاكر: متوسط زمن الحل، نسبة مخالفة SLA،
 * توزيع التذاكر حسب الموظف/التصنيف/الأولوية، ومتوسط تقييم رضا العملاء (CSAT).
 * الحساب يتم في الواجهة الأمامية من نفس البيانات المجلوبة أصلاً (allTickets)
 * تفادياً لاستدعاءات إضافية، وهذه الدالة تجلب فقط ما لا يتوفر أصلاً (التقييمات).
 */
export async function fetchTicketAnalyticsExtras() {
    const [ratings, agents] = await Promise.all([
        fetchAllTicketRatings(),
        fetchSupportAgents()
    ]);
    return { ratings, agents };
}
