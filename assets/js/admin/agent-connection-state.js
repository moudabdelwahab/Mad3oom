/**
 * حالة اتصال الوكيل — منطق نقي بلا اعتماد على DOM أو Supabase
 * (نفس نمط assets/js/admin/mcp-ui-state.js)، حتى يمكن اختباره
 * بـ node --test مباشرة.
 * ------------------------------------------------------------------
 * لماذا يوجد هذا الملف: «بلا endpoint» ليست خطأً. وكيل مثل Muse
 * مسجّل في ai_agents بلا endpoint لأنه يُدار من خارج مدعوم
 * (عبر ربط MCP)، ومع ذلك كانت
 * الواجهة تعامل فحص الاتصال والحالة والسجلات لهم كفشل يستحق تنبيهاً
 * أحمر — «الوكيل غير متصل بعد: لا يوجد endpoint مُعد لهذا الوكيل».
 * القاعدة هنا: غياب الـ endpoint حالة صادقة تُعرض كمعلومة محايدة،
 * لا كخطأ يُصحَّح؛ والنداءات التي تحتاج اتصالاً مباشراً تُتخطّى
 * أصلاً بدل أن تُستدعى لتفشل.
 */
export const NO_ENDPOINT_MESSAGE =
    'هذا الوكيل بلا endpoint — يُدار من خارج مدعوم (مثل ربط MCP)، فلا يوجد اتصال مباشر لفحصه أو التحكم فيه من هنا.';

/** نص قصير يظهر في كرت الوكيل الذي بلا endpoint. */
export const NO_ENDPOINT_CARD_NOTE = 'بلا endpoint — ربط خارجي';

/** true لو للوكيل endpoint مباشر يمكن الوصول إليه (فحص/سجلات/تحكم). */
export function hasDirectEndpoint(agent) {
    return typeof agent?.endpoint === 'string' && agent.endpoint.trim() !== '';
}

/** true لو الوكيل مسجّل بلا endpoint — حالة عادية، لا خطأ. */
export function isEndpointLessAgent(agent) {
    return !hasDirectEndpoint(agent);
}
