/**
 * Bootstrap
 * --------------------------------------------------------
 * فجوة كانت موجودة في السكافولد: كل auth provider وكل transport يسجّل
 * نفسه عبر registerAuthProvider()/registerTransport() كـ side effect عند
 * الاستيراد (بالضبط كما يصف README: "ملف جديد + سطر تسجيل واحد") - لكن
 * لا شيء كان يستورد تلك الملفات فعليًا. بدون هذا الملف، أول استدعاء لـ
 * resolveAuthProvider()/resolveTransport() كان سيفشل بـ "غير مسجّل" دائمًا،
 * حتى لو كان provider/transport المطلوب موجودًا في الكود.
 *
 * هذا ليس طبقة تجريد جديدة - فقط composition root يجمع أثر الاستيراد.
 * لا منطق هنا، فقط استيراد لأجل التسجيل (import for side effects).
 *
 * الاستخدام: استورد هذا الملف مرة واحدة عند بدء تشغيل العملية (Edge Function
 * cold start، أو أعلى نقطة دخول تستخدم ConnectionManager) قبل أي استخدام
 * فعلي لـ ConnectionManager/AuthenticationManager:
 *
 *   import '../bootstrap.js';
 *   import { ConnectionManager } from '../connection-manager/connection-manager.js';
 *
 * ترتيب الاستيراد هنا غير مهم - كل ملف يسجّل نفسه بشكل مستقل بالكامل.
 */

// Auth providers
import './auth/providers/none.js';
import './auth/providers/api-key.js';
import './auth/providers/bearer.js';
import './auth/providers/custom.js';
import './auth/providers/oauth2.js';

// Transports
import './transport/transports/streamable-http.js';
import './transport/transports/sse.js';
import './transport/transports/stdio.js';

import { listRegisteredAuthTypes } from './auth/registry.js';
import { listRegisteredTransports } from './transport/registry.js';

/** يُستخدم للتحقق وقت الإقلاع (health check / اختبارات) أن كل شيء مسجَّل فعليًا */
export function assertBootstrapped() {
    const authTypes = listRegisteredAuthTypes();
    const transports = listRegisteredTransports();
    const missingAuth = ['none', 'api_key', 'bearer', 'oauth2', 'custom'].filter((t) => !authTypes.includes(t));
    const missingTransports = ['streamable_http', 'sse', 'stdio'].filter((t) => !transports.includes(t));
    if (missingAuth.length || missingTransports.length) {
        throw new Error(
            `Bootstrap ناقص - auth مفقود: [${missingAuth.join(', ')}], transport مفقود: [${missingTransports.join(', ')}]`
        );
    }
    return { authTypes, transports };
}
