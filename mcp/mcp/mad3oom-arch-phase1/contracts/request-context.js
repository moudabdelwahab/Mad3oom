/**
 * RequestContext - العقد المشترك بين Auth و Transport
 * --------------------------------------------------------
 * هذا الملف كان مُشارًا إليه (عبر JSDoc @typedef import) من auth/types.js
 * و transport/types.js و transport/transports/streamable-http.js، لكنه لم
 * يكن موجودًا فعليًا في السكافولد المرفوع - تم إنشاؤه الآن ليطابق بالضبط
 * الشكل الذي تفترضه تلك الملفات الثلاثة (لا تغيير في توقيعاتها).
 *
 * RequestContext هو الشكل العام الوحيد الذي يُمرَّر من AuthContext.applyToRequest()
 * إلى Transport.send() عبر Connection Manager. لا Auth يعرف Transport، ولا
 * Transport يعرف Auth - كلاهما يتفقان فقط على شكل هذا الكائن.
 *
 * كل حقل اختياري تمامًا؛ أي Transport يطبّق فقط الحقول التي يفهمها فعليًا
 * ويتجاهل الباقي بصمت (موثّق في transport/types.js). إضافة طريقة مصادقة
 * جديدة تحتاج حقلاً غير موجود هنا = إضافة حقل اختياري جديد فقط، بدون
 * كسر أي Transport أو AuthProvider حالي.
 */

/** @typedef {{
 *   headers?: Record<string, string>,
 *   query?: Record<string, string>,
 *   cookies?: Record<string, string>,
 *   tls?: { clientCert?: string, clientKey?: string, ca?: string },
 *   sign?: (payload: unknown) => Promise<unknown>,
 * }} RequestContext
 *   - headers: تُدمج فوق أي headers افتراضية (مثل Content-Type) - لا تُستبدل كليًا
 *   - query: تُضاف كـ query params على الـ URL (توقيع عبر query-param مثلاً)
 *   - cookies: تُجمَّع في Cookie header واحد بمعرفة الـ Transport
 *   - tls: mTLS - غير مدعوم من fetch() في المتصفح، تتجاهله streamable-http
 *          transport بصمت وتُحذّر في console فقط؛ بيئات server-side مستقبلية
 *          (Deno/Node) يمكنها تنفيذه دون تعديل هذا العقد
 *   - sign: توقيع الـ payload بالكامل (HMAC مثلاً) قبل الإرسال - يُستدعى
 *          كخطوة أخيرة قبل transport.send() الفعلي
 */

export {};
