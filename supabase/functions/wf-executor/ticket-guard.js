/**
 * ticket-guard.js — عزل الشركات (097) لخطوات سير العمل التي تعمل على تذكرة بمعرّفها.
 *
 * wf-executor يعمل بمفتاح الخدمة، فلا RLS تحرسه. الخطوتان المبنيتان على دوال القاعدة (wf_assign_ticket و
 * wf_update_ticket_status) ترفضان تذكرة الشركة حين العزل مفعّل (097). أما الوسم وسجل النشاط والبريد واستطلاع
 * الرضا فتقرأ التذكرة وتكتب فيها مباشرة: بلا هذا الحارس يصل طاقم المنصة إلى تذكرة شركة بمعرّفها رغم العزل.
 *
 * القرار نفسه كما في 097: مع العزل، تذكرة scope = 'company' «غير موجودة» لسير العمل (نفس رسالة غيابها، فلا كاشف).
 * يفشل مغلقًا: تعذّر قراءة حالة العزل أو التذكرة ⇒ رفض.
 *
 * وحدة خالصة بلا Deno: تأخذ عميلًا بواجهة supabase-js (rpc و from)، مُختبَرة في tests/wf-executor-ticket-guard.test.mjs.
 */
export const TICKET_NOT_FOUND = 'التذكرة غير موجودة';

export async function assertWorkflowTicketAllowed(db, ticketId) {
    if (!ticketId) throw new Error(TICKET_NOT_FOUND);
    const { data: isolationOn, error: e0 } = await db.rpc('_isolation_on');
    if (e0 || typeof isolationOn !== 'boolean') throw new Error(TICKET_NOT_FOUND);
    if (!isolationOn) return;
    const { data: ticket, error: e1 } = await db.from('tickets').select('scope').eq('id', ticketId).maybeSingle();
    if (e1 || !ticket || ticket.scope !== 'mad3oom_support') throw new Error(TICKET_NOT_FOUND);
}
