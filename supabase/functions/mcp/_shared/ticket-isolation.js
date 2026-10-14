/**
 * ticket-isolation.js — قرار رؤية تذكرة في MCP بعد 097 (عزل الشركات، D9).
 *
 * MCP يقرأ بمفتاح الخدمة، فلا RLS تحرسه: القرار هنا يطابق السياسة التقييدية
 * tenant_isolation في القاعدة (_ticket_row_visible). مع مفتاح company_isolation_enforced
 * مطفأ (أو قبل 097) لا يتغير شيء.
 *
 *   • صاحب التذكرة يراها دائمًا.
 *   • تذكرة شركة (scope = company): فريق تلك الشركة فقط (المالك أو موظف نشط).
 *   • تذكرة مدعوم (mad3oom_support): طاقم المنصة فقط — لا مالك شركة صاحبها.
 *
 * وحدة خالصة بلا Deno ولا شبكة، مُختبَرة في tests/mcp-ticket-isolation.test.mjs.
 */

/** سياق العزل من رد mcp_ticket_tenancy(p_actor)، أو مطفأ إن لم تكن الدالة موجودة (قبل 097). */
export function tenancyFromRpc(data, error) {
    if (error || !data || typeof data !== 'object') return { isolationOn: false, teamCompanyIds: [] };
    return {
        isolationOn: data.isolation_on === true,
        teamCompanyIds: Array.isArray(data.team_company_ids) ? data.team_company_ids.map(String) : []
    };
}

export function ticketVisibleUnderIsolation(actor, ticket, ctx) {
    if (!ctx || ctx.isolationOn !== true) return true;
    if (!actor || !ticket) return false;
    if (ticket.user_id === actor.id) return true;
    if (ticket.scope === 'company') {
        return !!ticket.company_id && ctx.teamCompanyIds.includes(String(ticket.company_id));
    }
    if (ticket.scope === 'mad3oom_support') return actor.isMainAdmin === true || actor.isAdmin === true;
    return false;
}

/** أعمدة الإحصاءات: مع العزل نحتاج النطاق والشركة لنطبّق القرار نفسه. */
export function statsColumns(ctx) {
    return ctx && ctx.isolationOn === true ? 'status, user_id, scope, company_id' : 'status';
}
