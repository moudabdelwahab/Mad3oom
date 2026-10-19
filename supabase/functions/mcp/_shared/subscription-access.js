/**
 * subscription-access.js — من يرى اشتراكًا في MCP (تدقيق جاهزية العزل، 107).
 *
 * MCP يقرأ بمفتاح الخدمة، فلا RLS تحرسه. القاعدة هنا تطابق سياسات whatsapp_subscriptions في القاعدة حرفيًا:
 * صاحب الاشتراك (auth.uid() = user_id) أو الإدارة (is_admin). الاشتراك الشخصي فوترة بين صاحبه ومدعوم
 * (097/098): مالك شركة لا يقرأ اشتراك عميله ولا يلغيه لمجرد أن super_user_id يشير إليه.
 * اشتراك الشركة نفسه صفّه باسم مالكها (user_id = المالك)، فيبقى ظاهرًا له.
 *
 * وحدة خالصة بلا Deno ولا شبكة، مُختبَرة في tests/mcp-ticket-isolation.test.mjs.
 */
export function subscriptionVisibleTo(actor, ownerId) {
    if (!actor || !ownerId) return false;
    if (actor.isMainAdmin || actor.isAdmin) return true;
    return String(ownerId) === String(actor.id);
}

/** فلتر القائمة: null = كل الاشتراكات (الإدارة)، وإلا اشتراكات المنادي وحده. */
export function subscriptionListOwner(actor) {
    if (!actor) return '00000000-0000-0000-0000-000000000000';
    return actor.isMainAdmin || actor.isAdmin ? null : String(actor.id);
}
