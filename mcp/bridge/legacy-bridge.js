/**
 * Legacy Bridge
 * --------------------------------------------------------
 * ملاحظة مهمة: هذا الملف مذكور في خطة المعمارية كمكوّن قائم ("Legacy Bridge")
 * لكنه لم يكن موجودًا فعليًا في السكافولد المرفوع - تم إنشاؤه الآن من الصفر
 * كنقطة التكامل الوحيدة بين الكود القديم (mcp-service.js + الـ Edge Functions
 * الحالية: test-mcp-server / mcp-invoke-tool / mcp-server-info) والمعمارية
 * الجديدة (McpSession → ConnectionManager → AuthenticationManager).
 *
 * حدود واضحة لهذه المرحلة (Phase 0):
 *  - هذا الملف لا يُستورَد من أي مكان بعد. لا mcp.js، لا mcp-service.js،
 *    ولا أي Edge Function حالية تستدعيه - لأن مصدر تلك الـ Edge Functions
 *    غير موجود في هذا السكافولد، وإعادة كتابتها ممنوعة صراحة في هذه المرحلة
 *    (بند 6). هذا الملف "جاهز للربط"، وليس مربوطًا فعليًا.
 *  - يجب أن يُشغَّل في نفس حدود الثقة الخاصة بالـ Edge Functions الحالية
 *    (Deno server-side)، أبدًا من المتصفح - بالضبط نفس القيد المذكور في
 *    auth/providers/*.js. لا يفك أي سر بنفسه؛ يستقبل resolveSecret كدالة
 *    من المستدعي (نفس الدالة التي يستخدمها test-mcp-server اليوم فعليًا).
 *  - لا تعديل على mcp_servers / mcp_server_connections - يقرأ نفس الأعمدة
 *    الموجودة بالفعل (راجع CONNECTION_SAFE_COLUMNS / SERVER_BASE_COLUMNS في
 *    mcp-service.js) ويكتب فقط أشكال بيانات يقبلها الكود الحالي كما هو.
 *
 * نقطة التكامل الفعلية المستقبلية (Phase 1، خارج نطاق هذا الملف):
 *   داخل test-mcp-server Edge Function، استبدال منطق الاتصال المباشر بـ:
 *     import { discoverServerViaBridge, isBridgeEnabledFor } from '.../bridge/legacy-bridge.js';
 *     if (isBridgeEnabledFor(server.id)) return discoverServerViaBridge({ server, connection, resolveSecret, legacyStartOAuth, hasPlatformApp });
 *     else <المسار القديم كما هو>
 *   هذا سطر IF واحد حول الكود القديم - لا حذف، قابل للتراجع فورًا.
 *
 * تحديث Phase 1 - تباينات حقيقية اكتُشفت عند مقارنة هذا الملف بمصدر
 * test-mcp-server/mcp-invoke-tool الفعلي (غير متاح وقت Phase 0):
 *  1) `connection.api_key_header` المستخدم سابقًا هنا غير موجود كعمود فعلي في
 *     mcp_server_connections، والشكل الحقيقي لـ auth_type=api_key هو دائمًا
 *     `Authorization: Bearer <api_key>[.<api_secret>]` - تم حذف الحقل من هنا
 *     وتصحيح auth/providers/api-key.js ليطابق ذلك حرفيًا.
 *  2) `custom_config` الحقيقي (auth_type=custom) هو كائن headers مباشرة
 *     (`Object.assign(headers, JSON.parse(...))`) وليس `{ headers: {...} }`
 *     كما افترض auth/providers/custom.js سابقًا - تم تصحيحه كذلك.
 *  3) `server.connector_type === 'oauth_connector'` (REST بعد OAuth، مش خادم
 *     MCP حقيقي) موجود فعليًا في mcp_servers ومُتحقَّق منه صراحة في كل من
 *     test-mcp-server (يشغّل runOauthConnectorCheck بدل runTest) وفي
 *     mcp-invoke-tool (يرفض استدعاء الأدوات برسالة واضحة). هذا الجسر بروتوكول
 *     MCP فقط (JSON-RPC) - لا معنى لتشغيله على oauth_connector إطلاقًا. نقطة
 *     التكامل الفعلية تتحقق من connector_type *قبل* استدعاء isBridgeEnabledFor،
 *     ولا تلمس مسار runOauthConnectorCheck نهائيًا.
 */
import '../bootstrap.js';
import { ConnectionManager } from '../connection-manager/connection-manager.js';
import { McpSession } from '../session/mcp-session.js';

/**
 * تفعيل تدريجي بدون عمود DB جديد (ممنوع هذه المرحلة، بند 6): allowlist
 * تُمرَّر من المستدعي (مثلاً من متغير بيئة على مستوى الـ Edge Function نفسها)
 * بدل تخزينها في قاعدة البيانات. افتراضيًا: معطّل بالكامل، أي صفر تغيير
 * سلوك حتى يُفعَّل صراحة سيرفر واحد وقت الاختبار.
 * @param {string} serverId
 * @param {{ enabledServerIds?: string[] }} [opts]
 */
export function isBridgeEnabledFor(serverId, { enabledServerIds = [] } = {}) {
    return enabledServerIds.includes(serverId);
}

/**
 * يبني كائن connection بالشكل الذي تتوقعه AuthenticationManager/AuthProvider
 * (auth/types.js) من صفَّي server + connection الحاليين تمامًا كما يُرجعهما
 * mergeServerWithConnection في mcp-service.js اليوم - بدون أي عمود جديد.
 *
 * @param {object} input
 * @param {object} input.server - صف mcp_servers (id, name, transport, url, ...)
 * @param {object} [input.connection] - صف mcp_server_connections (auth_type, oauth_token_expires_at, ...) أو undefined لو أول اتصال
 * @param {(secretName: string) => Promise<unknown>} input.resolveSecret - نفس دالة فك التشفير المستخدمة اليوم في test-mcp-server (لا تُنفَّذ هنا)
 * @param {() => Promise<{ authorize_url: string }>} [input.legacyStartOAuth] - نفس startOAuth الحالية (auth/providers/oauth2.js يعتمد عليها لمسار manual)
 * @param {() => boolean} [input.hasPlatformApp] - يقرر لو فيه platform OAuth app مسجَّل لهذا السيرفر (Phase 2 لاحقًا - افتراضيًا false)
 */
export function buildConnectionForNewArchitecture({ server, connection, resolveSecret, legacyStartOAuth, hasPlatformApp }) {
    if (!server?.url) throw new Error('Legacy Bridge: server.url مطلوب لبناء connection');
    if (!resolveSecret) throw new Error('Legacy Bridge: resolveSecret مطلوب - لا يجوز تشغيل هذا الجسر بدون طبقة فك تشفير حقيقية من المستدعي');

    return {
        url: server.url,
        transport: server.transport, // stdio | sse | streamable_http - نفس القيم الحالية بالضبط
        auth_type: connection?.auth_type || 'none',
        oauth_token_expires_at: connection?.oauth_token_expires_at || null,
        _resolveSecret: resolveSecret,
        _legacyStartOAuth: legacyStartOAuth,
        _hasPlatformApp: hasPlatformApp || (() => false),
    };
}

/**
 * يعادل ما تفعله test-mcp-server اليوم: initialize + tools/list + resources/list
 * + prompts/list في نداء واحد، عبر المعمارية الجديدة بالكامل.
 *
 * شكل الإرجاع في حالة الفشل مطابق تمامًا لما يتوقعه testServer() في
 * mcp-service.js حاليًا (راجع مسار `error || data?.error` هناك):
 *   { ok: false, message: string, tools: 0 }
 *
 * شكل النجاح مصمَّم ليكون superset آمن: `tools` هنا مصفوفة (متوافقة مباشرة
 * مع عمود tools jsonb في mcp_server_connections كما يقرأه mergeServerWithConnection)
 * + حقول إضافية (capabilities/serverInfo/protocolVersion/resources/prompts)
 * غير موجودة في الشكل القديم. أي كود قديم يقرأ فقط {ok, message, tools:Array}
 * يستمر يعمل بدون تعديل؛ الشكل الدقيق 1:1 لنجاح test-mcp-server الفعلي لم
 * يُتحقّق منه هنا لأن مصدر تلك الـ Edge Function غير متاح في هذا السكافولد -
 * هذا مذكور صراحة في ملاحظات التوافق المرفقة مع هذا التسليم.
 *
 * @param {Parameters<typeof buildConnectionForNewArchitecture>[0]} input
 */
export async function discoverServerViaBridge(input) {
    let connectionManager;
    let session;
    try {
        const connection = buildConnectionForNewArchitecture(input);
        connectionManager = new ConnectionManager(connection);
        session = new McpSession(connectionManager);

        const result = await session.discoverAll();
        const toolsArray = result.tools?.supported ? (result.tools.items?.tools || []) : [];

        return {
            ok: true,
            message: 'تم الاتصال بنجاح',
            tools: toolsArray,
            capabilities: result.capabilities,
            serverInfo: result.serverInfo,
            protocolVersion: session.protocolVersion,
            resources: result.resources,
            prompts: result.prompts,
        };
    } catch (err) {
        return { ok: false, message: err?.message || 'فشل الاتصال بالسيرفر', tools: 0 };
    } finally {
        session?.dispose();
        await connectionManager?.close().catch(() => {});
    }
}

/**
 * يعادل ما تفعله mcp-invoke-tool اليوم (شكل الإرجاع مطابق تمامًا للتعليق
 * الموثَّق في mcp-service.js: `{ ok, toolName, serverName, result }`).
 * ملاحظة: التحقق من الصلاحيات (can_use_mcp_client) المذكور في التعليق
 * الأصلي يبقى مسؤولية الـ Edge Function المستدعية، وليس هذا الملف - هذا
 * الجسر تنفيذ بروتوكول فقط، لا صلاحيات.
 *
 * @param {Parameters<typeof buildConnectionForNewArchitecture>[0]} input
 * @param {string} toolName
 * @param {object} [args]
 */
export async function callToolViaBridge(input, toolName, args = {}) {
    let connectionManager;
    let session;
    try {
        const connection = buildConnectionForNewArchitecture(input);
        connectionManager = new ConnectionManager(connection);
        session = new McpSession(connectionManager);
        await session.initialize();
        const result = await session.toolsCall(toolName, args);
        return { ok: true, toolName, serverName: input.server?.name, result };
    } catch (err) {
        return { ok: false, toolName, serverName: input.server?.name, error: err?.message || 'فشل استدعاء الأداة' };
    } finally {
        session?.dispose();
        await connectionManager?.close().catch(() => {});
    }
}
