/**
 * comm-data.js — نداءات محرّك التواصل (migrations/123_communication_engine.sql).
 *
 * كل قراءة وكتابة عبر دوال comm_* في القاعدة؛ لا وصول مباشر لأي جدول (لا منح عليها أصلًا).
 * المرفقات: comm_attachment_begin يحجز مسارًا يختاره الخادم، ثم الرفع إلى المستودع الخاص
 * comm-attachments (سياسة الرفع تقبل المسار المحجوز لصاحبه وحده)، ثم تُربط بالرسالة داخل
 * comm_post في نفس المعاملة. التنزيل برابط موقّع قصير، وسياسة القراءة تعيد فحص الرسالة.
 */
import { supabase } from '/api-config.js';

export const BUCKET = 'comm-attachments';

const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
export { newKey };

async function call(name, args) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) return { ok: false, error };
        return { ok: true, data };
    } catch (err) {
        console.error(`[Comm] ${name}:`, err?.message || err);
        return { ok: false, error: { code: 'network', message: '' } };
    }
}

export const fetchOverview = () => call('comm_overview');

export const fetchThreads = (scope, filter = 'open', q = null) =>
    call('comm_threads_list', { p_scope: scope, p_filter: filter, p_q: q || null });

export const fetchThread = (scope, id) => call('comm_thread', { p_scope: scope, p_thread: id });

export const startThread = ({ scope, category, subject, body, priority, key, attachments = null }) =>
    call('comm_thread_start', {
        p_scope: scope, p_category: category, p_subject: subject, p_body: body,
        p_idempotency_key: key, p_priority: priority || 'normal', p_attachments: attachments
    });

export const postMessage = ({ scope, thread, body, internal = false, attachments = null }) =>
    call('comm_post', { p_scope: scope, p_thread: thread, p_body: body, p_internal: internal, p_attachments: attachments });

export const assignThread = (scope, thread, assignee) =>
    call('comm_thread_assign', { p_scope: scope, p_thread: thread, p_assignee: assignee || null });

export const setThreadStatus = (scope, thread, status) =>
    call('comm_thread_set_status', { p_scope: scope, p_thread: thread, p_status: status });

/**
 * رفع ملف لمحادثة: حجز ثم رفع. يعيد معرّف الحجز ليُرسل مع الرسالة.
 * @returns {Promise<{ok: boolean, id?: string, error?: object}>}
 */
export async function uploadAttachment(scope, thread, file) {
    const begin = await call('comm_attachment_begin', {
        p_scope: scope, p_thread: thread, p_name: file.name, p_mime: file.type, p_size: file.size
    });
    if (!begin.ok) return begin;
    try {
        const { error } = await supabase.storage.from(BUCKET).upload(begin.data.path, file, {
            contentType: file.type, upsert: false
        });
        if (error) return { ok: false, error: { code: 'upload', message: error.message || '' } };
    } catch (err) {
        return { ok: false, error: { code: 'upload', message: err?.message || '' } };
    }
    return { ok: true, id: begin.data.attachment_id };
}

/** رابط تنزيل موقّع قصير العمر (سياسة القراءة في القاعدة تقرر). */
export async function attachmentUrl(path) {
    try {
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
        if (error || !data?.signedUrl) return null;
        return data.signedUrl;
    } catch {
        return null;
    }
}

/**
 * تحويل المحادثة إلى تذكرة: إنشاؤها بالمسار المعتاد (حصة التذاكر وختم الشركة والعزل كما هي)،
 * ثم ربطها بالمحادثة على الخادم (comm_link_ticket يتحقق أنها تذكرة المنادي نفسه وحديثة).
 */
export async function convertToTicket(scope, thread, { title, description, category }) {
    let ticket;
    try {
        // تحميل عند الحاجة: لوحات بلا تحويل (الإدارة والمالك) لا تحمّل خدمة التذاكر
        const { createTicket } = await import('/tickets-service.js');
        ticket = await createTicket({ title, description, priority: 'medium', category });
    } catch (err) {
        return { ok: false, error: { code: 'ticket', message: err?.message || '' } };
    }
    const link = await call('comm_link_ticket', { p_scope: scope, p_thread: thread, p_ticket: ticket.id });
    if (!link.ok) return link;
    return { ok: true, data: link.data };
}
