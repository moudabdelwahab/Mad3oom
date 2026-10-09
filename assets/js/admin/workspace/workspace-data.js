/**
 * workspace-data.js — قراءات مساحة العمل نفسها (لا كتابة إطلاقًا)
 * ---------------------------------------------------------------------------
 * مساحة العمل لا تكتب أي بيانات: كل كتابة تحدث داخل الصفحة المضمّنة عبر
 * دوالها القائمة. هنا قراءتان فقط، كلتاهما بصلاحيات الموظف نفسه (RLS):
 *
 *   resolvePanels  هل ما زال الموظف يرى هذا السجل؟ وما عنوانه؟ — قبل عرض
 *                  تبويب مستعاد أو مفتوح من رابط. «لا يُرى» نتيجة قاطعة فقط
 *                  حين ينجح الاستعلام ولا يرجع الصف؛ خطأ الشبكة ليس رفضًا.
 *   searchRecords  البحث السريع (Ctrl+K) في المحادثات والتذاكر والعملاء.
 *
 * العناوين تُجلب حيّة بعد التفويض ولا تُحفظ أبدًا مع الترتيب.
 */
import { supabase } from '/api-config.js';
import { panelType } from './panel-registry.js';
import { normalize } from '../command-palette.js';

/** @returns {Promise<Map<string, {ok: true, title: string}|{ok: false}>>} المفقود من الخريطة = غير معروف */
export async function resolvePanels(panels) {
    const out = new Map();
    const byType = { conversation: [], ticket: [], customer: [] };
    for (const p of panels) if (byType[p.type]) byType[p.type].push(p);

    const ids = (list) => [...new Set(list.map((p) => p.params[panelType(p.type).param]))];

    const tasks = [];
    if (byType.conversation.length) tasks.push(resolveConversations(byType.conversation, ids(byType.conversation), out));
    if (byType.ticket.length) tasks.push(resolveTickets(byType.ticket, ids(byType.ticket), out));
    if (byType.customer.length) tasks.push(resolveCustomers(byType.customer, ids(byType.customer), out));
    await Promise.all(tasks.map((t) => t.catch(() => null)));
    return out;
}

async function resolveConversations(panels, sessionIds, out) {
    const { data, error } = await supabase.from('chat_sessions').select('id, user_id').in('id', sessionIds);
    if (error) return;
    const visible = new Set((data || []).map((s) => s.id));
    let names = new Map();
    if (visible.size) {
        const { data: customers } = await supabase.rpc('inbox_customer_profiles', { p_sessions: [...visible] });
        names = new Map((customers || []).map((c) => [c.session_id, c.full_name || c.email || '']));
    }
    for (const p of panels) {
        const id = p.params.sessionId;
        out.set(p.id, visible.has(id) ? { ok: true, title: names.get(id) || '' } : { ok: false });
    }
}

async function resolveTickets(panels, ticketIds, out) {
    const { data, error } = await supabase.from('tickets').select('id, ticket_number, title').in('id', ticketIds);
    if (error) return;
    const rows = new Map((data || []).map((t) => [t.id, t]));
    for (const p of panels) {
        const t = rows.get(p.params.ticketId);
        out.set(p.id, t ? { ok: true, title: ticketTitle(t) } : { ok: false });
    }
}

async function resolveCustomers(panels, customerIds, out) {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email').in('id', customerIds);
    if (error) return;
    const rows = new Map((data || []).map((c) => [c.id, c]));
    for (const p of panels) {
        const c = rows.get(p.params.customerId);
        out.set(p.id, c ? { ok: true, title: c.full_name || c.email || '' } : { ok: false });
    }
}

export function ticketTitle(t) {
    return [t.ticket_number != null ? `#${t.ticket_number}` : '', t.title || ''].filter(Boolean).join(' ');
}

/* ====================  البحث السريع  ==================== */

/**
 * محارف تفصل الشروط أو تقتبسها في صياغة فلاتر PostgREST (or=(…))، ومحارف
 * الأنماط. تُحذف من نص البحث قبل بناء الفلتر — وإلا أمكن لنص مثل
 * «x,role.eq.admin» أن يضيف شرطًا جديدًا للاستعلام. النقطة و@ تبقى: هي جزء من
 * القيمة (بريد إلكتروني) ولا تفصل شيئًا بعد العمود والعامل.
 */
const FILTER_UNSAFE = /[,()"'\\*%]/g;
export const safeTerm = (term) => String(term ?? '').replace(FILTER_UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

let recentConversations = null;
let recentAt = 0;

async function loadRecentConversations() {
    if (recentConversations && Date.now() - recentAt < 60_000) return recentConversations;
    const { data, error } = await supabase.from('chat_sessions')
        .select('id, user_id, status, updated_at').order('updated_at', { ascending: false }).limit(300);
    if (error) throw error;
    const sessions = data || [];
    let names = new Map();
    if (sessions.length) {
        const { data: customers } = await supabase.rpc('inbox_customer_profiles', { p_sessions: sessions.map((s) => s.id) });
        names = new Map((customers || []).map((c) => [c.session_id, c]));
    }
    recentConversations = sessions.map((s) => ({ ...s, customer: names.get(s.id) || null }));
    recentAt = Date.now();
    return recentConversations;
}

/**
 * @returns {Promise<Array<{type, params, title, subtitle, group}>>}
 */
export async function searchRecords(query) {
    const term = safeTerm(query.replace(/^#/, ''));
    if (term.length < 2 && !/^\d+$/.test(term)) return [];
    const needle = normalize(term);

    const conversations = loadRecentConversations().then((rows) => rows
        .filter((s) => normalize(`${s.customer?.full_name || ''} ${s.customer?.email || ''}`).includes(needle))
        .slice(0, 6)
        .map((s) => ({
            type: 'conversation', params: { sessionId: s.id }, group: 'conversation',
            title: s.customer?.full_name || s.customer?.email || '—',
            subtitle: s.customer?.email && s.customer?.full_name ? s.customer.email : ''
        })));

    const ticketQuery = supabase.from('tickets').select('id, ticket_number, title, status');
    const tickets = (/^\d+$/.test(term) ? ticketQuery.eq('ticket_number', Number(term)) : ticketQuery.ilike('title', `%${term}%`))
        .order('created_at', { ascending: false }).limit(6)
        .then(({ data, error }) => {
            if (error) throw error;
            return (data || []).map((t) => ({
                type: 'ticket', params: { ticketId: t.id }, group: 'ticket',
                title: ticketTitle(t), subtitle: t.status || ''
            }));
        });

    const customers = (term.length >= 2
        ? supabase.from('profiles').select('id, full_name, email')
            .or(`full_name.ilike.*${term}*,email.ilike.*${term}*`).limit(6)
            .then(({ data, error }) => {
                if (error) throw error;
                return (data || []).map((c) => ({
                    type: 'customer', params: { customerId: c.id }, group: 'customer',
                    title: c.full_name || c.email || '—', subtitle: c.full_name ? (c.email || '') : ''
                }));
            })
        : Promise.resolve([]));

    const settled = await Promise.allSettled([conversations, tickets, customers]);
    return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
