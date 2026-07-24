/**
 * Transport Negotiator
 * --------------------------------------------------------
 * كان مُستوردًا فعليًا من connection-manager.js (`import { negotiateTransport }
 * from '../transport/negotiator.js'`) لكن الملف لم يكن موجودًا في السكافولد
 * المرفوع - أي استخدام لـ ConnectionManager كان سيفشل فورًا بخطأ استيراد.
 * تم إنشاؤه الآن ليطابق بالضبط ما يفترضه الاستدعاء الحالي: دالة واحدة
 * synchronous تاخذ connection وترجّع Transport جاهز (عبر registry.js
 * الموجود بالفعل) - بدون أي "if kind === " هنا، فقط تحديد أي حقل من
 * connection يُقرأ ثم تفويض القرار الفعلي لـ resolveTransport().
 *
 * اليوم: المصدر الوحيد هو connection.transport (عمود موجود فعليًا في
 * mcp_servers، بنفس القيم المسجَّلة في transport/registry.js: stdio/sse/
 * streamable_http - راجع MCP_TRANSPORTS في mcp-service.js).
 *
 * لاحقًا (Phase 1+، بعد إضافة supported_transports من initialize/discovery
 * كما ورد في تقرير المعمارية): تُضاف أولوية اختيار هنا فقط (مثلاً تفضيل
 * streamable_http لو السيرفر يعلن دعمه حتى لو connection.transport القديم
 * كان sse) - دون تعديل ConnectionManager أو أي كود يستهلك negotiateTransport().
 */
import { resolveTransport } from './registry.js';

/**
 * @param {object} connection - سجل الاتصال (server + connection row مدموجين)
 * @returns {import('./types.js').Transport}
 */
export function negotiateTransport(connection) {
    const kind = connection?.transport;
    if (!kind) {
        throw new Error('Transport Negotiator: connection.transport غير موجود - لا يمكن تحديد نوع النقل');
    }
    return resolveTransport(kind);
}
