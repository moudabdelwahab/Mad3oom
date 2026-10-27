/**
 * ticket-email-data.js — قراءة بيانات بريد التذكرة من القاعدة (عميل Supabase بمفتاح الخدمة يُحقن).
 * يستعملها send-ticket-email وخطوات البريد في wf-executor، فتعرض الرسائل كلها الحقول نفسها من المصدر نفسه.
 * الأعمدة التي يعرضها القالب فقط (_shared/ticket-email.js)؛ لا وصف التذكرة ولا بيانات حساسة.
 */
export const TICKET_EMAIL_COLUMNS =
    'id, ticket_number, title, status, ticket_type, category, created_at, last_updated_at, user_id, scope, company_id';

/** @param {{ from: Function }} db عميل Supabase بمفتاح الخدمة */
export function ticketEmailData(db) {
    return {
        async getTicket(id) {
            const { data } = await db.from('tickets').select(TICKET_EMAIL_COLUMNS).eq('id', id).maybeSingle();
            return data || null;
        },
        async getProfile(id) {
            const { data } = await db.from('profiles').select('email, full_name, first_name, last_name').eq('id', id).maybeSingle();
            return data || null;
        },
        /**
         * تذكرة شركة ⇒ الشركة المختومة عليها (company_id، 097)؛ تذكرة مع مدعوم ⇒ شركة صاحب التذكرة إن كان
         * مالكها. لا يُعرض اسم شركة غيرهما، فلا يرى المستلم إلا شركته أو الشركة التي يتعامل معها في التذكرة.
         */
        async getCompanyName(ticket) {
            if (ticket?.scope === 'company' && ticket.company_id) {
                const { data } = await db.from('companies').select('company_name').eq('id', ticket.company_id).maybeSingle();
                return data?.company_name || null;
            }
            if (!ticket?.user_id) return null;
            const { data } = await db.from('companies').select('company_name').eq('user_id', ticket.user_id)
                .order('created_at', { ascending: true }).limit(1).maybeSingle();
            return data?.company_name || null;
        },
        async getReply(id) {
            const { data } = await db.from('ticket_replies').select('id, ticket_id, user_id, message, is_internal').eq('id', id).maybeSingle();
            return data || null;
        }
    };
}
